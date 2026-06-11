'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Inbox as InboxIcon, RefreshCw, AlertTriangle, CheckCircle2, Unlock, Play,
  GitMerge, ListChecks, Hourglass, Sparkles, Check, X as X2, ChevronRight, Pencil, Undo2,
} from 'lucide-react'
import { metisApi, ageLabel, type MetisResult } from '@/lib/metis-api'
import type { MetisInbox, MetisGoverndTask, MetisDecision, MetisDecisionContext } from '@/lib/metis-api-types'
import MaterialViewer from './MaterialViewer'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'
import { CardLoading, CardError } from '../overview/cards'
import { useControlCenterNav } from '@/lib/control-center-nav'
import { stateTextCls } from '@/lib/task-state'

// ── Operator inbox (#240 Phase 2) ─────────────────────────────────────────────
// One surface for everything needing Ant's judgment: formal decisions, task
// decision-points, verifications, blockers, parked work. Each task carries the
// SAME actionType badge as the Notion Command Center (classified server-side), so
// the mobile mirror and the Control Center agree. Every act-on-it button routes through
// the governed mutators / the audited decision-resolve endpoint — no raw writes.

// Notion-parity action-type → chip colour (Control Center palette).
const BADGE_CLS: Record<string, string> = {
  '🔀 Decision': 'border-amber-300/30 bg-amber-300/10 text-amber-200',
  '🤝 Agent+you': 'border-fuchsia-300/30 bg-fuchsia-300/10 text-fuchsia-200',
  '🗒️ Checklist': 'border-sky-300/30 bg-sky-300/10 text-sky-200',
  '🤖 Agent': 'border-violet-300/30 bg-violet-300/10 text-violet-200',
}

type InboxSort = 'priority' | 'newest' | 'oldest' | 'project' | 'state'

const SORT_LABEL: Record<InboxSort, string> = {
  priority: 'Priority',
  newest: 'Newest',
  oldest: 'Oldest',
  project: 'Project',
  state: 'State',
}

const PRIORITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 }
const STATE_RANK: Record<string, number> = {
  blocked: 0,
  needs_verification: 1,
  execution_finished: 2,
  waiting: 3,
  inbox: 4,
  queued: 5,
  accepted: 6,
  in_progress: 7,
  done: 8,
}

function timeValue(ts: string | null | undefined): number {
  const n = ts ? Date.parse(ts) : 0
  return Number.isFinite(n) ? n : 0
}

function compareText(a: string | null | undefined, b: string | null | undefined): number {
  return (a ?? '').localeCompare(b ?? '', undefined, { numeric: true, sensitivity: 'base' })
}

function compareTasks(sort: InboxSort, a: MetisGoverndTask, b: MetisGoverndTask): number {
  if (sort === 'newest') return timeValue(b.updatedAt) - timeValue(a.updatedAt) || compareText(a.title, b.title)
  if (sort === 'oldest') return timeValue(a.updatedAt) - timeValue(b.updatedAt) || compareText(a.title, b.title)
  if (sort === 'project') return compareText(a.project, b.project) || compareTasks('priority', a, b)
  if (sort === 'state') return (STATE_RANK[a.state] ?? 99) - (STATE_RANK[b.state] ?? 99) || compareTasks('priority', a, b)
  return (PRIORITY_RANK[a.priority] ?? 99) - (PRIORITY_RANK[b.priority] ?? 99) || timeValue(b.updatedAt) - timeValue(a.updatedAt) || compareText(a.title, b.title)
}

function compareDecisions(sort: InboxSort, a: MetisDecision, b: MetisDecision): number {
  if (sort === 'newest') return timeValue(b.created_at) - timeValue(a.created_at) || compareText(a.title, b.title)
  if (sort === 'oldest') return timeValue(a.created_at) - timeValue(b.created_at) || compareText(a.title, b.title)
  return compareText(a.title, b.title)
}

function ActionBadge({ type }: { type?: string }) {
  if (!type) return null
  return (
    <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${BADGE_CLS[type] ?? 'border-slate-400/20 text-slate-400'}`}>
      {type}
    </span>
  )
}

// ── Section shell ─────────────────────────────────────────────────────────────

function Section({ icon, title, accent, count, children }: {
  icon: React.ReactNode
  title: string
  accent: string
  count: number
  children: React.ReactNode
}) {
  if (count === 0) return null
  return (
    <div className="mb-4">
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <span className={accent}>{icon}</span>
        <span className="text-[13px] md:text-[12px] font-bold uppercase tracking-[0.12em] text-slate-200">{title}</span>
        <span className="rounded-full bg-white/5 px-1.5 text-[11px] md:text-[10px] text-[var(--muted)]">{count}</span>
      </div>
      <div className="mc-stagger flex flex-col gap-1.5">{children}</div>
    </div>
  )
}

// ── Task item card ────────────────────────────────────────────────────────────

// Done-gate strip — shows the 5 conditions and what's still missing, so "Pass"
// reads as evidence-gated rather than a blind button (#240 Phase 4).
function GateStrip({ task }: { task: MetisGoverndTask }) {
  const g = task.doneGate
  if (!g) return null
  return (
    <div className={`mt-2 rounded-lg border px-2.5 py-1.5 ${g.ready ? 'border-emerald-300/25 bg-emerald-300/5' : 'border-[var(--line)] bg-black/20'}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`text-[11px] md:text-[10px] font-bold uppercase tracking-[0.1em] ${g.ready ? 'text-emerald-300' : 'text-[var(--muted)]'}`}>
          {g.ready ? 'Ready to ship' : `Done-gate ${g.checks.filter((c) => c.ok).length}/${g.checks.length}`}
        </span>
        {g.checks.map((c) => (
          <span key={c.label} className={`flex items-center gap-0.5 text-[11px] md:text-[10px] ${c.ok ? 'text-emerald-200/70' : 'text-rose-300/80'}`}>
            {c.ok ? <Check size={11} /> : <X2 size={11} />} {c.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function ItemCard({ task, now, actions, gate, onOpen }: {
  task: MetisGoverndTask
  now: number
  actions: React.ReactNode
  gate?: boolean
  onOpen?: () => void
}) {
  const p1 = task.priority === 'P1'
  return (
    <div
      onClick={onOpen}
      className={`rounded-xl border border-[var(--line)] bg-gradient-to-b from-white/[0.025] to-black/25 p-3 backdrop-blur-sm ${onOpen ? 'cursor-pointer transition-colors hover:border-cyan-300/30 hover:from-cyan-300/[0.04] active:bg-cyan-300/5' : ''}`}
    >
      <div className="flex items-start gap-2">
        {/* No action-type chip here — the section header already groups by type,
            so a per-card badge is redundant (mobile annotation, #240). */}
        <div className="min-w-0 flex-1">
          <div className={`truncate text-[13px] ${p1 ? 'font-semibold text-slate-50' : 'font-medium text-slate-200'}`}>
            {task.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] md:text-[10px] text-[var(--muted)]">
            <span className="font-mono">{task.taskId}</span>
            <span className={`font-bold ${stateTextCls(task.state)}`}>{task.state.replace(/_/g, ' ')}</span>
            {task.project && <span>{task.project}</span>}
            <span>{ageLabel(task.updatedAt, now)}</span>
          </div>
        </div>
        {onOpen && <ChevronRight size={15} className="mt-0.5 shrink-0 text-[var(--muted)] opacity-50" />}
      </div>
      {task.nextDecisionPoint && (
        <div className="mt-2 rounded-lg border border-amber-300/20 bg-amber-300/5 px-2.5 py-1.5 text-[12px] md:text-[11px] text-amber-100">
          <span className="font-bold">Decide:</span> {task.nextDecisionPoint}
        </div>
      )}
      {task.blocker && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-rose-400/20 bg-rose-400/5 px-2.5 py-1.5 text-[12px] md:text-[11px] text-rose-200">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {task.blocker}
        </div>
      )}
      {task.state === 'needs_verification' && task.verificationMethod && (
        <div className="mt-2 rounded-lg border border-cyan-300/20 bg-cyan-300/5 px-2.5 py-1.5 text-[12px] md:text-[11px] text-cyan-100">
          <span className="font-bold">Verify by:</span> {task.verificationMethod}
        </div>
      )}
      {gate && <GateStrip task={task} />}
      <div className="mt-2.5 flex flex-wrap gap-1.5">{actions}</div>
    </div>
  )
}

// Compact action button used inside cards.
function ActBtn({ onClick, disabled, tone = 'neutral', icon, label, title }: {
  onClick: () => void
  disabled: boolean
  tone?: 'go' | 'warn' | 'danger' | 'neutral' | 'decide'
  icon?: React.ReactNode
  label: string
  title?: string
}) {
  const tones: Record<string, string> = {
    go: 'border-emerald-300/30 bg-emerald-300/10 text-emerald-100 hover:bg-emerald-300/20',
    decide: 'border-amber-300/30 bg-amber-300/10 text-amber-100 hover:bg-amber-300/20',
    warn: 'border-slate-400/25 bg-black/30 text-slate-300 hover:border-cyan-300/40 hover:text-cyan-100',
    danger: 'border-rose-400/30 bg-transparent text-rose-300 hover:bg-rose-400/10',
    neutral: 'border-slate-400/25 bg-black/30 text-slate-300 hover:text-slate-100',
  }
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      disabled={disabled}
      title={title}
      className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] md:text-[11px] font-semibold disabled:opacity-50 ${tones[tone]}`}
    >
      {icon} {label}
    </button>
  )
}

// ── Decision card ─────────────────────────────────────────────────────────────

function DecisionCard({ decision, busy, onResolve, onUpdate }: {
  decision: MetisDecision
  busy: boolean
  onResolve: (d: MetisDecision, chosen: string, rationale: string) => void
  onUpdate: (d: MetisDecision, patch: Record<string, unknown>) => void
}) {
  const [rationale, setRationale] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => ({
    title: decision.title ?? '',
    context: decision.context ?? '',
    task_context: decision.task_context ?? '',
    options: (decision.options ?? []).join('\n'),
    recommended: decision.recommended ?? '',
    criteria: (decision.criteria ?? []).join('\n'),
  }))
  return (
    <div className="rounded-xl border border-amber-300/20 bg-[#1a1710]/70 p-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-slate-50">{decision.title}</div>
        {(decision.context || decision.task_context) && (
          <div className="mt-0.5 text-[12px] md:text-[11px] text-[var(--muted)]">{decision.context ?? decision.task_context}</div>
        )}
      </div>
      {editing && (
        <div className="mt-3 rounded-xl border border-amber-300/20 bg-black/25 p-3">
          <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-200/70">Edit decision</div>
          <EditInput label="Title" value={draft.title} onChange={(v) => setDraft((d) => ({ ...d, title: v }))} />
          <EditTextarea label="Context" value={draft.context} onChange={(v) => setDraft((d) => ({ ...d, context: v }))} />
          <EditInput label="Task context" value={draft.task_context} onChange={(v) => setDraft((d) => ({ ...d, task_context: v }))} />
          <EditTextarea label="Options" value={draft.options} onChange={(v) => setDraft((d) => ({ ...d, options: v }))} hint="one option per line" />
          <EditInput label="Recommended" value={draft.recommended} onChange={(v) => setDraft((d) => ({ ...d, recommended: v }))} />
          <EditTextarea label="Criteria" value={draft.criteria} onChange={(v) => setDraft((d) => ({ ...d, criteria: v }))} hint="one criterion per line" />
          <div className="mt-2 flex gap-1.5">
            <button
              onClick={() => onUpdate(decision, draft)}
              disabled={busy}
              className="h-9 rounded-lg border border-emerald-300/30 bg-emerald-300/10 px-3 text-[12px] font-bold text-emerald-100 hover:bg-emerald-300/20 disabled:opacity-50"
            >
              Save decision
            </button>
            <button
              onClick={() => setEditing(false)}
              className="h-9 rounded-lg border border-slate-400/25 bg-black/30 px-3 text-[12px] font-bold text-slate-300 hover:text-slate-100"
            >
              Close
            </button>
          </div>
        </div>
      )}
      <input
        type="text"
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        placeholder="rationale (optional)…"
        className="mt-2.5 w-full rounded-lg border border-[var(--line)] bg-black/40 px-2.5 py-1.5 font-mono text-[12px] md:text-[11px] text-slate-200 placeholder-[var(--muted)] focus:border-amber-300/40 focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button
          onClick={() => setEditing((v) => !v)}
          disabled={busy}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-400/25 bg-black/30 px-3 text-[12px] md:text-[11px] font-semibold text-slate-200 hover:border-amber-300/40 hover:text-amber-100 disabled:opacity-50"
        >
          <Pencil size={13} /> Edit
        </button>
        {decision.options.map((opt) => {
          const rec = decision.recommended === opt
          return (
            <button
              key={opt}
              onClick={() => onResolve(decision, opt, rationale.trim() || 'chosen via Control Center inbox')}
              disabled={busy}
              title={rec ? 'recommended' : `choose ${opt}`}
              className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] md:text-[11px] font-semibold disabled:opacity-50 ${
                rec
                  ? 'border-emerald-300/40 bg-emerald-300/15 text-emerald-100 hover:bg-emerald-300/25'
                  : 'border-slate-400/25 bg-black/30 text-slate-200 hover:border-amber-300/40 hover:text-amber-100'
              }`}
            >
              {rec && <Sparkles size={13} />} {opt}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function EditInput({ label, value, onChange, hint }: { label: string; value: string; onChange: (value: string) => void; hint?: string }) {
  return (
    <label className="mb-2 block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-lg border border-[var(--line)] bg-black/40 px-2.5 font-mono text-[12px] text-slate-100 focus:border-cyan-300/40 focus:outline-none"
      />
      {hint && <span className="mt-0.5 block text-[10px] text-[var(--muted)]">{hint}</span>}
    </label>
  )
}

function EditTextarea({ label, value, onChange, hint, rows = 3 }: { label: string; value: string; onChange: (value: string) => void; hint?: string; rows?: number }) {
  return (
    <label className="mb-2 block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">{label}</span>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="w-full resize-y rounded-lg border border-[var(--line)] bg-black/40 px-2.5 py-2 font-mono text-[12px] text-slate-100 focus:border-cyan-300/40 focus:outline-none"
      />
      {hint && <span className="mt-0.5 block text-[10px] text-[var(--muted)]">{hint}</span>}
    </label>
  )
}

// ── Task detail slide-over ────────────────────────────────────────────────────
// Opening an inbox item shows its full context (mobile cards are too small to
// carry why/how + the decision text). For a Decide item it also exposes a
// recorder so the call is captured — the decision becomes the task's nextAction
// (what the agent does next) and the decision-point gate clears in one move.

// Extract one-tap options from a freeform decision point — mirrors the Notion
// classifier's option-detection so simple calls (yes/no, option a/b/c, x/y/z)
// become buttons instead of forcing a textarea. Returns null when it can't tell
// (→ freeform recorder). Caps at 4.
function decisionOptions(text: string | null | undefined): string[] | null {
  if (!text) return null
  const t = text.toLowerCase()
  // option a/b/c (≥2 distinct)
  const letters = [...text.matchAll(/\boption\s+([a-d])\b/gi)].map((m) => 'Option ' + m[1].toUpperCase())
  const uniq = [...new Set(letters)]
  if (uniq.length >= 2) return uniq.slice(0, 4)
  // approve-style gates (approve / sign-off / green-light / reviews-and-sends)
  if (/\bapprov(e|al)|sign[\s-]?off|green[\s-]?light|reviews?\s+and\s+sends?\b/.test(t)) return ['Approve', 'Reject']
  // explicit yes/no, or "whether to <act>" with no competing "or" alternative
  if (/\by\/n\b|yes\s*\/\s*no/.test(t)) return ['Yes', 'No']
  if (/\bwhether to\b/.test(t) && !/\bor\b/.test(t)) return ['Yes', 'No']
  // short slash list a/b/c — only when each side is a tidy token (avoids TCP/IP-style noise)
  const m = text.match(/\b([A-Za-z][\w'-]{1,18})\s*\/\s*([A-Za-z][\w'-]{1,18})(?:\s*\/\s*([A-Za-z][\w'-]{1,18}))?\b/)
  if (m && !/\b(https?|tcp|ip|ca|os|ui|api)\b/i.test(m[0])) return [m[1], m[2], m[3]].filter(Boolean).map((s) => (s as string).trim()).slice(0, 4)
  return null
}

function DField({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value || value === 'none') return null
  return (
    <div className="mb-3">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
      <div className="text-[13px] md:text-[12px] leading-relaxed text-slate-300">{value}</div>
    </div>
  )
}

// Curated decision frame (#240 review redesign): only what's needed to make the
// call — the why-context, the resolved task references (with their live state),
// and the spec/file paths the decision touches. Replaces dumping every task field
// into the decide view. Each ref/spec is its OWN visible element so "review the
// linked spec" is actually linked, and missing context (refs that resolve) is
// surfaced rather than left as a bare "#213".
function DecisionFrame({ ctx }: { ctx: MetisDecisionContext }) {
  const hasRefs = ctx.refs.length > 0
  const hasSpecs = ctx.specs.length > 0
  if (!ctx.context && !hasRefs && !hasSpecs) return null
  return (
    <div className="mt-3 space-y-3 border-t border-amber-300/15 pt-3">
      {ctx.context && (
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-200/70">Context</div>
          <div className="text-[13px] md:text-[12px] leading-relaxed text-slate-300">{ctx.context}</div>
        </div>
      )}
      {hasRefs && (
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-200/70">Referenced tasks</div>
          <div className="flex flex-col gap-1">
            {ctx.refs.map((r) => (
              <div key={r.taskId} className="flex items-center gap-2 rounded-lg border border-[var(--line)] bg-black/30 px-2.5 py-1.5">
                <span className="shrink-0 font-mono text-[12px] md:text-[11px] text-cyan-200">{r.taskId}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] md:text-[11px] text-slate-300">{r.title ?? '— unknown task —'}</span>
                {r.state && <span className={`shrink-0 text-[11px] md:text-[10px] font-bold ${stateTextCls(r.state)}`}>{r.state.replace(/_/g, ' ')}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {hasSpecs && (
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-200/70">Specs / files</div>
          <div className="flex flex-wrap gap-1.5">
            {ctx.specs.map((s) => (
              <span key={s} className="rounded-md border border-cyan-300/20 bg-cyan-300/5 px-1.5 py-0.5 font-mono text-[11px] md:text-[10px] text-cyan-200/90">{s}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function InboxTaskDetail({ task, busy, onClose, onRecord, onSaveTask, actions }: {
  task: MetisGoverndTask
  busy: boolean
  onClose: () => void
  onRecord: (task: MetisGoverndTask, decision: string) => void
  onSaveTask: (task: MetisGoverndTask, patch: Record<string, unknown>) => void
  actions: React.ReactNode
}) {
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => ({
    title: task.title ?? '',
    priority: task.priority ?? '',
    state: task.state ?? '',
    project: task.project ?? '',
    owner: task.owner ?? '',
    agent: task.agent ?? '',
    machine: task.machine ?? '',
    summary: task.summary ?? '',
    why: task.why ?? '',
    how: task.how ?? '',
    firstStep: task.firstStep ?? '',
    currentStep: task.currentStep ?? '',
    nextAction: task.nextAction ?? '',
    nextDecisionPoint: task.nextDecisionPoint ?? '',
    expectedArtifact: task.expectedArtifact ?? '',
    verificationMethod: task.verificationMethod ?? '',
    blockerOrNone: task.blocker ?? 'none',
  }))
  const isDecide = !!task.nextDecisionPoint
  const opts = decisionOptions(task.nextDecisionPoint)
  const ctx = task.decisionContext
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/60" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-[var(--line)] bg-[var(--panel)] shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] py-3 pl-2 pr-4">
          <button onClick={onClose} aria-label="close" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--muted)] hover:bg-white/5 hover:text-slate-200">
            <X2 size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] md:text-[13px] font-semibold text-slate-50">{task.title}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] md:text-[11px]">
              <span className="font-mono text-[var(--muted)]">{task.taskId}</span>
              <span className={`font-bold ${stateTextCls(task.state)}`}>{task.state.replace(/_/g, ' ')}</span>
              {task.project && <span className="text-[var(--muted)]">{task.project}</span>}
              <ActionBadge type={task.actionType} />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 font-mono text-[12px]">
          <div className="mb-4 flex gap-1.5">
            <button
              onClick={() => setEditing((v) => !v)}
              className="h-9 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-3 text-[12px] font-bold text-cyan-100 hover:bg-cyan-300/20"
            >
              {editing ? 'Close edit' : 'Edit task'}
            </button>
          </div>
          {editing && (
            <div className="mb-4 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-3">
              <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-cyan-200/80">Full task edit</div>
              <EditInput label="Title" value={draft.title} onChange={(v) => setDraft((d) => ({ ...d, title: v }))} />
              <div className="grid grid-cols-2 gap-2">
                <EditInput label="Priority" value={draft.priority} onChange={(v) => setDraft((d) => ({ ...d, priority: v }))} />
                <EditInput label="State" value={draft.state} onChange={(v) => setDraft((d) => ({ ...d, state: v }))} />
                <EditInput label="Project" value={draft.project} onChange={(v) => setDraft((d) => ({ ...d, project: v }))} />
                <EditInput label="Owner" value={draft.owner} onChange={(v) => setDraft((d) => ({ ...d, owner: v }))} />
                <EditInput label="Agent" value={draft.agent} onChange={(v) => setDraft((d) => ({ ...d, agent: v }))} />
                <EditInput label="Machine" value={draft.machine} onChange={(v) => setDraft((d) => ({ ...d, machine: v }))} />
              </div>
              <EditTextarea label="Summary" value={draft.summary} onChange={(v) => setDraft((d) => ({ ...d, summary: v }))} />
              <EditTextarea label="Why" value={draft.why} onChange={(v) => setDraft((d) => ({ ...d, why: v }))} />
              <EditTextarea label="How" value={draft.how} onChange={(v) => setDraft((d) => ({ ...d, how: v }))} />
              <EditTextarea label="First step" value={draft.firstStep} onChange={(v) => setDraft((d) => ({ ...d, firstStep: v }))} />
              <EditTextarea label="Current step" value={draft.currentStep} onChange={(v) => setDraft((d) => ({ ...d, currentStep: v }))} />
              <EditTextarea label="Next action" value={draft.nextAction} onChange={(v) => setDraft((d) => ({ ...d, nextAction: v }))} />
              <EditTextarea label="Next decision point" value={draft.nextDecisionPoint} onChange={(v) => setDraft((d) => ({ ...d, nextDecisionPoint: v }))} />
              <EditTextarea label="Expected artifact" value={draft.expectedArtifact} onChange={(v) => setDraft((d) => ({ ...d, expectedArtifact: v }))} />
              <EditTextarea label="Verification method" value={draft.verificationMethod} onChange={(v) => setDraft((d) => ({ ...d, verificationMethod: v }))} />
              <EditTextarea label="Blocker" value={draft.blockerOrNone} onChange={(v) => setDraft((d) => ({ ...d, blockerOrNone: v }))} />
              <button
                onClick={() => onSaveTask(task, draft)}
                disabled={busy}
                className="mt-1 h-10 w-full rounded-lg border border-emerald-300/30 bg-emerald-300/10 text-[13px] font-bold text-emerald-100 hover:bg-emerald-300/20 disabled:opacity-50"
              >
                Save task
              </button>
            </div>
          )}
          {isDecide && (
            <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-300/5 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-amber-200">
                <GitMerge size={13} /> Decision needed
              </div>
              <div className="text-[13px] font-semibold leading-snug text-amber-50">{ctx?.question ?? task.nextDecisionPoint}</div>
              {/* Curated context: the why + resolved task refs + spec paths the
                  decision touches — only what's needed to make the call. */}
              {ctx && <DecisionFrame ctx={ctx} />}
              {/* The actual material to review — a condensed brief by default,
                  full doc one tap away. Decide in-card, no doc-hunting. */}
              {task.material?.files?.length ? (
                <div className="mt-3"><MaterialViewer material={task.material} /></div>
              ) : null}
              <div className="mb-3 mt-3 border-t border-amber-300/15 pt-3 text-[10px] font-bold uppercase tracking-[0.14em] text-amber-200/70">Your call</div>
              {/* Recorder lives in the scrollable body (not the footer) so the
                  mobile keyboard never covers it. One-tap options + freeform. */}
              {opts && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {opts.map((o) => (
                    <button key={o} onClick={() => onRecord(task, o)} disabled={busy}
                      className="flex h-10 items-center gap-1.5 rounded-lg border border-amber-300/40 bg-amber-300/15 px-3.5 text-[13px] font-bold text-amber-100 hover:bg-amber-300/30 disabled:opacity-50">
                      <CheckCircle2 size={15} /> {o}
                    </button>
                  ))}
                </div>
              )}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                autoFocus={!opts}
                placeholder={opts ? 'Other / add a note…' : 'Type your decision / the direction to take…'}
                className="w-full resize-none rounded-lg border border-amber-300/20 bg-black/40 px-2.5 py-2 font-mono text-[13px] md:text-[12px] text-slate-100 placeholder-[var(--muted)] focus:border-amber-300/50 focus:outline-none"
              />
              <button
                onClick={() => onRecord(task, text.trim())}
                disabled={busy}
                className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-amber-300/30 bg-amber-300/10 text-[13px] font-bold text-amber-100 hover:bg-amber-300/20 disabled:opacity-50"
              >
                <CheckCircle2 size={18} /> {text.trim() ? 'Record decision' : 'Clear decision gate'}
              </button>
            </div>
          )}
          {/* For a Decide item the curated frame above carries the relevant
              context; the build-mechanics fields (how / expected artifact /
              verification / step) are noise to the decision and are suppressed.
              Non-decide items still show the full record. */}
          {!isDecide && task.material?.files?.length ? (
            <div className="mb-3">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">To review</div>
              <MaterialViewer material={task.material} />
            </div>
          ) : null}
          {!isDecide && (
            <>
              <DField label="Summary" value={task.summary} />
              <DField label="Why" value={task.why} />
              <DField label="How" value={task.how} />
              <DField label={task.currentStep ? 'Current step' : 'First step'} value={task.currentStep ?? task.firstStep} />
              <DField label="Next action" value={task.nextAction} />
              <DField label="Expected artifact" value={task.expectedArtifact} />
              <DField label="Verification method" value={task.verificationMethod} />
            </>
          )}
          {task.blocker && (
            <div className="mb-3">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-rose-400">Blocker</div>
              <div className="flex items-start gap-1.5 text-[12px] text-rose-300"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {task.blocker}</div>
            </div>
          )}
          <div className="mt-3 border-t border-[var(--line)] pt-3 text-[10px] text-[var(--muted)]">updated {task.updatedAt?.slice(0, 10)} · rev {task.revision} · owner {task.owner ?? '—'}</div>
        </div>

        {/* Footer: bucket actions only (the decision recorder lives in the body
            above so the keyboard can't cover it). */}
        <div className="shrink-0 space-y-2 border-t border-[var(--line)] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),12px)]">
          <div className="flex flex-wrap gap-1.5">{actions}</div>
        </div>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function InboxMode() {
  const nav = useControlCenterNav()
  const [res, setRes] = useState<MetisResult<MetisInbox> | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [busyId, setBusyId] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [detail, setDetail] = useState<MetisGoverndTask | null>(null)
  const [sort, setSort] = useState<InboxSort>('priority')
  // 8s undo window after a decision collapses (misclick safety net).
  const [undo, setUndo] = useState<{ taskId: string; decisionId?: string; prevPoint: string; prevAction: string; rev: number; label: string } | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await metisApi.inbox()
    setRes(r)
    setNow(Date.now())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    timer.current = setInterval(load, 60000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [load])

  // Shared mutation runner: mark busy, run the governed write, refresh on success,
  // surface any error (incl. 409 / done-gate) inline. Nothing optimistic.
  const mutate = useCallback(async (
    id: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
    okMsg: string,
  ) => {
    setBusyId(id)
    setMsg(null)
    try {
      const r = await fn()
      if (!r.ok) { setMsg(`✕ ${id}: ${r.error ?? 'failed'}`); return }
      setMsg(okMsg)
      await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'mutation failed')
    } finally {
      setBusyId(null)
    }
  }, [load])

  // Record a decision: capture WHAT was decided as the task's nextAction (so the
  // executing agent picks it up) and clear the decision-point gate, in one
  // governed write. Empty text → just clear the gate. Closes detail on success.
  const armUndo = useCallback((u: { taskId: string; decisionId?: string; prevPoint: string; prevAction: string; rev: number; label: string }) => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndo(u)
    undoTimer.current = setTimeout(() => setUndo(null), 8000)
  }, [])

  const recordDecision = useCallback(async (task: MetisGoverndTask, decision: string) => {
    setBusyId(task.taskId)
    setMsg(null)
    const prevPoint = task.nextDecisionPoint ?? 'none'
    const prevAction = task.nextAction ?? 'none'
    try {
      // A non-empty answer is logged as a tracked decision (decisions.json) AND
      // advances the task. Empty just clears the gate (no decision to log).
      const r = decision
        ? await metisApi.taskDecide(task.taskId, task.revision, decision, task.nextDecisionPoint ?? undefined, decisionOptions(task.nextDecisionPoint) ?? undefined)
        : await metisApi.taskUpdate(task.taskId, task.revision, { nextDecisionPoint: '' })
      if (!r.ok) { setMsg(`✕ ${task.taskId}: ${r.error ?? 'failed'}`); return }
      setDetail(null)
      if (decision) {
        setMsg(null)
        armUndo({ taskId: task.taskId, decisionId: r.decisionId, prevPoint, prevAction, rev: r.task?.revision ?? task.revision + 1, label: `${task.taskId}: ${decision}` })
      } else {
        setMsg(`${task.taskId} gate cleared`)
      }
      await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'failed')
    } finally {
      setBusyId(null)
    }
  }, [load, armUndo])

  const undoDecision = useCallback(async () => {
    if (!undo) return
    if (undoTimer.current) clearTimeout(undoTimer.current)
    const u = undo
    setUndo(null)
    setBusyId(u.taskId)
    try {
      const r = await metisApi.taskDecideUndo(u.taskId, u.rev, u.decisionId, u.prevPoint, u.prevAction)
      setMsg(r.ok ? `${u.taskId} decision undone` : `✕ undo ${u.taskId}: ${r.error ?? 'failed'}`)
      await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'undo failed')
    } finally {
      setBusyId(null)
    }
  }, [undo, load])

  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current) }, [])

  const saveTaskEdit = useCallback(async (task: MetisGoverndTask, patch: Record<string, unknown>) => {
    setBusyId(task.taskId)
    setMsg(null)
    const normalized = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]))
    try {
      const r = await metisApi.taskUpdate(task.taskId, task.revision, normalized)
      if (!r.ok) { setMsg(`✕ ${task.taskId}: ${r.error ?? 'save failed'}`); return }
      setMsg(`${task.taskId} updated`)
      if (r.task) setDetail(r.task)
      await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'save failed')
    } finally {
      setBusyId(null)
    }
  }, [load])

  const saveDecisionEdit = useCallback(async (decision: MetisDecision, patch: Record<string, unknown>) => {
    setBusyId(decision.decision_id)
    setMsg(null)
    try {
      const r = await metisApi.updateDecision(decision.decision_id, patch)
      if (!r.ok) { setMsg(`✕ ${decision.decision_id}: ${r.error ?? 'save failed'}`); return }
      setMsg(`${decision.decision_id} updated`)
      await load()
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'decision save failed')
    } finally {
      setBusyId(null)
    }
  }, [load])

  const data = res?.ok ? res.data : null
  const b = data?.buckets
  const sortedDecisions = useMemo(() => [...(data?.decisions ?? [])].sort((a, b) => compareDecisions(sort, a, b)), [data?.decisions, sort])
  const sortedBuckets = useMemo(() => ({
    decide: [...(b?.decide ?? [])].sort((a, b) => compareTasks(sort, a, b)),
    verify: [...(b?.verify ?? [])].sort((a, b) => compareTasks(sort, a, b)),
    unblock: [...(b?.unblock ?? [])].sort((a, b) => compareTasks(sort, a, b)),
    waiting: [...(b?.waiting ?? [])].sort((a, b) => compareTasks(sort, a, b)),
  }), [b, sort])

  // The bucket-appropriate action buttons for a task — reused in both the card
  // and the detail slide-over footer so they never drift.
  const bucketActions = (t: MetisGoverndTask): React.ReactNode => {
    const busy = busyId === t.taskId
    if (t.nextDecisionPoint) {
      const opts = decisionOptions(t.nextDecisionPoint)
      // Structured call → one-tap option buttons right on the card; freeform/extra
      // context → "Other…" opens the detail recorder.
      return (<>
        {opts?.map((o) => (
          <ActBtn key={o} onClick={() => recordDecision(t, o)} disabled={busy} tone="decide"
            icon={<CheckCircle2 size={14} />} label={o} title={`record "${o}" and clear the gate`} />
        ))}
        <ActBtn onClick={() => setDetail(t)} disabled={busy} tone="neutral"
          icon={<Pencil size={14} />} label={opts ? 'Other…' : 'Decide…'} title="open to record a freeform decision" />
      </>)
    }
    if (t.state === 'needs_verification' || t.state === 'execution_finished') {
      const ready = t.doneGate?.ready ?? true
      return (<>
        <ActBtn onClick={() => mutate(t.taskId, () => metisApi.taskCorrectState(t.taskId, t.revision, 'done', 'verified via Control Center inbox'), `${t.taskId} done ✓`)}
          disabled={busy || !ready} tone="go" icon={<CheckCircle2 size={14} />} label="Pass" title={ready ? 'mark done' : 'done-gate not satisfied'} />
        <ActBtn onClick={() => mutate(t.taskId, () => metisApi.taskUpdate(t.taskId, t.revision, { state: 'in_progress' }), `${t.taskId} → in progress`)}
          disabled={busy} tone="warn" label="Needs work" title="send back to in-progress" />
      </>)
    }
    if (t.state === 'blocked') {
      return (
        <ActBtn onClick={() => mutate(t.taskId, () => metisApi.taskUpdate(t.taskId, t.revision, { state: 'in_progress', blockerOrNone: 'none' }), `${t.taskId} unblocked`)}
          disabled={busy} tone="go" icon={<Unlock size={14} />} label="Unblock" title="clear the blocker and resume" />
      )
    }
    if (t.state === 'waiting') {
      return (
        <ActBtn onClick={() => mutate(t.taskId, () => metisApi.taskUpdate(t.taskId, t.revision, { state: 'in_progress' }), `${t.taskId} resumed`)}
          disabled={busy} tone="go" icon={<Play size={14} />} label="Resume" title="resume work" />
      )
    }
    return null
  }

  return (
    <div data-testid="inbox-mode" className="flex h-full w-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] bg-black/20 px-3 py-2 text-[13px] md:text-[12px]">
        <InboxIcon size={14} className="shrink-0 text-cyan-300" />
        <span className="text-[15px] md:text-[13px] font-black uppercase tracking-[0.18em] text-cyan-100">Inbox</span>
        {data && <span className="rounded-full bg-cyan-300/10 px-2 text-[12px] md:text-[11px] font-bold text-cyan-200">{data.counts.total}</span>}
        <div className="flex-1" />
        {res && (
          <span className="hidden text-[11px] md:text-[10px] text-[var(--muted)] sm:inline">
            {res.ok ? `fetched ${ageLabel(res.fetchedAt, now)}` : 'no data'}
          </span>
        )}
        <button
          onClick={load}
          title="Refresh"
          className="flex items-center gap-1.5 rounded-lg border border-slate-400/20 bg-black/30 px-2.5 py-1.5 text-[13px] md:text-[11px] text-slate-300 hover:border-cyan-300/40 hover:text-cyan-100"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> refresh
        </button>
        <AnnotateTrigger />
      </div>

      {/* Content */}
      {res && !res.ok && <CardError message={res.error} onRetry={load} />}
      {loading && !data && <CardLoading label="Loading operator inbox…" />}
      {data && (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="mb-3 flex items-center gap-2 overflow-x-auto rounded-xl border border-[var(--line)] bg-black/20 px-2 py-1.5">
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">Sort</span>
            {(['priority', 'newest', 'oldest', 'project', 'state'] as InboxSort[]).map((id) => {
              const active = id === sort
              return (
                <button
                  key={id}
                  onClick={() => setSort(id)}
                  className={`h-8 shrink-0 rounded-lg border px-2.5 text-[11px] font-bold ${
                    active
                      ? 'border-cyan-300/50 bg-cyan-300/10 text-cyan-100'
                      : 'border-transparent text-slate-400 hover:border-cyan-300/25 hover:text-slate-200'
                  }`}
                >
                  {SORT_LABEL[id]}
                </button>
              )
            })}
          </div>
          {msg && (
            <div className="mb-3 rounded-lg border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-[13px] md:text-[12px] text-cyan-100">{msg}</div>
          )}
          {undo && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[13px] md:text-[12px] text-amber-100">
              <CheckCircle2 size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">Logged · {undo.label}</span>
              <button
                onClick={undoDecision}
                className="flex shrink-0 items-center gap-1 rounded-md border border-amber-300/40 bg-amber-300/15 px-2 py-1 font-bold hover:bg-amber-300/25"
              >
                <Undo2 size={13} /> Undo
              </button>
            </div>
          )}

          {/* Focus banner — surfaces an explicit "waiting on Ant" / cross-task blocker */}
          {(data.focus.waitingOnAnt || data.focus.blockerSummary) && (
            <div className="mb-3 rounded-xl border border-amber-300/25 bg-amber-300/5 px-3 py-2.5">
              <div className="flex items-center gap-2 text-[12px] md:text-[11px] font-bold uppercase tracking-[0.1em] text-amber-200">
                <AlertTriangle size={13} /> {data.focus.waitingOnAnt ? 'Waiting on you' : 'Active blocker'}
              </div>
              {data.focus.blockerSummary && <div className="mt-1 text-[13px] md:text-[12px] text-amber-100">{data.focus.blockerSummary}</div>}
              {data.focus.focusSummary && <div className="mt-1 text-[12px] md:text-[11px] text-[var(--muted)]">{data.focus.focusSummary}</div>}
            </div>
          )}

          {data.counts.total === 0 ? (
            <div className="py-12 text-center text-[13px] text-[var(--muted)]">
              <CheckCircle2 size={28} className="mx-auto mb-2 text-emerald-300/60" />
              Nothing needs you right now. 🎉
            </div>
          ) : (
            <>
              {/* Formal decisions (decide.py) — resolvable inline */}
              <Section icon={<GitMerge size={14} />} title="Decisions" accent="text-amber-300" count={data.decisions.length}>
                {sortedDecisions.map((d) => (
                  <DecisionCard
                    key={d.decision_id}
                    decision={d}
                    busy={busyId === d.decision_id}
                    onUpdate={saveDecisionEdit}
                    onResolve={(dec, chosen, rationale) =>
                      mutate(dec.decision_id, () => metisApi.resolveDecision(dec.decision_id, chosen, rationale), `${dec.decision_id} → ${chosen}`)
                    }
                  />
                ))}
              </Section>

              {/* Task decision points — tap to open + record the call */}
              <Section icon={<GitMerge size={14} />} title="Decide" accent="text-amber-300" count={b?.decide.length ?? 0}>
                {sortedBuckets.decide.map((t) => (
                  <ItemCard key={t.taskId} task={t} now={now} onOpen={() => setDetail(t)} actions={bucketActions(t)} />
                ))}
              </Section>

              {/* Needs verification — pass (→done) or send back */}
              <Section icon={<ListChecks size={14} />} title="Verify" accent="text-cyan-300" count={b?.verify.length ?? 0}>
                {sortedBuckets.verify.map((t) => (
                  <ItemCard key={t.taskId} task={t} now={now} gate onOpen={() => setDetail(t)} actions={bucketActions(t)} />
                ))}
              </Section>

              {/* Blocked — unblock to in-progress */}
              <Section icon={<Unlock size={14} />} title="Unblock" accent="text-rose-300" count={b?.unblock.length ?? 0}>
                {sortedBuckets.unblock.map((t) => (
                  <ItemCard key={t.taskId} task={t} now={now} onOpen={() => setDetail(t)} actions={bucketActions(t)} />
                ))}
              </Section>

              {/* Waiting — resume */}
              <Section icon={<Hourglass size={14} />} title="Waiting" accent="text-slate-300" count={b?.waiting.length ?? 0}>
                {sortedBuckets.waiting.map((t) => (
                  <ItemCard key={t.taskId} task={t} now={now} onOpen={() => setDetail(t)} actions={bucketActions(t)} />
                ))}
              </Section>

              <button
                onClick={() => nav.goto('tasks')}
                className="mt-2 w-full rounded-lg border border-[var(--line)] bg-black/20 py-2 text-[12px] md:text-[11px] text-[var(--muted)] hover:border-cyan-300/30 hover:text-cyan-100"
              >
                Open full task board →
              </button>
            </>
          )}
        </div>
      )}

      {detail && (
        <InboxTaskDetail
          task={detail}
          busy={busyId === detail.taskId}
          onClose={() => setDetail(null)}
          onRecord={recordDecision}
          onSaveTask={saveTaskEdit}
          actions={detail.nextDecisionPoint ? null : bucketActions(detail)}
        />
      )}
    </div>
  )
}
