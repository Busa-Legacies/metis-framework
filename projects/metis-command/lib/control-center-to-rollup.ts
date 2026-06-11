/**
 * ControlCenter-summary → PortfolioRollup adapter.
 *
 * Pure function: maps the operational `ControlCenterSummaryResponse` produced by
 * `buildControlCenterSummary` into the `PortfolioRollup` shape consumed by the
 * Telegram-safe renderer (`lib/portfolio-render.ts`). No fs, no network, no PTY.
 *
 * Sync info (git ahead/behind/dirty) is not present in Control Center summary; callers
 * may pass a `syncByWorkspace` map sourced from a future Sync-Status endpoint.
 * When absent, sync defaults to in-repo + clean (the renderer surfaces "clean").
 */

import type {
  ControlCenterNextAction,
  ControlCenterSummaryResponse,
  ControlCenterWorkspace,
} from './control-center-summary'
import type {
  PortfolioRollup,
  PortfolioSyncSnapshot,
  PortfolioWorkspaceRollup,
} from './portfolio-render'

export interface ControlCenterToRollupOptions {
  syncByWorkspace?: Record<string, PortfolioSyncSnapshot>
}

const DEFAULT_SYNC: PortfolioSyncSnapshot = {
  inRepo: true,
  branch: null,
  ahead: 0,
  behind: 0,
  dirtyCount: 0,
  untrackedCount: 0,
}

function findLastShipped(workspace: ControlCenterWorkspace): string | null {
  let latest: string | null = null
  for (const run of workspace.recentRuns) {
    if (run.status !== 'succeeded') continue
    if (latest === null || run.updatedAt > latest) latest = run.updatedAt
  }
  return latest
}

function deriveNextAction(actions: ControlCenterNextAction[]): string | null {
  if (actions.length === 0) return null
  const sorted = [...actions].sort((a, b) => {
    if (a.severity !== b.severity) return b.severity - a.severity
    return (
      a.kind.localeCompare(b.kind) ||
      (a.agentId ?? '').localeCompare(b.agentId ?? '') ||
      (a.reportPath ?? '').localeCompare(b.reportPath ?? '')
    )
  })
  return sorted[0].reason
}

export function convertControlCenterToRollup(
  summary: ControlCenterSummaryResponse,
  options: ControlCenterToRollupOptions = {},
): PortfolioRollup {
  const syncOverrides = options.syncByWorkspace ?? {}
  const workspaces: PortfolioWorkspaceRollup[] = summary.workspaces.map((workspace) => {
    const wsActions = summary.nextActions.filter((a) => a.workspaceId === workspace.workspaceId)
    const sync = syncOverrides[workspace.workspaceId] ?? DEFAULT_SYNC
    const reportsUnread = workspace.reports.filter((report) => report.unread).length
    return {
      workspaceId: workspace.workspaceId,
      name: workspace.workspaceName,
      sync,
      inFlightAgents: workspace.agents.running,
      lastShipped: findLastShipped(workspace),
      nextAction: deriveNextAction(wsActions),
      evidenceCounts: {
        reportsUnread,
        reviewsOpen: workspace.readiness.reviewReadyAgentIds.length,
        manualOverrides: workspace.readiness.acknowledgedAgentIds.length,
      },
    }
  })
  return {
    generatedAt: summary.generatedAt,
    workspaces,
  }
}
