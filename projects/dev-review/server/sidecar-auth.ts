/**
 * Sidecar trust gate (#259): shared-secret token auth for the PTY sidecar.
 *
 * The sidecar can spawn real shells, so its surface is default-deny: every
 * HTTP route and the WS upgrade require the token. Design constraints from
 * the #259 arbiter pass on the earlier (rejected) attempt:
 *   - no unauthenticated endpoint may return the token (the console web app
 *     serves it from ITS origin via /api/sidecar-token — the console origin
 *     is the trust boundary, documented in README known limits);
 *   - no token-in-query: browsers can't set headers on WebSocket, so WS auth
 *     rides the Sec-WebSocket-Protocol field ('drt.<token>' offered alongside
 *     plain 'drt', server selects 'drt') — the Kubernetes-exec pattern, which
 *     keeps tokens out of URLs/logs/history;
 *   - default-deny includes /health.
 *
 * Token source: DEV_REVIEW_SIDECAR_TOKEN env wins; otherwise a 32-byte hex
 * token is minted once and persisted 0600 at <dataDir>/sidecar-token so the
 * same-machine console server (and e2e) can read it across restarts.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const TOKEN_FILE_NAME = 'sidecar-token'
export const TOKEN_HEADER = 'x-dev-review-token'
export const WS_PROTOCOL_PLAIN = 'drt'
export const WS_PROTOCOL_PREFIX = 'drt.'

export function loadOrMintToken(dataDir: string): string {
  const fromEnv = process.env.DEV_REVIEW_SIDECAR_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const file = path.join(dataDir, TOKEN_FILE_NAME)
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {}
  const minted = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, `${minted}\n`, { mode: 0o600 })
  return minted
}

export function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

type HeaderBag = Record<string, string | string[] | undefined>

/** HTTP auth: x-dev-review-token header or Authorization: Bearer. */
export function httpAuthorized(headers: HeaderBag, token: string): boolean {
  const raw = headers[TOKEN_HEADER]
  const presented = Array.isArray(raw) ? raw[0] : raw
  if (presented && timingSafeEq(presented, token)) return true
  const auth = headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ') && timingSafeEq(auth.slice(7), token)) {
    return true
  }
  return false
}

/**
 * WS upgrade auth: header (non-browser clients) or a 'drt.<token>' entry in
 * the offered subprotocols (browser clients — headers are unavailable there).
 */
export function wsAuthorized(headers: HeaderBag, token: string): boolean {
  if (httpAuthorized(headers, token)) return true
  const raw = headers['sec-websocket-protocol']
  const offered = Array.isArray(raw) ? raw.join(',') : raw
  if (typeof offered !== 'string') return false
  for (const part of offered.split(',')) {
    const candidate = part.trim()
    if (candidate.startsWith(WS_PROTOCOL_PREFIX) && timingSafeEq(candidate.slice(WS_PROTOCOL_PREFIX.length), token)) {
      return true
    }
  }
  return false
}
