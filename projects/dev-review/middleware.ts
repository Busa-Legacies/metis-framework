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

// Only exclude the API namespace this app actually owns (/api/reviews). A blanket
// /api/ exclusion made the proxied page's own root-relative API calls (e.g. the
// dashboard's /api/all) 404 against THIS origin instead of falling through to the
// preview target — every embedded panel rendered empty + console 404 noise.
const APP_PATHS = /^\/($|_next\/|api\/reviews|favicon\.ico|__nextjs)/

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl
  if (APP_PATHS.test(pathname)) return NextResponse.next()

  const target = req.cookies.get('dr-target')?.value
  if (!target || !/^https?:\/\/[\w.-]+(:\d+)?$/.test(target)) {
    return NextResponse.next()
  }

  const path = pathname === '/__preview' ? '/' : pathname
  return NextResponse.rewrite(new URL(`${target}${path}${search}`))
}

export const config = {
  // Everything except Next internals/static — app paths re-checked above.
  matcher: ['/((?!_next/static|_next/image).*)'],
}
