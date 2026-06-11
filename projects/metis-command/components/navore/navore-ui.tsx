'use client'

import { ExternalLink, Briefcase, RefreshCw } from 'lucide-react'
import type { NavoreTask, NavoreTone } from '@/lib/navore-data'
import { navoreStatusTone, sortNavoreTasks } from '@/lib/navore-data'
import { useAuthStatus } from '@/lib/use-auth-status'

/**
 * Shared presentation primitives for the Navore (professional) workspace. Reuses
 * the Control Center card design system (overview/cards) for visual parity; only the
 * Navore-specific bits (ClickUp task rows, the scope banner, the mode header)
 * live here so NavoreMode and the per-mode professional variants stay DRY.
 */

const TONE_DOT: Record<NavoreTone, string> = {
  done: 'bg-emerald-300',
  active: 'bg-amber-300',
  blocked: 'bg-rose-300 pulse-dot',
  open: 'bg-slate-400',
}

const PRIO_TEXT: Record<string, string> = {
  urgent: 'text-rose-300',
  high: 'text-amber-300',
  normal: 'text-slate-400',
  low: 'text-slate-500',
}

/** A single ClickUp task row — status dot, name, priority, due, external link. */
export function NavoreTaskRow({ task }: { task: NavoreTask }) {
  const tone = navoreStatusTone(task.status)
  const done = tone === 'done'
  return (
    <li className="flex items-start gap-2 py-1 text-[13px] md:text-[11px]">
      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${TONE_DOT[tone]}`} title={task.status} />
      <div className="min-w-0 flex-1">
        <div className={`truncate ${done ? 'text-slate-500 line-through' : 'font-medium text-slate-200'}`}>{task.name}</div>
        <div className="flex flex-wrap items-center gap-x-2 text-[12px] md:text-[10px] text-[var(--muted)]">
          <span className="capitalize">{task.status}</span>
          {task.priority && task.priority !== 'normal' && (
            <span className={`font-bold capitalize ${PRIO_TEXT[task.priority] ?? 'text-slate-400'}`}>{task.priority}</span>
          )}
          {task.due && <span>due {task.due}</span>}
        </div>
      </div>
      {task.url && (
        <a
          href={task.url}
          target="_blank"
          rel="noreferrer"
          title="Open in ClickUp"
          className="mt-0.5 shrink-0 text-slate-500 hover:text-cyan-200"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink size={12} />
        </a>
      )}
    </li>
  )
}

/** A sorted, length-capped task list with an explicit empty state. */
export function NavoreTaskList({ tasks, limit = 8, empty = 'No tasks' }: { tasks: NavoreTask[]; limit?: number; empty?: string }) {
  if (!tasks.length) return <span className="text-[13px] md:text-[11px] text-[var(--muted)]">{empty}</span>
  const sorted = sortNavoreTasks(tasks).slice(0, limit)
  return (
    <ul className="flex flex-col divide-y divide-white/5">
      {sorted.map((t) => (
        <NavoreTaskRow key={t.id} task={t} />
      ))}
      {tasks.length > limit && (
        <li className="pt-1 text-[12px] md:text-[10px] text-[var(--muted)]">+{tasks.length - limit} more</li>
      )}
    </ul>
  )
}

/**
 * Scope banner shown atop shared-infra modes (Agents, Usage) in the professional
 * context. Reflects the real Navore Claude account state: once linked, spawned
 * Claude agents run under it; until then they fall back to the default account
 * (stated plainly, not faked — PLAN §8.5).
 */
export function NavoreScopeBanner({ note }: { note?: string }) {
  const status = useAuthStatus()
  const linked = status?.claudeNavore?.linked

  // Linked: confirm agents run under Navore (calm/emerald). Unknown or pending:
  // amber, with the honest fallback note.
  const linkedView = linked === true
  return (
    <div
      className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[13px] md:text-[11px] ${
        linkedView ? 'border-emerald-300/20 bg-emerald-300/[0.06]' : 'border-amber-300/20 bg-amber-300/[0.06]'
      }`}
    >
      <Briefcase size={13} className={`shrink-0 ${linkedView ? 'text-emerald-300' : 'text-amber-300'}`} />
      <span className={`font-bold uppercase tracking-[0.16em] ${linkedView ? 'text-emerald-200' : 'text-amber-200'}`}>Navore</span>
      <span className="text-[var(--muted)]">
        {linkedView
          ? 'Professional context · Claude agents run under the Navore account.'
          : note ?? 'Professional context · Navore Claude account not linked yet — using the default account.'}
      </span>
    </div>
  )
}

/** Standard header for a Navore mode variant (title + data age + refresh). */
export function NavoreModeHeader({
  title,
  ageText,
  loading,
  onRefresh,
}: {
  title: string
  ageText?: string
  loading?: boolean
  onRefresh: () => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] bg-black/20 px-3 py-2 text-[15px] md:text-[12px]">
      <Briefcase size={14} className="text-amber-300" />
      <span className="text-[17px] md:text-[13px] font-black uppercase tracking-[0.18em] text-amber-100">{title}</span>
      <span className="rounded-full bg-amber-300/15 px-1.5 py-0 text-[9px] font-bold text-amber-200">Navore</span>
      <div className="flex-1" />
      {ageText && <span className="text-[13px] md:text-[10px] text-[var(--muted)]">{ageText}</span>}
      <button
        onClick={onRefresh}
        title="Refresh (flush server cache)"
        className="flex items-center gap-1 rounded-lg border border-slate-400/20 bg-black/30 px-2.5 py-1.5 text-[13px] md:text-[11px] text-slate-300 hover:border-amber-300/40 hover:text-amber-100"
      >
        <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> refresh
      </button>
    </div>
  )
}
