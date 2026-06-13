import { NextRequest, NextResponse } from 'next/server'

/**
 * Same-origin proxy to the FastAPI dashboard (the data plane). The browser
 * reaching :8080 directly is cross-origin (port counts) and CORS-blocked, so
 * the typed metis-api client calls `/api/metis/<path>` here and we forward
 * server-side to `${METIS_API_URL}/api/<path>`.
 *
 * Read-only GET passthrough only — mutations stay on governed dashboard routes.
 * See docs/plans/PLAN-metis-control-center-convergence.md §3, §7.1.
 */
export const dynamic = 'force-dynamic'

const DASHBOARD_URL = process.env.METIS_API_URL ?? 'http://127.0.0.1:8080'

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const sub = (path ?? []).join('/')
  // Forward the query string — endpoints like `file?path=…` and
  // `tasks/governed?include_done=…` carry their args there, not in the segments.
  const url = `${DASHBOARD_URL}/api/${sub}${req.nextUrl.search}`
  try {
    // /api/all can take ~16s on a cold aggregate; allow generous headroom.
    const res = await fetch(url, { signal: AbortSignal.timeout(25000), cache: 'no-store' })
    const body = await res.text()
    return new NextResponse(body, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), upstream: url },
      { status: 502 },
    )
  }
}

/**
 * Mutating passthrough is ALLOWLISTED (§8.6 "no hidden mutability") — this proxy
 * is not a blanket mutation gateway. Only idempotent/safe paths pass; gated
 * actions (restart bot/service, task claim/finish — #240) must be added here
 * deliberately, behind their own confirmation/audit, never by default.
 */
const POST_ALLOW = new Set([
  'cache/invalidate',
  'bot/restart',
  'plaid/link-token',
  'plaid/exchange',
  'plaid/sync',
  // Governed task mutations (#228/#240) — the Control Center DRIVES the canonical store.
  // Each routes server-side to a sanctioned, revision-aware/fencing CLI; no raw json.
  'tasks/governed/update',
  'tasks/governed/transition',
  'tasks/governed/correct-state',
  'tasks/governed/claim',
  'tasks/governed/unclaim',
  'tasks/governed/decide',
  'tasks/governed/decide-undo',
])

// Dynamic-id POST paths (operator inbox #240 Phase 2) — exact-match Set can't
// express a path segment. Resolving a pending decision is governed
// (require_trusted + can't re-resolve) so it's safe to allowlist by shape.
const POST_ALLOW_RE = [
  /^decisions\/[\w-]+\/resolve$/,
  /^decisions\/[\w-]+\/update$/,
]

export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params
  const sub = (path ?? []).join('/')
  if (!POST_ALLOW.has(sub) && !POST_ALLOW_RE.some((re) => re.test(sub))) {
    return NextResponse.json({ error: `POST /api/${sub} is not allowlisted` }, { status: 403 })
  }
  const url = `${DASHBOARD_URL}/api/${sub}`
  try {
    const body = await req.text()
    const ct = req.headers.get('content-type')
    const res = await fetch(url, {
      method: 'POST',
      headers: ct ? { 'content-type': ct } : undefined,
      body: body || undefined,
      signal: AbortSignal.timeout(25000),
      cache: 'no-store',
    })
    const text = await res.text()
    return new NextResponse(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), upstream: url },
      { status: 502 },
    )
  }
}
