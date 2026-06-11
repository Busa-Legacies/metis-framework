import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { convertControlCenterToRollup } from '../lib/control-center-to-rollup'
import {
  assertTelegramSafe,
  renderPortfolioForTelegram,
} from '../lib/portfolio-render'
import type {
  ControlCenterLastRunSummary,
  ControlCenterNextAction,
  ControlCenterReportEntry,
  ControlCenterSummaryResponse,
  ControlCenterWorkspace,
  ControlCenterWorkspaceReadiness,
} from '../lib/control-center-summary'
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

function ws(overrides: Partial<ControlCenterWorkspace> & Pick<ControlCenterWorkspace, 'workspaceId' | 'workspaceName'>): ControlCenterWorkspace {
  return {
    cwd: `/tmp/${overrides.workspaceId}`,
    agents: { total: 0, running: 0, exited: 0, byKind: {} },
    lastRun: null,
    recentRuns: [],
    readiness: emptyReadiness(),
    reports: [],
    staleThresholdMs: 600_000,
    evidence: zeroEvidence(),
    ...overrides,
  }
}

function run(
  runId: string,
  status: ControlCenterLastRunSummary['status'],
  updatedAt: string,
): ControlCenterLastRunSummary {
  return {
    runId,
    status,
    createdAt: updatedAt,
    updatedAt,
    userPrompt: 'test',
    actionCount: 1,
    spawnedAgentIds: [],
    failedSpecCount: 0,
  }
}

function report(path: string, unread: boolean, mtime = '2026-05-09T17:00:00.000Z'): ControlCenterReportEntry {
  return { path, kind: 'markdown', mtime, sizeBytes: 100, unread }
}

function summary(
  workspaces: ControlCenterWorkspace[],
  nextActions: ControlCenterNextAction[] = [],
  generatedAt = '2026-05-09T17:00:00.000Z',
): ControlCenterSummaryResponse {
  return {
    generatedAt,
    workspaces,
    nextActions,
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
  }
}

describe('convertControlCenterToRollup', () => {
  it('handles an empty controlCenter summary (no workspaces)', () => {
    const rollup = convertControlCenterToRollup(summary([]))
    assert.equal(rollup.generatedAt, '2026-05-09T17:00:00.000Z')
    assert.deepEqual(rollup.workspaces, [])
    const text = renderPortfolioForTelegram(rollup)
    assert.equal(text, 'No workspaces tracked.')
    assertTelegramSafe(text)
  })

  it('maps an all-clean workspace with no actions or runs', () => {
    const rollup = convertControlCenterToRollup(
      summary([ws({ workspaceId: 'wb', workspaceName: 'Workbench' })]),
    )
    assert.equal(rollup.workspaces.length, 1)
    const w = rollup.workspaces[0]
    assert.equal(w.workspaceId, 'wb')
    assert.equal(w.name, 'Workbench')
    assert.equal(w.inFlightAgents, 0)
    assert.equal(w.lastShipped, null)
    assert.equal(w.nextAction, null)
    assert.deepEqual(w.evidenceCounts, { reportsUnread: 0, reviewsOpen: 0, manualOverrides: 0 })
    assert.deepEqual(w.sync, {
      inRepo: true,
      branch: null,
      ahead: 0,
      behind: 0,
      dirtyCount: 0,
      untrackedCount: 0,
    })
    const text = renderPortfolioForTelegram(rollup)
    assert.equal(text, 'Workbench — clean, no agents in flight. Next: nothing pending.')
    assertTelegramSafe(text)
  })

  it('maps a mixed-state portfolio (review-ready + blocked + read_report) and picks highest-severity next action', () => {
    const wbReadiness = emptyReadiness()
    wbReadiness.reviewReadyAgentIds = ['forge-1']
    wbReadiness.acknowledgedAgentIds = ['forge-2']

    const reosReadiness = emptyReadiness()
    reosReadiness.blockedAgentIds = ['scout-7']

    const summaryValue = summary(
      [
        ws({
          workspaceId: 'wb',
          workspaceName: 'Workbench',
          agents: { total: 3, running: 0, exited: 3, byKind: { forge: 3 } },
          readiness: wbReadiness,
          recentRuns: [
            run('r2', 'succeeded', '2026-05-09T16:30:00.000Z'),
            run('r1', 'succeeded', '2026-05-09T15:00:00.000Z'),
          ],
          reports: [report('reports/forge-1.md', true), report('reports/old.md', false)],
        }),
        ws({
          workspaceId: 'reos',
          workspaceName: 'REOS',
          agents: { total: 2, running: 1, exited: 1, byKind: { scout: 2 } },
          readiness: reosReadiness,
          recentRuns: [run('r9', 'failed', '2026-05-09T14:00:00.000Z')],
        }),
      ],
      [
        {
          kind: 'review',
          workspaceId: 'wb',
          agentId: 'forge-1',
          reason: 'forge-1 (forge) exited cleanly with code 0',
          derivedFrom: 'reviewReadyAgentIds',
          severity: 2,
        },
        {
          kind: 'read_report',
          workspaceId: 'wb',
          agentId: 'forge-1',
          reportPath: 'reports/forge-1.md',
          reason: 'forge-1.md is ready to read',
          derivedFrom: 'reports.unread',
          severity: 1,
        },
        {
          kind: 'investigate',
          workspaceId: 'reos',
          agentId: 'scout-7',
          reason: 'scout-7 (scout) exited with code 1',
          derivedFrom: 'blockedAgentIds',
          severity: 3,
        },
      ],
    )

    const rollup = convertControlCenterToRollup(summaryValue)
    assert.equal(rollup.workspaces.length, 2)

    const wb = rollup.workspaces.find((w) => w.workspaceId === 'wb')!
    assert.equal(wb.inFlightAgents, 0)
    assert.equal(wb.lastShipped, '2026-05-09T16:30:00.000Z')
    assert.equal(wb.nextAction, 'forge-1 (forge) exited cleanly with code 0')
    assert.deepEqual(wb.evidenceCounts, {
      reportsUnread: 1,
      reviewsOpen: 1,
      manualOverrides: 1,
    })

    const reos = rollup.workspaces.find((w) => w.workspaceId === 'reos')!
    assert.equal(reos.inFlightAgents, 1)
    assert.equal(reos.lastShipped, null)
    assert.equal(reos.nextAction, 'scout-7 (scout) exited with code 1')
    assert.deepEqual(reos.evidenceCounts, {
      reportsUnread: 0,
      reviewsOpen: 0,
      manualOverrides: 0,
    })

    const text = renderPortfolioForTelegram(rollup)
    assertTelegramSafe(text)
    const lines = text.split('\n')
    assert.equal(lines.length, 2)
    assert.equal(
      lines[0],
      'REOS — clean, 1 agent in flight. Next: scout-7 (scout) exited with code 1.',
    )
    assert.equal(
      lines[1],
      'Workbench — clean, no agents in flight, 1 unread report, last shipped 2026-05-09T16:30:00.000Z. Next: forge-1 (forge) exited cleanly with code 0.',
    )
  })

  it('surfaces an in-flight workspace with a stale-running wake action', () => {
    const readiness = emptyReadiness()
    readiness.staleRunningAgentIds = ['forge-stuck']
    readiness.staleRunningAgents = [
      {
        agentId: 'forge-stuck',
        idleMs: 1_800_000,
        lastOutputAt: '2026-05-09T15:00:00.000Z',
        outputBytes: 4096,
        hasReport: false,
      },
    ]
    const summaryValue = summary(
      [
        ws({
          workspaceId: 'reos',
          workspaceName: 'REOS',
          agents: { total: 2, running: 2, exited: 0, byKind: { forge: 2 } },
          readiness,
          recentRuns: [run('r1', 'running', '2026-05-09T16:45:00.000Z')],
        }),
      ],
      [
        {
          kind: 'wake',
          workspaceId: 'reos',
          agentId: 'forge-stuck',
          reason: 'forge-stuck (forge) idle 30m; output 4096 bytes; no report artifact',
          derivedFrom: 'staleRunningAgentIds',
          severity: 2,
        },
      ],
    )

    const rollup = convertControlCenterToRollup(summaryValue)
    assert.equal(rollup.workspaces.length, 1)
    const w = rollup.workspaces[0]
    assert.equal(w.inFlightAgents, 2)
    assert.equal(w.lastShipped, null)
    assert.equal(
      w.nextAction,
      'forge-stuck (forge) idle 30m; output 4096 bytes; no report artifact',
    )
    const text = renderPortfolioForTelegram(rollup)
    assert.equal(
      text,
      'REOS — clean, 2 agents in flight. Next: forge-stuck (forge) idle 30m; output 4096 bytes; no report artifact.',
    )
    assertTelegramSafe(text)
  })

  it('honors a syncByWorkspace override for sync state', () => {
    const summaryValue = summary([ws({ workspaceId: 'wb', workspaceName: 'Workbench' })])
    const rollup = convertControlCenterToRollup(summaryValue, {
      syncByWorkspace: {
        wb: {
          inRepo: true,
          branch: 'slice/controlCenter-rollup-adapter',
          ahead: 1,
          behind: 0,
          dirtyCount: 2,
          untrackedCount: 0,
        },
      },
    })
    assert.deepEqual(rollup.workspaces[0].sync, {
      inRepo: true,
      branch: 'slice/controlCenter-rollup-adapter',
      ahead: 1,
      behind: 0,
      dirtyCount: 2,
      untrackedCount: 0,
    })
    const text = renderPortfolioForTelegram(rollup)
    assertTelegramSafe(text)
    assert.equal(
      text,
      'Workbench — branch slice/controlCenter-rollup-adapter, 1 ahead, 0 behind, 2 dirty, no agents in flight. Next: nothing pending.',
    )
  })

  it('produces a deterministic rollup for the same input (byte-equal JSON)', () => {
    const wbReadiness = emptyReadiness()
    wbReadiness.reviewReadyAgentIds = ['a']
    const summaryValue = summary(
      [ws({ workspaceId: 'wb', workspaceName: 'Workbench', readiness: wbReadiness })],
      [
        {
          kind: 'review',
          workspaceId: 'wb',
          agentId: 'a',
          reason: 'a (forge) exited cleanly with code 0',
          derivedFrom: 'reviewReadyAgentIds',
          severity: 2,
        },
      ],
    )
    const first = JSON.stringify(convertControlCenterToRollup(summaryValue))
    const second = JSON.stringify(convertControlCenterToRollup(summaryValue))
    assert.equal(first, second)
  })
})
