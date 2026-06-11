import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { buildControlCenterSummary, type ControlCenterSummaryResponse } from '../lib/control-center-summary'
import { detectControlCenterReports, readControlCenterReports } from '../lib/control-center-continuity'
import { applyControlCenterAgentAcknowledgement, controlCenterReportCount, getControlCenterActionGroups, getControlCenterWorkspaceMatrix } from '../lib/control-center-ui-state'
import type { Agent, Workspace } from '../lib/types'

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
    createdAt: '2026-05-09T11:00:00.000Z',
  }
}

function workspace(id: string, name: string, cwd = `/tmp/${id}`): Workspace {
  return { id, name, cwd, createdAt: new Date(0).toISOString() }
}

function withTempControlCenterStore<T>(fn: (dir: string) => T): T {
  const prev = process.env.AW_CONTROL_CENTER_STATE_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-controlCenter-final-'))
  process.env.AW_CONTROL_CENTER_STATE_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) delete process.env.AW_CONTROL_CENTER_STATE_DIR
    else process.env.AW_CONTROL_CENTER_STATE_DIR = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function expectSummary(value: ReturnType<typeof buildControlCenterSummary>): ControlCenterSummaryResponse {
  assert.equal('error' in value, false)
  if ('error' in value) throw new Error(value.error)
  return value
}

describe('controlCenter continuity final gate', () => {
  it('orders nextActions by severity, workspace name, source id, report path, then kind', () => {
    const summary = expectSummary(buildControlCenterSummary({
      workspaces: [
        workspace('ws_b', 'Beta'),
        workspace('ws_a', 'Alpha'),
      ],
      agents: [
        { ...agent('b_block', 'codex', 'ws_b', 'exited'), exitCode: 1 },
        { ...agent('a_block', 'codex', 'ws_a', 'exited'), exitCode: 1 },
        { ...agent('z_ready', 'claude', 'ws_a', 'exited'), exitCode: 0 },
        { ...agent('a_ready', 'claude', 'ws_a', 'exited'), exitCode: 0 },
        { ...agent('stale', 'shell', 'ws_b'), lastOutputAt: '2026-05-09T11:00:00.000Z' },
      ],
      now: '2026-05-09T12:00:00.000Z',
      reports: [
        { workspaceId: 'ws_b', path: '/tmp/b/z.md', kind: 'markdown', mtime: '2026-05-09T12:00:00.000Z', sizeBytes: 1, unread: true },
        { workspaceId: 'ws_a', path: '/tmp/a/a.md', kind: 'markdown', mtime: '2026-05-09T12:00:00.000Z', sizeBytes: 1, unread: true },
      ],
    }))

    assert.deepEqual(summary.nextActions.map((action) => [
      action.severity,
      action.workspaceId,
      action.agentId ?? action.reportPath,
      action.kind,
    ]), [
      [3, 'ws_a', 'a_block', 'investigate'],
      [3, 'ws_b', 'b_block', 'investigate'],
      [2, 'ws_a', 'a_ready', 'review'],
      [2, 'ws_a', 'z_ready', 'review'],
      [2, 'ws_b', 'stale', 'wake'],
      [1, 'ws_a', '/tmp/a/a.md', 'read_report'],
      [1, 'ws_b', '/tmp/b/z.md', 'read_report'],
    ])
    assert.equal(summary.totals.nextActionCount, summary.nextActions.length)
  })

  it('applies stale pane threshold at the exact boundary and falls back to createdAt', () => {
    const summary = expectSummary(buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench')],
      agents: [
        { ...agent('exact', 'codex'), lastOutputAt: '2026-05-09T11:59:00.000Z' },
        { ...agent('fresh', 'codex'), lastOutputAt: '2026-05-09T11:59:00.001Z' },
        { ...agent('created_fallback', 'shell'), createdAt: '2026-05-09T11:58:59.000Z' },
      ],
      now: '2026-05-09T12:00:00.000Z',
      staleThresholdMs: 60_000,
    }))

    assert.deepEqual(summary.workspaces[0].readiness.staleRunningAgentIds, ['exact', 'created_fallback'])
    assert.deepEqual(summary.nextActions.map((action) => action.agentId), ['created_fallback', 'exact'])
  })

  it('persists report-ready rows after the attributed agent disappears', () => withTempControlCenterStore(() => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-report-ws-'))
    try {
      const reportPath = path.join(cwd, 'WORK_REPORT.md')
      fs.writeFileSync(reportPath, '# Report\n')
      const mtime = new Date()
      fs.utimesSync(reportPath, mtime, mtime)

      const ws = workspace('ws1', 'Workbench', cwd)
      const writer = { ...agent('ag_writer', 'claude', 'ws1'), lastOutputAt: mtime.toISOString() }
      const first = detectControlCenterReports([ws], [writer])
      assert.equal(first[0]?.agentId, 'ag_writer')

      const second = detectControlCenterReports([ws], [])
      assert.equal(second[0]?.agentId, 'ag_writer')
      assert.deepEqual(readControlCenterReports().map((report) => report.agentId), ['ag_writer'])

      const summary = expectSummary(buildControlCenterSummary({
        workspaces: [ws],
        agents: [],
        reports: second,
      }))
      assert.equal(summary.workspaces[0].reports[0].agentId, 'ag_writer')
      assert.deepEqual(summary.nextActions.map((action) => [action.kind, action.reportPath]), [['read_report', reportPath]])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }))

  it('updates controlCenter drawer state after acknowledgement without removing panes or non-ack actions', () => {
    const summary = expectSummary(buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench')],
      agents: [
        { ...agent('ag_ready', 'claude', 'ws1', 'exited'), exitCode: 0 },
        agent('ag_unknown', 'codex', 'ws1', 'exited'),
        { ...agent('ag_blocked', 'shell', 'ws1', 'exited'), exitCode: 2 },
      ],
    }))
    assert.deepEqual(getControlCenterActionGroups(summary).map((group) => group.actions.length), [3])

    const afterReadyAck = applyControlCenterAgentAcknowledgement(summary, 'ws1', 'ag_ready')
    assert.deepEqual(afterReadyAck.workspaces[0].readiness.acknowledgedAgentIds, ['ag_ready'])
    assert.deepEqual(afterReadyAck.nextActions.map((action) => [action.kind, action.agentId]), [
      ['investigate', 'ag_blocked'],
      ['ack_or_clear', 'ag_unknown'],
    ])
    assert.equal(afterReadyAck.totals.acknowledgedAgentCount, 1)
    assert.equal(afterReadyAck.totals.nextActionCount, 2)
    assert.equal(afterReadyAck.totals.exitedAgents, 3)

    const afterUnknownAck = applyControlCenterAgentAcknowledgement(afterReadyAck, 'ws1', 'ag_unknown')
    assert.deepEqual(afterUnknownAck.nextActions.map((action) => [action.kind, action.agentId]), [
      ['investigate', 'ag_blocked'],
    ])
    assert.equal(afterUnknownAck.totals.acknowledgedAgentCount, 2)
  })

  it('computes disclosure report counts from visible report rows', () => {
    const summary = expectSummary(buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench'), workspace('ws2', 'Sitework')],
      agents: [],
      reportsLimit: 1,
      reports: [
        { workspaceId: 'ws1', path: '/tmp/ws1/a.md', kind: 'markdown', mtime: '2026-05-09T12:00:00.000Z', sizeBytes: 1, unread: true },
        { workspaceId: 'ws1', path: '/tmp/ws1/b.md', kind: 'markdown', mtime: '2026-05-09T11:00:00.000Z', sizeBytes: 1, unread: true },
        { workspaceId: 'ws2', path: '/tmp/ws2/a.md', kind: 'markdown', mtime: '2026-05-09T12:00:00.000Z', sizeBytes: 1, unread: false },
      ],
    }))

    assert.equal(controlCenterReportCount(summary), 2)
    assert.equal(summary.totals.unreadReportCount, 1)
    assert.deepEqual(getControlCenterWorkspaceMatrix(summary).map((row) => [
      row.workspace.workspaceId,
      row.health,
      row.unreadReportCount,
      row.kindSummary,
    ]), [
      ['ws2', 'clean', 0, 'no agents'],
      ['ws1', 'attention', 1, 'no agents'],
    ])
  })

  it("getControlCenterWorkspaceMatrix carries evidenceTotal from workspace.evidence", () => {
    const summary = expectSummary(buildControlCenterSummary({
      workspaces: [workspace('ws1', 'Workbench'), workspace('ws2', 'Sitework')],
      agents: [],
      evidenceByWorkspace: {
        ws1: { total: 5, byKind: { report: 2, test: 2, diff: 1, review: 0, manual_override: 0, commit_approval: 0, push_approval: 0 } },
      },
    }))
    const matrix = getControlCenterWorkspaceMatrix(summary)
    const ws1Row = matrix.find((r) => r.workspace.workspaceId === 'ws1')!
    const ws2Row = matrix.find((r) => r.workspace.workspaceId === 'ws2')!
    assert.equal(ws1Row.evidenceTotal, 5)
    assert.equal(ws2Row.evidenceTotal, 0)
  })
})
