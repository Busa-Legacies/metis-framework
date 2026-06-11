/**
 * Resolves the Navore Claude credential server-side, so the long-lived OAuth
 * token never has to live in the LaunchAgent plist or the repo. Precedence:
 *
 *   1. AW_CLAUDE_NAVORE_OAUTH_TOKEN env var (if the operator prefers env).
 *   2. A gitignored secret file: $AW_DATA_DIR/navore-claude-token
 *      (default ~/.openclaw/metis-command/navore-claude-token), chmod 600.
 *
 * The secret file is the recommended path — it's outside the repo, survives
 * `bootstrap` regenerating the plist, and rotates with a single `echo > file`.
 * Pairs with lib/claude-account.ts, which stays pure and takes resolved values.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function dataDir(): string {
  return expandHome(process.env.AW_DATA_DIR ?? path.join(os.homedir(), '.openclaw', 'metis-command'))
}

/** Path to the gitignored Navore token file. */
export function navoreTokenPath(): string {
  return path.join(dataDir(), 'navore-claude-token')
}

function readSecretFile(p: string): string | undefined {
  try {
    const s = fs.readFileSync(p, 'utf8')
    return s || undefined
  } catch {
    return undefined
  }
}

/**
 * OAuth tokens are a single unbroken string with no whitespace. Terminals wrap
 * long tokens on display, and a copy/paste can carry those breaks into the
 * secret file — `claude` then rejects the token and drops to interactive login.
 * Strip ALL whitespace (not just the ends) so a wrapped paste still works.
 */
export function sanitizeToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const t = raw.replace(/\s+/g, '')
  return t || undefined
}

/** A resolved token that looks like a setup-token OAuth token (shape only). */
export function navoreTokenLooksValid(token: string | undefined): boolean {
  return !!token && /^sk-ant-oat/.test(token)
}

/** Long-lived Navore OAuth token (env first, then the secret file), sanitized. */
export function navoreOAuthToken(): string | undefined {
  return sanitizeToken(process.env.AW_CLAUDE_NAVORE_OAUTH_TOKEN) || sanitizeToken(readSecretFile(navoreTokenPath()))
}

/** Optional Navore config-dir override (settings/history isolation). */
export function navoreConfigDir(): string | undefined {
  return process.env.AW_CLAUDE_NAVORE_CONFIG_DIR?.trim() || undefined
}
