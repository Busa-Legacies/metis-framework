'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Mic, MicOff, Send, Bot, Trash2, Zap, Sparkles, ImagePlus, X, ArrowDown, RefreshCw, AlertTriangle, Check, ExternalLink, PanelRightOpen } from 'lucide-react'
import { nanoid } from 'nanoid'
import { ptyApi } from '@/lib/pty-client'
import type { Attachment } from '@/lib/types'
import { buildCeoControlCenterView, formatCeoShippedAtCt, renderCeoBranchLabel, type CeoAgentRow, type CeoWorkspaceControlCenter } from '@/lib/ceo-control-center-view'
import type { ControlCenterNextAction, ControlCenterSummaryResponse } from '@/lib/control-center-summary'
import { applyControlCenterAgentAcknowledgement, controlCenterReportCount, getControlCenterActionGroups, getControlCenterWorkspaceMatrix, type ControlCenterWorkspaceHealth } from '@/lib/control-center-ui-state'
import { ChatMessage, type UiMessage } from './ChatMessage'
import { MetisLoader } from './ui/MetisLoader'

interface Props {
  activeWorkspaceId: string | null
  onAfterTurn: () => void
  onOpenAgent?: (workspaceId: string, agentId: string) => void
  injectedAttachments?: Attachment[]
  onInjectedConsumed?: () => void
}

type SR = any

type DispatchRunStatus = 'running' | 'succeeded' | 'partial_failed' | 'failed' | 'canceled' | 'closed'
type DispatchActionStatus = 'running' | 'succeeded' | 'partial_failed' | 'failed' | 'already_applied'

interface DispatchSpawnedAgent {
  id: string
  name?: string
  kind?: string
  laneName?: string
  role?: string
}

interface DispatchFailedSpec {
  spec: unknown
  error: string
}

interface DispatchAction {
  actionId: string
  tool: string
  sessionWorkspaceId?: string
  targetWorkspaceId?: string
  explicitTargetWorkspaceId?: string
  status: DispatchActionStatus
  spawnedAgents: DispatchSpawnedAgent[]
  failedSpecs?: DispatchFailedSpec[]
  error?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

interface DispatchRun {
  runId: string
  workspaceId: string
  sessionWorkspaceId?: string
  targetWorkspaceId?: string
  explicitTargetWorkspaceId?: string
  createdBy: string
  userPrompt: string
  status: DispatchRunStatus
  actions: DispatchAction[]
  createdAt: string
  updatedAt: string
}

interface DispatchStatusResponse {
  run: DispatchRun | null
  runs?: DispatchRun[]
}

function getSpeechRecognition(): SR | null {
  if (typeof window === 'undefined') return null
  // Chrome/Edge expose webkitSpeechRecognition
  const w = window as any
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

function statusTone(status: DispatchRunStatus | DispatchActionStatus | 'stale' | 'report' | 'blocked' | 'review' | 'unknown'): string {
  if (status === 'succeeded' || status === 'already_applied') return 'border-emerald-300/35 bg-emerald-300/10 text-emerald-200'
  if (status === 'running') return 'border-cyan-300/35 bg-cyan-300/10 text-cyan-200'
  if (status === 'partial_failed' || status === 'stale' || status === 'review' || status === 'unknown') return 'border-amber-300/40 bg-amber-300/10 text-amber-200'
  if (status === 'report') return 'border-sky-300/35 bg-sky-300/10 text-sky-200'
  if (status === 'blocked') return 'border-rose-300/40 bg-rose-300/10 text-rose-200'
  return 'border-rose-300/40 bg-rose-300/10 text-rose-200'
}

function labelFailedSpec(spec: unknown): string {
  if (!spec || typeof spec !== 'object') return 'spec'
  const rec = spec as Record<string, unknown>
  const name = typeof rec.name === 'string' ? rec.name : typeof rec.laneName === 'string' ? rec.laneName : null
  const kind = typeof rec.kind === 'string' ? rec.kind : null
  if (name && kind) return `${name} (${kind})`
  return name ?? kind ?? 'spec'
}

function compactRunId(runId: string): string {
  return runId.length > 18 ? `${runId.slice(0, 10)}…${runId.slice(-5)}` : runId
}

function controlCenterCountButton(label: string, count: number, tone: string, onOpen: () => void) {
  if (count <= 0) return <span className="text-slate-600">{count} {label}</span>
  return (
    <button onClick={onOpen} className={`rounded border px-1.5 py-0 text-[9px] font-semibold ${tone}`}>
      {count} {label}
    </button>
  )
}

function ControlCenterDisclosure({ summary, error, onOpen, onRefresh }: {
  summary: ControlCenterSummaryResponse | null
  error: string | null
  onOpen: () => void
  onRefresh: () => void
}) {
  if (!summary) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-500">
        <span className="font-bold uppercase tracking-[0.16em]">Control Center</span>
        <span className="min-w-0 flex-1 truncate">{error ? `unavailable: ${error}` : 'loading'}</span>
        <button onClick={onRefresh} title="refresh Control Center summary" className="rounded border border-slate-400/15 bg-black/30 p-0.5 text-slate-400 hover:text-white">
          <RefreshCw size={12} />
        </button>
      </div>
    )
  }
  const t = summary.totals
  const reportCount = controlCenterReportCount(summary)
  return (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
      <button onClick={onOpen} title="open Control Center next-action queue" className="flex items-center gap-1 rounded border border-slate-400/15 bg-black/30 px-1.5 py-0.5 text-slate-300 hover:text-white">
        <PanelRightOpen size={12} /> Control Center
      </button>
      <span>{t.workspaces} ws</span>
      <span>{t.runningAgents} running</span>
      {controlCenterCountButton('stale', t.staleRunningAgentCount, statusTone('stale'), onOpen)}
      {controlCenterCountButton('review', t.reviewReadyAgentCount, statusTone('review'), onOpen)}
      {controlCenterCountButton('blocked', t.blockedAgentCount, statusTone('blocked'), onOpen)}
      {controlCenterCountButton('unknown', t.unknownExitAgentCount, statusTone('unknown'), onOpen)}
      {controlCenterCountButton('reports', reportCount, statusTone('report'), onOpen)}
      {t.acknowledgedAgentCount > 0 && <span title="acknowledged but not cleared">{t.acknowledgedAgentCount} acked</span>}
      <span className="text-slate-600">· {t.nextActionCount} next</span>
    </div>
  )
}

function severityTone(severity: 1 | 2 | 3): string {
  if (severity === 3) return 'bg-rose-300'
  if (severity === 2) return 'bg-amber-300'
  return 'bg-sky-300'
}

function workspaceHealthTone(health: ControlCenterWorkspaceHealth): string {
  if (health === 'blocked') return 'border-rose-300/40 bg-rose-300/10 text-rose-200'
  if (health === 'attention') return 'border-amber-300/40 bg-amber-300/10 text-amber-200'
  if (health === 'active') return 'border-cyan-300/35 bg-cyan-300/10 text-cyan-200'
  if (health === 'clean') return 'border-emerald-300/35 bg-emerald-300/10 text-emerald-200'
  return 'border-slate-400/15 bg-slate-400/5 text-slate-500'
}

function ceoBucketTone(kind: 'approval' | 'stuck' | 'flight' | 'done' | 'reports'): string {
  if (kind === 'stuck') return statusTone('blocked')
  if (kind === 'approval') return statusTone('review')
  if (kind === 'flight') return statusTone('running')
  if (kind === 'done') return statusTone('succeeded')
  return statusTone('report')
}

function agentNames(rows: CeoAgentRow[], limit = 3): string {
  if (rows.length === 0) return 'none'
  const head = rows.slice(0, limit).map((row) => row.name || row.agentId)
  const extra = rows.length - head.length
  return extra > 0 ? `${head.join(', ')} +${extra}` : head.join(', ')
}

function acknowledgedCount(ws: CeoWorkspaceControlCenter): number {
  return [...ws.done, ...ws.needsApproval, ...ws.stuck, ...ws.inFlight, ...ws.starting].filter((row) => row.acknowledged).length
}

function pathLabel(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || pathValue
}

function openReport(pathValue: string) {
  if (typeof window === 'undefined') return
  const url = `file://${pathValue}`
  window.open(url, '_blank', 'noopener,noreferrer')
}

function ControlCenterNextActionsDrawer({ summary, onClose, onRefresh, onAcknowledgeLocal, onOpenAgent }: {
  summary: ControlCenterSummaryResponse
  onClose: () => void
  onRefresh: () => Promise<void>
  onAcknowledgeLocal: (workspaceId: string, agentId: string) => void
  onOpenAgent?: (workspaceId: string, agentId: string) => void
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const grouped = getControlCenterActionGroups(summary)
  const matrix = getControlCenterWorkspaceMatrix(summary)
  const ceoView = useMemo(() => buildCeoControlCenterView({ summary }), [summary])
  const ceoActionCount = ceoView.totals.needsApproval + ceoView.totals.stuck + ceoView.totals.inFlight + ceoView.totals.starting + ceoView.totals.reportsUnread

  async function acknowledge(action: ControlCenterNextAction) {
    if (!action.agentId) return
    setBusyKey(`ack:${action.workspaceId}:${action.agentId}`)
    try {
      const res = await fetch('/api/assistant?scope=acknowledge_agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id: action.workspaceId, agent_id: action.agentId, reason: action.reason, by: 'metis-brain' }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
      onAcknowledgeLocal(action.workspaceId, action.agentId)
      await onRefresh()
    } finally {
      setBusyKey(null)
    }
  }

  async function wake(action: ControlCenterNextAction) {
    if (!action.agentId) return
    setBusyKey(`wake:${action.workspaceId}:${action.agentId}`)
    try {
      await ptyApi.sendInput(action.agentId, '\r')
      await onRefresh()
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-full max-w-[340px] flex-col border-l border-slate-400/15 bg-black/95 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-2 border-b border-slate-400/10 px-3 py-2">
        <PanelRightOpen size={14} className="text-cyan-200" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-bold uppercase tracking-[0.18em] text-cyan-100">Control Center queue</div>
          <div className="text-[10px] text-slate-500">{summary.totals.workspaces} workspace{summary.totals.workspaces === 1 ? '' : 's'} · {summary.totals.nextActionCount} action{summary.totals.nextActionCount === 1 ? '' : 's'}</div>
        </div>
        <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-300/10 hover:text-white" title="close Control Center queue">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-cyan-100/85">CEO overnight</div>
          </div>
          {ceoActionCount === 0 ? (
            <div className="mb-2 rounded border border-emerald-300/25 bg-emerald-300/10 px-2 py-1 text-[11px] text-emerald-100">
              All clear. No CEO action needed.
            </div>
          ) : (
            <div className="mb-2 flex flex-wrap gap-1">
              <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${ceoBucketTone('approval')}`}>{ceoView.totals.needsApproval} approval</span>
              <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${ceoBucketTone('stuck')}`}>{ceoView.totals.stuck} stuck</span>
              <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${ceoBucketTone('flight')}`}>{ceoView.totals.inFlight + ceoView.totals.starting} in flight</span>
              <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${ceoBucketTone('done')}`}>{ceoView.totals.done} done</span>
              {ceoView.totals.reportsUnread > 0 && <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${ceoBucketTone('reports')}`}>{ceoView.totals.reportsUnread} reports</span>}
            </div>
          )}
          <div className="space-y-1.5">
            {ceoView.workspaces.map((ws) => {
              const branch = renderCeoBranchLabel(ws)
              const acked = acknowledgedCount(ws)
              return (
              <div key={ws.workspaceId} className="rounded-lg border border-slate-400/15 bg-black/35 p-2">
                <div className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-200" title={`${ws.workspaceName} · ${ws.cwd}`}>
                        {ws.workspaceName}
                      </div>
                      {branch && <span className="min-w-0 max-w-[45%] truncate text-[10px] text-slate-500" title={branch}>{branch}</span>}
                      {ws.lastShippedAt && <span className="shrink-0 rounded border border-emerald-300/25 bg-emerald-300/10 px-1 py-0 text-[10px] text-emerald-200" title={ws.lastShippedAt}>{formatCeoShippedAtCt(ws.lastShippedAt)}</span>}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {ws.needsApproval.length > 0 && <span className={`rounded border px-1.5 py-0.5 text-[10px] ${ceoBucketTone('approval')}`} title={agentNames(ws.needsApproval)}>{ws.needsApproval.length} approval</span>}
                      {ws.stuck.length > 0 && <span className={`rounded border px-1.5 py-0.5 text-[10px] ${ceoBucketTone('stuck')}`} title={agentNames(ws.stuck)}>{ws.stuck.length} stuck</span>}
                      {(ws.inFlight.length + ws.starting.length) > 0 && <span className={`rounded border px-1.5 py-0.5 text-[10px] ${ceoBucketTone('flight')}`} title={agentNames([...ws.inFlight, ...ws.starting])}>{ws.inFlight.length + ws.starting.length} in flight</span>}
                      {ws.done.length > 0 && <span className={`rounded border px-1.5 py-0.5 text-[10px] ${ceoBucketTone('done')}`} title={agentNames(ws.done)}>{ws.done.length} done</span>}
                      {acked > 0 && <span className="rounded border border-slate-400/15 bg-black/30 px-1.5 py-0.5 text-[10px] text-slate-500">{acked} acked</span>}
                      {ws.tests.evidenceCount > 0 && <span className="rounded border border-slate-400/15 bg-black/30 px-1.5 py-0.5 text-[10px] text-slate-400">{ws.tests.evidenceCount} tests</span>}
                      {ws.reportsUnread > 0 && <span className={`rounded border px-1.5 py-0.5 text-[10px] ${ceoBucketTone('reports')}`}>{ws.reportsUnread} report{ws.reportsUnread === 1 ? '' : 's'}</span>}
                    </div>
                    {ws.nextAction && (
                      <div className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-slate-300" title={ws.nextAction.reason}>
                        <span className={`h-2 w-2 shrink-0 rounded-full ${severityTone(ws.nextAction.severity)}`} />
                        <span className="min-w-0 truncate">next: {ws.nextAction.reason}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              )
            })}
          </div>
        </div>

        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">workspace state</div>
            <button onClick={() => void onRefresh()} className="rounded border border-slate-400/15 bg-black/30 p-0.5 text-slate-400 hover:text-white" title="refresh Control Center matrix">
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="space-y-1.5">
            {matrix.map((row) => {
              const workspace = row.workspace
              const lastRun = workspace.lastRun
              return (
                <div key={workspace.workspaceId} className="rounded-lg border border-slate-400/15 bg-black/35 p-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold ${workspaceHealthTone(row.health)}`}>
                      {row.health}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-200" title={`${workspace.workspaceName} · ${workspace.cwd}`}>
                          {workspace.workspaceName}
                        </div>
                        <span className="shrink-0 text-[10px] text-slate-500">{row.actions.length} next</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-400">
                        <span>{workspace.agents.running} running / {workspace.agents.exited} exited</span>
                        <span className="truncate" title={row.kindSummary}>{row.kindSummary}</span>
                        {lastRun && <span className={`rounded border px-1 py-0 text-[9px] ${statusTone(lastRun.status)}`}>{lastRun.status.replace('_', ' ')}</span>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {workspace.readiness.blockedAgentIds.length > 0 && <span className={`rounded border px-1.5 py-0 text-[9px] ${statusTone('blocked')}`}>{workspace.readiness.blockedAgentIds.length} blocked</span>}
                        {workspace.readiness.staleRunningAgentIds.length > 0 && <span className={`rounded border px-1.5 py-0 text-[9px] ${statusTone('stale')}`}>{workspace.readiness.staleRunningAgentIds.length} stale</span>}
                        {workspace.readiness.reviewReadyAgentIds.length > 0 && <span className={`rounded border px-1.5 py-0 text-[9px] ${statusTone('review')}`}>{workspace.readiness.reviewReadyAgentIds.length} review</span>}
                        {workspace.readiness.unknownExitAgentIds.length > 0 && <span className={`rounded border px-1.5 py-0 text-[9px] ${statusTone('unknown')}`}>{workspace.readiness.unknownExitAgentIds.length} unknown</span>}
                        {workspace.readiness.retryableFailedSpecCount > 0 && <span className={`rounded border px-1.5 py-0 text-[9px] ${statusTone('partial_failed')}`}>{workspace.readiness.retryableFailedSpecCount} retryable</span>}
                        {row.unreadReportCount > 0 && <span className={`rounded border px-1.5 py-0 text-[9px] ${statusTone('report')}`}>{row.unreadReportCount} unread report{row.unreadReportCount === 1 ? '' : 's'}</span>}
                        {workspace.readiness.acknowledgedAgentIds.length > 0 && <span className="rounded border border-slate-400/15 bg-black/30 px-1.5 py-0 text-[9px] text-slate-500">{workspace.readiness.acknowledgedAgentIds.length} acked</span>}
                      </div>
                      {row.latestUnreadReportPath && (
                        <button onClick={() => openReport(row.latestUnreadReportPath as string)} className="mt-1 block max-w-full truncate text-left text-[10px] text-sky-200 hover:text-sky-100" title={row.latestUnreadReportPath}>
                          latest: {pathLabel(row.latestUnreadReportPath)}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">next actions</div>
        {grouped.length === 0 ? (
          <div className="rounded-lg border border-slate-400/15 bg-black/30 p-3 text-[12px] text-slate-400">No queued Control Center actions.</div>
        ) : grouped.map(({ workspace, actions }) => (
          <div key={workspace.workspaceId} className="mb-3">
            <div className="mb-1 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
              <span className="truncate">{workspace.workspaceName}</span>
              {workspace.readiness.acknowledgedAgentIds.length > 0 && <span className="normal-case tracking-normal text-slate-600">{workspace.readiness.acknowledgedAgentIds.length} acked</span>}
            </div>
            <div className="space-y-1.5">
              {actions.map((action) => {
                const key = `${action.kind}:${action.workspaceId}:${action.agentId ?? action.reportPath ?? 'workspace'}`
                const busy = busyKey?.endsWith(`${action.workspaceId}:${action.agentId}`) ?? false
                return (
                  <div key={key} className="rounded-lg border border-slate-400/15 bg-black/35 p-2">
                    <div className="flex items-start gap-2">
                      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${severityTone(action.severity)}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[11px] text-slate-200" title={action.reason}>{action.reason}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {action.agentId && (
                            <button onClick={() => onOpenAgent?.(action.workspaceId, action.agentId as string)} className="rounded border border-slate-400/15 bg-black/30 px-1.5 py-0.5 text-[10px] text-slate-300 hover:text-white">
                              open pane
                            </button>
                          )}
                          {(action.kind === 'review' || action.kind === 'ack_or_clear') && (
                            <button disabled={busy} onClick={() => acknowledge(action)} className="flex items-center gap-1 rounded border border-emerald-300/30 bg-emerald-300/10 px-1.5 py-0.5 text-[10px] text-emerald-200 disabled:opacity-40">
                              <Check size={12} /> acknowledge
                            </button>
                          )}
                          {action.kind === 'wake' && (
                            <button disabled={busy} onClick={() => wake(action)} className="rounded border border-cyan-300/30 bg-cyan-300/10 px-1.5 py-0.5 text-[10px] text-cyan-200 disabled:opacity-40">
                              send newline
                            </button>
                          )}
                          {action.kind === 'read_report' && action.reportPath && (
                            <button onClick={() => openReport(action.reportPath as string)} className="flex items-center gap-1 rounded border border-sky-300/30 bg-sky-300/10 px-1.5 py-0.5 text-[10px] text-sky-200">
                              <ExternalLink size={12} /> open file
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function AssistantPanel({ activeWorkspaceId, onAfterTurn, onOpenAgent, injectedAttachments, onInjectedConsumed }: Props) {
  const [messagesByWs, setMessagesByWs] = useState<Record<string, UiMessage[]>>({})
  const messages = activeWorkspaceId ? (messagesByWs[activeWorkspaceId] ?? []) : []
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [voiceErr, setVoiceErr] = useState<string | null>(null)
  const [persona, setPersona] = useState<'workbench' | 'metis-brain'>('metis-brain')
  const [autoMode, setAutoMode] = useState(true)
  const [pending, setPending] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [dispatchStatus, setDispatchStatus] = useState<DispatchStatusResponse | null>(null)
  const [dispatchErr, setDispatchErr] = useState<string | null>(null)
  const [controlCenterSummary, setControlCenterSummary] = useState<ControlCenterSummaryResponse | null>(null)
  const [controlCenterErr, setControlCenterErr] = useState<string | null>(null)
  const [showControlCenterDrawer, setShowControlCenterDrawer] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const recRef = useRef<any>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const SR = useMemo(() => getSpeechRecognition(), [])
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshDispatchStatus = useCallback(async () => {
    if (!activeWorkspaceId) {
      setDispatchStatus(null)
      setDispatchErr(null)
      return
    }
    try {
      const res = await fetch(`/api/assistant?workspaceId=${encodeURIComponent(activeWorkspaceId)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : res.statusText)
      setDispatchStatus(data as DispatchStatusResponse)
      setDispatchErr(null)
    } catch (e) {
      setDispatchErr(e instanceof Error ? e.message : 'dispatch status unavailable')
    }
  }, [activeWorkspaceId])

  const refreshControlCenterSummary = useCallback(async () => {
    if (!activeWorkspaceId) {
      setControlCenterSummary(null)
      setControlCenterErr(null)
      return
    }
    try {
      const qs = new URLSearchParams({
        scope: 'control-center',
        active_workspace_id: activeWorkspaceId,
        reports_limit: '5',
      })
      const res = await fetch(`/api/assistant?${qs.toString()}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : res.statusText)
      setControlCenterSummary(data as ControlCenterSummaryResponse)
      setControlCenterErr(null)
    } catch (e) {
      setControlCenterErr(e instanceof Error ? e.message : 'Control Center unavailable')
    }
  }, [activeWorkspaceId])

  // Hydrate persona from settings on mount
  useEffect(() => {
    fetch('/api/settings').then((r) => r.json()).then((d) => {
      if (d.assistantPersona === 'metis-brain' || d.assistantPersona === 'jarvis') setPersona('metis-brain')
      else if (d.assistantPersona === 'workbench') setPersona('workbench')
    }).catch(() => {})
  }, [])

  async function patchPersona(p: 'workbench' | 'metis-brain') {
    setPersona(p)
    fetch('/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assistantPersona: p }) }).catch(() => {})
  }

  function fileToAttachment(file: File): Promise<Attachment | null> {
    return new Promise((resolve) => {
      if (!file.type.startsWith('image/')) { resolve(null); return }
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = String(reader.result || '')
        if (!dataUrl.startsWith('data:image/')) { resolve(null); return }
        resolve({ type: 'image', dataUrl, name: file.name || 'image', size: file.size })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
  }

  async function addFiles(list: FileList | File[]) {
    const files = Array.from(list).slice(0, 6)
    const attachs = (await Promise.all(files.map(fileToAttachment))).filter(Boolean) as Attachment[]
    if (attachs.length) setPending((p) => [...p, ...attachs].slice(0, 8))
  }

  useEffect(() => {
    if (!injectedAttachments?.length) return
    setPending((p) => [...p, ...injectedAttachments].slice(0, 8))
    onInjectedConsumed?.()
  }, [injectedAttachments, onInjectedConsumed])

  // Load persisted chat when workspace changes
  useEffect(() => {
    if (!activeWorkspaceId) return
    if (messagesByWs[activeWorkspaceId]) return
    let alive = true
    ptyApi.getChat(activeWorkspaceId).then((d) => {
      if (!alive) return
      const chat = (d.chat ?? []).map((t: any) => ({
        id: t.id ?? nanoid(),
        role: t.role,
        content: t.content,
        toolCalls: t.toolCalls,
      })) as UiMessage[]
      setMessagesByWs((cur) => ({ ...cur, [activeWorkspaceId]: chat }))
    }).catch(() => {
      setMessagesByWs((cur) => ({ ...cur, [activeWorkspaceId]: [] }))
    })
    return () => { alive = false }
  }, [activeWorkspaceId, messagesByWs])

  useEffect(() => {
    refreshDispatchStatus()
    refreshControlCenterSummary()
    const t = setInterval(() => {
      refreshDispatchStatus()
      refreshControlCenterSummary()
    }, 5000)
    return () => clearInterval(t)
  }, [refreshDispatchStatus, refreshControlCenterSummary])

  // Persist chat (debounced) when messages change
  useEffect(() => {
    if (!activeWorkspaceId) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const wsId = activeWorkspaceId
    const m = messages
    saveTimer.current = setTimeout(() => {
      ptyApi.putChat(wsId, m).catch(() => {})
    }, 500)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [activeWorkspaceId, messages])

  function setMessages(updater: (cur: UiMessage[]) => UiMessage[]) {
    if (!activeWorkspaceId) return
    setMessagesByWs((curAll) => ({
      ...curAll,
      [activeWorkspaceId]: updater(curAll[activeWorkspaceId] ?? []),
    }))
  }

  async function clearChat() {
    if (!activeWorkspaceId) return
    setMessagesByWs((cur) => ({ ...cur, [activeWorkspaceId]: [] }))
    try { await ptyApi.clearChat(activeWorkspaceId) } catch {}
  }

  const [stickToBottom, setStickToBottom] = useState(true)

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setStickToBottom(distance < 32)
  }, [])

  useEffect(() => {
    if (!stickToBottom) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, busy, stickToBottom])

  function jumpToBottom() {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setStickToBottom(true)
  }

  async function send(text: string) {
    const trimmed = text.trim()
    if ((!trimmed && pending.length === 0) || busy) return
    const userMsg: UiMessage = { id: nanoid(), role: 'user', content: trimmed, attachments: pending.length ? pending : undefined }
    const next = [...messages, userMsg]
    setMessages(() => next)
    setInput('')
    setPending([])
    setBusy(true)
    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          activeWorkspaceId,
          messages: next.map((m) => ({ role: m.role, content: m.content, attachments: m.attachments })),
          persona,
          auto: autoMode,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessages((p) => [...p, { id: nanoid(), role: 'assistant', content: `Error: ${data.error ?? res.statusText}` }])
      } else {
        const reply: UiMessage = {
          id: nanoid(),
          role: 'assistant',
          content: typeof data.message?.content === 'string' ? data.message.content : '(no response)',
          toolCalls: data.toolCalls,
        }
        setMessages((p) => [...p, reply])
        if (data.toolCalls?.length) onAfterTurn()
        if (data.dispatchRunId || data.toolCalls?.length) {
          void refreshDispatchStatus()
          void refreshControlCenterSummary()
        }
      }
    } catch (e) {
      setMessages((p) => [...p, { id: nanoid(), role: 'assistant', content: `Error: ${e instanceof Error ? e.message : 'request failed'}` }])
    } finally {
      setBusy(false)
    }
  }

  function startListening() {
    setVoiceErr(null)
    if (!SR) {
      setVoiceErr('SpeechRecognition is not available in this browser. Use Chrome or Edge.')
      return
    }
    try {
      const rec = new SR()
      rec.lang = 'en-US'
      rec.interimResults = true
      rec.continuous = false
      let finalText = ''
      rec.onresult = (e: any) => {
        let interim = ''
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]
          if (r.isFinal) finalText += r[0].transcript
          else interim += r[0].transcript
        }
        setInput((finalText + interim).trim())
      }
      rec.onerror = (e: any) => {
        setVoiceErr(`mic: ${e.error}`)
        setListening(false)
      }
      rec.onend = () => {
        setListening(false)
        const text = finalText.trim()
        if (text) send(text)
      }
      rec.start()
      recRef.current = rec
      setListening(true)
    } catch (e) {
      setVoiceErr(e instanceof Error ? e.message : 'mic error')
    }
  }

  function stopListening() {
    try { recRef.current?.stop() } catch {}
    setListening(false)
  }

  const latestRun = dispatchStatus?.run ?? null
  const targetWorkspaceLabel = latestRun?.targetWorkspaceId && latestRun.targetWorkspaceId !== activeWorkspaceId
    ? latestRun.targetWorkspaceId
    : latestRun?.workspaceId && latestRun.workspaceId !== activeWorkspaceId
      ? latestRun.workspaceId
      : null
  const spawnedAgents = useMemo(() => latestRun?.actions.flatMap((a) => a.spawnedAgents ?? []) ?? [], [latestRun])
  const failedRows = useMemo(() => latestRun?.actions.flatMap((action) => (action.failedSpecs ?? []).map((row, index) => ({
    actionId: action.actionId,
    tool: action.tool,
    row,
    index,
  }))) ?? [], [latestRun])
  const retryableRows = failedRows.filter((row) => row.tool === 'spawn_agents')

  // Hold space anywhere outside input to PTT
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (e.repeat) return
      e.preventDefault()
      if (!listening) startListening()
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (listening) stopListening()
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [listening, SR])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-400/10 px-4 py-2">
        <div className="flex items-center gap-2">
          {persona === 'metis-brain' ? <Sparkles size={16} className="text-amber-300" /> : <Bot size={16} className="text-cyan-300" />}
          <div className={`text-[12px] font-bold uppercase tracking-[0.2em] ${persona === 'metis-brain' ? 'text-amber-200/85' : 'text-cyan-200/85'}`}>
            {persona === 'metis-brain' ? 'Metis Brain' : 'Workbench Assistant'}
          </div>
          <div className="flex-1" />
          <span className={`badge ${listening ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-200' : busy ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-200' : 'border-slate-400/20 bg-slate-400/10 text-slate-300'}`}>
            {listening ? 'listening' : busy ? 'thinking' : 'idle'}
          </span>
          <button
            onClick={clearChat}
            disabled={messages.length === 0 || busy}
            title="clear this workspace's chat"
            className="rounded-md border border-slate-400/20 bg-black/30 p-1 text-slate-400 hover:border-rose-300/30 hover:text-rose-200 disabled:opacity-40"
          >
            <Trash2 size={12} />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex rounded-lg border border-slate-400/15 bg-black/40 p-0.5 text-[10px]">
            <button onClick={() => patchPersona('metis-brain')} className={`rounded-md px-2 py-0.5 ${persona === 'metis-brain' ? 'bg-amber-300/15 text-amber-200' : 'text-slate-400 hover:text-white'}`}>brain</button>
            <button onClick={() => patchPersona('workbench')} className={`rounded-md px-2 py-0.5 ${persona === 'workbench' ? 'bg-cyan-300/15 text-cyan-200' : 'text-slate-400 hover:text-white'}`}>direct</button>
          </div>
          <button
            onClick={() => setAutoMode((v) => !v)}
            title="autonomous mode: keep tool-calling until done (uses the configured hop cap)"
            className={`flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[10px] ${autoMode ? 'border-amber-300/40 bg-amber-300/10 text-amber-200' : 'border-slate-400/15 bg-black/30 text-slate-400 hover:text-white'}`}
          >
            <Zap size={12} /> auto
          </button>
        </div>
        {activeWorkspaceId && (
          <div className="mt-2 rounded-md border border-slate-400/15 bg-black/30 px-2 py-1.5 text-[10px] text-slate-400">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 font-bold uppercase tracking-[0.16em] text-slate-500">dispatch</span>
              {latestRun ? (
                <>
                  <span className={`badge shrink-0 px-1.5 py-0 text-[9px] ${statusTone(latestRun.status)}`}>{latestRun.status.replace('_', ' ')}</span>
                  <span className="min-w-0 flex-1 truncate" title={latestRun.runId}>
                    {compactRunId(latestRun.runId)}
                    {targetWorkspaceLabel && <span className="text-slate-500"> · target:{targetWorkspaceLabel}</span>}
                    {latestRun.actions.length > 0 && <span className="text-slate-500"> · {latestRun.actions.length} action{latestRun.actions.length === 1 ? '' : 's'}</span>}
                  </span>
                  <button
                    onClick={() => void refreshDispatchStatus()}
                    title="refresh dispatch status"
                    className="shrink-0 rounded border border-slate-400/15 bg-black/30 p-0.5 text-slate-400 hover:text-white"
                  >
                    <RefreshCw size={12} />
                  </button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{dispatchErr ? `status unavailable: ${dispatchErr}` : 'no run yet'}</span>
                  <button
                    onClick={() => void refreshDispatchStatus()}
                    title="refresh dispatch status"
                    className="shrink-0 rounded border border-slate-400/15 bg-black/30 p-0.5 text-slate-400 hover:text-white"
                  >
                    <RefreshCw size={12} />
                  </button>
                </>
              )}
            </div>
            {latestRun && (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate" title={spawnedAgents.map((a) => a.id).join(', ') || 'none'}>
                  spawned: <span className="text-slate-200">{spawnedAgents.length ? spawnedAgents.map((a) => a.id).join(', ') : 'none'}</span>
                </span>
                <span className="truncate" title={failedRows.map((r) => `${labelFailedSpec(r.row.spec)}: ${r.row.error}`).join('\n') || 'none'}>
                  failed specs: <span className={failedRows.length ? 'text-amber-200' : 'text-slate-300'}>{failedRows.length}</span>
                </span>
                {retryableRows.length > 0 && (
                  <span className="inline-flex min-w-0 items-center gap-1 truncate text-amber-200" title={retryableRows.map((r) => `${labelFailedSpec(r.row.spec)}: ${r.row.error}`).join('\n')}>
                    <AlertTriangle size={12} className="shrink-0" />
                    retryable: {retryableRows.map((r) => labelFailedSpec(r.row.spec)).join(', ')}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
        {activeWorkspaceId && (
          <ControlCenterDisclosure
            summary={controlCenterSummary}
            error={controlCenterErr}
            onOpen={() => setShowControlCenterDrawer(true)}
            onRefresh={() => void refreshControlCenterSummary()}
          />
        )}
      </div>

      {showControlCenterDrawer && controlCenterSummary && (
        <ControlCenterNextActionsDrawer
          summary={controlCenterSummary}
          onClose={() => setShowControlCenterDrawer(false)}
          onRefresh={refreshControlCenterSummary}
          onAcknowledgeLocal={(workspaceId, agentId) => setControlCenterSummary((cur) => cur ? applyControlCenterAgentAcknowledgement(cur, workspaceId, agentId) : cur)}
          onOpenAgent={onOpenAgent}
        />
      )}

      <div className="relative flex-1 overflow-hidden">
        <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 space-y-2.5 overflow-y-auto px-3 py-3">
          {messages.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-400/15 p-3 text-[12px] leading-5 text-slate-500">
              Try: <span className="text-slate-300">"open 2 claude code, 1 codex, 1 shell — name them frontend, api, deploy."</span>
              <br />Hold <kbd className="rounded bg-black/40 px-1 text-slate-300">Space</kbd> to dictate.
            </div>
          )}
          {messages.map((m) => (
            <ChatMessage key={m.id} m={m} />
          ))}
          {busy && <MetisLoader size={18} label="Métis is working…" inline className="text-[12px]" />}
        </div>
        {!stickToBottom && (
          <button
            onClick={jumpToBottom}
            title="jump to latest"
            className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-cyan-300/40 bg-black/80 px-3 py-1 text-[11px] text-cyan-100 shadow-lg backdrop-blur hover:bg-black/90"
          >
            <ArrowDown size={12} /> latest
          </button>
        )}
      </div>

      {voiceErr && <div className="border-t border-rose-300/20 bg-rose-300/5 px-4 py-1 text-[11px] text-rose-200">{voiceErr}</div>}

      {pending.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-slate-400/10 px-3 py-2">
          {pending.map((a, i) => (
            <div key={i} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.dataUrl} alt={a.name} className="h-12 w-12 rounded border border-slate-400/20 object-cover" />
              <button
                onClick={() => setPending((p) => p.filter((_, j) => j !== i))}
                className="absolute -right-1 -top-1 rounded-full border border-rose-300/40 bg-black/80 p-0.5 text-rose-200 opacity-0 group-hover:opacity-100"
                title="remove"
              ><X size={12} /></button>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); send(input) }}
        onDragOver={(e) => { if (Array.from(e.dataTransfer.items).some((i) => i.kind === 'file')) { e.preventDefault(); setDragOver(true) } }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files) }}
        onPaste={(e) => {
          const items = Array.from(e.clipboardData.items).filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
          if (items.length) {
            e.preventDefault()
            const files = items.map((i) => i.getAsFile()).filter(Boolean) as File[]
            addFiles(files)
          }
        }}
        className={`flex items-center gap-2 border-t border-slate-400/10 px-3 py-3 ${dragOver ? 'bg-cyan-300/5 ring-1 ring-inset ring-cyan-300/30' : ''}`}
      >
        <button
          type="button"
          onClick={listening ? stopListening : startListening}
          className={`rounded-lg border p-2 transition ${listening ? 'border-emerald-300/40 bg-emerald-300/10 text-emerald-200' : 'border-slate-400/20 bg-black/30 text-slate-300 hover:text-white'}`}
          aria-label="microphone"
        >
          {listening ? <MicOff size={16} /> : <Mic size={16} />}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="attach images (or drag/paste)"
          className="rounded-lg border border-slate-400/20 bg-black/30 p-2 text-slate-300 hover:text-white"
        >
          <ImagePlus size={14} />
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='ask Metis… or drag/paste an image'
          className="flex-1 rounded-lg border border-slate-400/15 bg-black/40 px-3 py-2 text-[13px] text-white placeholder:text-slate-500 focus:border-cyan-300/40 focus:outline-none"
        />
        <button
          type="submit"
          disabled={busy || (!input.trim() && pending.length === 0)}
          className="rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 py-2 text-cyan-100 transition hover:bg-cyan-300/20 disabled:opacity-40"
        >
          <Send size={14} />
        </button>
      </form>
    </div>
  )
}
