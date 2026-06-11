import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { parseActionBlockJson, resolveDirectAgentTarget, selectBroadcastTargets, validateToolCall } from '../lib/tool-routing'
import { extractCurrentTurnActionBlocks, prepareCurrentTurnActions } from '../lib/action-ledger'
import { buildWorkbenchSessionKey, isReservedNonWorkbenchSessionKey } from '../lib/workbench-session'
import { validateWorkspaceCwd } from '../lib/workspace-boundary'
import { resolveWorkspaceSelector } from '../lib/workspace-selector'
import { beginDispatchAction, completeDispatchAction, dispatchRunStatus, dispatchRunStatusForSession, synthesizeDispatchRunId } from '../lib/dispatch-runs'
import { buildControlCenterSummary } from '../lib/control-center-summary'
import { acknowledgeControlCenterAgent, readControlCenterAcks } from '../lib/control-center-continuity'
import { controlCenterPaneStates, getControlCenterWorkspaceMatrix } from '../lib/control-center-ui-state'
import { leaves, placeOrFocusAgent } from '../lib/layout'
import type { Agent, LayoutNode, Workspace } from '../lib/types'

function agent(id: string, kind: Agent['kind'], workspaceId = 'ws1', status: Agent['status'] = 'running'): Agent {
  return {
    id,
    kind,
    workspaceId,
    status,
    name: id,
    cwd: '/tmp',
    cmd: 'true',
    args: [],
    createdAt: new Date(0).toISOString(),
  }
}

function workspace(id: string, name: string): Workspace {
  return { id, name, cwd: `/tmp/${id}`, createdAt: new Date(0).toISOString() }
}

function withTempDispatchStore<T>(fn: (dir: string) => T): T {
  const prev = process.env.AW_DISPATCH_RUNS_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dispatch-runs-'))
  process.env.AW_DISPATCH_RUNS_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) delete process.env.AW_DISPATCH_RUNS_DIR
    else process.env.AW_DISPATCH_RUNS_DIR = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function withTempControlCenterStore<T>(fn: (dir: string) => T): T {
  const prev = process.env.AW_CONTROL_CENTER_STATE_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-controlCenter-'))
  process.env.AW_CONTROL_CENTER_STATE_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) delete process.env.AW_CONTROL_CENTER_STATE_DIR
    else process.env.AW_CONTROL_CENTER_STATE_DIR = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('action-block validation', () => {
  it('accepts a valid send_to_agent action', () => {
    assert.deepEqual(
      parseActionBlockJson('{"tool":"send_to_agent","args":{"id":"ag_1","text":"hello\\n"}}'),
      { tool: 'send_to_agent', args: { id: 'ag_1', text: 'hello\n' } },
    )
  })

  it('rejects malformed JSON before execution', () => {
    const result = parseActionBlockJson('{"tool":"send_to_agent","args":')
    assert.equal('error' in result, true)
    assert.match('error' in result ? result.error : '', /invalid aw_action JSON/)
  })

  it('rejects unknown tools with a clear error', () => {
    const result = parseActionBlockJson('{"tool":"send_to_codex","args":{"id":"ag_1","text":"x"}}')
    assert.deepEqual(result, { error: 'unknown tool "send_to_codex"' })
  })

  it('accepts optional action ids for current-turn ledger dedupe', () => {
    assert.deepEqual(
      parseActionBlockJson('{"id":"act_1","tool":"list_agents","args":{}}'),
      { id: 'act_1', tool: 'list_agents', args: {} },
    )
  })

  it('rejects send_to_agent without a string id', () => {
    const result = validateToolCall('send_to_agent', { text: 'x' })
    assert.deepEqual(result, { error: 'send_to_agent.args.id must be a non-empty string' })
  })

  it('accepts optional workspace_id on direct agent tools', () => {
    assert.deepEqual(
      validateToolCall('send_to_agent', { id: 'ag_1', text: 'x', workspace_id: 'ws2' }),
      { tool: 'send_to_agent', args: { id: 'ag_1', text: 'x', workspace_id: 'ws2' } },
    )
  })

  it('validates read-only controlCenter summary tool args', () => {
    assert.deepEqual(validateToolCall('get_control_center_summary', {}), { tool: 'get_control_center_summary', args: {} })
    assert.deepEqual(
      validateToolCall('get_control_center_summary', { workspace_ids: ['ws1'], runs_limit: 50 }),
      { tool: 'get_control_center_summary', args: { workspace_ids: ['ws1'], runs_limit: 50 } },
    )
    assert.deepEqual(
      validateToolCall('get_control_center_summary', { workspace_ids: 'ws1' }),
      { error: 'get_control_center_summary.args.workspace_ids must be an array of strings' },
    )
    assert.deepEqual(
      validateToolCall('get_control_center_summary', { runs_limit: 51 }),
      { error: 'get_control_center_summary.args.runs_limit must be an integer between 1 and 50' },
    )
    assert.deepEqual(
      validateToolCall('get_control_center_summary', { stale_threshold_ms: 10 }),
      { error: 'get_control_center_summary.args.stale_threshold_ms must be an integer between 60000 and 3600000' },
    )
  })

  it('validates controlCenter continuity tools', () => {
    assert.deepEqual(
      validateToolCall('acknowledge_agent', { agent_id: 'ag_1', workspace_id: 'ws1', reason: 'reviewed', by: 'metis-brain' }),
      { tool: 'acknowledge_agent', args: { agent_id: 'ag_1', workspace_id: 'ws1', reason: 'reviewed', by: 'metis-brain' } },
    )
    assert.deepEqual(
      validateToolCall('acknowledge_agent', { agent_id: '' }),
      { error: 'acknowledge_agent.args.agent_id must be a non-empty string' },
    )
    assert.deepEqual(
      validateToolCall('acknowledge_agent', { agent_id: 'ag_1', reason: 'x'.repeat(201) }),
      { error: 'acknowledge_agent.args.reason must be a string no longer than 200 characters' },
    )
    assert.deepEqual(
      validateToolCall('list_workspace_reports', { workspace_id: 'ws1', reports_limit: 50, unread_only: true }),
      { tool: 'list_workspace_reports', args: { workspace_id: 'ws1', reports_limit: 50, unread_only: true } },
    )
  })

  it('rejects broadcast with an invalid kind instead of broadening targets', () => {
    const result = validateToolCall('broadcast', { text: 'x', kind: 'all' })
    assert.deepEqual(result, { error: 'broadcast.args.kind must be one of claude, codex, shell, gemini, python' })
  })
})

describe('direct agent workspace guardrails', () => {
  it('rejects an agent id from another workspace without explicit workspace_id', () => {
    const result = resolveDirectAgentTarget({
      agents: [agent('ag_ws2', 'claude', 'ws2')],
      id: 'ag_ws2',
      activeWorkspaceId: 'ws1',
    })

    assert.equal('error' in result, true)
    assert.match('error' in result ? result.error : '', /supply workspace_id/)
  })

  it('allows a cross-workspace agent id only when explicit workspace_id matches', () => {
    const result = resolveDirectAgentTarget({
      agents: [agent('ag_ws2', 'claude', 'ws2')],
      id: 'ag_ws2',
      activeWorkspaceId: 'ws1',
      explicitWorkspaceId: 'ws2',
    })

    assert.equal('ok' in result, true)
    assert.equal('ok' in result ? result.targetWorkspaceId : '', 'ws2')
    assert.equal('ok' in result ? result.explicit : false, true)
  })

  it('rejects an explicit workspace_id that does not match the agent', () => {
    const result = resolveDirectAgentTarget({
      agents: [agent('ag_ws2', 'claude', 'ws2')],
      id: 'ag_ws2',
      activeWorkspaceId: 'ws1',
      explicitWorkspaceId: 'ws1',
    })

    assert.equal('error' in result, true)
    assert.match('error' in result ? result.error : '', /belongs to workspace ws2, not ws1/)
  })
})

describe('workspace selector', () => {
  const workspaces = [
    { id: 'ws1', name: 'Workbench', cwd: '/tmp/workbench', createdAt: new Date(0).toISOString() },
    { id: 'ws2', name: 'Sitework', cwd: '/tmp/sitework-a', createdAt: new Date(0).toISOString() },
    { id: 'ws3', name: 'Sitework', cwd: '/tmp/sitework-b', createdAt: new Date(0).toISOString() },
  ]

  it('resolves exact workspace ids before names', () => {
    assert.deepEqual(resolveWorkspaceSelector(workspaces, 'ws2'), { workspaceId: 'ws2' })
  })

  it('rejects ambiguous workspace names with candidate ids', () => {
    const result = resolveWorkspaceSelector(workspaces, 'sitework')
    assert.equal('error' in result, true)
    assert.match('error' in result ? result.error : '', /ws2 \(Sitework\), ws3 \(Sitework\)/)
  })
})

describe('current-turn action replay hygiene', () => {
  it('extracts only the assistant turn text passed for execution', () => {
    const stale = '```aw_action\n{"tool":"broadcast","args":{"text":"old"}}\n```'
    const current = 'Done; no action needed.'

    assert.equal(extractCurrentTurnActionBlocks(current).length, 0)
    assert.equal(extractCurrentTurnActionBlocks(stale).length, 1)
  })

  it('ignores duplicate explicit action ids in the same assistant turn', () => {
    const turn = [
      '```aw_action',
      '{"id":"act_same","tool":"list_agents","args":{}}',
      '```',
      '```aw_action',
      '{"id":"act_same","tool":"list_agents","args":{}}',
      '```',
    ].join('\n')

    const actions = prepareCurrentTurnActions(turn, () => '2026-05-08T00:00:00.000Z')
    assert.equal(actions.length, 2)
    assert.equal('action' in actions[0], true)
    assert.equal('error' in actions[1], true)
    assert.match('error' in actions[1] ? actions[1].error : '', /duplicate action/)
  })

  it('ignores same-turn replay without explicit ids by tool and args hash', () => {
    const turn = [
      '```aw_action',
      '{"tool":"list_agents","args":{}}',
      '```',
      '```aw_action',
      '{"args":{},"tool":"list_agents"}',
      '```',
    ].join('\n')

    const actions = prepareCurrentTurnActions(turn)
    assert.equal(actions.length, 2)
    assert.equal('action' in actions[0], true)
    assert.equal('error' in actions[1], true)
  })
})

describe('durable dispatch run ledger', () => {
  function withDispatchStore<T>(fn: () => T): T {
    const prev = process.env.AW_DISPATCH_RUNS_DIR
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dispatch-runs-'))
    process.env.AW_DISPATCH_RUNS_DIR = dir
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env.AW_DISPATCH_RUNS_DIR
      else process.env.AW_DISPATCH_RUNS_DIR = prev
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('synthesizes stable run ids from workspace and prompt', () => {
    assert.equal(
      synthesizeDispatchRunId({ workspaceId: 'ws1', userPrompt: 'spawn lanes' }),
      synthesizeDispatchRunId({ workspaceId: 'ws1', userPrompt: 'spawn lanes' }),
    )
    assert.notEqual(
      synthesizeDispatchRunId({ workspaceId: 'ws1', userPrompt: 'spawn lanes' }),
      synthesizeDispatchRunId({ workspaceId: 'ws2', userPrompt: 'spawn lanes' }),
    )
  })

  it('prevents duplicate execution by action id or same action fingerprint', () => withDispatchStore(() => {
    const first = beginDispatchAction({
      runId: 'run_1',
      workspaceId: 'ws1',
      createdBy: 'metis-brain',
      userPrompt: 'spawn lanes',
      actionId: 'act_spawn',
      tool: 'spawn_agents',
      args: { specs: [{ kind: 'claude', name: 'Forge' }] },
    })
    assert.equal(first.duplicate, false)
    completeDispatchAction({
      workspaceId: 'ws1',
      runId: 'run_1',
      actionId: 'act_spawn',
      tool: 'spawn_agents',
      result: { spawned: [{ id: 'ag_1', name: 'Forge', kind: 'claude' }] },
    })

    const duplicateId = beginDispatchAction({
      runId: 'run_1',
      workspaceId: 'ws1',
      createdBy: 'metis-brain',
      userPrompt: 'spawn lanes',
      actionId: 'act_spawn',
      tool: 'spawn_agents',
      args: { specs: [{ kind: 'claude', name: 'Forge' }] },
    })
    assert.equal(duplicateId.duplicate, true)
    assert.deepEqual(duplicateId.action.spawnedAgents.map((a) => a.id), ['ag_1'])

    const duplicateFingerprint = beginDispatchAction({
      runId: 'run_1',
      workspaceId: 'ws1',
      createdBy: 'metis-brain',
      userPrompt: 'spawn lanes',
      actionId: 'act_spawn_retry_name_changed',
      tool: 'spawn_agents',
      args: { specs: [{ kind: 'claude', name: 'Forge' }] },
    })
    assert.equal(duplicateFingerprint.duplicate, true)
  }))

  it('persists dispatch runs through a same-directory atomic rename', () => withTempDispatchStore((dir) => {
    const originalRename = fs.renameSync
    const renames: Array<{ from: string; to: string }> = []
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      renames.push({ from: String(from), to: String(to) })
      return originalRename(from, to)
    }) as typeof fs.renameSync

    try {
      beginDispatchAction({
        runId: 'run_atomic',
        workspaceId: 'ws1',
        createdBy: 'metis-brain',
        userPrompt: 'supervise product build',
        actionId: 'act_atomic',
        tool: 'broadcast',
        args: { text: 'status' },
      })
    } finally {
      fs.renameSync = originalRename
    }

    assert.equal(renames.length, 1)
    assert.equal(path.dirname(renames[0].from), path.dirname(renames[0].to))
    assert.equal(renames[0].to, path.join(dir, 'ws1.json'))
    assert.match(path.basename(renames[0].from), /^\.ws1\.json\.\d+\.\d+\.\d+\.tmp$/)
    assert.deepEqual(fs.readdirSync(dir), ['ws1.json'])
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ws1.json'), 'utf8')).runs[0].runId, 'run_atomic')
  }))

  it('records explicit target workspace on runs and actions', () => withDispatchStore(() => {
    beginDispatchAction({
      runId: 'run_cross_ws',
      workspaceId: 'ws2',
      sessionWorkspaceId: 'ws1',
      targetWorkspaceId: 'ws2',
      explicitTargetWorkspaceId: 'ws2',
      createdBy: 'metis-brain',
      userPrompt: 'message Sitework agent from Workbench',
      actionId: 'act_send',
      tool: 'send_to_agent',
      args: { id: 'ag_sitework', text: 'status', workspace_id: 'Sitework' },
    })
    completeDispatchAction({
      workspaceId: 'ws2',
      runId: 'run_cross_ws',
      actionId: 'act_send',
      tool: 'send_to_agent',
      result: { ok: true },
    })

    const status = dispatchRunStatus('ws2', 'run_cross_ws')
    assert.equal(status.run?.sessionWorkspaceId, 'ws1')
    assert.equal(status.run?.targetWorkspaceId, 'ws2')
    assert.equal(status.run?.explicitTargetWorkspaceId, 'ws2')
    assert.equal(status.run?.actions[0].sessionWorkspaceId, 'ws1')
    assert.equal(status.run?.actions[0].targetWorkspaceId, 'ws2')
    assert.equal(status.run?.actions[0].explicitTargetWorkspaceId, 'ws2')
  }))

  it('includes cross-workspace target runs in active session status', () => withDispatchStore(() => {
    beginDispatchAction({
      runId: 'run_cross_ws',
      workspaceId: 'ws2',
      sessionWorkspaceId: 'ws1',
      targetWorkspaceId: 'ws2',
      explicitTargetWorkspaceId: 'ws2',
      createdBy: 'metis-brain',
      userPrompt: 'spawn in Sitework from Workbench',
      actionId: 'act_spawn',
      tool: 'spawn_agents',
      args: { workspace_id: 'Sitework', specs: [{ kind: 'claude', name: 'Forge' }] },
    })
    completeDispatchAction({
      workspaceId: 'ws2',
      runId: 'run_cross_ws',
      actionId: 'act_spawn',
      tool: 'spawn_agents',
      result: { spawned: [{ id: 'ag_sitework', name: 'Forge', kind: 'claude' }] },
    })

    assert.equal(dispatchRunStatus('ws1', 'run_cross_ws').run, null)
    const sessionStatus = dispatchRunStatusForSession('ws1', 'run_cross_ws')
    assert.equal(sessionStatus.run?.workspaceId, 'ws2')
    assert.equal(sessionStatus.run?.targetWorkspaceId, 'ws2')
    assert.deepEqual(sessionStatus.run?.actions[0].spawnedAgents.map((a) => a.id), ['ag_sitework'])
  }))

  it('persists partial spawn failures with spawned ids and retryable failed specs', () => withDispatchStore(() => {
    beginDispatchAction({
      runId: 'run_partial',
      workspaceId: 'ws1',
      createdBy: 'metis-brain',
      userPrompt: 'spawn forge and shield',
      actionId: 'act_spawn_partial',
      tool: 'spawn_agents',
      args: { specs: [{ kind: 'claude', name: 'Forge' }, { kind: 'claude', name: 'Shield', cwd: '/nope' }] },
    })
    completeDispatchAction({
      workspaceId: 'ws1',
      runId: 'run_partial',
      actionId: 'act_spawn_partial',
      tool: 'spawn_agents',
      result: {
        spawned: [
          { id: 'ag_forge', name: 'Forge', kind: 'claude' },
          { error: 'cwd outside workspace boundary', spec: { kind: 'claude', name: 'Shield', cwd: '/nope' } },
        ],
      },
    })

    const status = dispatchRunStatus('ws1', 'run_partial')
    assert.equal(status.run?.status, 'partial_failed')
    assert.equal(status.run?.actions[0].status, 'partial_failed')
    assert.deepEqual(status.run?.actions[0].spawnedAgents.map((a) => a.id), ['ag_forge'])
    assert.equal(status.run?.actions[0].failedSpecs?.[0].error, 'cwd outside workspace boundary')

    const duplicateAfterReload = beginDispatchAction({
      runId: 'run_partial',
      workspaceId: 'ws1',
      createdBy: 'metis-brain',
      userPrompt: 'spawn forge and shield',
      actionId: 'act_spawn_partial',
      tool: 'spawn_agents',
      args: { specs: [{ kind: 'claude', name: 'Forge' }, { kind: 'claude', name: 'Shield', cwd: '/nope' }] },
    })
    assert.equal(duplicateAfterReload.duplicate, true)
    assert.deepEqual(duplicateAfterReload.action.spawnedAgents.map((a) => a.id), ['ag_forge'])
    assert.equal(duplicateAfterReload.action.failedSpecs?.length, 1)
  }))
})

describe('controlCenter summary fan-out', () => {
  it('aggregates latest runs and totals across workspaces', () => withTempDispatchStore(() => {
    for (const wsId of ['ws1', 'ws2']) {
      beginDispatchAction({
        runId: `run_${wsId}`,
        workspaceId: wsId,
        createdBy: 'metis-brain',
        userPrompt: `spawn ${wsId}`,
        actionId: `act_${wsId}`,
        tool: 'spawn_agents',
        args: { specs: [{ kind: 'claude', name: 'Forge' }] },
      })
      completeDispatchAction({
        workspaceId: wsId,
        runId: `run_${wsId}`,
        actionId: `act_${wsId}`,
        tool: 'spawn_agents',
        result: { spawned: [{ id: `ag_${wsId}`, name: 'Forge', kind: 'claude' }] },
      })
    }

    const summary = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench'), workspace('ws2', 'Sitework')],
      agents: [],
      generatedAt: '2026-05-09T00:00:00.000Z',
    })
    assert.equal('error' in summary, false)
    if ('error' in summary) return
    assert.equal(summary.totals.workspaces, 2)
    assert.equal(summary.totals.succeededRunCount, 2)
    assert.deepEqual(summary.workspaces.map((ws) => ws.lastRun?.status), ['succeeded', 'succeeded'])
    assert.deepEqual(summary.workspaces.find((ws) => ws.workspaceId === 'ws2')?.lastRun?.spawnedAgentIds, ['ag_ws2'])
  }))

  it('reduces mixed run status, retryable failures, and close recommendation buckets', () => withTempDispatchStore(() => {
    beginDispatchAction({
      runId: 'run_running',
      workspaceId: 'ws1',
      createdBy: 'metis-brain',
      userPrompt: 'running',
      actionId: 'act_running',
      tool: 'broadcast',
      args: { text: 'go' },
    })

    beginDispatchAction({
      runId: 'run_partial',
      workspaceId: 'ws2',
      createdBy: 'metis-brain',
      userPrompt: 'partial',
      actionId: 'act_partial',
      tool: 'spawn_agents',
      args: { specs: [{ kind: 'claude', name: 'Forge' }, { kind: 'codex', name: 'Shield' }] },
    })
    completeDispatchAction({
      workspaceId: 'ws2',
      runId: 'run_partial',
      actionId: 'act_partial',
      tool: 'spawn_agents',
      result: { spawned: [{ id: 'ag_ok', kind: 'claude' }, { error: 'spawn failed', spec: { kind: 'codex', name: 'Shield' } }] },
    })

    beginDispatchAction({
      runId: 'run_failed',
      workspaceId: 'ws3',
      createdBy: 'metis-brain',
      userPrompt: 'failed',
      actionId: 'act_failed',
      tool: 'spawn_agents',
      args: { specs: [{ kind: 'claude', name: 'Forge' }] },
    })
    completeDispatchAction({
      workspaceId: 'ws3',
      runId: 'run_failed',
      actionId: 'act_failed',
      tool: 'spawn_agents',
      result: { spawned: [{ error: 'spawn failed', spec: { kind: 'claude', name: 'Forge' } }] },
    })

    const ready = { ...agent('ag_ready', 'claude', 'ws2', 'exited'), exitCode: 0 }
    const blocked = { ...agent('ag_blocked', 'codex', 'ws2', 'exited'), exitCode: 1 }
    const unknown = agent('ag_unknown', 'shell', 'ws2', 'exited')
    const summary = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'A'), workspace('ws2', 'B'), workspace('ws3', 'C')],
      agents: [agent('ag_running', 'shell', 'ws2'), ready, blocked, unknown],
    })
    assert.equal('error' in summary, false)
    if ('error' in summary) return
    assert.equal(summary.totals.activeRunCount, 1)
    assert.equal(summary.totals.partialRunCount, 1)
    assert.equal(summary.totals.failedRunCount, 1)
    assert.equal(summary.totals.retryableFailedSpecCount, 2)
    assert.equal(summary.totals.runningAgents, 1)
    assert.equal(summary.totals.reviewReadyAgentCount, 1)
    assert.equal(summary.totals.blockedAgentCount, 1)
    assert.equal(summary.totals.unknownExitAgentCount, 1)
    const ws2 = summary.workspaces.find((ws) => ws.workspaceId === 'ws2')
    assert.deepEqual(ws2?.readiness.reviewReadyAgentIds, ['ag_ready'])
    assert.deepEqual(ws2?.readiness.blockedAgentIds, ['ag_blocked'])
    assert.deepEqual(ws2?.readiness.unknownExitAgentIds, ['ag_unknown'])
    assert.equal(ws2?.agents.byKind.claude, 1)
    assert.deepEqual(summary.nextActions.map((action) => [action.kind, action.agentId, action.severity]), [
      ['investigate', 'ag_blocked', 3],
      ['retry', undefined, 2],
      ['review', 'ag_ready', 2],
      ['wake', 'ag_running', 2],
      ['ack_or_clear', 'ag_unknown', 2],
      ['retry', undefined, 2],
    ])
  }))

  it('detects stale running panes with configurable threshold', () => withTempDispatchStore(() => {
    const now = '2026-05-09T12:00:00.000Z'
    const stale = { ...agent('ag_stale', 'codex', 'ws1'), lastOutputAt: '2026-05-09T11:48:00.000Z', outputBytes: 42 }
    const fresh = { ...agent('ag_fresh', 'codex', 'ws1'), lastOutputAt: '2026-05-09T11:59:00.000Z' }

    const defaultSummary = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench')],
      agents: [stale, fresh],
      now,
    })
    assert.equal('error' in defaultSummary, false)
    if ('error' in defaultSummary) return
    assert.deepEqual(defaultSummary.workspaces[0].readiness.staleRunningAgentIds, ['ag_stale'])
    assert.deepEqual(defaultSummary.workspaces[0].readiness.staleRunningAgents, [{
      agentId: 'ag_stale',
      idleMs: 720_000,
      lastOutputAt: '2026-05-09T11:48:00.000Z',
      outputBytes: 42,
      hasReport: false,
    }])
    assert.equal(defaultSummary.nextActions.find((action) => action.agentId === 'ag_stale')?.reason, 'ag_stale (codex) idle 12m; output 42 bytes; no report artifact')
    assert.equal(defaultSummary.totals.staleRunningAgentCount, 1)
    assert.deepEqual(defaultSummary.workspaces[0].readiness.agentStates.map((row) => ({
      agentId: row.agentId,
      state: row.state,
      idleMs: row.idleMs,
      outputBytes: row.outputBytes,
      hasReport: row.hasReport,
    })), [
      { agentId: 'ag_stale', state: 'stale', idleMs: 720_000, outputBytes: 42, hasReport: false },
      { agentId: 'ag_fresh', state: 'running', idleMs: 60_000, outputBytes: 0, hasReport: false },
    ])

    const lowerThreshold = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench')],
      agents: [stale, fresh],
      now,
      staleThresholdMs: 60_000,
    })
    assert.equal('error' in lowerThreshold, false)
    if ('error' in lowerThreshold) return
    assert.deepEqual(lowerThreshold.workspaces[0].readiness.staleRunningAgentIds, ['ag_stale', 'ag_fresh'])
  }))

  it('provides deterministic supervisor agent states for done, blocked, stale, and unknown exits', () => withTempDispatchStore(() => {
    const summary = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench')],
      agents: [
        { ...agent('z_done', 'claude', 'ws1', 'exited'), exitCode: 0 },
        { ...agent('b_blocked', 'codex', 'ws1', 'exited'), exitCode: 2 },
        { ...agent('a_stale', 'shell', 'ws1', 'running'), lastOutputAt: '2026-05-09T11:00:00.000Z', outputBytes: 7 },
        agent('c_unknown', 'shell', 'ws1', 'exited'),
        { ...agent('d_starting', 'claude', 'ws1', 'starting'), name: 'Starting Lane' },
      ],
      reports: [{
        workspaceId: 'ws1',
        path: '/tmp/ws1/A_STALE_REPORT.md',
        agentId: 'a_stale',
        kind: 'markdown',
        mtime: '2026-05-09T12:00:00.000Z',
        sizeBytes: 100,
        unread: true,
      }],
      acks: [{
        workspaceId: 'ws1',
        agentId: 'z_done',
        ackedAt: '2026-05-09T12:00:00.000Z',
        by: 'metis-brain',
      }],
      now: '2026-05-09T12:00:00.000Z',
      staleThresholdMs: 60_000,
    })
    assert.equal('error' in summary, false)
    if ('error' in summary) return
    assert.deepEqual(summary.workspaces[0].readiness.agentStates.map((row) => [
      row.agentId,
      row.state,
      row.acknowledged,
      row.hasReport,
      row.exitCode,
      row.idleMs,
      row.outputBytes,
    ]), [
      ['b_blocked', 'blocked', false, false, 2, undefined, undefined],
      ['a_stale', 'stale', false, true, undefined, 3_600_000, 7],
      ['z_done', 'done', true, false, 0, undefined, undefined],
      ['c_unknown', 'unknown_exit', false, false, undefined, undefined, undefined],
      ['d_starting', 'starting', false, false, undefined, undefined, undefined],
    ])
  }))

  it('surfaces report rows even when their agent is gone', () => withTempDispatchStore(() => {
    const summary = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench')],
      agents: [],
      reports: [{
        workspaceId: 'ws1',
        path: '/tmp/ws1/WORK_REPORT.md',
        agentId: 'ag_removed',
        kind: 'markdown',
        mtime: '2026-05-09T12:00:00.000Z',
        sizeBytes: 123,
        unread: true,
      }],
    })
    assert.equal('error' in summary, false)
    if ('error' in summary) return
    assert.deepEqual(summary.workspaces[0].reports, [{
      path: '/tmp/ws1/WORK_REPORT.md',
      agentId: 'ag_removed',
      kind: 'markdown',
      mtime: '2026-05-09T12:00:00.000Z',
      sizeBytes: 123,
      unread: true,
    }])
    assert.equal(summary.totals.unreadReportCount, 1)
    assert.deepEqual(summary.nextActions.map((action) => action.kind), ['read_report'])
  }))

  it('acknowledgement metadata removes clean exited agents from next actions without touching dispatch runs', () => withTempDispatchStore((dispatchDir) => withTempControlCenterStore((controlCenterDir) => {
    beginDispatchAction({
      runId: 'run_readonly_ack',
      workspaceId: 'ws1',
      createdBy: 'metis-brain',
      userPrompt: 'ack readonly',
      actionId: 'act_readonly_ack',
      tool: 'broadcast',
      args: { text: 'status' },
    })
    const dispatchFile = path.join(dispatchDir, 'ws1.json')
    const beforeDispatch = fs.readFileSync(dispatchFile, 'utf8')
    const beforeAcksExists = fs.existsSync(path.join(controlCenterDir, 'control-center-acks.json'))

    const ack = acknowledgeControlCenterAgent({
      workspaceId: 'ws1',
      agentId: 'ag_ready',
      by: 'metis-brain',
      reason: 'reviewed',
      now: '2026-05-09T12:00:00.000Z',
    })
    assert.equal(ack.agentId, 'ag_ready')
    assert.equal(beforeAcksExists, false)
    assert.equal(fs.readFileSync(dispatchFile, 'utf8'), beforeDispatch)

    const ready = { ...agent('ag_ready', 'claude', 'ws1', 'exited'), exitCode: 0 }
    const summary = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench')],
      agents: [ready],
      acks: readControlCenterAcks(),
    })
    assert.equal('error' in summary, false)
    if ('error' in summary) return
    assert.deepEqual(summary.workspaces[0].readiness.acknowledgedAgentIds, ['ag_ready'])
    assert.deepEqual(summary.nextActions, [])

    const includeAcked = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench')],
      agents: [ready],
      acks: readControlCenterAcks(),
      includeAcked: true,
    })
    assert.equal('error' in includeAcked, false)
    if (!('error' in includeAcked)) assert.deepEqual(includeAcked.nextActions.map((action) => action.kind), ['review'])
  })))

  it('threads active workspace ordering through the summary builder', () => withTempDispatchStore(() => {
    const summary = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Alpha'), workspace('ws2', 'Beta'), workspace('ws3', 'Gamma')],
      agents: [],
      activeWorkspaceId: 'ws2',
    })
    assert.equal('error' in summary, false)
    if (!('error' in summary)) assert.deepEqual(summary.workspaces.map((ws) => ws.workspaceId), ['ws2', 'ws1', 'ws3'])
  }))

  it('orders next actions deterministically by severity, workspace, and source id', () => withTempDispatchStore(() => {
    const makeSummary = () => buildControlCenterSummary({
      workspaces: [workspace('ws2', 'Beta'), workspace('ws1', 'Alpha')],
      agents: [
        { ...agent('z_blocked', 'codex', 'ws2', 'exited'), exitCode: 1 },
        { ...agent('a_blocked', 'codex', 'ws1', 'exited'), exitCode: 1 },
        { ...agent('b_ready', 'claude', 'ws1', 'exited'), exitCode: 0 },
        { ...agent('a_ready', 'claude', 'ws1', 'exited'), exitCode: 0 },
      ],
    })
    const first = makeSummary()
    const second = makeSummary()
    assert.equal('error' in first, false)
    assert.equal('error' in second, false)
    if ('error' in first || 'error' in second) return
    assert.deepEqual(first.nextActions, second.nextActions)
    assert.deepEqual(first.nextActions.map((action) => [action.severity, action.workspaceId, action.agentId]), [
      [3, 'ws1', 'a_blocked'],
      [3, 'ws2', 'z_blocked'],
      [2, 'ws1', 'a_ready'],
      [2, 'ws1', 'b_ready'],
    ])
  }))

  it('builds a controlCenter workspace matrix row for every workspace, including idle ones', () => withTempDispatchStore(() => {
    const summary = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Alpha'), workspace('ws2', 'Beta'), workspace('ws3', 'Gamma')],
      agents: [
        { ...agent('ag_blocked', 'codex', 'ws1', 'exited'), exitCode: 1 },
        agent('ag_active', 'claude', 'ws2', 'running'),
      ],
      reports: [{
        workspaceId: 'ws2',
        path: '/tmp/ws2/WORKBENCH_REPORT.md',
        kind: 'markdown',
        mtime: '2026-05-09T12:00:00.000Z',
        sizeBytes: 123,
        unread: true,
      }],
      now: '2026-05-09T12:00:00.000Z',
      staleThresholdMs: 3_600_000,
    })
    assert.equal('error' in summary, false)
    if ('error' in summary) return

    const matrix = getControlCenterWorkspaceMatrix(summary)
    assert.deepEqual(matrix.map((row) => [row.workspace.workspaceId, row.health]), [
      ['ws1', 'blocked'],
      ['ws2', 'attention'],
      ['ws3', 'empty'],
    ])
    assert.equal(matrix.length, 3)
    assert.equal(matrix[1].kindSummary, '1 claude')
    assert.equal(matrix[1].unreadReportCount, 1)
    assert.equal(matrix[1].latestUnreadReportPath, '/tmp/ws2/WORKBENCH_REPORT.md')
  }))

  it('filters by workspace selector and returns selector errors', () => withTempDispatchStore(() => {
    const workspaces = [
      workspace('ws1', 'Workbench'),
      workspace('ws2', 'Sitework'),
      workspace('ws3', 'Sitework'),
    ]
    const filtered = buildControlCenterSummary({ workspaces, agents: [], workspaceSelectors: ['ws2'] })
    assert.equal('error' in filtered, false)
    if (!('error' in filtered)) assert.deepEqual(filtered.workspaces.map((ws) => ws.workspaceId), ['ws2'])

    const unknown = buildControlCenterSummary({ workspaces, agents: [], workspaceSelectors: ['Missing'] })
    assert.deepEqual(unknown, { error: 'unknown workspace id/name: Missing' })

    const ambiguous = buildControlCenterSummary({ workspaces, agents: [], workspaceSelectors: ['sitework'] })
    assert.equal('error' in ambiguous, true)
    assert.match('error' in ambiguous ? ambiguous.error : '', /ambiguous workspace name/)
  }))

  it('does not mutate dispatch run files while reading summary', () => withTempDispatchStore((dir) => {
    beginDispatchAction({
      runId: 'run_readonly',
      workspaceId: 'ws1',
      createdBy: 'metis-brain',
      userPrompt: 'readonly',
      actionId: 'act_readonly',
      tool: 'broadcast',
      args: { text: 'status' },
    })
    const file = path.join(dir, 'ws1.json')
    const before = {
      mtimeMs: fs.statSync(file).mtimeMs,
      content: fs.readFileSync(file, 'utf8'),
    }
    const summary = buildControlCenterSummary({ workspaces: [workspace('ws1', 'Workbench')], agents: [] })
    assert.equal('error' in summary, false)
    assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs)
    assert.equal(fs.readFileSync(file, 'utf8'), before.content)
  }))

  // Placeholder for follow-up #3 in WORKBENCH_TARGET_GUARDRAILS_CLAUDE_20260508.md:
  // once explicit cross-workspace target propagates into session metadata, a run
  // dispatched from wsA targeting wsB should expose lastRun.originWorkspaceId === wsA
  // under the wsB block. Today runs are stored under the resolved target so
  // run.workspaceId === blockWorkspaceId and originWorkspaceId stays undefined.
  it.skip('surfaces originWorkspaceId once session-metadata propagation lands', () => {})
})

describe('workbench pane placement and state helpers', () => {
  function twoLeafLayout(leftAgentId: string | null, rightAgentId: string | null): LayoutNode {
    return {
      kind: 'split',
      id: 'split_1',
      dir: 'horizontal',
      sizes: [50, 50],
      children: [
        { kind: 'leaf', id: 'left', agentId: leftAgentId },
        { kind: 'leaf', id: 'right', agentId: rightAgentId },
      ],
    }
  }

  it('focuses an already-open agent without changing the layout', () => {
    const root = twoLeafLayout('ag_a', null)
    const result = placeOrFocusAgent(root, 'ag_a', 'right')

    assert.equal(result.root, root)
    assert.equal(result.leafId, 'left')
    assert.equal(result.placed, false)
    assert.deepEqual(leaves(result.root).map((leaf) => [leaf.id, leaf.agentId]), [
      ['left', 'ag_a'],
      ['right', null],
    ])
  })

  it('fills an empty leaf before replacing an occupied pane', () => {
    const root = twoLeafLayout('ag_a', null)
    const result = placeOrFocusAgent(root, 'ag_b', 'left')

    assert.notEqual(result.root, root)
    assert.equal(result.leafId, 'right')
    assert.equal(result.placed, true)
    assert.deepEqual(leaves(result.root).map((leaf) => [leaf.id, leaf.agentId]), [
      ['left', 'ag_a'],
      ['right', 'ag_b'],
    ])
  })

  it('derives stale age, report-ready, and acknowledged pane labels without mutating controlCenter data', () => withTempDispatchStore(() => {
    const summary = buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench')],
      agents: [{ ...agent('ag_visible', 'codex'), lastOutputAt: '2026-05-09T11:00:00.000Z', outputBytes: 2048 }],
      reports: [{
        workspaceId: 'ws1',
        agentId: 'ag_visible',
        path: '/tmp/ws1/WORKBENCH_REPORT.md',
        kind: 'markdown',
        mtime: '2026-05-09T12:00:00.000Z',
        sizeBytes: 123,
        unread: true,
      }],
      acks: [{
        workspaceId: 'ws1',
        agentId: 'ag_visible',
        ackedAt: '2026-05-09T12:00:00.000Z',
        by: 'metis-brain',
      }],
      now: '2026-05-09T12:00:00.000Z',
      staleThresholdMs: 60_000,
    })
    assert.equal('error' in summary, false)
    if ('error' in summary) return

    assert.deepEqual(controlCenterPaneStates(summary.workspaces[0], 'ag_visible'), [
      { kind: 'stale', label: 'stale 1h' },
      { kind: 'report-ready', label: 'report ready' },
      { kind: 'acked', label: "ack'd" },
    ])
    assert.deepEqual(controlCenterPaneStates(summary.workspaces[0], 'ag_other'), [])
  }))
})

describe('workbench session keys', () => {
  it('separates workbench sessions from Telegram/default keys', () => {
    assert.equal(buildWorkbenchSessionKey('ws_123'), 'workbench:ws_123')
    assert.equal(buildWorkbenchSessionKey(null), 'workbench:global')
    assert.equal(isReservedNonWorkbenchSessionKey(buildWorkbenchSessionKey('ws_123')), false)
    assert.equal(isReservedNonWorkbenchSessionKey('telegram:direct'), true)
    assert.equal(isReservedNonWorkbenchSessionKey('default'), true)
  })
})

describe('workspace cwd validation', () => {
  it('allows the workspace root and children', () => {
    assert.deepEqual(validateWorkspaceCwd({
      workspaceCwd: '/tmp/workspace-a',
      requestedCwd: '/tmp/workspace-a/src',
      homeDir: '/home/nick',
    }), { ok: true, cwd: '/tmp/workspace-a/src' })
  })

  it('allows pinned roots and rejects unrelated cwd escapes', () => {
    assert.deepEqual(validateWorkspaceCwd({
      workspaceCwd: '/tmp/workspace-a',
      requestedCwd: '/tmp/shared/docs',
      pinnedRoots: ['/tmp/shared'],
      homeDir: '/home/nick',
    }), { ok: true, cwd: '/tmp/shared/docs' })

    const rejected = validateWorkspaceCwd({
      workspaceCwd: '/tmp/workspace-a',
      requestedCwd: '/tmp/workspace-b',
      pinnedRoots: ['/tmp/shared'],
      homeDir: '/home/nick',
    })
    assert.equal(rejected.ok, false)
    assert.match(rejected.ok ? '' : rejected.error, /outside workspace boundary/)
  })
})

describe('broadcast target selection', () => {
  it('keeps claude broadcasts isolated from codex and shell agents', () => {
    const targets = selectBroadcastTargets([
      agent('claude-1', 'claude'),
      agent('codex-1', 'codex'),
      agent('shell-1', 'shell'),
      agent('claude-2', 'claude', 'ws2'),
      agent('claude-exited', 'claude', 'ws1', 'exited'),
    ], 'ws1', 'claude')

    assert.deepEqual(targets.map((a) => a.id), ['claude-1'])
  })

  it('unfiltered broadcasts include only running agents in the workspace', () => {
    const targets = selectBroadcastTargets([
      agent('claude-1', 'claude'),
      agent('codex-1', 'codex'),
      agent('shell-1', 'shell'),
      agent('other-ws', 'shell', 'ws2'),
      agent('exited', 'codex', 'ws1', 'exited'),
    ], 'ws1')

    assert.deepEqual(targets.map((a) => a.id), ['claude-1', 'codex-1', 'shell-1'])
  })
})
