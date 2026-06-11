import { EVIDENCE_KINDS, type EvidenceCounts, type EvidenceKind } from './evidence-ledger'
import { listDispatchRuns, type DispatchRun, type DispatchRunStatus } from './dispatch-runs'
import type { Agent, Workspace } from './types'
import { resolveWorkspaceSelector } from './workspace-selector'

export interface ControlCenterWorkspaceAgents {
  total: number
  running: number
  exited: number
  byKind: Record<string, number>
}

export interface ControlCenterStaleRunningAgent {
  agentId: string
  idleMs: number
  lastOutputAt: string
  outputBytes: number
  hasReport: boolean
}

export type ControlCenterAgentStateKind = 'starting' | 'running' | 'stale' | 'done' | 'blocked' | 'unknown_exit'

export interface ControlCenterAgentState {
  agentId: string
  name: string
  kind: Agent['kind']
  state: ControlCenterAgentStateKind
  acknowledged: boolean
  hasReport: boolean
  lastOutputAt?: string
  idleMs?: number
  outputBytes?: number
  exitCode?: number
}

export interface ControlCenterWorkspaceReadiness {
  activeRunCount: number
  partialRunCount: number
  failedRunCount: number
  succeededRunCount: number
  retryableFailedSpecCount: number
  reviewReadyAgentIds: string[]
  blockedAgentIds: string[]
  unknownExitAgentIds: string[]
  staleRunningAgentIds: string[]
  staleRunningAgents: ControlCenterStaleRunningAgent[]
  acknowledgedAgentIds: string[]
  agentStates: ControlCenterAgentState[]
}

export interface ControlCenterAckEntry {
  workspaceId: string
  agentId: string
  ackedAt: string
  by: string
  reason?: string
}

export type ControlCenterReportKind = 'markdown' | 'json' | 'log' | 'other'

export interface ControlCenterReportEntry {
  path: string
  agentId?: string
  kind: ControlCenterReportKind
  mtime: string
  sizeBytes: number
  unread: boolean
}

export interface ControlCenterStoredReportEntry extends ControlCenterReportEntry {
  workspaceId: string
}

export interface ControlCenterLastRunSummary {
  runId: string
  status: DispatchRunStatus
  createdAt: string
  updatedAt: string
  userPrompt: string
  actionCount: number
  spawnedAgentIds: string[]
  failedSpecCount: number
  originWorkspaceId?: string
  explicitTargetWorkspaceId?: string
}

export interface ControlCenterWorkspace {
  workspaceId: string
  workspaceName: string
  cwd: string
  agents: ControlCenterWorkspaceAgents
  lastRun: ControlCenterLastRunSummary | null
  recentRuns: ControlCenterLastRunSummary[]
  readiness: ControlCenterWorkspaceReadiness
  reports: ControlCenterReportEntry[]
  staleThresholdMs: number
  evidence: EvidenceCounts
}

export interface ControlCenterTotals {
  workspaces: number
  runningAgents: number
  exitedAgents: number
  activeRunCount: number
  partialRunCount: number
  failedRunCount: number
  succeededRunCount: number
  retryableFailedSpecCount: number
  reviewReadyAgentCount: number
  blockedAgentCount: number
  unknownExitAgentCount: number
  staleRunningAgentCount: number
  acknowledgedAgentCount: number
  unreadReportCount: number
  nextActionCount: number
  evidenceTotal: number
}

export type ControlCenterNextActionKind = 'review' | 'investigate' | 'ack_or_clear' | 'retry' | 'wake' | 'read_report'
export type ControlCenterNextActionDerivedFrom =
  | 'reviewReadyAgentIds'
  | 'blockedAgentIds'
  | 'unknownExitAgentIds'
  | 'staleRunningAgentIds'
  | 'retryableFailedSpecCount'
  | 'reports.unread'

export interface ControlCenterNextAction {
  kind: ControlCenterNextActionKind
  workspaceId: string
  agentId?: string
  reportPath?: string
  reason: string
  derivedFrom: ControlCenterNextActionDerivedFrom
  severity: 1 | 2 | 3
}

export interface ControlCenterSummaryResponse {
  generatedAt: string
  workspaces: ControlCenterWorkspace[]
  totals: ControlCenterTotals
  nextActions: ControlCenterNextAction[]
}

export interface ControlCenterSummaryInput {
  workspaces: Workspace[]
  agents: Agent[]
  workspaceSelectors?: string[]
  runsLimit?: number
  activeWorkspaceId?: string
  generatedAt?: string
  now?: string
  staleThresholdMs?: number
  reportsLimit?: number
  includeAcked?: boolean
  acks?: ControlCenterAckEntry[]
  reports?: ControlCenterStoredReportEntry[]
  evidenceByWorkspace?: Record<string, EvidenceCounts>
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function zeroEvidenceCounts(): EvidenceCounts {
  return {
    total: 0,
    byKind: EVIDENCE_KINDS.reduce<Record<EvidenceKind, number>>((acc, k) => {
      acc[k] = 0
      return acc
    }, {} as Record<EvidenceKind, number>),
  }
}

function clampRunsLimit(limit?: number): number {
  if (limit === undefined) return 10
  return Math.max(1, Math.min(50, Math.trunc(limit)))
}

function clampReportsLimit(limit?: number): number {
  if (limit === undefined) return 5
  return Math.max(1, Math.min(20, Math.trunc(limit)))
}

function clampStaleThresholdMs(threshold?: number): number {
  if (threshold === undefined) return 600_000
  return Math.max(60_000, Math.min(3_600_000, Math.trunc(threshold)))
}

function summarizeRun(run: DispatchRun, blockWorkspaceId: string): ControlCenterLastRunSummary {
  const spawnedAgentIds = unique(run.actions.flatMap((action) => action.spawnedAgents.map((agent) => agent.id)))
  const failedSpecCount = run.actions.reduce((sum, action) => sum + (action.failedSpecs?.length ?? 0), 0)
  return {
    runId: run.runId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    userPrompt: run.userPrompt,
    actionCount: run.actions.length,
    spawnedAgentIds,
    failedSpecCount,
    originWorkspaceId: run.workspaceId !== blockWorkspaceId ? run.workspaceId : undefined,
    explicitTargetWorkspaceId: run.explicitTargetWorkspaceId,
  }
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

function countRunStatus(readiness: ControlCenterWorkspaceReadiness, run: ControlCenterLastRunSummary): void {
  if (run.status === 'running') readiness.activeRunCount += 1
  else if (run.status === 'partial_failed') readiness.partialRunCount += 1
  else if (run.status === 'failed') readiness.failedRunCount += 1
  else if (run.status === 'succeeded') readiness.succeededRunCount += 1
  readiness.retryableFailedSpecCount += run.failedSpecCount
}

function resolveRequestedWorkspaces(workspaces: Workspace[], selectors?: string[]): Workspace[] | { error: string } {
  if (!selectors || selectors.length === 0) return workspaces
  const ids: string[] = []
  for (const selector of selectors) {
    const resolved = resolveWorkspaceSelector(workspaces, selector)
    if ('error' in resolved) return resolved
    ids.push(resolved.workspaceId)
  }
  const idSet = new Set(ids)
  return workspaces.filter((workspace) => idSet.has(workspace.id))
}

function orderWorkspaces(workspaces: Workspace[], activeWorkspaceId?: string): Workspace[] {
  return [...workspaces].sort((a, b) => {
    if (activeWorkspaceId) {
      if (a.id === activeWorkspaceId && b.id !== activeWorkspaceId) return -1
      if (b.id === activeWorkspaceId && a.id !== activeWorkspaceId) return 1
    }
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  })
}

function latestAcksByAgent(acks: ControlCenterAckEntry[]): Map<string, ControlCenterAckEntry> {
  const out = new Map<string, ControlCenterAckEntry>()
  for (const ack of acks) {
    const key = `${ack.workspaceId}:${ack.agentId}`
    const prev = out.get(key)
    if (!prev || ack.ackedAt >= prev.ackedAt) out.set(key, ack)
  }
  return out
}

function reasonForAgent(agent: Agent, fallbackKind: ControlCenterNextActionKind): string {
  const label = `${agent.name || agent.id} (${agent.kind})`
  if (fallbackKind === 'review') return `${label} exited cleanly with code 0`
  if (fallbackKind === 'investigate') return `${label} exited with code ${agent.exitCode}`
  if (fallbackKind === 'ack_or_clear') return `${label} exited without a recorded exit code`
  return `${label} has been running without recent output`
}

function formatIdleDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  if (hours < 24) return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`
  const days = Math.floor(hours / 24)
  const remHours = hours % 24
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`
}

function staleReasonForAgent(agent: Agent, stale: ControlCenterStaleRunningAgent): string {
  const label = `${agent.name || agent.id} (${agent.kind})`
  const reportState = stale.hasReport ? 'report artifact present' : 'no report artifact'
  return `${label} idle ${formatIdleDuration(stale.idleMs)}; output ${stale.outputBytes} bytes; ${reportState}`
}

function compareAgentStates(a: ControlCenterAgentState, b: ControlCenterAgentState): number {
  const stateRank: Record<ControlCenterAgentStateKind, number> = {
    blocked: 0,
    stale: 1,
    done: 2,
    unknown_exit: 3,
    starting: 4,
    running: 5,
  }
  return stateRank[a.state] - stateRank[b.state] ||
    a.name.localeCompare(b.name) ||
    a.agentId.localeCompare(b.agentId)
}

export function classifyControlCenterAgentState(input: {
  agent: Agent
  nowMs: number
  staleThresholdMs: number
  hasReport: boolean
  acknowledged: boolean
}): ControlCenterAgentState {
  const { agent, nowMs, staleThresholdMs, hasReport, acknowledged } = input
  const base = {
    agentId: agent.id,
    name: agent.name || agent.id,
    kind: agent.kind,
    acknowledged,
    hasReport,
  }
  if (agent.status === 'starting') {
    return { ...base, state: 'starting' }
  }
  if (agent.status === 'running') {
    const lastOutputAt = agent.lastOutputAt ?? agent.createdAt
    const lastOutputMs = new Date(lastOutputAt).getTime()
    const outputBytes = agent.outputBytes ?? 0
    const idleMs = nowMs - lastOutputMs
    const state = Number.isFinite(lastOutputMs) && idleMs >= staleThresholdMs ? 'stale' : 'running'
    return { ...base, state, lastOutputAt, idleMs, outputBytes }
  }
  if (agent.exitCode === 0) return { ...base, state: 'done', exitCode: agent.exitCode }
  if (agent.exitCode === undefined) return { ...base, state: 'unknown_exit' }
  return { ...base, state: 'blocked', exitCode: agent.exitCode }
}

function compareNextActions(a: ControlCenterNextAction, b: ControlCenterNextAction, workspaceNames: Map<string, string>): number {
  if (a.severity !== b.severity) return b.severity - a.severity
  const an = workspaceNames.get(a.workspaceId) ?? a.workspaceId
  const bn = workspaceNames.get(b.workspaceId) ?? b.workspaceId
  return an.localeCompare(bn) ||
    (a.agentId ?? '').localeCompare(b.agentId ?? '') ||
    (a.reportPath ?? '').localeCompare(b.reportPath ?? '') ||
    a.kind.localeCompare(b.kind)
}

export function buildControlCenterSummary(input: ControlCenterSummaryInput): ControlCenterSummaryResponse | { error: string } {
  const requested = resolveRequestedWorkspaces(input.workspaces, input.workspaceSelectors)
  if ('error' in requested) return requested

  const runsLimit = clampRunsLimit(input.runsLimit)
  const reportsLimit = clampReportsLimit(input.reportsLimit)
  const staleThresholdMs = clampStaleThresholdMs(input.staleThresholdMs)
  const nowMs = new Date(input.now ?? input.generatedAt ?? Date.now()).getTime()
  const ackMap = latestAcksByAgent(input.acks ?? [])
  const nextActions: ControlCenterNextAction[] = []
  const workspaceNames = new Map(input.workspaces.map((workspace) => [workspace.id, workspace.name]))
  const controlCenterWorkspaces = orderWorkspaces(requested, input.activeWorkspaceId).map((workspace) => {
    const workspaceAgents = input.agents.filter((agent) => agent.workspaceId === workspace.id)
    const workspaceAgentById = new Map(workspaceAgents.map((agent) => [agent.id, agent]))
    const reportAgentIds = new Set((input.reports ?? [])
      .filter((report) => report.workspaceId === workspace.id && report.agentId)
      .map((report) => report.agentId as string))
    const agents: ControlCenterWorkspaceAgents = {
      total: workspaceAgents.length,
      running: workspaceAgents.filter((agent) => agent.status === 'running').length,
      exited: workspaceAgents.filter((agent) => agent.status === 'exited').length,
      byKind: {},
    }
    for (const agent of workspaceAgents) agents.byKind[agent.kind] = (agents.byKind[agent.kind] ?? 0) + 1

    const recentRuns = listDispatchRuns(workspace.id, runsLimit).map((run) => summarizeRun(run, workspace.id))
    const readiness = emptyReadiness()
    for (const run of recentRuns) countRunStatus(readiness, run)
    for (const agent of workspaceAgents) {
      const ack = ackMap.get(`${workspace.id}:${agent.id}`)
      if (ack) readiness.acknowledgedAgentIds.push(agent.id)
      const agentState = classifyControlCenterAgentState({
        agent,
        nowMs,
        staleThresholdMs,
        hasReport: reportAgentIds.has(agent.id),
        acknowledged: Boolean(ack),
      })
      readiness.agentStates.push(agentState)
      if (agentState.state === 'stale') {
        readiness.staleRunningAgentIds.push(agent.id)
        readiness.staleRunningAgents.push({
          agentId: agent.id,
          idleMs: agentState.idleMs ?? 0,
          lastOutputAt: agentState.lastOutputAt ?? agent.createdAt,
          outputBytes: agentState.outputBytes ?? 0,
          hasReport: agentState.hasReport,
        })
        continue
      }
      if (agentState.state === 'done') readiness.reviewReadyAgentIds.push(agent.id)
      else if (agentState.state === 'unknown_exit') readiness.unknownExitAgentIds.push(agent.id)
      else if (agentState.state === 'blocked') readiness.blockedAgentIds.push(agent.id)
    }
    readiness.agentStates.sort(compareAgentStates)

    for (const id of readiness.reviewReadyAgentIds) {
      if (!input.includeAcked && ackMap.has(`${workspace.id}:${id}`)) continue
      const agent = workspaceAgentById.get(id)
      nextActions.push({
        kind: 'review',
        workspaceId: workspace.id,
        agentId: id,
        reason: agent ? reasonForAgent(agent, 'review') : `${id} exited cleanly with code 0`,
        derivedFrom: 'reviewReadyAgentIds',
        severity: 2,
      })
    }
    for (const id of readiness.blockedAgentIds) {
      const agent = workspaceAgentById.get(id)
      nextActions.push({
        kind: 'investigate',
        workspaceId: workspace.id,
        agentId: id,
        reason: agent ? reasonForAgent(agent, 'investigate') : `${id} exited non-zero`,
        derivedFrom: 'blockedAgentIds',
        severity: 3,
      })
    }
    for (const id of readiness.unknownExitAgentIds) {
      if (!input.includeAcked && ackMap.has(`${workspace.id}:${id}`)) continue
      const agent = workspaceAgentById.get(id)
      nextActions.push({
        kind: 'ack_or_clear',
        workspaceId: workspace.id,
        agentId: id,
        reason: agent ? reasonForAgent(agent, 'ack_or_clear') : `${id} exited without a recorded exit code`,
        derivedFrom: 'unknownExitAgentIds',
        severity: 2,
      })
    }
    for (const id of readiness.staleRunningAgentIds) {
      const agent = workspaceAgentById.get(id)
      const stale = readiness.staleRunningAgents.find((row) => row.agentId === id)
      nextActions.push({
        kind: 'wake',
        workspaceId: workspace.id,
        agentId: id,
        reason: agent && stale ? staleReasonForAgent(agent, stale) : agent ? reasonForAgent(agent, 'wake') : `${id} has been running without recent output`,
        derivedFrom: 'staleRunningAgentIds',
        severity: 2,
      })
    }
    if (readiness.retryableFailedSpecCount > 0) {
      nextActions.push({
        kind: 'retry',
        workspaceId: workspace.id,
        reason: `${readiness.retryableFailedSpecCount} failed dispatch spec${readiness.retryableFailedSpecCount === 1 ? '' : 's'} can be retried`,
        derivedFrom: 'retryableFailedSpecCount',
        severity: 2,
      })
    }

    const reports = (input.reports ?? [])
      .filter((report) => report.workspaceId === workspace.id)
      .sort((a, b) => b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path))
      .slice(0, reportsLimit)
      .map(({ workspaceId: _workspaceId, ...report }) => report)
    for (const report of reports) {
      if (!report.unread) continue
      nextActions.push({
        kind: 'read_report',
        workspaceId: workspace.id,
        agentId: report.agentId,
        reportPath: report.path,
        reason: `${pathBasename(report.path)} is ready to read`,
        derivedFrom: 'reports.unread',
        severity: 1,
      })
    }

    const evidence = input.evidenceByWorkspace?.[workspace.id] ?? zeroEvidenceCounts()

    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cwd: workspace.cwd,
      agents,
      lastRun: recentRuns[0] ?? null,
      recentRuns,
      readiness,
      reports,
      staleThresholdMs,
      evidence,
    }
  })

  const totals = controlCenterWorkspaces.reduce<ControlCenterTotals>((acc, workspace) => {
    acc.workspaces += 1
    acc.runningAgents += workspace.agents.running
    acc.exitedAgents += workspace.agents.exited
    acc.activeRunCount += workspace.readiness.activeRunCount
    acc.partialRunCount += workspace.readiness.partialRunCount
    acc.failedRunCount += workspace.readiness.failedRunCount
    acc.succeededRunCount += workspace.readiness.succeededRunCount
    acc.retryableFailedSpecCount += workspace.readiness.retryableFailedSpecCount
    acc.reviewReadyAgentCount += workspace.readiness.reviewReadyAgentIds.length
    acc.blockedAgentCount += workspace.readiness.blockedAgentIds.length
    acc.unknownExitAgentCount += workspace.readiness.unknownExitAgentIds.length
    acc.staleRunningAgentCount += workspace.readiness.staleRunningAgentIds.length
    acc.acknowledgedAgentCount += workspace.readiness.acknowledgedAgentIds.length
    acc.unreadReportCount += workspace.reports.filter((report) => report.unread).length
    acc.evidenceTotal += workspace.evidence.total
    return acc
  }, {
    workspaces: 0,
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
    nextActionCount: 0,
    evidenceTotal: 0,
  })
  nextActions.sort((a, b) => compareNextActions(a, b, workspaceNames))
  totals.nextActionCount = nextActions.length

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    workspaces: controlCenterWorkspaces,
    totals,
    nextActions,
  }
}

function pathBasename(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || value
}
