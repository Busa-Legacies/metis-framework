'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { GitBranch, Target, ArrowUpRight, Ban, FolderKanban, Lock, X, ListTodo } from 'lucide-react'
import { ageLabel, goalProgressPct, metisApi } from '@/lib/metis-api'
import { useMetisAll } from '@/lib/use-metis-all'
import type { MetisGoal, MetisPriorityItem, MetisTaskSummary, MetisLease, MetisGoverned, MetisGoverndTask } from '@/lib/metis-api-types'
import { StatusCard, StatusChip, CardLoading, CardError, SEV_BAR, CopyButton } from '../overview/cards'
import { AnnotateTrigger } from '../annotate/AnnotateWidget'
import { taskHandoffPrompt, leaseHandoffPrompt } from '@/lib/handoff-prompt'
import type { Severity } from '@/lib/metis-api'
import { useControlCenterNav } from '@/lib/control-center-nav'
import { stateDotCls } from '@/lib/task-state'

function prioSeverity(priority: string): Severity {
  if (priority === 'P1') return 'critical'
  if (priority === 'P2') return 'warn'
  return 'ok'
}

/** Lease attribution — Work Graph's core info, so it stays, but as quiet text
    (lock + agent) rather than a pill chip (noise-reduction pass). */
function OwnerChip({ agent }: { agent: string | null | undefined }) {
  if (!agent) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-[12px] md:text-[10px] font-bold text-cyan-200/80">
      <Lock size={12} /> {agent}
    </span>
  )
}

// Title-first row, state = colored dot, P1 = brighter title — same encoding as
// TaskBoardMode rows (shared maps in lib/task-state.ts). No chips, no taskId.
function TaskRow({ t, owner, onClick }: { t: MetisPriorityItem; owner?: string | null; onClick?: () => void }) {
  const p1 = t.priority === 'P1'
  return (
    <li className={`flex items-center gap-2 rounded-lg px-1.5 py-1.5 text-[13px] md:text-[11px] ${onClick ? 'cursor-pointer hover:bg-white/5' : ''}`} onClick={onClick}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${stateDotCls(t.state)}`} title={t.state.replace(/_/g, ' ')} />
      <span className={`min-w-0 flex-1 truncate ${p1 ? 'font-semibold text-slate-50' : 'font-medium text-slate-300'}`}>{t.title}</span>
      <OwnerChip agent={owner} />
      <CopyButton text={taskHandoffPrompt(t)} title="Copy work prompt" />
    </li>
  )
}

function GoalCard({ g, selected, onClick }: { g: MetisGoal; selected: boolean; onClick: () => void }) {
  const pct = goalProgressPct(g)
  return (
    <button
      onClick={onClick}
      className={`flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors ${selected ? 'border-cyan-300/50 bg-cyan-300/10' : 'border-[var(--line)] bg-black/20 hover:border-cyan-300/30 hover:bg-white/[0.03]'}`}
    >
      <div className="flex items-center gap-1.5 text-[15px] md:text-[12px]">
        <span className="font-bold text-cyan-200">{g.id}</span>
        <span className="truncate text-slate-400">{g.title}</span>
        <span className="ml-auto shrink-0 font-bold text-emerald-200">{pct}%</span>
      </div>
      {g.domain && (
        <span className="w-fit rounded-md border border-cyan-300/20 bg-cyan-300/10 px-1.5 py-0.5 text-[10px] font-bold text-cyan-100">
          {g.domain}
        </span>
      )}
      {g.marker && <div className="truncate text-[13px] md:text-[10px] text-[var(--muted)]">{g.marker}</div>}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div className={`h-full rounded-full ${SEV_BAR.ok}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-wrap gap-1">
        {g.in_progress > 0 && <StatusChip label={`${g.in_progress} wip`} severity="warn" />}
        {g.active > 0 && <StatusChip label={`${g.active} active`} severity="ok" />}
        {g.blocked > 0 && <StatusChip label={`${g.blocked} blocked`} severity="critical" />}
        <StatusChip label={`${g.done} done`} severity="ok" />
      </div>
    </button>
  )
}

function ProjectRow({ p, selected, onClick }: { p: MetisTaskSummary; selected: boolean; onClick: () => void }) {
  return (
    <li
      onClick={onClick}
      className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[13px] md:text-[11px] ${selected ? 'bg-cyan-300/10' : 'hover:bg-white/5'}`}
    >
      <StatusChip label={p.priority} severity={prioSeverity(p.priority)} />
      <span className="truncate text-slate-200">{p.project}</span>
      <span className="text-[13px] md:text-[10px] text-[var(--muted)]">{p.status}</span>
      {p.next_up && <span className="ml-auto truncate text-[13px] md:text-[10px] text-cyan-200">{p.next_up}</span>}
    </li>
  )
}

function GovernedTaskRow({ task, onClick }: { task: MetisGoverndTask; onClick?: () => void }) {
  const p1 = task.priority === 'P1'
  return (
    <li
      onClick={onClick}
      className={`rounded-lg border border-[var(--line)] bg-black/20 px-2.5 py-2 ${onClick ? 'cursor-pointer hover:border-cyan-300/30 hover:bg-white/5' : ''}`}
    >
      <div className="flex items-center gap-2 text-[13px] md:text-[11px]">
        <span className={`h-2 w-2 shrink-0 rounded-full ${stateDotCls(task.state)}`} title={task.state.replace(/_/g, ' ')} />
        <span className={`min-w-0 flex-1 truncate ${p1 ? 'font-semibold text-slate-50' : 'font-medium text-slate-200'}`}>{task.title}</span>
      </div>
      {(task.currentStep ?? task.nextAction ?? task.summary) && (
        <div className="mt-0.5 truncate pl-4 text-[13px] md:text-[10px] text-[var(--muted)]">{task.currentStep ?? task.nextAction ?? task.summary}</div>
      )}
    </li>
  )
}

/**
 * Work Graph mode (PLAN M4). First-class view of the task spine from the typed
 * /api/all: goal/milestone progress, ranked next work, blockers, and per-project
 * status — so "what's active, what's blocked, what's next, where do I intervene"
 * is answerable without reading working-context.md. Read-only for now; lease/
 * owner attribution and safe actions land in a follow-up (needs a leases endpoint).
 */
export default function WorkGraphMode() {
  const nav = useControlCenterNav()
  const { res, data, now, reload } = useMetisAll()
  const p = data?.priorities
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null)
  const [selectedProject, setSelectedProject] = useState<string | null>(null)

  // Leases are a separate light endpoint (owner/fence attribution, #235).
  const [leases, setLeases] = useState<MetisLease[]>([])
  const [governed, setGoverned] = useState<MetisGoverned | null>(null)
  const loadLeases = useCallback(async () => {
    const r = await metisApi.leases()
    setLeases(r.ok ? r.data.leases : [])
  }, [])
  const loadGoverned = useCallback(async () => {
    const r = await metisApi.tasksGoverned(true)
    setGoverned(r.ok ? r.data : null)
  }, [])
  useEffect(() => {
    loadLeases()
    loadGoverned()
    const t = setInterval(loadLeases, 15000)
    return () => clearInterval(t)
  }, [loadLeases, loadGoverned])
  const leaseByTask = new Map(leases.filter((l) => l.taskId).map((l) => [l.taskId as string, l.agent]))
  const priorityById = useMemo(() => {
    const rows = [...(p?.next ?? []), ...(p?.blocked ?? []), ...(p?.orphans ?? []), ...Object.values(p?.by_system ?? {}).flat()]
    return new Map(rows.map((row) => [row.taskId, row]))
  }, [p])
  const selectedGoal = p?.goals?.find((g) => g.id === selectedGoalId) ?? null
  const goalTasks = useMemo(() => {
    if (!selectedGoal || !governed) return []
    return governed.projects.flatMap((project) => project.tasks).filter((task) => {
      const priority = priorityById.get(task.taskId)
      return priority?.goals?.includes(selectedGoal.id)
    })
  }, [governed, priorityById, selectedGoal])
  const projectTasks = useMemo(() => {
    if (!selectedProject || !governed) return []
    return governed.projects.find((project) => project.name === selectedProject || project.slug === selectedProject)?.tasks ?? []
  }, [governed, selectedProject])
  const detailTitle = selectedGoal ? `${selectedGoal.id} · ${selectedGoal.title}` : selectedProject
  const detailTasks = selectedGoal ? goalTasks : projectTasks
  const clearDetail = () => { setSelectedGoalId(null); setSelectedProject(null) }

  return (
    <div data-testid="work-graph" className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-[var(--line)] bg-black/20 px-3 py-2 text-[15px] md:text-[12px]">
        <GitBranch size={14} className="text-cyan-300" />
        <span className="text-[17px] md:text-[13px] font-black uppercase tracking-[0.18em] text-cyan-100">Work Graph</span>
        {p && (
          <span className="hidden gap-2 sm:flex">
            <StatusChip label={`${p.active_total} active`} severity="ok" />
            {p.blocked_count > 0 && <StatusChip label={`${p.blocked_count} blocked`} severity="critical" />}
          </span>
        )}
        <div className="flex-1" />
        {res && <span className="text-[13px] md:text-[10px] text-[var(--muted)]">{res.ok ? `data ${ageLabel(data?.ts, now)}` : 'no data'}</span>}
        <AnnotateTrigger />
      </div>

      {res && !res.ok ? (
        <CardError message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`} onRetry={reload} />
      ) : !data || !p ? (
        <CardLoading label="loading work graph…" />
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:gap-3 md:p-3 lg:grid-cols-2">
          {/* Campaigns / milestones */}
          <StatusCard title="Campaigns · Milestones" icon={<Target size={12} />}>
            {p.goals?.length ? (
              <div className="flex flex-col gap-2">
                {p.goals.map((g) => (
                  <GoalCard
                    key={g.id}
                    g={g}
                    selected={selectedGoalId === g.id}
                    onClick={() => { setSelectedGoalId(g.id); setSelectedProject(null) }}
                  />
                ))}
              </div>
            ) : (
              <span className="text-[15px] md:text-[12px] text-[var(--muted)]">no campaigns tracked</span>
            )}
          </StatusCard>

          {/* Next up */}
          <StatusCard title="Next Up" icon={<ArrowUpRight size={12} />}>
            {p.next?.length ? (
              <ul className="flex flex-col gap-1.5">{p.next.slice(0, 10).map((t) => (
                <TaskRow key={t.taskId} t={t} owner={leaseByTask.get(t.taskId)} onClick={() => nav.goto('tasks', { taskId: t.taskId })} />
              ))}</ul>
            ) : (
              <span className="text-[15px] md:text-[12px] text-emerald-200">queue clear</span>
            )}
          </StatusCard>

          {/* Blocked */}
          <StatusCard title="Blocked" icon={<Ban size={12} />} severity={p.blocked_count ? 'critical' : 'ok'}>
            {p.blocked?.length ? (
              <ul className="flex flex-col gap-1.5">{p.blocked.slice(0, 10).map((t) => (
                <TaskRow key={t.taskId} t={t} owner={leaseByTask.get(t.taskId)} onClick={() => nav.goto('tasks', { taskId: t.taskId })} />
              ))}</ul>
            ) : (
              <span className="text-[15px] md:text-[12px] text-emerald-200">nothing blocked</span>
            )}
          </StatusCard>

          {/* Active leases — who owns active work right now */}
          <StatusCard title="Active Work Lanes" icon={<Lock size={12} />}>
            {leases.length ? (
              <ul className="flex flex-col gap-1.5">
                {leases.map((l) => (
                  // Two-line row: four shrink-0 spans in one line overflowed the
                  // page edge on phones (Ant annotation 2026-06-10). Identity up
                  // top, fence/renewed metadata below — everything truncates.
                  <li
                    key={`${l.session}-${l.fenceToken}`}
                    onClick={l.taskId ? () => nav.goto('tasks', { taskId: l.taskId as string }) : undefined}
                    className={`flex flex-col gap-0.5 ${l.taskId ? 'cursor-pointer rounded-lg px-1 hover:bg-white/5' : ''}`}
                    title={l.taskId ? 'open this task' : undefined}
                  >
                    <div className="flex min-w-0 items-center gap-2 text-[13px] md:text-[11px]">
                      <OwnerChip agent={l.agent} />
                      {l.taskId && <span className="min-w-0 shrink-[2] truncate text-cyan-200">{l.taskId}</span>}
                      <span className="min-w-0 flex-1 truncate text-slate-300">{l.title}</span>
                      <CopyButton text={leaseHandoffPrompt(l)} title="Copy handoff prompt" label="handoff" />
                    </div>
                    <div className="truncate text-[13px] md:text-[10px] text-[var(--muted)]">
                      fence {l.fenceToken} · renewed {ageLabel(l.lastRenewedAt ?? undefined, now)}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-[15px] md:text-[12px] text-[var(--muted)]">no background lanes active</span>
            )}
          </StatusCard>

          {/* By project */}
          <StatusCard title="By Project" icon={<FolderKanban size={12} />}>
            {data.tasks?.summary?.length ? (
              <ul className="flex flex-col gap-1.5">{data.tasks.summary.map((pr, i) => (
                <ProjectRow key={i} p={pr} selected={selectedProject === pr.project} onClick={() => { setSelectedProject(pr.project); setSelectedGoalId(null) }} />
              ))}</ul>
            ) : (
              <span className="text-[15px] md:text-[12px] text-[var(--muted)]">no project rollup</span>
            )}
          </StatusCard>

          {/* Focus detail */}
          <StatusCard title="Focus" icon={<ListTodo size={12} />} severity={detailTasks.some((task) => task.state === 'blocked') ? 'warn' : 'ok'}>
            {detailTitle ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[15px] md:text-[12px] font-bold text-slate-200">{detailTitle}</span>
                  <StatusChip label={`${detailTasks.length} tasks`} severity="ok" />
                  <button onClick={clearDetail} className="rounded p-1 text-[var(--muted)] hover:text-slate-200" title="clear focus">
                    <X size={14} />
                  </button>
                </div>
                {selectedGoal?.marker && <div className="text-[13px] md:text-[11px] text-[var(--muted)]">{selectedGoal.marker}</div>}
                {detailTasks.length ? (
                  <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
                    {detailTasks.map((task) => <GovernedTaskRow key={task.taskId} task={task} onClick={() => nav.goto('tasks', { taskId: task.taskId })} />)}
                  </ul>
                ) : (
                  <span className="text-[15px] md:text-[12px] text-[var(--muted)]">no governed tasks found for this focus</span>
                )}
                <button
                  onClick={() => selectedGoal
                    ? nav.goto('tasks', { goalId: selectedGoal.id, goalLabel: `${selectedGoal.id} · ${selectedGoal.title}` })
                    : nav.goto('tasks')}
                  className="mt-1 flex items-center justify-center gap-1 rounded-lg border border-cyan-300/30 bg-cyan-300/10 px-2 py-1.5 text-[13px] md:text-[11px] font-bold text-cyan-100 hover:bg-cyan-300/20"
                >
                  open in Tasks
                </button>
              </div>
            ) : (
              <span className="text-[15px] md:text-[12px] text-[var(--muted)]">click a campaign, project, or task row to focus its work</span>
            )}
          </StatusCard>
        </div>
      )}
    </div>
  )
}
