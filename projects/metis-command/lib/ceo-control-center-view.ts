/**
 * CEO/PMA overnight supervision view-model.
 *
 * Pure function: derives a CEO-shaped digest (done / stuck / needs-approval /
 * in-flight, plus branch, last-output, next-action, evidence counts) from
 * the existing operational primitives.
 *
 * Inputs are passed in - no fs, no network, no PTY, no API call. Output is
 * deterministic for a given input. Designed to be consumed by:
 *   - the assistant Control Center drawer (UI),
 *   - a future overnight digest endpoint,
 *   - read-only assistant tooling for low-token supervisor checks.
 */

import type {
  ControlCenterAgentState,
  ControlCenterNextAction,
  ControlCenterSummaryResponse,
  ControlCenterWorkspace,
} from './control-center-summary'
import type { Agent, AgentKind, Task } from './types'

export type CeoBucket =
  | 'done'
  | 'needs_approval'
  | 'stuck'
  | 'in_flight'
  | 'starting'

export type CeoStuckReason = 'blocked' | 'stale' | 'unknown_exit'
export type CeoLifecycleAction = 'none' | 'close' | 'recycle'

export interface CeoCurrentTask {
  taskId: string
  title: string
  status: Task['status']
}

export interface CeoAgentRow {
  agentId: string
  name: string
  kind: AgentKind
  bucket: CeoBucket
  state: ControlCenterAgentState['state']
  acknowledged: boolean
  hasReport: boolean
  stuckReason?: CeoStuckReason
  idleMs?: number
  outputBytes?: number
  exitCode?: number
  lastOutput?: string
  lastOutputAt?: string
  currentTask?: CeoCurrentTask
  reportPath?: string
  lifecycleAction: CeoLifecycleAction
}

export interface CeoWorkspaceAgentCounts {
  running: number
  exited: number
  completed: number
}

export interface CeoBranchSnapshot {
  inRepo: boolean
  branch: string | null
  ahead: number
  behind: number
  dirty: number
  untracked: number
  clean: boolean
}

export interface CeoBudget {
  kind: 'unknown' | 'tokens' | 'usd'
  value?: number
  note?: string
}

export interface CeoNextAction {
  kind: ControlCenterNextAction['kind']
  reason: string
  severity: 1 | 2 | 3
  agentId?: string
  reportPath?: string
}

export interface CeoTestsSnapshot {
  evidenceCount: number
  lastStatus: null
}

export interface CeoWorkspaceControlCenter {
  workspaceId: string
  workspaceName: string
  cwd: string
  agentCounts: CeoWorkspaceAgentCounts
  branch: CeoBranchSnapshot
  budget: CeoBudget
  tests: CeoTestsSnapshot
  agentRows: CeoAgentRow[]
  done: CeoAgentRow[]
  needsApproval: CeoAgentRow[]
  stuck: CeoAgentRow[]
  inFlight: CeoAgentRow[]
  starting: CeoAgentRow[]
  reportsUnread: number
  retryableFailedSpecCount: number
  lastShippedAt: string | null
  nextAction: CeoNextAction | null
}

export interface CeoControlCenterTotals {
  workspaces: number
  done: number
  needsApproval: number
  stuck: number
  inFlight: number
  starting: number
  reportsUnread: number
  retryableFailedSpecCount: number
}

export interface CeoControlCenterView {
  generatedAt: string
  totals: CeoControlCenterTotals
  workspaces: CeoWorkspaceControlCenter[]
}

export interface BuildCeoControlCenterViewInput {
  summary: ControlCenterSummaryResponse
  agents?: Agent[]
  tasks?: Task[]
  gitByWorkspace?: Record<string, {
    inRepo: boolean
    branch?: string | null
    dirty?: number
    untracked?: number
    ahead?: number
    behind?: number
  } | undefined>
}

const DEFAULT_BRANCH: CeoBranchSnapshot = {
  inRepo: false,
  branch: null,
  ahead: 0,
  behind: 0,
  dirty: 0,
  untracked: 0,
  clean: true,
}

function bucketForAgentState(state: ControlCenterAgentState): {
  bucket: CeoBucket
  stuckReason?: CeoStuckReason
} {
  switch (state.state) {
    case 'starting':
      return { bucket: 'starting' }
    case 'running':
      return { bucket: 'in_flight' }
    case 'stale':
      return { bucket: 'stuck', stuckReason: 'stale' }
    case 'blocked':
      return { bucket: 'stuck', stuckReason: 'blocked' }
    case 'unknown_exit':
      return { bucket: 'stuck', stuckReason: 'unknown_exit' }
    case 'done':
      return { bucket: state.acknowledged ? 'done' : 'needs_approval' }
    default: {
      return { bucket: 'stuck', stuckReason: 'unknown_exit' }
    }
  }
}

function lifecycleActionForAgentState(state: ControlCenterAgentState): CeoLifecycleAction {
  if (state.state === 'blocked' || state.state === 'stale') return 'recycle'
  if (state.state === 'done' || state.state === 'unknown_exit') return 'close'
  return 'none'
}

function rowFromAgentState(
  state: ControlCenterAgentState,
  agent: Agent | undefined,
  task: Task | undefined,
  reportPath: string | undefined,
): CeoAgentRow {
  const { bucket, stuckReason } = bucketForAgentState(state)
  return {
    agentId: state.agentId,
    name: state.name,
    kind: state.kind,
    bucket,
    state: state.state,
    acknowledged: state.acknowledged,
    hasReport: state.hasReport,
    stuckReason,
    idleMs: state.idleMs,
    outputBytes: state.outputBytes,
    exitCode: state.exitCode,
    lastOutput: agent?.lastOutput ?? undefined,
    lastOutputAt: state.lastOutputAt ?? agent?.lastOutputAt ?? undefined,
    currentTask: task ? { taskId: task.id, title: task.title, status: task.status } : undefined,
    reportPath,
    lifecycleAction: lifecycleActionForAgentState(state),
  }
}

function compareCeoRows(a: CeoAgentRow, b: CeoAgentRow): number {
  return a.name.localeCompare(b.name) || a.agentId.localeCompare(b.agentId)
}

function deriveBranch(
  workspaceId: string,
  gitByWorkspace?: BuildCeoControlCenterViewInput['gitByWorkspace'],
): CeoBranchSnapshot {
  const raw = gitByWorkspace?.[workspaceId]
  if (!raw || !raw.inRepo) return { ...DEFAULT_BRANCH }
  const dirty = raw.dirty ?? 0
  const untracked = raw.untracked ?? 0
  const ahead = raw.ahead ?? 0
  const behind = raw.behind ?? 0
  return {
    inRepo: true,
    branch: raw.branch ?? null,
    ahead,
    behind,
    dirty,
    untracked,
    clean: dirty === 0 && untracked === 0 && ahead === 0 && behind === 0,
  }
}

function lastShippedAt(workspace: ControlCenterWorkspace): string | null {
  let latest: string | null = null
  for (const run of workspace.recentRuns) {
    if (run.status !== 'succeeded') continue
    if (latest === null || run.updatedAt > latest) latest = run.updatedAt
  }
  return latest
}

function topNextAction(
  workspace: ControlCenterWorkspace,
  summary: ControlCenterSummaryResponse,
): CeoNextAction | null {
  const top = summary.nextActions.find((a) => a.workspaceId === workspace.workspaceId)
  if (!top) return null
  return {
    kind: top.kind,
    reason: top.reason,
    severity: top.severity,
    agentId: top.agentId,
    reportPath: top.reportPath,
  }
}

export function buildCeoControlCenterView(input: BuildCeoControlCenterViewInput): CeoControlCenterView {
  const { summary, agents, tasks, gitByWorkspace } = input
  const agentById = new Map<string, Agent>(
    (agents ?? []).map((a) => [a.id, a]),
  )
  const taskById = new Map<string, Task>(
    (tasks ?? []).map((t) => [t.id, t]),
  )
  const taskByOwnerId = new Map<string, Task>()
  for (const task of tasks ?? []) {
    if (task.ownerId && !taskByOwnerId.has(task.ownerId)) taskByOwnerId.set(task.ownerId, task)
  }

  const workspaces: CeoWorkspaceControlCenter[] = summary.workspaces.map((workspace) => {
    const agentRows: CeoAgentRow[] = []
    const done: CeoAgentRow[] = []
    const needsApproval: CeoAgentRow[] = []
    const stuck: CeoAgentRow[] = []
    const inFlight: CeoAgentRow[] = []
    const starting: CeoAgentRow[] = []

    for (const state of workspace.readiness.agentStates) {
      const agent = agentById.get(state.agentId)
      const task = agent?.taskId ? taskById.get(agent.taskId) : taskByOwnerId.get(state.agentId)
      const reportPath = workspace.reports.find((report) => report.agentId === state.agentId)?.path
      const row = rowFromAgentState(state, agent, task, reportPath)
      agentRows.push(row)
      if (row.bucket === 'done') done.push(row)
      else if (row.bucket === 'needs_approval') needsApproval.push(row)
      else if (row.bucket === 'stuck') stuck.push(row)
      else if (row.bucket === 'in_flight') inFlight.push(row)
      else if (row.bucket === 'starting') starting.push(row)
    }

    agentRows.sort(compareCeoRows)
    done.sort(compareCeoRows)
    needsApproval.sort(compareCeoRows)
    stuck.sort(compareCeoRows)
    inFlight.sort(compareCeoRows)
    starting.sort(compareCeoRows)

    const reportsUnread = workspace.reports.filter((r) => r.unread).length
    const retryableFailedSpecCount = workspace.readiness.retryableFailedSpecCount

    return {
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName,
      cwd: workspace.cwd,
      agentCounts: {
        running: workspace.agents.running,
        exited: workspace.agents.exited,
        completed: done.length + needsApproval.length,
      },
      branch: deriveBranch(workspace.workspaceId, gitByWorkspace),
      budget: { kind: 'unknown', note: 'budget tracking not yet wired' },
      tests: {
        evidenceCount: workspace.evidence.byKind.test ?? 0,
        lastStatus: null,
      },
      agentRows,
      done,
      needsApproval,
      stuck,
      inFlight,
      starting,
      reportsUnread,
      retryableFailedSpecCount,
      lastShippedAt: lastShippedAt(workspace),
      nextAction: topNextAction(workspace, summary),
    }
  })

  const totals = workspaces.reduce<CeoControlCenterTotals>(
    (acc, ws) => {
      acc.done += ws.done.length
      acc.needsApproval += ws.needsApproval.length
      acc.stuck += ws.stuck.length
      acc.inFlight += ws.inFlight.length
      acc.starting += ws.starting.length
      acc.reportsUnread += ws.reportsUnread
      acc.retryableFailedSpecCount += ws.retryableFailedSpecCount
      return acc
    },
    {
      workspaces: workspaces.length,
      done: 0,
      needsApproval: 0,
      stuck: 0,
      inFlight: 0,
      starting: 0,
      reportsUnread: 0,
      retryableFailedSpecCount: 0,
    },
  )

  return {
    generatedAt: summary.generatedAt,
    totals,
    workspaces,
  }
}

export function renderCeoWorkspaceLine(ws: CeoWorkspaceControlCenter): string {
  const branch = ws.branch.inRepo
    ? 'branch ' + (ws.branch.branch ?? 'detached') + branchModifiers(ws.branch)
    : 'no repo'
  const counts = 'done ' + ws.done.length + ', needs-approval ' + ws.needsApproval.length + ', stuck ' + ws.stuck.length + ', in-flight ' + ws.inFlight.length
  const tail: string[] = []
  if (ws.reportsUnread > 0) tail.push(ws.reportsUnread + ' unread report' + (ws.reportsUnread === 1 ? '' : 's'))
  if (ws.nextAction) tail.push('next: ' + ws.nextAction.reason)
  const tailStr = tail.length > 0 ? '; ' + tail.join('; ') : ''
  return ws.workspaceName + ' - ' + branch + '; ' + counts + tailStr
}

export function renderCeoBranchLabel(ws: CeoWorkspaceControlCenter): string | null {
  if (!ws.branch.inRepo) return null
  const branch = ws.branch.branch ?? 'detached'
  if (ws.branch.clean) return branch + ' clean'
  const modifiers = branchModifiers(ws.branch).replace(/^, /, '')
  return modifiers ? branch + ' ' + modifiers : branch
}

export function formatCeoShippedAtCt(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'shipped time unknown'
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00'
  return 'shipped ' + hour + ':' + minute + ' CT'
}

function branchModifiers(branch: CeoBranchSnapshot): string {
  if (branch.clean) return ', clean'
  const parts: string[] = []
  if (branch.ahead > 0) parts.push('ahead ' + branch.ahead)
  if (branch.behind > 0) parts.push('behind ' + branch.behind)
  if (branch.dirty > 0) parts.push(branch.dirty + ' dirty')
  if (branch.untracked > 0) parts.push(branch.untracked + ' untracked')
  return parts.length > 0 ? ', ' + parts.join(', ') : ''
}
