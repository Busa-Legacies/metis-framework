import type { MetisAll, MetisRateLimits, MetisLeasesResponse, MetisGoverned, MetisGoverndTask, MetisInbox, MetisLinesIndex, MetisLineDetail, MetisFileContent, MetisTaskRoutePlan } from './metis-api-types'

/**
 * Typed client for the dashboard data plane, consumed by the Control Center
 * Overview. Calls the same-origin proxy (`/api/metis/*`) which forwards to the
 * FastAPI backend, so the browser never hits :8080 cross-origin.
 *
 * Every call resolves to a discriminated MetisResult — never throws — so cards
 * render explicit degraded states instead of blank panels (PLAN §8.5).
 */

export type MetisResult<T> =
  | { ok: true; data: T; fetchedAt: string }
  | { ok: false; error: string; status: number; fetchedAt: string }

async function getJson<T>(path: string, timeoutMs = 25000): Promise<MetisResult<T>> {
  const fetchedAt = new Date().toISOString()
  try {
    const res = await fetch(`/api/metis/${path}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      let detail = `HTTP ${res.status}`
      try {
        const body = await res.json()
        if (body?.error) detail = String(body.error)
      } catch {
        /* non-JSON error body */
      }
      return { ok: false, error: detail, status: res.status, fetchedAt }
    }
    const data = (await res.json()) as T
    return { ok: true, data, fetchedAt }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: 0,
      fetchedAt,
    }
  }
}

export const metisApi = {
  /** Full aggregate (cached server-side, ~15s TTL). The Overview's primary source for M2. */
  all: () => getJson<MetisAll>('all'),
  /** Standalone rate-limit/usage endpoint (lighter than /api/all). */
  ratelimits: () => getJson<MetisRateLimits>('ratelimits'),
  /** Active agent leases (owners + fence tokens) — light, for Work Graph attribution. */
  leases: () => getJson<MetisLeasesResponse>('leases', 8000),
  /** Work-progress endpoint. */
  progress: () => getJson<unknown>('progress'),
  /** Governed task board — all tasks grouped by project. */
  tasksGoverned: (includeDone = false) =>
    getJson<MetisGoverned>('tasks/governed?include_done=' + includeDone),
  /** Route/spawn preview for task assignment and work resumption. */
  taskRoutePlan: (taskId: string) =>
    getJson<MetisTaskRoutePlan>(`task-routing/plan?task_id=${encodeURIComponent(taskId)}`, 12000),
  /**
   * Safe action (§8.6 idempotent tier): flush the server-side /api/all cache so
   * the next fetch is fresh. Allowlisted POST through the proxy. Returns true on
   * success; never throws.
   */
  invalidateCache: async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/metis/cache/invalidate', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000) })
      return res.ok
    } catch {
      return false
    }
  },
  /**
   * Shared-state safe action (§8.6): restart the trading bot via the governed
   * /api/bot/restart endpoint (require_trusted; only reports ok once the process
   * survives startup). Confirm-gated in the UI. Returns the result + log tail as
   * evidence; never throws.
   */
  restartBot: async (): Promise<MetisActionResult> => {
    try {
      const res = await fetch('/api/metis/bot/restart', { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(30000) })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; log_tail?: string }
      return { ok: res.ok && body.ok !== false, error: body.error, log_tail: body.log_tail }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  /**
   * Governed write path (#228/#240): the Control Center DRIVES the canonical task store.
   * Each call routes through the proxy to a sanctioned, revision-aware/fencing CLI
   * server-side — never a raw json edit. `expectedRevision` gives optimistic
   * concurrency: a stale revision returns 409 (someone else moved the task). Never
   * throws; render the error inline.
   */
  taskUpdate: (taskId: string, expectedRevision: number, patch: Record<string, unknown>) =>
    postGoverned('tasks/governed/update', { taskId, expectedRevision, patch }),
  /** Audited state correction (e.g. mark done) — carries a required reason. */
  taskCorrectState: (taskId: string, expectedRevision: number, toState: string, reason: string) =>
    postGoverned('tasks/governed/correct-state', { taskId, expectedRevision, toState, reason }),
  /**
   * Answer a task decision-point: logs the response as a tracked decision
   * (decisions.json audit trail) AND advances the task (clears the gate, writes
   * nextAction) in one governed move. `question`/`options` enrich the record.
   */
  taskDecide: (taskId: string, expectedRevision: number, response: string, question?: string, options?: string[], chosenKey?: string) =>
    postGoverned('tasks/governed/decide', { taskId, expectedRevision, response, question, options, chosenKey }),
  /** Reverse a just-logged decision (8s undo): restore the task + remove the record. */
  taskDecideUndo: (taskId: string, expectedRevision: number, decisionId: string | undefined, restorePoint: string, restoreAction: string) =>
    postGoverned('tasks/governed/decide-undo', { taskId, expectedRevision, decisionId, restorePoint, restoreAction }),
  /** Lease a task to an agent (fencing token). Returns claimId + fence for release. */
  taskClaim: (taskId: string, agent: string, title?: string) =>
    postGoverned('tasks/governed/claim', { taskId, agent, title }),
  /** Release a lease by its claim-id. */
  taskUnclaim: (claimId: string) =>
    postGoverned('tasks/governed/unclaim', { claimId }),

  /**
   * Operator inbox (#240 Phase 2): everything needing Ant's judgment — formal
   * decisions, task decision-points, verifications, blockers, parked work — in
   * one read, each task carrying a Notion-parity actionType badge.
   */
  inbox: () => getJson<MetisInbox>('inbox'),
  /** Resolve a pending formal decision (decisions.json). Audited, can't re-resolve. */
  resolveDecision: (decisionId: string, chosen: string, rationale: string) =>
    postGoverned(`decisions/${decisionId}/resolve`, { chosen, rationale, resolved_by: 'ant' }),
  /** Edit a pending formal decision record through the governed dashboard route. */
  updateDecision: (decisionId: string, patch: Record<string, unknown>) =>
    postGoverned(`decisions/${decisionId}/update`, { patch }),

  /**
   * Lines of work (#240 Phase 3): follow one thread top to bottom. `lines()`
   * lists drillable projects; `lineDetail(slug)` returns the milestone ladder
   * with each milestone's tasks, per-task done-gate, and live lease attribution.
   */
  lines: () => getJson<MetisLinesIndex>('lines'),
  lineDetail: (slug: string) => getJson<MetisLineDetail>(`lines/${slug}`),

  /**
   * Read a repo file for inline review (#240): the inbox links a plan/spec/design
   * to a decision; this serves it (repo-scoped, allowlisted server-side). For
   * markdown the result carries a condensed `brief` (outline + decision sections)
   * so the card can be decided from without opening the whole doc.
   */
  file: (path: string) => getJson<MetisFileContent>(`file?path=${encodeURIComponent(path)}`),
}

export interface GovernedMutationResult {
  ok: boolean
  error?: string
  task?: MetisGoverndTask
  claimId?: string
  fence?: string
  decisionId?: string
}

async function postGoverned(path: string, payload: Record<string, unknown>): Promise<GovernedMutationResult> {
  try {
    const res = await fetch(`/api/metis/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
    })
    const body = (await res.json().catch(() => ({}))) as GovernedMutationResult & { detail?: string }
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error ?? body.detail ?? `HTTP ${res.status}` }
    }
    return { ok: true, task: body.task, claimId: body.claimId, fence: body.fence, decisionId: body.decisionId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface MetisActionResult {
  ok: boolean
  error?: string
  log_tail?: string
}

// ── pure selectors (unit-testable without a network) ────────────────────────

export type Severity = 'ok' | 'warn' | 'critical'

/** Map a 0-100 utilization to a severity band (§8.3 per-panel thresholds). */
export function utilSeverity(pct: number, warn = 75, critical = 90): Severity {
  if (pct >= critical) return 'critical'
  if (pct >= warn) return 'warn'
  return 'ok'
}

/** Highest alert severity present, for the Overview header badge. */
export function topAlertSeverity(alerts: { level: string }[] | undefined): Severity {
  if (!alerts?.length) return 'ok'
  if (alerts.some((a) => a.level === 'critical')) return 'critical'
  if (alerts.some((a) => a.level === 'warning' || a.level === 'warn')) return 'warn'
  return 'ok'
}

/**
 * Completion fraction (0-100) for a goal/milestone. Denominator is all tracked
 * tasks (done + active + in_progress + blocked); returns 0 when nothing tracked
 * so an empty goal reads as 0%, not NaN.
 */
export function goalProgressPct(g: { done: number; active: number; in_progress: number; blocked: number }): number {
  const total = g.done + g.active + g.in_progress + g.blocked
  if (total <= 0) return 0
  return Math.round((g.done / total) * 100)
}

/**
 * Human "time until" label for a FUTURE timestamp (reset windows); 'now' when
 * past, '—' when invalid. Accepts ISO strings AND bare epoch-seconds strings —
 * the ratelimits inference path emits `resets_at: str(int(window_end))`, which
 * Date.parse() rejects, so Usage-mode reset windows rendered '—' forever.
 */
export function untilLabel(iso: string | undefined, now: number): string {
  if (!iso) return '—'
  // bare digits = epoch seconds (13+ digits would be ms; the API emits seconds)
  const t = /^\d{9,12}$/.test(iso) ? Number(iso) * 1000 : Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.round((t - now) / 1000)
  if (s <= 0) return 'now'
  if (s < 60) return `in ${s}s`
  if (s < 3600) return `in ${Math.round(s / 60)}m`
  if (s < 48 * 3600) return `in ${Math.round(s / 3600)}h`
  return `in ${Math.round(s / 86400)}d`
}

/** Human age label from an ISO timestamp; '—' when missing/invalid. */
export function ageLabel(iso: string | undefined, now: number): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}
