'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayoutList, AlertTriangle, X, ChevronRight, ChevronDown, ChevronUp, ArrowDown, ArrowUp, Play, Unlock, Ban, Pause, CheckCircle2, Link2, Link2Off, Target } from 'lucide-react'
import { metisApi, ageLabel, type MetisResult } from '@/lib/metis-api'
import type { MetisGoverned, MetisGoverndProject, MetisGoverndTask, MetisTaskRoutePlan } from '@/lib/metis-api-types'
import { CardLoading, CardError } from '../overview/cards'
import { ptyApi } from '@/lib/pty-client'
import type { AgentKind, AgentRole } from '@/lib/types'
import { useControlCenterNav } from '@/lib/control-center-nav'
import { useMetisAll } from '@/lib/use-metis-all'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'
import { STATE_BG, stateDotCls, stateTextCls } from '@/lib/task-state'

// ── State colours ─────────────────────────────────────────────────────────────
// Noise-reduction redesign (mobile pass 3): rows encode state with a single
// colored dot and detail views with a colored word — no repeated chip badges.
// Grounded in HIG/Material task-list patterns: title-first rows (~16px bold),
// metadata below, one-glance color coding instead of per-row labels.
// Color maps live in lib/task-state.ts (shared with WorkGraphMode).

const STATE_ORDER = [
  'in_progress', 'needs_verification', 'execution_finished',
  'blocked', 'waiting', 'accepted', 'queued',
]

const COLLAPSED_KEY = 'metis.tasks.collapsedProjects'
const ORDER_KEY = 'metis.tasks.projectOrder'

// ── Governed state machine (mirror of scripts/update-tier1-state.py) ──────────
// Kept in sync with ALLOWED_STATE_TRANSITIONS so the Control Center only offers moves the
// mutator will accept (a forward-only graph — no rewind edges). `done` is reached
// via the audited correct-state path (carries a reason + done-gate), not a plain
// patch, so it is handled separately, not listed here.
const TRANSITIONS: Record<string, string[]> = {
  inbox: ['queued', 'accepted'],
  queued: ['in_progress', 'accepted', 'waiting'],
  accepted: ['in_progress'],
  in_progress: ['execution_finished', 'waiting', 'blocked'],
  execution_finished: ['needs_verification'],
  needs_verification: ['in_progress', 'blocked'],
  waiting: ['in_progress'],
  blocked: ['in_progress'],
  failed: ['in_progress', 'accepted'],
  done: [],
}

// Friendly verbs for a target state (Control Center copy, not raw jargon).
const STATE_VERB: Record<string, string> = {
  queued: 'Queue',
  accepted: 'Accept',
  in_progress: 'Start',
  execution_finished: 'Mark built',
  needs_verification: 'Send to verify',
  blocked: 'Block',
  waiting: 'Park',
  failed: 'Mark failed',
  done: 'Complete',
}

// ── Task detail slide-over ────────────────────────────────────────────────────

function governedTaskPrompt(task: MetisGoverndTask): string {
  return [
    `Work ${task.taskId} "${task.title}" (${task.priority}, ${task.state}).`,
    task.project ? `Project: ${task.project}` : '',
    task.milestone ? `Milestone: ${task.milestone.id} — ${task.milestone.title}` : '',
    '',
    task.summary ? `Summary:\n${task.summary}` : '',
    task.why ? `Why:\n${task.why}` : '',
    task.how ? `How:\n${task.how}` : '',
    task.currentStep || task.firstStep ? `Current step:\n${task.currentStep ?? task.firstStep}` : '',
    task.nextAction ? `Next action:\n${task.nextAction}` : '',
    task.expectedArtifact ? `Expected artifact:\n${task.expectedArtifact}` : '',
    task.verificationMethod ? `Verification:\n${task.verificationMethod}` : '',
    task.blocker ? `Blocker:\n${task.blocker}` : '',
    '',
    'Protocol:',
    '1. Read AGENTS.md, Jay/memory/working-context.md, and this task in docs/process/state/tasks.json.',
    '2. Claim/renew the task before editing if the governed task system says it is free.',
    '3. Keep edits tightly scoped, preserve unrelated work, and verify before marking anything done.',
  ].filter(Boolean).join('\n')
}

// Hoisted out of TaskDetail (was re-created every render — lint: no components
// during render, and it reset DOM state on each detail re-render).
function DetailField({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="mb-4">
      <div className="mb-1 text-[11px] md:text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
      <div className="text-[13px] md:text-[12px] leading-relaxed text-slate-300">{value}</div>
    </div>
  )
}

const AGENT_KINDS = new Set(['claude', 'codex', 'shell', 'gemini', 'python', 'custom'])
const AGENT_ROLES = new Set(['builder', 'reviewer', 'scout', 'coordinator'])

function routeAgentKind(kind: string | undefined): AgentKind {
  return AGENT_KINDS.has(kind ?? '') ? kind as AgentKind : 'codex'
}

function routeAgentRole(role: string | undefined): AgentRole {
  return AGENT_ROLES.has(role ?? '') ? role as AgentRole : 'builder'
}

function routeClaimAgent(plan: MetisTaskRoutePlan | null): string {
  const recommended = plan?.recommendation.kind
  if (recommended && recommended !== 'human') return recommended
  return plan?.recommendation.lane || 'codex'
}

function RoutePreview({ route, loading }: {
  route: MetisResult<MetisTaskRoutePlan> | null
  loading: boolean
}) {
  if (loading && !route) {
    return (
      <div className="mb-4 rounded-lg border border-[var(--line)] bg-black/25 p-3 text-[12px] text-[var(--muted)]">
        loading route preview...
      </div>
    )
  }
  if (route && !route.ok) {
    return (
      <div className="mb-4 rounded-lg border border-rose-400/25 bg-rose-400/10 p-3 text-[12px] text-rose-200">
        route preview unavailable: {route.error}
      </div>
    )
  }
  if (!route?.ok) return null

  const plan = route.data
  const lane = plan.missionPacket.lanes[0]
  const scope = lane?.scope?.slice(0, 4) ?? []
  const active = plan.activeLeases.length
  const enabled = plan.workbenchSpawn.enabled

  return (
    <div className="mb-4 rounded-lg border border-cyan-300/20 bg-cyan-300/5 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[11px] md:text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-200">Route preview</div>
        <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase ${
          enabled ? 'border-emerald-300/25 bg-emerald-300/10 text-emerald-200' : 'border-amber-300/25 bg-amber-300/10 text-amber-200'
        }`}>
          {enabled ? plan.action.label : 'blocked'}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[12px] md:text-[11px]">
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">Engine</div>
          <div className="font-semibold text-slate-200">{plan.recommendation.kind} / {plan.recommendation.ownerRole}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">Lane</div>
          <div className="font-semibold text-slate-200">{plan.recommendation.lane}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">Risk</div>
          <div className="font-semibold text-slate-200">{plan.risk.tier} · {plan.risk.approvalMode.replace(/_/g, ' ')}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">Lease</div>
          <div className="font-semibold text-slate-200">{active ? `${active} active` : 'none'}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] md:text-[11px] leading-relaxed text-slate-300">{plan.recommendation.reason}</div>
      {scope.length > 0 && (
        <div className="mt-2 text-[11px] md:text-[10px] text-[var(--muted)]">
          scope: {scope.join(', ')}{(lane?.scope?.length ?? 0) > scope.length ? '...' : ''}
        </div>
      )}
      {plan.risk.reasons.length > 0 && (
        <div className="mt-2 text-[11px] md:text-[10px] text-amber-200">
          {plan.risk.reasons[0]}
        </div>
      )}
    </div>
  )
}

function TaskDetail({ task, onClose, onStart, onTransition, onComplete, onUnblock, onClaim, onRelease, leased, busy, routePlan, routeLoading }: {
  task: MetisGoverndTask
  onClose: () => void
  onStart: (task: MetisGoverndTask, routePlan?: MetisTaskRoutePlan) => void
  onTransition: (task: MetisGoverndTask, toState: string) => void
  onComplete: (task: MetisGoverndTask) => void
  onUnblock: (task: MetisGoverndTask) => void
  onClaim: (task: MetisGoverndTask) => void
  onRelease: (task: MetisGoverndTask) => void
  leased: boolean
  busy: boolean
  routePlan: MetisResult<MetisTaskRoutePlan> | null
  routeLoading: boolean
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const step = task.currentStep ?? task.firstStep
  const isBlocked = task.state === 'blocked'
  // Forward moves the mutator will accept, minus the ones we surface as dedicated
  // buttons (Unblock handles blocked→in_progress; Complete handles →done).
  const moves = (TRANSITIONS[task.state] ?? []).filter((s) => !(isBlocked && s === 'in_progress'))
  const canComplete = task.state === 'needs_verification'
  const visibleRoutePlan = routePlan?.ok && routePlan.data.task.taskId === task.taskId ? routePlan : null
  const plan = visibleRoutePlan?.ok ? visibleRoutePlan.data : null
  const startDisabled = busy || plan?.workbenchSpawn.enabled === false
  const startLabel = plan?.action.label ? `${plan.action.label} work` : 'Start work'

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-[var(--line)] bg-[var(--panel)] shadow-2xl">
        {/* Header: close top-left (HIG detail-view pattern), title prominent.
            The primary Start action lives in a bottom bar, far from dismiss —
            destructive/primary adjacency is a basic-design-principles no-go. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] py-3 pl-2 pr-4">
          <button
            onClick={onClose}
            aria-label="close task detail"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--muted)] hover:bg-white/5 hover:text-slate-200"
          >
            <X size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[17px] md:text-[15px] font-semibold text-slate-50">{task.title}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] md:text-[11px]">
              <span className={`font-bold ${stateTextCls(task.state)}`}>{task.state.replace(/_/g, ' ')}</span>
              {task.project && <span className="text-[var(--muted)]">{task.project}</span>}
              {task.milestone && <span className="truncate text-indigo-300">{task.milestone.title}</span>}
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-4 font-mono text-[12px]">
          <DetailField label="Summary" value={task.summary} />
          <DetailField label="Why" value={task.why} />
          <DetailField label="How" value={task.how} />
          <DetailField label={task.currentStep ? 'Current step' : 'First step'} value={step} />
          {task.blocker && (
            <div className="mb-4">
              <div className="mb-1 text-[11px] md:text-[10px] font-bold uppercase tracking-[0.14em] text-rose-400">Blocker</div>
              <div className="flex items-start gap-1.5 text-[13px] md:text-[12px] text-rose-300">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                {task.blocker}
              </div>
            </div>
          )}
          <DetailField label="Next action" value={task.nextAction} />
          <RoutePreview route={visibleRoutePlan ?? (routePlan?.ok ? null : routePlan)} loading={routeLoading} />
          <DetailField label="Expected artifact" value={task.expectedArtifact} />
          <DetailField label="Verification" value={task.verificationMethod} />
          <div className="mt-4 border-t border-[var(--line)] pt-3 text-[11px] md:text-[10px] text-[var(--muted)]">
            updated {task.updatedAt?.slice(0, 10)} · rev {task.revision}
          </div>
        </div>
        {/* Action bar — governed write path. State ops (claim/transition/unblock/
            complete) route through the revision-aware mutators; the primary CTA
            spins an agent. Thumb-zone, 12px+ from any dismiss. */}
        <div className="shrink-0 space-y-2 border-t border-[var(--line)] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]">
          {/* Secondary row: lease + governed state transitions */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => (leased ? onRelease(task) : onClaim(task))}
              disabled={busy}
              className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] md:text-[11px] font-semibold disabled:opacity-50 ${
                leased
                  ? 'border-amber-300/30 bg-amber-300/10 text-amber-200 hover:bg-amber-300/20'
                  : 'border-cyan-300/30 bg-cyan-300/10 text-cyan-100 hover:bg-cyan-300/20'
              }`}
              title={leased ? 'release this session’s lease' : 'lease this task to claude (fencing token)'}
            >
              {leased ? <Link2Off size={14} /> : <Link2 size={14} />} {leased ? 'Release' : 'Claim'}
            </button>
            {isBlocked && (
              <button
                onClick={() => onUnblock(task)}
                disabled={busy}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-2.5 text-[12px] md:text-[11px] font-semibold text-emerald-100 hover:bg-emerald-300/20 disabled:opacity-50"
                title="clear the blocker and resume (→ in progress)"
              >
                <Unlock size={14} /> Unblock
              </button>
            )}
            {moves.map((s) => {
              const block = s === 'blocked'
              const park = s === 'waiting'
              return (
                <button
                  key={s}
                  onClick={() => onTransition(task, s)}
                  disabled={busy}
                  className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] md:text-[11px] font-semibold disabled:opacity-50 ${
                    block
                      ? 'border-rose-400/30 bg-transparent text-rose-300 hover:bg-rose-400/10'
                      : 'border-slate-400/25 bg-black/30 text-slate-300 hover:border-cyan-300/40 hover:text-cyan-100'
                  }`}
                  title={`transition → ${s.replace(/_/g, ' ')}`}
                >
                  {block ? <Ban size={14} /> : park ? <Pause size={14} /> : <ChevronRight size={14} />}
                  {STATE_VERB[s] ?? s}
                </button>
              )
            })}
            {canComplete && (
              <button
                onClick={() => onComplete(task)}
                disabled={busy}
                className="flex h-9 items-center gap-1.5 rounded-lg border border-indigo-300/30 bg-indigo-300/10 px-2.5 text-[12px] md:text-[11px] font-semibold text-indigo-100 hover:bg-indigo-300/20 disabled:opacity-50"
                title="mark done (audited correct-state + done-gate)"
              >
                <CheckCircle2 size={14} /> Complete
              </button>
            )}
          </div>
          {/* Primary CTA: claim + move to in-progress + spin an agent */}
          <button
            onClick={() => onStart(task, plan ?? undefined)}
            disabled={startDisabled}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-emerald-300/30 bg-emerald-300/10 text-[15px] md:text-[13px] font-bold text-emerald-100 hover:bg-emerald-300/20 active:bg-emerald-300/25 disabled:opacity-50"
            title={plan?.workbenchSpawn.enabled === false ? 'routing says this task needs a blocker or decision resolved first' : 'claim or resume, move to in-progress, and spin the routed agent in Agents'}
          >
            <Play size={20} /> {busy ? 'starting...' : startLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Task row ──────────────────────────────────────────────────────────────────
// Title-first, metadata below (Things/Todoist/Linear pattern). No taskId, no
// agent, no chip badges — the state dot + position in a priority-sorted group
// carry the distinction. P1 titles render brighter/heavier than the rest.

function TaskRow({ task, onClick }: { task: MetisGoverndTask; onClick: () => void }) {
  const step = task.currentStep ?? task.summary
  const p1 = task.priority === 'P1'
  return (
    <li
      onClick={onClick}
      className="group flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2.5 hover:bg-indigo-400/5 active:bg-indigo-400/10"
    >
      <span
        className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${stateDotCls(task.state)}`}
        title={task.state.replace(/_/g, ' ')}
      />
      <div className="min-w-0 flex-1">
        <div className={`truncate text-[15px] md:text-[13px] ${p1 ? 'font-semibold text-slate-50' : 'font-medium text-slate-200'}`}>
          {task.title}
        </div>
        {step && <div className="truncate text-[12px] md:text-[11px] text-[var(--muted)]">{step}</div>}
        {task.blocker && (
          <div className="mt-0.5 flex items-start gap-1 text-[12px] md:text-[11px] text-rose-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="truncate">{task.blocker}</span>
          </div>
        )}
      </div>
      <ChevronRight size={14} className="mt-1.5 shrink-0 text-[var(--muted)] opacity-40 group-hover:opacity-100" />
    </li>
  )
}

// ── Progress bar ──────────────────────────────────────────────────────────────

function ProgressBar({ progress }: { progress: number }) {
  const pct = Math.round(progress * 100)
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--line)]">
        <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-indigo-300" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] md:text-[10px] text-[var(--muted)]">{pct}%</span>
    </div>
  )
}

// ── Filter logic ──────────────────────────────────────────────────────────────

function applyFilters(
  data: MetisGoverned,
  query: string,
  stateFilter: string | null,
  sortBy: string,
  goalFilter: string | null,
  goalsByTask: Map<string, string[]>,
): MetisGoverned {
  const q = query.trim().toLowerCase()
  const PRIO_ORDER: Record<string, number> = { P1: 0, P2: 1, P3: 2 }

  const projects = data.projects
    .map((g) => {
      let tasks = g.tasks.filter((t) => {
        if (stateFilter && t.state !== stateFilter) return false
        // Goal membership lives on the priorities feed (MetisPriorityItem.goals),
        // not the governed task — map it in via taskId.
        if (goalFilter && !(goalsByTask.get(t.taskId)?.includes(goalFilter))) return false
        if (q && !`${t.taskId} ${t.title ?? ''} ${t.summary ?? ''}`.toLowerCase().includes(q)) return false
        return true
      })
      if (sortBy === 'priority') tasks = [...tasks].sort((a, b) => (PRIO_ORDER[a.priority] ?? 2) - (PRIO_ORDER[b.priority] ?? 2))
      else if (sortBy === 'updated') tasks = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      else if (sortBy === 'id') tasks = [...tasks].sort((a, b) => a.taskId.localeCompare(b.taskId))
      return { ...g, tasks, openCount: tasks.length }
    })
    .filter((g) => g.tasks.length > 0)

  const stateCounts: Record<string, number> = {}
  projects.forEach((g) => g.tasks.forEach((t) => { stateCounts[t.state] = (stateCounts[t.state] ?? 0) + 1 }))

  return { ...data, projects, stateCounts }
}

// ── Project group ─────────────────────────────────────────────────────────────

function ProjectGroup({ project, collapsed, onToggle, onMove, canMoveUp, canMoveDown, onTaskClick }: {
  project: MetisGoverndProject
  collapsed: boolean
  onToggle: () => void
  onMove: (direction: -1 | 1) => void
  canMoveUp: boolean
  canMoveDown: boolean
  onTaskClick: (t: MetisGoverndTask) => void
}) {
  return (
    <div className="mb-3 rounded-xl border border-[var(--line)] bg-gradient-to-b from-white/[0.025] to-black/25 p-3 backdrop-blur-sm">
      <div className={`flex items-center gap-1.5 ${collapsed ? '' : 'mb-1.5 border-b border-[var(--line)] pb-2'}`}>
        <button
          onClick={onToggle}
          className="-ml-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-white/5 hover:text-slate-200"
          title={collapsed ? 'expand project' : 'collapse project'}
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
        </button>
        <span className="min-w-0 flex-1 truncate text-[15px] md:text-[13px] font-semibold text-slate-100">{project.name}</span>
        <span className="shrink-0 text-[12px] md:text-[10px] text-[var(--muted)]">{project.openCount}</span>
        {project.progress != null && <ProgressBar progress={project.progress} />}
        <button
          onClick={() => onMove(-1)}
          disabled={!canMoveUp}
          className="flex h-10 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-white/5 hover:text-slate-200 disabled:opacity-30"
          title="move project up"
        >
          <ArrowUp size={16} />
        </button>
        <button
          onClick={() => onMove(1)}
          disabled={!canMoveDown}
          className="-mr-1 flex h-10 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-white/5 hover:text-slate-200 disabled:opacity-30"
          title="move project down"
        >
          <ArrowDown size={16} />
        </button>
      </div>
      {!collapsed && (
        <ul className="mc-stagger flex flex-col gap-0.5">
          {project.tasks.map((t) => (
            <TaskRow key={t.taskId} task={t} onClick={() => onTaskClick(t)} />
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TaskBoardMode() {
  const nav = useControlCenterNav()
  // Priorities carry the goal→task membership the governed task lacks; we read
  // the shared /api/all to map taskId → goals for the goal-filter deep-link.
  const { data: allData } = useMetisAll()
  const goalsByTask = useMemo(() => {
    const p = allData?.priorities
    const rows = [...(p?.next ?? []), ...(p?.blocked ?? []), ...(p?.orphans ?? []), ...Object.values(p?.by_system ?? {}).flat()]
    const m = new Map<string, string[]>()
    for (const row of rows) if (row.goals?.length) m.set(row.taskId, row.goals)
    return m
  }, [allData?.priorities])
  const [res, setRes] = useState<MetisResult<MetisGoverned> | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [includeDone, setIncludeDone] = useState(false)
  const [query, setQuery] = useState('')
  const [stateFilter, setStateFilter] = useState<string | null>(null)
  const [goalFilter, setGoalFilter] = useState<{ id: string; label: string } | null>(null)
  const [sortBy, setSortBy] = useState('default')
  const [selected, setSelected] = useState<MetisGoverndTask | null>(null)
  const [routePlan, setRoutePlan] = useState<MetisResult<MetisTaskRoutePlan> | null>(null)
  const [routeLoading, setRouteLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set()
    try { return new Set(JSON.parse(window.localStorage.getItem(COLLAPSED_KEY) ?? '[]')) } catch { return new Set() }
  })
  const [projectOrder, setProjectOrder] = useState<string[]>(() => {
    if (typeof window === 'undefined') return []
    try { return JSON.parse(window.localStorage.getItem(ORDER_KEY) ?? '[]') } catch { return [] }
  })
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [actionTask, setActionTask] = useState<string | null>(null)
  // taskId → claim-id for leases this session holds (lets us offer Release + a
  // fencing token to pass to a spun agent). Cleared on unclaim.
  const [claims, setClaims] = useState<Record<string, string>>({})
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await metisApi.tasksGoverned(includeDone)
    setRes(r)
    setNow(Date.now())
    setLoading(false)
  }, [includeDone])

  useEffect(() => {
    load()
    timer.current = setInterval(load, 60000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [load])

  const loadRoutePlan = useCallback(async (taskId: string): Promise<MetisResult<MetisTaskRoutePlan>> => {
    setRouteLoading(true)
    const r = await metisApi.taskRoutePlan(taskId)
    setRoutePlan((current) => {
      if (!selected || selected.taskId !== taskId) return current
      return r
    })
    setRouteLoading(false)
    return r
  }, [selected])

  useEffect(() => {
    if (!selected) {
      setRoutePlan(null)
      setRouteLoading(false)
      return
    }
    let alive = true
    setRouteLoading(true)
    setRoutePlan(null)
    metisApi.taskRoutePlan(selected.taskId).then((r) => {
      if (!alive) return
      setRoutePlan(r)
      setRouteLoading(false)
    })
    return () => { alive = false }
  }, [selected?.taskId])

  // Deep-link in from a goal card (WorkGraph) → pre-filter the board to that goal.
  // A navigation that carries no goalId (e.g. Overview → Tasks) clears the filter
  // so a prior goal scope never leaks across an unrelated jump.
  useEffect(() => {
    if (nav.params?.goalId) setGoalFilter({ id: nav.params.goalId, label: nav.params.goalLabel ?? nav.params.goalId })
    else setGoalFilter(null)
  }, [nav.params?.goalId, nav.params?.goalLabel])

  // Deep-link to a single task (Overview work rows) → open its detail once loaded.
  useEffect(() => {
    const tid = nav.params?.taskId
    if (!tid || !res?.ok) return
    const found = res.data.projects.flatMap((p) => p.tasks).find((t) => t.taskId === tid)
    if (found) setSelected(found)
  }, [nav.params?.taskId, res])

  const raw = res?.ok ? res.data : null
  const data = raw ? applyFilters(raw, query, stateFilter, sortBy, goalFilter?.id ?? null, goalsByTask) : null
  const hasFilter = !!query || !!stateFilter || !!goalFilter
  const orderedProjects = useMemo(() => {
    const projects = data?.projects ?? []
    if (!projects.length) return []
    const rank = new Map(projectOrder.map((slug, i) => [slug, i]))
    return [...projects].sort((a, b) => {
      const ar = rank.get(a.slug)
      const br = rank.get(b.slug)
      if (ar != null && br != null) return ar - br
      if (ar != null) return -1
      if (br != null) return 1
      return 0
    })
  }, [data?.projects, projectOrder])

  const persistCollapsed = useCallback((next: Set<string>) => {
    setCollapsed(next)
    try { window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next])) } catch {}
  }, [])

  const persistOrder = useCallback((next: string[]) => {
    setProjectOrder(next)
    try { window.localStorage.setItem(ORDER_KEY, JSON.stringify(next)) } catch {}
  }, [])

  const toggleProject = useCallback((slug: string) => {
    const next = new Set(collapsed)
    if (next.has(slug)) next.delete(slug)
    else next.add(slug)
    persistCollapsed(next)
  }, [collapsed, persistCollapsed])

  const moveProject = useCallback((slug: string, direction: -1 | 1) => {
    const visible = orderedProjects.map((p) => p.slug)
    const base = projectOrder.filter((s) => visible.includes(s))
    for (const s of visible) if (!base.includes(s)) base.push(s)
    const idx = base.indexOf(slug)
    const nextIdx = idx + direction
    if (idx < 0 || nextIdx < 0 || nextIdx >= base.length) return
    const next = [...base]
    const [item] = next.splice(idx, 1)
    next.splice(nextIdx, 0, item)
    persistOrder(next)
  }, [orderedProjects, persistOrder, projectOrder])

  // ── Governed mutations ──────────────────────────────────────────────────────
  // Single runner: marks busy, calls the governed write path, then refreshes the
  // board AND the open slide-over from the returned fresh task (so the next action
  // carries the new revision — no stale-409 on a second click). On failure the
  // error (incl. 409 "someone moved it") renders inline; nothing optimistic.
  const mutate = useCallback(async (
    task: MetisGoverndTask,
    fn: () => Promise<{ ok: boolean; error?: string; task?: MetisGoverndTask }>,
    okMsg: (t?: MetisGoverndTask) => string,
  ): Promise<boolean> => {
    setActionTask(task.taskId)
    setActionMsg(null)
    try {
      const r = await fn()
      if (!r.ok) {
        setActionMsg(`✕ ${task.taskId}: ${r.error ?? 'failed'}`)
        return false
      }
      if (r.task) setSelected((s) => (s && s.taskId === r.task!.taskId ? r.task! : s))
      setActionMsg(okMsg(r.task))
      await load()
      if (r.task) await loadRoutePlan(r.task.taskId)
      return true
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : 'mutation failed')
      return false
    } finally {
      setActionTask(null)
    }
  }, [load])

  const transitionTask = useCallback((task: MetisGoverndTask, toState: string) =>
    mutate(task, () => metisApi.taskUpdate(task.taskId, task.revision, { state: toState }),
      (t) => `${task.taskId} → ${(t?.state ?? toState).replace(/_/g, ' ')}`)
  , [mutate])

  const unblockTask = useCallback((task: MetisGoverndTask) =>
    mutate(task, () => metisApi.taskUpdate(task.taskId, task.revision, { state: 'in_progress', blockerOrNone: 'none' }),
      () => `${task.taskId} unblocked → in progress`)
  , [mutate])

  const completeTask = useCallback((task: MetisGoverndTask) =>
    mutate(task, () => metisApi.taskCorrectState(task.taskId, task.revision, 'done', 'completed via Control Center'),
      () => `${task.taskId} marked done ✓`)
  , [mutate])

  const claimTask = useCallback(async (task: MetisGoverndTask, plan?: MetisTaskRoutePlan | null) => {
    setActionTask(task.taskId)
    setActionMsg(null)
    try {
      const r = await metisApi.taskClaim(task.taskId, routeClaimAgent(plan ?? null), task.title)
      if (!r.ok || !r.claimId) {
        setActionMsg(`✕ claim ${task.taskId}: ${r.error ?? 'no claim-id'}`)
        return null
      }
      setClaims((c) => ({ ...c, [task.taskId]: r.claimId! }))
      setActionMsg(`leased ${task.taskId}${r.fence ? ` · fence ${r.fence}` : ''}`)
      return r.claimId
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : 'claim failed')
      return null
    } finally {
      setActionTask(null)
    }
  }, [])

  const releaseTask = useCallback(async (task: MetisGoverndTask) => {
    const claimId = claims[task.taskId]
    if (!claimId) return
    setActionTask(task.taskId)
    setActionMsg(null)
    try {
      const r = await metisApi.taskUnclaim(claimId)
      if (!r.ok) { setActionMsg(`✕ release ${task.taskId}: ${r.error ?? 'failed'}`); return }
      setClaims((c) => { const n = { ...c }; delete n[task.taskId]; return n })
      setActionMsg(`released ${task.taskId}`)
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : 'release failed')
    } finally {
      setActionTask(null)
    }
  }, [claims])

  const startTask = useCallback(async (task: MetisGoverndTask, suppliedPlan?: MetisTaskRoutePlan) => {
    setActionTask(task.taskId)
    setActionMsg(null)
    try {
      let plan = suppliedPlan
      if (!plan) {
        const route = await metisApi.taskRoutePlan(task.taskId)
        setRoutePlan(route)
        if (route.ok) plan = route.data
      }
      if (plan?.workbenchSpawn.enabled === false) {
        setActionMsg(`${task.taskId}: ${plan.action.label.toLowerCase()} required before work can start`)
        return
      }
      const [workspaces, agents] = await Promise.all([
        ptyApi.listWorkspaces(),
        ptyApi.listAgents({ includeExited: true }),
      ])
      const live = agents.agents.find((a) => a.taskId === task.taskId && a.status === 'running')
      if (live) {
        setActionMsg(`running agent already exists: ${live.name}`)
        nav.goto('agents')
        return
      }
      // Pick the metis-os workspace (no hardcoded path — match the cwd, fall back
      // to the first available), and run the agent in that workspace's cwd.
      const routedCwd = plan?.workbenchSpawn.cwd
      const ws =
        (routedCwd ? workspaces.workspaces.find((w) => w.cwd === routedCwd) : null) ??
        workspaces.workspaces.find((w) => /metis-os\/?$/.test(w.cwd)) ??
        workspaces.workspaces[0]
      if (!ws) throw new Error('no Workbench workspace available')

      // Lease before spinning (idempotent-ish: surface but don't abort if the
      // lease is already held), then move the task into in_progress so the board
      // reflects that work is live the moment the agent starts.
      const routeHasLease = (plan?.activeLeases.length ?? 0) > 0
      if (!claims[task.taskId] && !routeHasLease) await claimTask(task, plan ?? null)
      if (['queued', 'accepted', 'waiting'].includes(task.state)) {
        await metisApi.taskUpdate(task.taskId, task.revision, { state: 'in_progress' })
      } else if (task.state === 'blocked') {
        await metisApi.taskUpdate(task.taskId, task.revision, { state: 'in_progress', blockerOrNone: 'none' })
      }

      const agent = await ptyApi.spawnAgent({
        workspaceId: ws.id,
        kind: routeAgentKind(plan?.workbenchSpawn.kind),
        name: plan?.workbenchSpawn.name || `work:${task.taskId}`,
        cwd: routedCwd || ws.cwd,
        role: routeAgentRole(plan?.workbenchSpawn.role),
        taskId: task.taskId,
        initialPrompt: plan?.workbenchSpawn.initialPrompt || governedTaskPrompt(task),
      })
      setActionMsg(`started ${agent.agent.name}`)
      await load()
      await loadRoutePlan(task.taskId)
      nav.goto('agents')
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : 'failed to start task')
    } finally {
      setActionTask(null)
    }
  }, [nav, claims, claimTask, load, loadRoutePlan])

  return (
    <div data-testid="tasks-mode" className="flex h-full w-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] bg-black/20 px-3 py-2 text-[13px] md:text-[12px]">
        <LayoutList size={14} className="shrink-0 text-cyan-300" />
        <span className="text-[15px] md:text-[13px] font-black uppercase tracking-[0.18em] text-cyan-100">Tasks</span>
        <div className="flex-1" />
        {res && (
          <span className="hidden text-[11px] md:text-[10px] text-[var(--muted)] sm:inline">
            {res.ok ? `fetched ${ageLabel(res.fetchedAt, now)}` : 'no data'}
          </span>
        )}
        <button
          onClick={() => setIncludeDone((v) => !v)}
          className="rounded-lg border border-slate-400/20 bg-black/30 px-2.5 py-1.5 text-[13px] md:text-[11px] text-slate-400 hover:text-slate-200"
        >
          {includeDone ? 'hide done' : 'show done'}
        </button>
        <AnnotateTrigger />
      </div>

      {/* Search + filter bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--line)] bg-black/10 px-3 py-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search tasks…"
          className="w-44 shrink-0 rounded-lg border border-[var(--line)] bg-black/40 px-3 py-1.5 font-mono text-[13px] md:text-[12px] text-slate-200 placeholder-[var(--muted)] focus:border-cyan-300/40 focus:outline-none"
        />
        {raw && STATE_ORDER.filter((s) => (raw.stateCounts[s] ?? 0) > 0).map((s) => {
          const active = stateFilter === s
          const count = active ? (data?.stateCounts[s] ?? 0) : (raw.stateCounts[s] ?? 0)
          const cls = active
            ? (STATE_BG[s] ?? 'bg-slate-400/10 text-slate-400 border-slate-400/15')
            : 'bg-transparent border-[var(--line)] text-[var(--muted)] hover:border-slate-400/40 hover:text-slate-300'
          return (
            <button
              key={s}
              onClick={() => setStateFilter(stateFilter === s ? null : s)}
              className={`rounded-md border px-2.5 py-1.5 text-[11px] md:text-[9px] font-bold uppercase tracking-[0.06em] transition-colors ${cls}`}
            >
              {s.replace(/_/g, ' ')} {count}
            </button>
          )
        })}
        <div className="flex-1" />
        <button
          onClick={() => persistCollapsed(new Set((data?.projects ?? []).map((p) => p.slug)))}
          className="flex items-center gap-1 rounded-lg border border-slate-400/20 bg-black/30 px-2.5 py-1.5 text-[12px] md:text-[10px] text-slate-400 hover:text-slate-200"
          title="collapse every project"
        >
          <ChevronUp size={14} /> collapse
        </button>
        <button
          onClick={() => persistCollapsed(new Set())}
          className="flex items-center gap-1 rounded-lg border border-slate-400/20 bg-black/30 px-2.5 py-1.5 text-[12px] md:text-[10px] text-slate-400 hover:text-slate-200"
          title="expand every project"
        >
          <ChevronDown size={14} /> expand
        </button>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="rounded-lg border border-[var(--line)] bg-black/40 px-2 py-1.5 text-[12px] md:text-[10px] text-[var(--muted)] focus:outline-none"
        >
          <option value="default">sort: default</option>
          <option value="priority">sort: priority</option>
          <option value="updated">sort: updated</option>
          <option value="id">sort: id</option>
        </select>
        {hasFilter && (
          <button
            onClick={() => { setQuery(''); setStateFilter(null); setSortBy('default'); setGoalFilter(null) }}
            className="rounded-lg border border-rose-400/30 bg-transparent px-2.5 py-1.5 text-[12px] md:text-[10px] text-rose-300 hover:border-rose-400/60"
          >
            ✕ clear
          </button>
        )}
      </div>

      {/* Goal-filter banner — set when you drill in from a goal card in the Work
          Map. Makes the active scope obvious and gives a one-tap way out. */}
      {goalFilter && (
        <div className="flex shrink-0 items-center gap-2 border-b border-cyan-300/20 bg-cyan-300/[0.07] px-3 py-2">
          <Target size={13} className="shrink-0 text-cyan-300" />
          <span className="text-[12px] md:text-[11px] text-[var(--muted)]">Goal</span>
          <span className="min-w-0 flex-1 truncate text-[13px] md:text-[12px] font-semibold text-cyan-100">{goalFilter.label}</span>
          <span className="shrink-0 text-[12px] md:text-[11px] text-[var(--muted)]">{data?.projects.reduce((n, p) => n + p.tasks.length, 0) ?? 0} tasks</span>
          <button
            onClick={() => setGoalFilter(null)}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-cyan-300/30 bg-black/20 px-2 py-1 text-[12px] md:text-[11px] text-cyan-100 hover:bg-cyan-300/10"
            title="clear goal filter"
          >
            <X size={13} /> all tasks
          </button>
        </div>
      )}

      {/* Content */}
      {res && !res.ok && <CardError message={res.error} onRetry={load} />}
      {loading && !data && <CardLoading label="Loading task board…" />}
      {data && (
        <div className="flex-1 overflow-y-auto p-3">
          {actionMsg && (
            <div className="mb-3 rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-[13px] md:text-[12px] text-cyan-100">
              {actionMsg}
            </div>
          )}
          {orderedProjects.length === 0 ? (
            <div className="py-8 text-center text-[13px] md:text-[12px] text-[var(--muted)]">
              {hasFilter ? 'No tasks match the current filter.' : 'No open tasks. 🎉'}
            </div>
          ) : (
            orderedProjects.map((g, index) => (
              <ProjectGroup
                key={g.slug}
                project={g}
                collapsed={goalFilter ? false : collapsed.has(g.slug)}
                onToggle={() => toggleProject(g.slug)}
                onMove={(direction) => moveProject(g.slug, direction)}
                canMoveUp={index > 0}
                canMoveDown={index < orderedProjects.length - 1}
                onTaskClick={setSelected}
              />
            ))
          )}
        </div>
      )}

      {selected && (
        <TaskDetail
          task={selected}
          onClose={() => setSelected(null)}
          onStart={startTask}
          onTransition={transitionTask}
          onComplete={completeTask}
          onUnblock={unblockTask}
          onClaim={claimTask}
          onRelease={releaseTask}
          leased={!!claims[selected.taskId]}
          busy={actionTask === selected.taskId}
          routePlan={routePlan}
          routeLoading={routeLoading}
        />
      )}
    </div>
  )
}
