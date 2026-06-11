'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Route, RefreshCw, ChevronRight, ChevronDown, ChevronLeft, X, AlertTriangle,
  CheckCircle2, Circle, Bot, Flag, Layers,
} from 'lucide-react'
import { metisApi, ageLabel, type MetisResult } from '@/lib/metis-api'
import type {
  MetisLinesIndex, MetisLineSummary, MetisLineDetail, MetisLineMilestone,
  MetisGoverndTask, MetisLineLease,
} from '@/lib/metis-api-types'
import { CardLoading, CardError } from '../overview/cards'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'
import { stateDotCls, stateTextCls } from '@/lib/task-state'

// ── Lines of work (#240 Phase 3) ──────────────────────────────────────────────
// Follow ONE thread top to bottom: project → milestone → task → the agent/lease
// working it → evidence → done-gate. A read-and-trace surface (the act-on-it
// verbs live in Inbox + Tasks); here you see how a line of work is structured and
// exactly what stands between a task and "done".

const AGENT_DOT: Record<string, string> = {
  claude: 'bg-violet-300', codex: 'bg-cyan-300', shell: 'bg-emerald-300',
  gemini: 'bg-amber-300', forge: 'bg-violet-300', scout: 'bg-cyan-300',
}
const MS_STATUS_CLS: Record<string, string> = {
  done: 'text-emerald-300', active: 'text-cyan-300', blocked: 'text-rose-300',
  paused: 'text-amber-300', todo: 'text-slate-400',
}

function Bar({ progress, tone = 'indigo' }: { progress: number; tone?: 'indigo' | 'emerald' }) {
  const pct = Math.round((progress ?? 0) * 100)
  const grad = tone === 'emerald' ? 'from-emerald-500 to-emerald-300' : 'from-indigo-500 to-indigo-300'
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--line)]">
        <div className={`h-full rounded-full bg-gradient-to-r ${grad}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] md:text-[10px] tabular-nums text-[var(--muted)]">{pct}%</span>
    </div>
  )
}

function AgentChip({ lease }: { lease?: MetisLineLease }) {
  if (!lease?.agent) return null
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-slate-200">
      <span className={`h-1.5 w-1.5 rounded-full ${AGENT_DOT[lease.agent] ?? 'bg-slate-300'}`} />
      {lease.agent}{lease.fenceToken != null ? ` ·${lease.fenceToken}` : ''}
    </span>
  )
}

// Done-gate readiness pill on a task row.
function GatePill({ task }: { task: MetisGoverndTask }) {
  const g = task.doneGate
  if (!g) return null
  const met = g.checks.filter((c) => c.ok).length
  return (
    <span
      className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${
        g.ready ? 'border-emerald-300/30 bg-emerald-300/10 text-emerald-200'
                : 'border-slate-400/20 bg-black/30 text-[var(--muted)]'
      }`}
      title="done-gate readiness"
    >
      gate {met}/{g.checks.length}
    </span>
  )
}

// ── Task detail slide-over: evidence + done-gate + attribution ─────────────────

function LineTaskDetail({ task, lease, onClose }: {
  task: MetisGoverndTask
  lease?: MetisLineLease
  onClose: () => void
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])
  const g = task.doneGate
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/60" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="flex h-full w-full max-w-lg flex-col overflow-hidden border-l border-[var(--line)] bg-[#0a0d14] shadow-2xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] py-3 pl-2 pr-4">
          <button onClick={onClose} aria-label="close" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--muted)] hover:bg-white/5 hover:text-slate-200">
            <X size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[15px] md:text-[13px] font-semibold text-slate-50">{task.title}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] md:text-[11px]">
              <span className="font-mono text-[var(--muted)]">{task.taskId}</span>
              <span className={`font-bold ${stateTextCls(task.state)}`}>{task.state.replace(/_/g, ' ')}</span>
              {task.milestone && <span className="truncate text-indigo-300">{task.milestone.id} · {task.milestone.title}</span>}
              <AgentChip lease={lease} />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 font-mono text-xs">
          {/* Done-gate checklist — exactly what stands between this task and done */}
          {g && (
            <div className={`mb-4 rounded-xl border p-3 ${g.ready ? 'border-emerald-300/30 bg-emerald-300/5' : 'border-[var(--line)] bg-black/20'}`}>
              <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-200">
                <Flag size={13} className={g.ready ? 'text-emerald-300' : 'text-[var(--muted)]'} />
                Done-gate {g.ready ? '· ready' : `· ${g.checks.filter((c) => c.ok).length}/${g.checks.length}`}
              </div>
              <div className="flex flex-col gap-1">
                {g.checks.map((c) => (
                  <div key={c.label} className={`flex items-center gap-2 text-[12px] ${c.ok ? 'text-emerald-200' : 'text-[var(--muted)]'}`}>
                    {c.ok ? <CheckCircle2 size={14} className="shrink-0" /> : <Circle size={14} className="shrink-0" />}
                    {c.label}
                  </div>
                ))}
              </div>
            </div>
          )}

          <Field label="Summary" value={task.summary} />
          <Field label="Why" value={task.why} />
          <Field label="How" value={task.how} />
          <Field label={task.currentStep ? 'Current step' : 'First step'} value={task.currentStep ?? task.firstStep} />
          <Field label="Next action" value={task.nextAction} />
          {task.blocker && (
            <div className="mb-4">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-rose-400">Blocker</div>
              <div className="flex items-start gap-1.5 text-[12px] text-rose-300">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {task.blocker}
              </div>
            </div>
          )}
          {/* Evidence */}
          <div className="mt-2 rounded-xl border border-cyan-300/15 bg-cyan-300/5 p-3">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-cyan-200">Evidence</div>
            <Field label="Expected artifact" value={task.expectedArtifact} />
            <Field label="Verification method" value={task.verificationMethod} />
            <Field label="Verification state" value={task.verificationState ?? null} />
          </div>
          <div className="mt-4 border-t border-[var(--line)] pt-3 text-[10px] text-[var(--muted)]">
            updated {task.updatedAt?.slice(0, 10)} · rev {task.revision} · owner {task.owner ?? '—'}
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="mb-3">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--muted)]">{label}</div>
      <div className="text-[12px] leading-relaxed text-slate-300">{value}</div>
    </div>
  )
}

// ── Task row ──────────────────────────────────────────────────────────────────

function LineTaskRow({ task, lease, onClick }: { task: MetisGoverndTask; lease?: MetisLineLease; onClick: () => void }) {
  return (
    <li onClick={onClick} className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-indigo-400/5 active:bg-indigo-400/10">
      <span className={`h-2 w-2 shrink-0 rounded-full ${stateDotCls(task.state)}`} title={task.state.replace(/_/g, ' ')} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] md:text-[12px] font-medium text-slate-200">{task.title}</div>
        <div className="flex items-center gap-2 text-[11px] md:text-[10px] text-[var(--muted)]">
          <span className="font-mono">{task.taskId}</span>
          <span className={`font-bold ${stateTextCls(task.state)}`}>{task.state.replace(/_/g, ' ')}</span>
        </div>
      </div>
      <AgentChip lease={lease} />
      <GatePill task={task} />
      <ChevronRight size={14} className="shrink-0 text-[var(--muted)] opacity-40 group-hover:opacity-100" />
    </li>
  )
}

// ── Milestone card ────────────────────────────────────────────────────────────

function MilestoneCard({ ms, leases, expanded, onToggle, onTaskClick }: {
  ms: MetisLineMilestone
  leases: Record<string, MetisLineLease>
  expanded: boolean
  onToggle: () => void
  onTaskClick: (t: MetisGoverndTask) => void
}) {
  const done = ms.status === 'done'
  return (
    <div className="mb-2 rounded-xl border border-[var(--line)] bg-[#13161f]/80 p-3">
      <div className="flex items-center gap-2">
        <button onClick={onToggle} className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-white/5 hover:text-slate-200" title={expanded ? 'collapse' : 'expand'}>
          {ms.tasks.length === 0 ? <span className="text-[10px]">·</span> : expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <span className="shrink-0 font-mono text-[12px] md:text-[11px] font-bold text-slate-300">{ms.id}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] md:text-[12px] font-semibold text-slate-100">{ms.title}</span>
        <span className={`shrink-0 text-[11px] md:text-[10px] font-bold uppercase ${MS_STATUS_CLS[ms.status] ?? 'text-slate-400'}`}>{ms.status}</span>
        <Bar progress={ms.progress} tone={done ? 'emerald' : 'indigo'} />
        <span className="shrink-0 text-[11px] md:text-[10px] text-[var(--muted)]">{ms.openCount}/{ms.taskCount}</span>
      </div>
      {expanded && ms.tasks.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5 border-t border-[var(--line)] pt-1.5">
          {ms.tasks.map((t) => (
            <LineTaskRow key={t.taskId} task={t} lease={leases[t.taskId]} onClick={() => onTaskClick(t)} />
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Project picker card ───────────────────────────────────────────────────────

function ProjectCard({ p, onOpen }: { p: MetisLineSummary; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-3 rounded-xl border border-[var(--line)] bg-[#13161f]/80 p-3 text-left hover:border-cyan-300/30 hover:bg-cyan-300/5">
      <Route size={16} className="shrink-0 text-cyan-300" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] md:text-[13px] font-semibold text-slate-100">{p.name}</div>
        <div className="flex items-center gap-2 text-[11px] md:text-[10px] text-[var(--muted)]">
          <span>{p.priority}</span>
          <span>{p.openCount} open</span>
          {p.milestonesTotal ? <span>{p.milestonesTotal} milestones</span> : null}
        </div>
      </div>
      {p.progress != null && <Bar progress={p.progress} />}
      <ChevronRight size={16} className="shrink-0 text-[var(--muted)]" />
    </button>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function LinesOfWorkMode() {
  const [index, setIndex] = useState<MetisResult<MetisLinesIndex> | null>(null)
  const [slug, setSlug] = useState<string | null>(null)
  const [detail, setDetail] = useState<MetisResult<MetisLineDetail> | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<MetisGoverndTask | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadIndex = useCallback(async () => {
    setLoading(true)
    const r = await metisApi.lines()
    setIndex(r)
    setNow(Date.now())
    setLoading(false)
  }, [])

  const loadDetail = useCallback(async (s: string) => {
    setLoading(true)
    const r = await metisApi.lineDetail(s)
    setDetail(r)
    setNow(Date.now())
    setLoading(false)
    // Auto-expand the first milestone that still has open work.
    if (r.ok) {
      const firstOpen = r.data.milestones.find((m) => m.openCount > 0)
      if (firstOpen) setExpanded(new Set([firstOpen.id]))
    }
  }, [])

  useEffect(() => {
    if (slug) loadDetail(slug)
    else loadIndex()
  }, [slug, loadIndex, loadDetail])

  useEffect(() => {
    timer.current = setInterval(() => { if (slug) loadDetail(slug); else loadIndex() }, 60000)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [slug, loadIndex, loadDetail])

  const open = (s: string) => { setExpanded(new Set()); setSlug(s) }
  const back = () => { setSlug(null); setDetail(null); setSelected(null) }
  const toggleMs = (id: string) => setExpanded((e) => { const n = new Set(e); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const d = detail?.ok ? detail.data : null
  const leaseFor = (tid: string) => d?.leases[tid]

  return (
    <div data-testid="lines-mode" className="flex h-full w-full flex-col overflow-hidden">
      {/* Header / breadcrumb */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] bg-black/20 px-3 py-2 text-sm md:text-xs">
        {slug ? (
          <button onClick={back} className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-cyan-200 hover:bg-white/5" title="back to projects">
            <ChevronLeft size={16} /> <Route size={14} />
          </button>
        ) : (
          <Route size={14} className="shrink-0 text-cyan-300" />
        )}
        <span className="text-base md:text-sm font-black uppercase tracking-[0.18em] text-cyan-100">
          {slug ? (d?.project.name ?? slug) : 'Lines of Work'}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => (slug ? loadDetail(slug) : loadIndex())}
          title="Refresh"
          className="flex items-center gap-1.5 rounded-lg border border-slate-400/20 bg-black/30 px-2.5 py-1.5 text-sm md:text-[11px] text-slate-300 hover:border-cyan-300/40 hover:text-cyan-100"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> refresh
        </button>
        <AnnotateTrigger />
      </div>

      {/* ── Project picker ── */}
      {!slug && (
        <>
          {index && !index.ok && <CardError message={index.error} onRetry={loadIndex} />}
          {loading && !index?.ok && <CardLoading label="Loading lines of work…" />}
          {index?.ok && (
            <div className="flex-1 overflow-y-auto p-3">
              <div className="mb-2 px-1 text-[12px] md:text-[11px] text-[var(--muted)]">
                Pick a project to follow its line of work top to bottom.
              </div>
              <div className="flex flex-col gap-2">
                {index.data.projects.map((p) => <ProjectCard key={p.slug} p={p} onOpen={() => open(p.slug)} />)}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Project drill ── */}
      {slug && (
        <>
          {detail && !detail.ok && <CardError message={detail.error} onRetry={() => loadDetail(slug)} />}
          {loading && !d && <CardLoading label="Loading project line…" />}
          {d && (
            <div className="flex-1 overflow-y-auto p-3">
              {/* Project header */}
              <div className="mb-3 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] md:text-[13px] font-bold text-slate-50">{d.project.name}</span>
                  <span className="text-[11px] md:text-[10px] text-[var(--muted)]">{d.project.priority} · {d.project.status}</span>
                  <div className="flex-1" />
                  {d.project.progress != null && <Bar progress={d.project.progress} tone="emerald" />}
                </div>
                {d.project.goal && <div className="mt-1 text-[12px] md:text-[11px] text-[var(--muted)]">goal {d.project.goal}</div>}
                {d.project.doneWhen && <div className="mt-1 text-[12px] md:text-[11px] text-slate-300"><span className="font-bold text-[var(--muted)]">Done when:</span> {d.project.doneWhen}</div>}
                <div className="mt-1.5 flex items-center gap-3 text-[11px] md:text-[10px] text-[var(--muted)]">
                  <span>{d.project.openCount} open</span>
                  {d.project.milestonesTotal != null && <span>{d.project.shipped ?? 0}/{d.project.milestonesTotal} milestones shipped</span>}
                  <span>fetched {ageLabel(detail?.ok ? detail.fetchedAt : undefined, now)}</span>
                </div>
              </div>

              {/* Milestone ladder */}
              {d.milestones.map((ms) => (
                <MilestoneCard
                  key={ms.id}
                  ms={ms}
                  leases={d.leases}
                  expanded={expanded.has(ms.id)}
                  onToggle={() => toggleMs(ms.id)}
                  onTaskClick={setSelected}
                />
              ))}

              {/* Unassigned (project tasks not linked to a milestone) */}
              {d.unassigned.length > 0 && (
                <div className="mb-2 rounded-xl border border-[var(--line)] bg-[#13161f]/60 p-3">
                  <div className="mb-1.5 flex items-center gap-2 border-b border-[var(--line)] pb-1.5 text-[12px] md:text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--muted)]">
                    <Layers size={13} /> Unassigned <span className="font-normal">· {d.unassigned.length}</span>
                  </div>
                  <ul className="flex flex-col gap-0.5">
                    {d.unassigned.map((t) => (
                      <LineTaskRow key={t.taskId} task={t} lease={leaseFor(t.taskId)} onClick={() => setSelected(t)} />
                    ))}
                  </ul>
                </div>
              )}

              {d.milestones.length === 0 && d.unassigned.length === 0 && (
                <div className="py-10 text-center text-[13px] md:text-[12px] text-[var(--muted)]">
                  <Bot size={24} className="mx-auto mb-2 opacity-50" />
                  No tasks on this line yet.
                </div>
              )}
            </div>
          )}
        </>
      )}

      {selected && <LineTaskDetail task={selected} lease={leaseFor(selected.taskId)} onClose={() => setSelected(null)} />}
    </div>
  )
}
