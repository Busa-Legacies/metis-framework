import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildCeoControlCenterView, formatCeoShippedAtCt, renderCeoBranchLabel, renderCeoWorkspaceLine } from '../lib/ceo-control-center-view'
import type { ControlCenterAgentState, ControlCenterNextAction, ControlCenterSummaryResponse, ControlCenterWorkspace, ControlCenterWorkspaceReadiness } from '../lib/control-center-summary'
import { EVIDENCE_KINDS, type EvidenceCounts, type EvidenceKind } from '../lib/evidence-ledger'

function zeroEvidence(): EvidenceCounts {
  const byKind = EVIDENCE_KINDS.reduce<Record<EvidenceKind, number>>((acc, k) => {
    acc[k] = 0
    return acc
  }, {} as Record<EvidenceKind, number>)
  return { total: 0, byKind }
}

function emptyReadiness(): ControlCenterWorkspaceReadiness {
  return {
    activeRunCount: 0,
    partialRunCount: 0,
    failedRunCount: 0,
    succeededRunCount: 0,
    retryableFailedSpecCount: 0,
    reviewReadyAgentIds: [],
    blockedAgentIds: [],
    unknownExitAgentIds: [],
    staleRunningAgentIds: [],
    staleRunningAgents: [],
    acknowledgedAgentIds: [],
    agentStates: [],
  }
}

function agentState(over: Partial<ControlCenterAgentState> & Pick<ControlCenterAgentState, 'agentId' | 'state'>): ControlCenterAgentState {
  return {
    agentId: over.agentId,
    name: over.name ?? over.agentId,
    kind: over.kind ?? 'claude',
    state: over.state,
    acknowledged: over.acknowledged ?? false,
    hasReport: over.hasReport ?? false,
    lastOutputAt: over.lastOutputAt,
    idleMs: over.idleMs,
    outputBytes: over.outputBytes,
    exitCode: over.exitCode,
  }
}

function ws(over: Partial<ControlCenterWorkspace> & Pick<ControlCenterWorkspace, 'workspaceId' | 'workspaceName'>): ControlCenterWorkspace {
  return {
    cwd: '/tmp/' + over.workspaceId,
    agents: { total: 0, running: 0, exited: 0, byKind: {} },
    lastRun: null,
    recentRuns: [],
    readiness: over.readiness ?? emptyReadiness(),
    reports: over.reports ?? [],
    staleThresholdMs: 600000,
    evidence: over.evidence ?? zeroEvidence(),
    ...over,
  }
}

function summary(workspaces: ControlCenterWorkspace[], nextActions: ControlCenterNextAction[] = []): ControlCenterSummaryResponse {
  return {
    generatedAt: '2026-05-10T08:00:00.000Z',
    workspaces,
    totals: {
      workspaces: workspaces.length,
      runningAgents: 0,
      exitedAgents: 0,
      activeRunCount: 0,
      partialRunCount: 0,
      failedRunCount: 0,
      succeededRunCount: 0,
      retryableFailedSpecCount: 0,
      reviewReadyAgentCount: 0,
      blockedAgentCount: 0,
      unknownExitAgentCount: 0,
      staleRunningAgentCount: 0,
      acknowledgedAgentCount: 0,
      unreadReportCount: 0,
      nextActionCount: nextActions.length,
      evidenceTotal: 0,
    },
    nextActions,
  }
}

describe('buildCeoControlCenterView', () => {
  it('buckets agent states into done / needs-approval / stuck / in-flight / starting', () => {
    const wsBox = ws({ workspaceId: 'ws1', workspaceName: 'Workbench' })
    wsBox.readiness.agentStates = [
      agentState({ agentId: 'a_done_acked', state: 'done', acknowledged: true, exitCode: 0 }),
      agentState({ agentId: 'b_done_unacked', state: 'done', acknowledged: false, exitCode: 0 }),
      agentState({ agentId: 'c_blocked', state: 'blocked', exitCode: 2 }),
      agentState({ agentId: 'd_stale', state: 'stale', idleMs: 720000, outputBytes: 12 }),
      agentState({ agentId: 'e_unknown', state: 'unknown_exit' }),
      agentState({ agentId: 'f_running', state: 'running', idleMs: 30000, outputBytes: 200 }),
      agentState({ agentId: 'g_starting', state: 'starting' }),
    ]
    const view = buildCeoControlCenterView({ summary: summary([wsBox]) })
    const w = view.workspaces[0]
    assert.deepEqual(w.done.map((r) => r.agentId), ['a_done_acked'])
    assert.deepEqual(w.needsApproval.map((r) => r.agentId), ['b_done_unacked'])
    assert.deepEqual(w.stuck.map((r) => [r.agentId, r.stuckReason]), [
      ['c_blocked', 'blocked'],
      ['d_stale', 'stale'],
      ['e_unknown', 'unknown_exit'],
    ])
    assert.deepEqual(w.inFlight.map((r) => r.agentId), ['f_running'])
    assert.deepEqual(w.starting.map((r) => r.agentId), ['g_starting'])
  })

  it('totals aggregate across workspaces', () => {
    const w1 = ws({ workspaceId: 'ws1', workspaceName: 'A' })
    w1.readiness.agentStates = [
      agentState({ agentId: 'x', state: 'done', acknowledged: false, exitCode: 0 }),
      agentState({ agentId: 'y', state: 'blocked', exitCode: 1 }),
    ]
    const w2 = ws({ workspaceId: 'ws2', workspaceName: 'B' })
    w2.readiness.agentStates = [
      agentState({ agentId: 'z', state: 'done', acknowledged: true, exitCode: 0 }),
      agentState({ agentId: 'q', state: 'running', idleMs: 0 }),
    ]
    const view = buildCeoControlCenterView({ summary: summary([w1, w2]) })
    assert.equal(view.totals.workspaces, 2)
    assert.equal(view.totals.done, 1)
    assert.equal(view.totals.needsApproval, 1)
    assert.equal(view.totals.stuck, 1)
    assert.equal(view.totals.inFlight, 1)
  })

  it('keeps starting separate from in-flight for compact UI rollups', () => {
    const w1 = ws({ workspaceId: 'ws1', workspaceName: 'A' })
    w1.readiness.agentStates = [
      agentState({ agentId: 'starting-one', state: 'starting' }),
      agentState({ agentId: 'running-one', state: 'running', idleMs: 1000 }),
    ]
    const view = buildCeoControlCenterView({ summary: summary([w1]) })
    assert.equal(view.totals.starting, 1)
    assert.equal(view.totals.inFlight, 1)
    assert.equal(view.workspaces[0].starting[0].agentId, 'starting-one')
    assert.equal(view.workspaces[0].inFlight[0].agentId, 'running-one')
  })

  it('attaches branch snapshot from gitByWorkspace and falls back to no-repo', () => {
    const w1 = ws({ workspaceId: 'ws1', workspaceName: 'Has Repo' })
    const w2 = ws({ workspaceId: 'ws2', workspaceName: 'No Repo' })
    const view = buildCeoControlCenterView({
      summary: summary([w1, w2]),
      gitByWorkspace: {
        ws1: { inRepo: true, branch: 'slice/x', dirty: 2, ahead: 1, behind: 0 },
      },
    })
    assert.equal(view.workspaces[0].branch.inRepo, true)
    assert.equal(view.workspaces[0].branch.branch, 'slice/x')
    assert.equal(view.workspaces[0].branch.dirty, 2)
    assert.equal(view.workspaces[0].branch.ahead, 1)
    assert.equal(view.workspaces[0].branch.clean, false)
    assert.equal(view.workspaces[1].branch.inRepo, false)
    assert.equal(view.workspaces[1].branch.clean, true)
  })

  it('picks the highest-severity next action per workspace', () => {
    const wsBox = ws({ workspaceId: 'ws1', workspaceName: 'Workbench' })
    const view = buildCeoControlCenterView({
      summary: summary([wsBox], [
        { kind: 'investigate', workspaceId: 'ws1', agentId: 'a', reason: 'blocked agent', derivedFrom: 'blockedAgentIds', severity: 3 },
        { kind: 'review', workspaceId: 'ws1', agentId: 'b', reason: 'review me', derivedFrom: 'reviewReadyAgentIds', severity: 2 },
        { kind: 'read_report', workspaceId: 'ws1', agentId: 'c', reportPath: '/r.md', reason: 'report ready', derivedFrom: 'reports.unread', severity: 1 },
      ]),
    })
    assert.equal(view.workspaces[0].nextAction?.severity, 3)
    assert.equal(view.workspaces[0].nextAction?.kind, 'investigate')
  })

  it('attaches lastOutput from agents map onto in-flight rows', () => {
    const wsBox = ws({ workspaceId: 'ws1', workspaceName: 'Workbench' })
    wsBox.readiness.agentStates = [
      agentState({ agentId: 'ag1', state: 'running', idleMs: 5000, outputBytes: 100, lastOutputAt: '2026-05-10T07:50:00.000Z' }),
    ]
    const view = buildCeoControlCenterView({
      summary: summary([wsBox]),
      agents: [
        { id: 'ag1', name: 'ag1', kind: 'claude', workspaceId: 'ws1', cwd: '/tmp', cmd: 'x', args: [], status: 'running', createdAt: '2026-05-10T07:00:00.000Z', lastOutput: 'tail of stdout', lastOutputAt: '2026-05-10T07:50:00.000Z' },
      ],
    })
    const row = view.workspaces[0].inFlight[0]
    assert.equal(row.lastOutput, 'tail of stdout')
    assert.equal(row.lastOutputAt, '2026-05-10T07:50:00.000Z')
  })

  it('surfaces last shipped time from the latest succeeded run', () => {
    const wsBox = ws({
      workspaceId: 'ws1',
      workspaceName: 'Workbench',
      recentRuns: [
        { runId: 'old', userPrompt: 'old', status: 'succeeded', actionCount: 0, spawnedAgentIds: [], failedSpecCount: 0, createdAt: '2026-05-10T05:00:00.000Z', updatedAt: '2026-05-10T05:30:00.000Z' },
        { runId: 'failed', userPrompt: 'failed', status: 'failed', actionCount: 0, spawnedAgentIds: [], failedSpecCount: 0, createdAt: '2026-05-10T06:00:00.000Z', updatedAt: '2026-05-10T07:00:00.000Z' },
        { runId: 'new', userPrompt: 'new', status: 'succeeded', actionCount: 0, spawnedAgentIds: [], failedSpecCount: 0, createdAt: '2026-05-10T06:00:00.000Z', updatedAt: '2026-05-10T06:45:00.000Z' },
      ],
    })
    const view = buildCeoControlCenterView({ summary: summary([wsBox]) })
    assert.equal(view.workspaces[0].lastShippedAt, '2026-05-10T06:45:00.000Z')
  })

  it('counts test evidence per workspace and surfaces unread reports', () => {
    const ev = zeroEvidence()
    ev.byKind.test = 3
    ev.total = 3
    const wsBox = ws({ workspaceId: 'ws1', workspaceName: 'Workbench', evidence: ev, reports: [
      { path: '/r1.md', kind: 'markdown', mtime: '2026-05-10T07:00:00.000Z', sizeBytes: 1, unread: true },
      { path: '/r2.md', kind: 'markdown', mtime: '2026-05-10T07:00:00.000Z', sizeBytes: 1, unread: false },
    ] })
    const view = buildCeoControlCenterView({ summary: summary([wsBox]) })
    assert.equal(view.workspaces[0].tests.evidenceCount, 3)
    assert.equal(view.workspaces[0].reportsUnread, 1)
  })

  it('builds CEO dashboard rows with counts, latest output, task, report path, and close/recycle action', () => {
    const wsBox = ws({ workspaceId: 'ws1', workspaceName: 'Workbench', agents: { total: 3, running: 1, exited: 2, byKind: { codex: 3 } }, reports: [
      { path: '/tmp/reports/forge.md', agentId: 'done-agent', kind: 'markdown', mtime: '2026-05-10T07:10:00.000Z', sizeBytes: 10, unread: true },
      { path: '/tmp/reports/stuck.md', agentId: 'stuck-agent', kind: 'markdown', mtime: '2026-05-10T07:00:00.000Z', sizeBytes: 10, unread: true },
    ] })
    wsBox.readiness.agentStates = [
      agentState({ agentId: 'run-agent', name: 'Runner', kind: 'codex', state: 'running', idleMs: 5000, outputBytes: 100, lastOutputAt: '2026-05-10T07:50:00.000Z' }),
      agentState({ agentId: 'done-agent', name: 'Forge', kind: 'codex', state: 'done', acknowledged: false, exitCode: 0 }),
      agentState({ agentId: 'stuck-agent', name: 'Shield', kind: 'codex', state: 'blocked', exitCode: 2 }),
    ]
    const view = buildCeoControlCenterView({
      summary: summary([wsBox]),
      agents: [
        { id: 'run-agent', name: 'Runner', kind: 'codex', workspaceId: 'ws1', cwd: '/tmp', cmd: 'x', args: [], status: 'running', createdAt: '2026-05-10T07:00:00.000Z', taskId: 'task-run', lastOutput: 'still checking tests', lastOutputAt: '2026-05-10T07:50:00.000Z' },
        { id: 'done-agent', name: 'Forge', kind: 'codex', workspaceId: 'ws1', cwd: '/tmp', cmd: 'x', args: [], status: 'exited', exitCode: 0, createdAt: '2026-05-10T07:00:00.000Z', taskId: 'task-done', lastOutput: 'wrote final report' },
        { id: 'stuck-agent', name: 'Shield', kind: 'codex', workspaceId: 'ws1', cwd: '/tmp', cmd: 'x', args: [], status: 'exited', exitCode: 2, createdAt: '2026-05-10T07:00:00.000Z', lastOutput: 'typecheck failed' },
      ],
      tasks: [
        { id: 'task-run', workspaceId: 'ws1', title: 'Run checks', status: 'building', createdAt: '2026-05-10T06:00:00.000Z', updatedAt: '2026-05-10T07:00:00.000Z' },
        { id: 'task-done', workspaceId: 'ws1', title: 'Build dashboard slice', status: 'review', createdAt: '2026-05-10T06:00:00.000Z', updatedAt: '2026-05-10T07:00:00.000Z' },
      ],
    })
    const workspace = view.workspaces[0]
    assert.deepEqual(workspace.agentCounts, { running: 1, exited: 2, completed: 1 })
    assert.deepEqual(workspace.agentRows.map((row) => [row.agentId, row.currentTask?.title ?? null, row.reportPath ?? null, row.lifecycleAction]), [
      ['done-agent', 'Build dashboard slice', '/tmp/reports/forge.md', 'close'],
      ['run-agent', 'Run checks', null, 'none'],
      ['stuck-agent', null, '/tmp/reports/stuck.md', 'recycle'],
    ])
    assert.equal(workspace.agentRows.find((row) => row.agentId === 'run-agent')?.lastOutput, 'still checking tests')
  })
})

describe('renderCeoWorkspaceLine', () => {
  it('renders a deterministic Telegram-safe one-liner with branch, counts, and next action', () => {
    const wsBox = ws({ workspaceId: 'ws1', workspaceName: 'Workbench' })
    wsBox.readiness.agentStates = [
      agentState({ agentId: 'a', state: 'done', acknowledged: false, exitCode: 0 }),
      agentState({ agentId: 'b', state: 'blocked', exitCode: 2 }),
    ]
    const view = buildCeoControlCenterView({
      summary: summary([wsBox], [
        { kind: 'investigate', workspaceId: 'ws1', agentId: 'b', reason: 'b (codex) exited with code 2', derivedFrom: 'blockedAgentIds', severity: 3 },
      ]),
      gitByWorkspace: { ws1: { inRepo: true, branch: 'slice/x', dirty: 0, ahead: 0, behind: 0, untracked: 0 } },
    })
    const line = renderCeoWorkspaceLine(view.workspaces[0])
    assert.match(line, /^Workbench /);
    assert.match(line, /branch slice\/x, clean/);
    assert.match(line, /done 0, needs-approval 1, stuck 1, in-flight 0/);
    assert.match(line, /next: b \(codex\) exited with code 2/);
  })

  it('renders dirty/ahead/behind branch state as ASCII text', () => {
    const wsBox = ws({ workspaceId: 'ws1', workspaceName: 'Workbench' })
    const view = buildCeoControlCenterView({
      summary: summary([wsBox]),
      gitByWorkspace: { ws1: { inRepo: true, branch: 'slice/y', dirty: 2, ahead: 1, behind: 3, untracked: 4 } },
    })
    const line = renderCeoWorkspaceLine(view.workspaces[0])
    assert.match(line, /^Workbench - branch slice\/y, ahead 1, behind 3, 2 dirty, 4 untracked/)
    assert.doesNotMatch(line, /[^\x00-\x7F]/)
  })
})

describe('CEO controlCenter UI helpers', () => {
  it('suppresses branch labels when git data is unavailable', () => {
    const wsBox = ws({ workspaceId: 'ws1', workspaceName: 'Workbench' })
    const view = buildCeoControlCenterView({ summary: summary([wsBox]) })
    assert.equal(renderCeoBranchLabel(view.workspaces[0]), null)
  })

  it('renders branch and shipped time labels for compact UI chips', () => {
    const wsBox = ws({ workspaceId: 'ws1', workspaceName: 'Workbench' })
    const view = buildCeoControlCenterView({
      summary: summary([wsBox]),
      gitByWorkspace: { ws1: { inRepo: true, branch: 'slice/y', dirty: 2, ahead: 1, behind: 0, untracked: 0 } },
    })
    assert.equal(renderCeoBranchLabel(view.workspaces[0]), 'slice/y ahead 1, 2 dirty')
    assert.equal(formatCeoShippedAtCt('2026-05-10T06:45:00.000Z'), 'shipped 01:45 CT')
  })
})
