import { NextResponse, type NextRequest } from 'next/server'

/**
 * Same-origin preview proxy. The iframe must share the app's origin (:3760) for
 * the overlay controller to touch its DOM — localhost ports are NOT same-origin
 * with each other. So the page under review is proxied through this origin:
 *
 *   /__preview            → <target>/            (entry, set by PreviewPane)
 *   /<anything-else>      → <target>/<path>      (root-relative assets/XHR of
 *                                                  the proxied page fall through)
 *
 * The target origin lives in the `dr-target` cookie (set by PreviewPane on URL
 * submit). App-internal paths are excluded by the matcher below. Target WS/HMR
 * is not proxied — acceptable for review; reload the preview instead.
 */

// Only exclude the API namespaces this app actually owns (/api/reviews,
// /api/sidecar-token — the #259 trust-gate hand-off). A blanket /api/ exclusion
// made the proxied page's own root-relative API calls (e.g. the dashboard's
// /api/all) 404 against THIS origin instead of falling through to the preview
// target — every embedded panel rendered empty + console 404 noise.
const APP_PATHS = /^\/($|_next\/|api\/reviews|api\/sidecar-token|favicon\.ico|__nextjs)/

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl
  if (APP_PATHS.test(pathname)) return NextResponse.next()

  const target = req.cookies.get('dr-target')?.value
  if (!target || !/^https?:\/\//.test(target)) {
    return NextResponse.next()
  }

  // Extract credentials from target URL (http://user:pass@host:port) so
  // auth-gated local targets (e.g. Metis Command :3747) work in the proxy.
  let targetOrigin = target
  let authHeader: string | null = null
  try {
    const u = new URL(target)
    if (u.username) {
      authHeader = 'Basic ' + Buffer.from(`${u.username}:${u.password}`).toString('base64')
      u.username = ''
      u.password = ''
      targetOrigin = u.origin
    }
  } catch { /* invalid URL — fall through */ }

  if (!/^https?:\/\/[\w.-]+(:\d+)?$/.test(targetOrigin)) {
    return NextResponse.next()
  }

  const path = pathname === '/__preview' ? '/' : pathname
  const destUrl = new URL(`${targetOrigin}${path}${search}`)

  if (authHeader) {
    const headers = new Headers(req.headers)
    headers.set('authorization', authHeader)
    return NextResponse.rewrite(destUrl, { request: { headers } })
  }
  return NextResponse.rewrite(destUrl)
}

export const config = {
  // Everything except Next internals/static — app paths re-checked above.
  matcher: ['/((?!_next/static|_next/image).*)'],
}
