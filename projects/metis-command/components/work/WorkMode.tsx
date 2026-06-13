'use client'

import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight, Bot, CheckCircle2, Eye, GitBranch, Inbox, LayoutList,
  Lock, Route, Target,
} from 'lucide-react'
import { ageLabel, goalProgressPct, metisApi, type MetisResult } from '@/lib/metis-api'
import { useMetisAll } from '@/lib/use-metis-all'
import { useControlCenterNav } from '@/lib/control-center-nav'
import type { MetisInbox, MetisLease } from '@/lib/metis-api-types'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'
import { CardError, CardLoading, StatusCard, StatusChip } from '../overview/cards'
import InboxMode from '../inbox/InboxMode'
import LinesOfWorkMode from '../workgraph/LinesOfWorkMode'
import WorkGraphMode from '../workgraph/WorkGraphMode'
import TaskBoardMode from '../tasks/TaskBoardMode'
import ReviewMode from '../review/ReviewMode'
import { NavoreTasks, NavoreWorkGraph } from '../example/NavoreMode'

export type WorkView = 'home' | 'attention' | 'plan' | 'lines' | 'tasks' | 'review'

const WORK_VIEWS: { id: WorkView; label: string; icon: React.ReactNode }[] = [
  { id: 'home', label: 'Home', icon: <Target size={14} /> },
  { id: 'attention', label: 'Needs You', icon: <Inbox size={14} /> },
  { id: 'plan', label: 'Plan', icon: <GitBranch size={14} /> },
  { id: 'lines', label: 'Lines', icon: <Route size={14} /> },
  { id: 'tasks', label: 'Tasks', icon: <LayoutList size={14} /> },
  { id: 'review', label: 'Review', icon: <Eye size={14} /> },
]

function workViewFromLegacy(id?: string | null): WorkView {
  if (id === 'inbox') return 'attention'
  if (id === 'work-graph') return 'plan'
  if (id === 'lines') return 'lines'
  if (id === 'tasks') return 'tasks'
  if (id === 'review') return 'review'
  return 'home'
}

function AttentionCard({ inbox, loading, onOpen }: {
  inbox: MetisResult<MetisInbox> | null
  loading: boolean
  onOpen: () => void
}) {
  if (loading) {
    return (
      <StatusCard title="Needs You" icon={<Inbox size={12} />}>
        <span className="text-[13px] md:text-[12px] text-[var(--muted)]">checking attention queue...</span>
      </StatusCard>
    )
  }
  if (!inbox?.ok) {
    return (
      <StatusCard title="Needs You" icon={<Inbox size={12} />} severity="warn">
        <span className="text-[13px] md:text-[12px] text-amber-200">attention queue unavailable</span>
      </StatusCard>
    )
  }
  const c = inbox.data.counts
  const waiting = inbox.data.focus.waitingOnAnt || !!inbox.data.focus.blockerSummary
  return (
    <StatusCard title="Needs You" icon={<Inbox size={12} />} severity={c.total > 0 || waiting ? 'warn' : 'ok'}>
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2">
          <div className={`text-[36px] font-black tabular-nums ${c.total > 0 ? 'text-amber-100' : 'text-emerald-200'}`}>{c.total}</div>
          <div className="pb-1 text-[12px] text-[var(--muted)]">items needing a human call</div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StatusChip label={`${c.decisions + c.decide} decide`} severity={c.decisions + c.decide ? 'warn' : 'ok'} />
          <StatusChip label={`${c.verify} verify`} severity={c.verify ? 'warn' : 'ok'} />
          <StatusChip label={`${c.unblock} unblock`} severity={c.unblock ? 'critical' : 'ok'} />
          <StatusChip label={`${c.waiting} waiting`} severity={c.waiting ? 'warn' : 'ok'} />
        </div>
        {(inbox.data.focus.blockerSummary || inbox.data.focus.focusSummary) && (
          <div className="rounded-lg border border-amber-300/20 bg-amber-300/5 px-2.5 py-2 text-[12px] leading-relaxed text-amber-100">
            {inbox.data.focus.blockerSummary ?? inbox.data.focus.focusSummary}
          </div>
        )}
        <button
          onClick={onOpen}
          className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 text-[12px] font-bold text-amber-100 hover:bg-amber-300/20"
        >
          <ArrowUpRight size={14} /> Open attention queue
        </button>
      </div>
    </StatusCard>
  )
}

function attentionTotal(inbox: MetisResult<MetisInbox> | null): number | null {
  return inbox?.ok ? inbox.data.counts.total : null
}

export default function WorkMode({ professional = false, initialView }: { professional?: boolean; initialView?: string | null }) {
  const nav = useControlCenterNav()
  const [view, setView] = useState<WorkView>(() => workViewFromLegacy(initialView))
  const { res, data, now, reload } = useMetisAll()
  const [inbox, setInbox] = useState<MetisResult<MetisInbox> | null>(null)
  const [inboxLoading, setInboxLoading] = useState(true)
  const [leases, setLeases] = useState<MetisLease[]>([])

  useEffect(() => setView(workViewFromLegacy(initialView)), [initialView])

  const loadInbox = useCallback(async () => {
    setInboxLoading(true)
    const r = await metisApi.inbox()
    setInbox(r)
    setInboxLoading(false)
  }, [])

  const loadLeases = useCallback(async () => {
    const r = await metisApi.leases()
    setLeases(r.ok ? r.data.leases : [])
  }, [])

  useEffect(() => {
    loadInbox()
    loadLeases()
    const t = setInterval(() => {
      loadInbox()
      loadLeases()
    }, 30000)
    return () => clearInterval(t)
  }, [loadInbox, loadLeases])

  const priorities = data?.priorities
  const topGoal = useMemo(() => {
    const goals = priorities?.goals ?? []
    return [...goals].sort((a, b) => (b.active + b.in_progress + b.blocked) - (a.active + a.in_progress + a.blocked))[0] ?? null
  }, [priorities])
  const activeProjects = data?.tasks?.summary?.filter((p) => p.status !== 'done') ?? []
  const stale = res?.ok ? ageLabel(data?.ts, now) : 'no data'

  return (
    <div data-testid="work-mode" className="flex h-full w-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-[var(--line)] bg-black/20">
        <div className="flex items-center gap-2 px-3 py-2 text-[15px] md:text-[12px]">
          <GitBranch size={14} className="text-cyan-300" />
          <span className="text-[17px] md:text-[13px] font-black uppercase tracking-[0.18em] text-cyan-100">Work</span>
          <span className="hidden text-[12px] text-[var(--muted)] sm:inline">big picture, attention, plan, execution</span>
          <div className="flex-1" />
          {priorities && (
            <span className="hidden gap-2 sm:flex">
              <StatusChip label={`${priorities.active_total} active`} severity="ok" />
              {priorities.blocked_count > 0 && <StatusChip label={`${priorities.blocked_count} blocked`} severity="critical" />}
            </span>
          )}
          <span className="text-[13px] md:text-[10px] text-[var(--muted)]">data {stale}</span>
          <AnnotateTrigger />
        </div>
        <div className="flex gap-1 overflow-x-auto px-1.5 pb-2 sm:px-3">
          {WORK_VIEWS.map((v) => {
            const active = v.id === view
            return (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-[11px] font-bold transition-colors sm:h-9 sm:gap-1.5 sm:px-3 sm:text-[12px] ${
                  active
                    ? 'border-cyan-300/50 bg-cyan-300/10 text-cyan-100'
                    : 'border-transparent bg-black/20 text-slate-400 hover:border-cyan-300/25 hover:text-slate-200'
                }`}
              >
                {v.icon} {v.label}
              </button>
            )
          })}
        </div>
      </div>

      {view === 'home' ? (
        res && !res.ok ? (
          <CardError message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`} onRetry={reload} />
        ) : !data || !priorities ? (
          <CardLoading label="loading work summary..." />
        ) : (
          <div className="flex-1 overflow-y-auto p-2.5 sm:p-3 lg:p-4">
            <div className="mc-stagger grid grid-cols-1 gap-2.5 sm:gap-3 lg:grid-cols-[1.25fr_0.75fr]">
              <StatusCard title="Command Brief" icon={<Target size={12} />}>
                <div className="flex flex-col gap-3 sm:gap-4">
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 sm:gap-2">
                    <Metric label="Active" value={priorities.active_total} tone="text-emerald-200" />
                    <Metric label="Blocked" value={priorities.blocked_count} tone={priorities.blocked_count ? 'text-rose-200' : 'text-emerald-200'} />
                    <Metric label="Projects" value={activeProjects.length} tone="text-cyan-100" />
                    <Metric label="Needs" value={attentionTotal(inbox) ?? 0} tone={(attentionTotal(inbox) ?? 0) ? 'text-amber-100' : 'text-emerald-200'} />
                  </div>

                  <button
                    type="button"
                    disabled={!topGoal}
                    onClick={() => topGoal && nav.goto('tasks', { goalId: topGoal.id, goalLabel: `${topGoal.id} · ${topGoal.title}` })}
                    className="w-full rounded-lg border border-[var(--line)] bg-black/20 px-2.5 py-2 text-left transition-colors enabled:hover:border-cyan-300/30 enabled:hover:bg-cyan-300/[0.04] disabled:cursor-default sm:px-3 sm:py-2.5"
                    title={topGoal ? 'open this goal’s tasks' : undefined}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-50 sm:text-[15px]">
                        {topGoal ? `${topGoal.id} · ${topGoal.title}` : 'No active goal selected'}
                      </span>
                      {topGoal && <StatusChip label={`${goalProgressPct(topGoal)}%`} severity="ok" />}
                    </div>
                    {topGoal?.marker && <div className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--muted)] sm:text-[12px]">{topGoal.marker}</div>}
                  </button>

                  <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                    <BriefList title="Next Up" rows={(priorities.next ?? []).slice(0, 3)} empty="queue clear" tone="cyan" onSelect={(taskId) => nav.goto('tasks', { taskId })} />
                    <BriefList title="Blocked" rows={(priorities.blocked ?? []).slice(0, 3)} empty="nothing blocked" tone="rose" onSelect={(taskId) => nav.goto('tasks', { taskId })} />
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 sm:hidden">
                    <button
                      onClick={() => setView('attention')}
                      aria-label="Open attention queue"
                      className="rounded-lg border border-amber-300/30 bg-amber-300/10 px-2 py-1.5 text-[11px] font-bold text-amber-100"
                    >
                      Needs You
                    </button>
                    <button
                      onClick={() => setView('tasks')}
                      aria-label="Open task board"
                      className="rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-2 py-1.5 text-[11px] font-bold text-cyan-100"
                    >
                      Tasks
                    </button>
                    <button
                      onClick={() => setView('lines')}
                      aria-label="Open lines of work"
                      className="col-span-2 rounded-lg border border-slate-500/40 bg-white/[0.04] px-2 py-1.5 text-[11px] font-bold text-slate-100"
                    >
                      Lines
                    </button>
                  </div>
                </div>
              </StatusCard>

              <div className="hidden sm:block">
                <AttentionCard inbox={inbox} loading={inboxLoading} onOpen={() => setView('attention')} />
              </div>

              <div className="hidden sm:block">
                <StatusCard title="Live Agents" icon={<Bot size={12} />}>
                  {leases.length ? (
                    <ul className="flex flex-col gap-1.5">
                      {leases.slice(0, 6).map((lease) => (
                        <li
                          key={`${lease.session}-${lease.fenceToken}`}
                          onClick={() => (lease.taskId ? nav.goto('tasks', { taskId: lease.taskId }) : nav.goto('agents'))}
                          className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 text-[12px] hover:bg-white/5"
                          title={lease.taskId ? 'open this task' : 'open Agents'}
                        >
                          <Lock size={12} className="shrink-0 text-cyan-300" />
                          <span className="shrink-0 font-bold text-cyan-200">{lease.agent ?? 'agent'}</span>
                          <span className="min-w-0 flex-1 truncate text-slate-300">{lease.title ?? lease.taskId ?? lease.session}</span>
                          {lease.fenceToken != null && <span className="text-[10px] text-[var(--muted)]">#{lease.fenceToken}</span>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-[13px] text-[var(--muted)]">no active leases</span>
                  )}
                </StatusCard>
              </div>
            </div>
          </div>
        )
      ) : view === 'attention' ? (
        <InboxMode />
      ) : view === 'plan' ? (
        professional ? <NavoreWorkGraph /> : <WorkGraphMode />
      ) : view === 'lines' ? (
        <LinesOfWorkMode />
      ) : view === 'tasks' ? (
        professional ? <NavoreTasks /> : <TaskBoardMode />
      ) : (
        <ReviewMode />
      )}
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[var(--line)] bg-black/20 px-2 py-1.5 sm:px-3 sm:py-2">
      <div className={`text-[17px] font-black leading-none tabular-nums sm:text-[24px] ${tone}`}>{value}</div>
      <div className="mt-1 truncate text-[9px] font-bold uppercase tracking-[0.08em] text-[var(--muted)] sm:text-[10px] sm:tracking-[0.12em]">{label}</div>
    </div>
  )
}

function BriefList({ title, rows, empty, tone, onSelect }: {
  title: string
  rows: { taskId: string; title: string; priority: string }[]
  empty: string
  tone: 'cyan' | 'rose'
  onSelect: (taskId: string) => void
}) {
  const dot = tone === 'rose' ? 'bg-rose-300' : 'bg-cyan-300'
  const id = tone === 'rose' ? 'text-rose-200' : 'text-cyan-200'
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--muted)]">{title}</div>
      {rows.length ? (
        <ul className="flex flex-col gap-1">
          {rows.map((t) => (
            <li
              key={t.taskId}
              onClick={() => onSelect(t.taskId)}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-[11px] hover:bg-white/5 sm:text-[12px]"
              title="open this task"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${t.priority === 'P1' ? 'bg-amber-300' : dot}`} />
              <span className="min-w-0 flex-1 truncate text-slate-200">{t.title}</span>
              <span className={`shrink-0 text-[9px] font-bold ${id}`}>{t.taskId}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-200">
          <CheckCircle2 size={12} /> {empty}
        </div>
      )}
    </div>
  )
}
