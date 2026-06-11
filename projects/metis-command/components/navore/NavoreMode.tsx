'use client'

import { ListChecks, FolderKanban, Flag, Code2, Mail, CalendarClock, GitCommitHorizontal, Wallet } from 'lucide-react'
import { ageLabel } from '@/lib/metis-api'
import { useMetisAll } from '@/lib/use-metis-all'
import {
  selectClickup,
  selectMs365,
  selectNavoreRepos,
  navoreCounts,
  navoreOpenWork,
} from '@/lib/navore-data'
import { StatusCard, CardLoading, CardError } from '../overview/cards'
import { NavoreTaskList, NavoreModeHeader } from './navore-ui'

/**
 * Navore — the professional workspace (PLAN §9.4 project view). Occupies the
 * domain nav slot (replacing Personal) when the Control Center is in the professional
 * context, and supplies the per-mode professional variants (Overview / Work
 * Graph / Tasks) below. Read-only; all data is the local /api/all clickup +
 * ms365 + github slices.
 */

function CountChip({ label, n, icon }: { label: string; n: number; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-black/20 px-2.5 py-1.5">
      <span className="text-amber-300">{icon}</span>
      <span className="text-lg font-black text-slate-100">{n}</span>
      <span className="text-[12px] md:text-[10px] uppercase tracking-[0.12em] text-[var(--muted)]">{label}</span>
    </div>
  )
}

/** ClickUp connect/error guard shared by every Navore surface. */
function useNavore() {
  const all = useMetisAll()
  const cu = selectClickup(all.data)
  return { ...all, cu }
}

function ClickupErrorNote({ error }: { error: string }) {
  return (
    <StatusCard title="ClickUp" icon={<ListChecks size={12} />} severity="warn">
      <span className="text-sm md:text-[11px] text-amber-200">{error}</span>
      <span className="text-[12px] md:text-[10px] text-[var(--muted)]">
        Set CLICKUP_TOKEN in the dashboard .env to surface Navore Market tasks.
      </span>
    </StatusCard>
  )
}

// ── Domain home: the full Navore workspace ───────────────────────────────────

export default function NavoreMode() {
  const { res, data, loading, now, hardReload, cu } = useNavore()
  const counts = navoreCounts(cu)
  const ms = selectMs365(data)
  const repos = selectNavoreRepos(data)

  return (
    <div data-testid="navore-mode" className="flex h-full w-full flex-col overflow-hidden">
      <NavoreModeHeader
        title="Navore Workspace"
        ageText={res ? (res.ok ? `data ${ageLabel(data?.ts, now)}` : 'no data') : undefined}
        loading={loading}
        onRefresh={hardReload}
      />

      {res && !res.ok ? (
        <CardError message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`} onRetry={hardReload} />
      ) : !data ? (
        <CardLoading label="loading Navore workspace…" />
      ) : (
        <div className="flex-1 overflow-y-auto p-4 md:p-3">
          {/* Counts strip */}
          <div className="mb-4 flex flex-wrap gap-2">
            <CountChip label="open work" n={navoreOpenWork(cu)} icon={<ListChecks size={14} />} />
            <CountChip label="projects" n={counts.projects} icon={<FolderKanban size={14} />} />
            <CountChip label="milestones" n={counts.milestones} icon={<Flag size={14} />} />
            <CountChip label="dev" n={counts.dev} icon={<Code2 size={14} />} />
          </div>

          {cu.error ? (
            <ClickupErrorNote error={cu.error} />
          ) : (
            <div className="grid grid-cols-1 gap-4 md:gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <StatusCard title="Ops · My Tasks" icon={<ListChecks size={12} />}>
                <NavoreTaskList tasks={cu.ops_tasks} empty="No ops tasks assigned" />
              </StatusCard>

              <StatusCard title="Dev · Sprint" icon={<Code2 size={12} />}>
                <NavoreTaskList tasks={cu.dev_tasks} empty="No dev tasks assigned" />
              </StatusCard>

              <StatusCard title="Projects" icon={<FolderKanban size={12} />}>
                <NavoreTaskList tasks={cu.projects} empty="No open projects" />
              </StatusCard>

              <StatusCard title="Milestones" icon={<Flag size={12} />}>
                <NavoreTaskList tasks={cu.milestones} empty="No milestones" />
              </StatusCard>

              {/* MS365 (Navore Teams/Outlook) */}
              <StatusCard title="Comms · MS365" icon={<Mail size={12} />} severity={ms.error ? 'warn' : 'ok'}>
                {ms.error ? (
                  <span className="text-sm md:text-[11px] text-amber-200">{ms.error}</span>
                ) : (
                  <div className="flex flex-col gap-0.5 text-sm md:text-[11px] text-[var(--muted)]">
                    <span className="flex items-center gap-1"><Mail size={12} /> {ms.email.length} recent emails</span>
                    <span className="flex items-center gap-1"><CalendarClock size={12} /> {ms.calendar.length} calendar items</span>
                    {ms.cache_age_min != null && (
                      <span className="text-[12px] md:text-[10px]">synced {ms.cache_age_min}m ago{ms.stale ? ' · stale' : ''}</span>
                    )}
                  </div>
                )}
              </StatusCard>

              {/* Navore GitHub */}
              <StatusCard title="GitHub · Navore" icon={<GitCommitHorizontal size={12} />}>
                {repos.length ? (
                  <div className="flex flex-col gap-1 text-sm md:text-[11px] text-[var(--muted)]">
                    {repos.map((r) => (
                      <div key={r.repo} className="flex flex-col">
                        <span className="font-bold text-slate-200">{r.repo}</span>
                        {r.error ? (
                          <span className="text-[12px] md:text-[10px] text-amber-200">{r.error}</span>
                        ) : (
                          r.commits?.[0] && (
                            <span className="truncate text-[12px] md:text-[10px]">
                              <span className="text-amber-200">{r.commits[0].sha}</span> {r.commits[0].message} · {r.commits[0].author}
                            </span>
                          )
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="text-sm md:text-[11px] text-[var(--muted)]">no Navore repo data</span>
                )}
              </StatusCard>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Overview (professional variant) ──────────────────────────────────────────

export function NavoreOverview() {
  const { res, data, loading, now, hardReload, cu } = useNavore()
  const counts = navoreCounts(cu)
  const ms = selectMs365(data)

  return (
    <div data-testid="navore-overview" className="flex h-full w-full flex-col overflow-hidden">
      <NavoreModeHeader
        title="Overview"
        ageText={res ? (res.ok ? `data ${ageLabel(data?.ts, now)}` : 'no data') : undefined}
        loading={loading}
        onRefresh={hardReload}
      />
      {res && !res.ok ? (
        <CardError message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`} onRetry={hardReload} />
      ) : !data ? (
        <CardLoading label="loading Navore overview…" />
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:gap-3 md:p-3 sm:grid-cols-2 xl:grid-cols-3">
          <StatusCard title="Open Work" icon={<ListChecks size={12} />} severity={navoreOpenWork(cu) ? 'warn' : 'ok'}>
            <span className="text-lg font-black text-slate-100">{navoreOpenWork(cu)}</span>
            <span className="text-sm md:text-[11px] text-[var(--muted)]">
              {counts.ops} ops · {counts.dev} dev · {counts.projects} projects · {counts.milestones} milestones
            </span>
          </StatusCard>

          {cu.error ? (
            <ClickupErrorNote error={cu.error} />
          ) : (
            <StatusCard title="Ops · My Tasks" icon={<ListChecks size={12} />}>
              <NavoreTaskList tasks={cu.ops_tasks} limit={5} empty="No ops tasks assigned" />
            </StatusCard>
          )}

          <StatusCard title="Comms · MS365" icon={<Mail size={12} />} severity={ms.error ? 'warn' : 'ok'}>
            {ms.error ? (
              <span className="text-sm md:text-[11px] text-amber-200">{ms.error}</span>
            ) : (
              <div className="flex flex-col gap-0.5 text-sm md:text-[11px] text-[var(--muted)]">
                <span>{ms.email.length} emails · {ms.calendar.length} calendar items</span>
                {ms.cache_age_min != null && <span className="text-[12px] md:text-[10px]">synced {ms.cache_age_min}m ago{ms.stale ? ' · stale' : ''}</span>}
              </div>
            )}
          </StatusCard>
        </div>
      )}
    </div>
  )
}

// ── Work Graph (professional variant): projects → milestones ─────────────────

export function NavoreWorkGraph() {
  const { res, data, loading, now, hardReload, cu } = useNavore()

  return (
    <div data-testid="navore-work-graph" className="flex h-full w-full flex-col overflow-hidden">
      <NavoreModeHeader
        title="Work Graph"
        ageText={res ? (res.ok ? `data ${ageLabel(data?.ts, now)}` : 'no data') : undefined}
        loading={loading}
        onRefresh={hardReload}
      />
      {res && !res.ok ? (
        <CardError message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`} onRetry={hardReload} />
      ) : !data ? (
        <CardLoading label="loading Navore work graph…" />
      ) : cu.error ? (
        <div className="p-4"><ClickupErrorNote error={cu.error} /></div>
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:gap-3 md:p-3 sm:grid-cols-2">
          <StatusCard title="Projects" icon={<FolderKanban size={12} />}>
            <NavoreTaskList tasks={cu.projects} limit={12} empty="No open projects" />
          </StatusCard>
          <StatusCard title="Milestones" icon={<Flag size={12} />}>
            <NavoreTaskList tasks={cu.milestones} limit={12} empty="No milestones" />
          </StatusCard>
        </div>
      )}
    </div>
  )
}

// ── Tasks (professional variant): ops + dev boards ───────────────────────────

export function NavoreTasks() {
  const { res, data, loading, now, hardReload, cu } = useNavore()

  return (
    <div data-testid="navore-tasks" className="flex h-full w-full flex-col overflow-hidden">
      <NavoreModeHeader
        title="Tasks"
        ageText={res ? (res.ok ? `data ${ageLabel(data?.ts, now)}` : 'no data') : undefined}
        loading={loading}
        onRefresh={hardReload}
      />
      {res && !res.ok ? (
        <CardError message={`${res.error} — start the backend on Jay with: bash scripts/restart-dashboard.sh`} onRetry={hardReload} />
      ) : !data ? (
        <CardLoading label="loading Navore tasks…" />
      ) : cu.error ? (
        <div className="p-4"><ClickupErrorNote error={cu.error} /></div>
      ) : (
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:gap-3 md:p-3 sm:grid-cols-2">
          <StatusCard title="Ops · My Tasks" icon={<Wallet size={12} />}>
            <NavoreTaskList tasks={cu.ops_tasks} limit={20} empty="No ops tasks assigned" />
          </StatusCard>
          <StatusCard title="Dev · Sprint" icon={<Code2 size={12} />}>
            <NavoreTaskList tasks={cu.dev_tasks} limit={20} empty="No dev tasks assigned" />
          </StatusCard>
        </div>
      )}
    </div>
  )
}
