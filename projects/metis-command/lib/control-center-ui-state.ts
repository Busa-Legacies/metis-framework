import type { ControlCenterNextAction, ControlCenterSummaryResponse, ControlCenterWorkspace } from './control-center-summary'

export interface ControlCenterActionGroup {
  workspace: ControlCenterWorkspace
  actions: ControlCenterNextAction[]
}

export type ControlCenterWorkspaceHealth = 'blocked' | 'attention' | 'active' | 'clean' | 'empty'

export interface ControlCenterWorkspaceMatrixRow {
  workspace: ControlCenterWorkspace
  actions: ControlCenterNextAction[]
  health: ControlCenterWorkspaceHealth
  unreadReportCount: number
  attentionCount: number
  kindSummary: string
  latestUnreadReportPath?: string
  evidenceTotal: number
}

export type ControlCenterPaneStateKind = 'stale' | 'report-ready' | 'acked'

export interface ControlCenterPaneState {
  kind: ControlCenterPaneStateKind
  label: string
}

export function getControlCenterActionGroups(summary: ControlCenterSummaryResponse): ControlCenterActionGroup[] {
  return summary.workspaces.map((workspace) => ({
    workspace,
    actions: summary.nextActions.filter((action) => action.workspaceId === workspace.workspaceId),
  })).filter((row) => row.actions.length > 0)
}

export function controlCenterWorkspaceHealth(workspace: ControlCenterWorkspace): ControlCenterWorkspaceHealth {
  if (workspace.readiness.blockedAgentIds.length > 0 || workspace.readiness.failedRunCount > 0) return 'blocked'
  if (
    workspace.readiness.staleRunningAgentIds.length > 0 ||
    workspace.readiness.reviewReadyAgentIds.length > 0 ||
    workspace.readiness.unknownExitAgentIds.length > 0 ||
    workspace.readiness.retryableFailedSpecCount > 0 ||
    workspace.reports.some((report) => report.unread)
  ) return 'attention'
  if (workspace.agents.running > 0 || workspace.readiness.activeRunCount > 0) return 'active'
  if (workspace.agents.total > 0 || workspace.lastRun || workspace.reports.length > 0) return 'clean'
  return 'empty'
}

export function controlCenterKindSummary(workspace: ControlCenterWorkspace): string {
  const rows = Object.entries(workspace.agents.byKind).sort(([a], [b]) => a.localeCompare(b))
  if (rows.length === 0) return 'no agents'
  return rows.map(([kind, count]) => `${count} ${kind}`).join(' / ')
}

export function getControlCenterWorkspaceMatrix(summary: ControlCenterSummaryResponse): ControlCenterWorkspaceMatrixRow[] {
  return summary.workspaces.map((workspace) => {
    const actions = summary.nextActions.filter((action) => action.workspaceId === workspace.workspaceId)
    const unreadReports = workspace.reports.filter((report) => report.unread)
    const attentionCount = workspace.readiness.blockedAgentIds.length +
      workspace.readiness.staleRunningAgentIds.length +
      workspace.readiness.reviewReadyAgentIds.length +
      workspace.readiness.unknownExitAgentIds.length +
      workspace.readiness.retryableFailedSpecCount +
      unreadReports.length
    return {
      workspace,
      actions,
      health: controlCenterWorkspaceHealth(workspace),
      unreadReportCount: unreadReports.length,
      attentionCount,
      kindSummary: controlCenterKindSummary(workspace),
      latestUnreadReportPath: unreadReports[0]?.path,
      evidenceTotal: workspace.evidence.total,
    }
  })
}

export function controlCenterPaneStates(workspace: ControlCenterWorkspace | null | undefined, agentId: string | null | undefined): ControlCenterPaneState[] {
  if (!workspace || !agentId) return []
  const states: ControlCenterPaneState[] = []
  if (workspace.readiness.staleRunningAgentIds.includes(agentId)) {
    const stale = workspace.readiness.staleRunningAgents?.find((row) => row.agentId === agentId)
    states.push({ kind: 'stale', label: stale ? `stale ${formatPaneIdle(stale.idleMs)}` : 'stale' })
  }
  if (workspace.reports.some((report) => report.agentId === agentId && report.unread)) {
    states.push({ kind: 'report-ready', label: 'report ready' })
  }
  if (workspace.readiness.acknowledgedAgentIds.includes(agentId)) {
    states.push({ kind: 'acked', label: "ack'd" })
  }
  return states
}

function formatPaneIdle(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function controlCenterReportCount(summary: ControlCenterSummaryResponse): number {
  return summary.workspaces.reduce((sum, workspace) => sum + workspace.reports.length, 0)
}

export function applyControlCenterAgentAcknowledgement(
  summary: ControlCenterSummaryResponse,
  workspaceId: string,
  agentId: string,
): ControlCenterSummaryResponse {
  let addedAck = false
  const workspaces = summary.workspaces.map((workspace) => {
    if (workspace.workspaceId !== workspaceId) return workspace
    if (workspace.readiness.acknowledgedAgentIds.includes(agentId)) return workspace
    addedAck = true
    return {
      ...workspace,
      readiness: {
        ...workspace.readiness,
        acknowledgedAgentIds: [...workspace.readiness.acknowledgedAgentIds, agentId],
      },
    }
  })

  const nextActions = summary.nextActions.filter((action) => {
    if (action.workspaceId !== workspaceId || action.agentId !== agentId) return true
    return action.kind !== 'review' && action.kind !== 'ack_or_clear'
  })

  return {
    ...summary,
    workspaces,
    totals: {
      ...summary.totals,
      acknowledgedAgentCount: summary.totals.acknowledgedAgentCount + (addedAck ? 1 : 0),
      nextActionCount: nextActions.length,
    },
    nextActions,
  }
}
