/**
 * Example (professional workspace) selectors over the shared `/api/all` payload.
 * The dashboard backend already aggregates `clickup`, `ms365`, and `github` into
 * /api/all, so the professional surface rides the SAME shared poller as the
 * personal one — no extra fetch plumbing. These selectors pull the Example slices
 * out defensively (the keys are untyped in the strict MetisAll contract) so a
 * missing/erroring feed renders an explicit empty state, never a crash.
 *
 * Pure + framework-free → unit-tested in tests/example-data.test.ts.
 */

import type { MetisAll } from './metis-api-types'

export interface NavoreTask {
  id: string
  name: string
  status: string
  priority: string
  due: string | null
  url: string
}

export interface NavoreCounts {
  ops: number
  projects: number
  milestones: number
  dev: number
}

export interface NavoreClickup {
  ops_tasks: NavoreTask[]
  projects: NavoreTask[]
  milestones: NavoreTask[]
  dev_tasks: NavoreTask[]
  counts?: NavoreCounts
  error?: string
}

export interface NavoreMs365 {
  calendar: unknown[]
  email: unknown[]
  cache_age_min?: number
  stale: boolean
  error?: string
}

export interface NavoreGithubRepo {
  repo: string
  commits?: { sha?: string; message?: string; author?: string; date?: string }[]
  error?: string
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export function selectClickup(data?: MetisAll | null): NavoreClickup {
  const c = asRecord(data?.clickup)
  return {
    ops_tasks: asArray<NavoreTask>(c.ops_tasks),
    projects: asArray<NavoreTask>(c.projects),
    milestones: asArray<NavoreTask>(c.milestones),
    dev_tasks: asArray<NavoreTask>(c.dev_tasks),
    counts: c.counts as NavoreCounts | undefined,
    error: typeof c.error === 'string' ? c.error : undefined,
  }
}

/** Counts from the payload, falling back to array lengths when absent. */
export function navoreCounts(c: NavoreClickup): NavoreCounts {
  return (
    c.counts ?? {
      ops: c.ops_tasks.length,
      projects: c.projects.length,
      milestones: c.milestones.length,
      dev: c.dev_tasks.length,
    }
  )
}

export function selectMs365(data?: MetisAll | null): NavoreMs365 {
  const m = asRecord(data?.ms365)
  return {
    calendar: asArray(m.calendar),
    email: asArray(m.email),
    cache_age_min: typeof m.cache_age_min === 'number' ? m.cache_age_min : undefined,
    stale: m.stale === true,
    error: typeof m.error === 'string' ? m.error : undefined,
  }
}

/** Example-owned repos from the github feed (filters the cross-project list). */
export function selectNavoreRepos(data?: MetisAll | null): NavoreGithubRepo[] {
  return asArray<NavoreGithubRepo>(data?.github).filter((r) => /example/i.test(r?.repo ?? ''))
}

export type NavoreTone = 'done' | 'active' | 'blocked' | 'open'

/** Map a free-form ClickUp status string to a coarse tone for dot colour. */
export function navoreStatusTone(status: string | null | undefined): NavoreTone {
  const s = (status ?? '').toLowerCase()
  if (/(complete|done|closed|shipped|live)/.test(s)) return 'done'
  if (/(block|hold|stuck|waiting|on.?hold)/.test(s)) return 'blocked'
  if (/(progress|active|doing|review|qa|started)/.test(s)) return 'active'
  return 'open'
}

const PRIO_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }

/** Sort tasks: open/active before done, then by ClickUp priority. */
export function sortNavoreTasks(tasks: NavoreTask[]): NavoreTask[] {
  return [...tasks].sort((a, b) => {
    const ad = navoreStatusTone(a.status) === 'done' ? 1 : 0
    const bd = navoreStatusTone(b.status) === 'done' ? 1 : 0
    if (ad !== bd) return ad - bd
    return (PRIO_RANK[a.priority] ?? 2) - (PRIO_RANK[b.priority] ?? 2)
  })
}

/** Count of not-yet-done tasks across the ops + dev lists (the action surface). */
export function navoreOpenWork(c: NavoreClickup): number {
  return [...c.ops_tasks, ...c.dev_tasks].filter((t) => navoreStatusTone(t.status) !== 'done').length
}
