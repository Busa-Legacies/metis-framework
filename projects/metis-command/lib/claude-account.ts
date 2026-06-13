/**
 * Per-account Claude credentials for spawned `claude` CLIs (Example professional
 * workspace vs Ant's default). Two Claude accounts on one machine:
 *
 *   - `default`  — the machine's own `~/.claude` login (no overrides).
 *   - `example`   — a separate Claude subscription, run via env overrides so it
 *                  never collides with the default account.
 *
 * macOS reality (Jay is a Mac): `CLAUDE_CONFIG_DIR` alone does NOT isolate OAuth
 * there — the login keychain entry is shared, so a second `claude login` would
 * overwrite the first. The reliable two-account path on one Mac is a long-lived
 * token from `claude setup-token`, injected as `CLAUDE_CODE_OAUTH_TOKEN` per
 * spawn (plus `CLAUDE_CONFIG_DIR` to isolate settings/history). So the Example
 * account is "linked" when that token is present.
 *
 * Pure + framework-free → unit-tested in tests/claude-account.test.ts. The PTY
 * server reads the real env (AW_CLAUDE_NAVORE_*) and feeds it here.
 */

export type ClaudeAccount = 'default' | 'example'

export interface ClaudeAccountSource {
  /** Operator home dir, for the default Example config-dir location. */
  home: string
  /** AW_CLAUDE_NAVORE_CONFIG_DIR — overrides the default `~/.claude-example`. */
  navoreConfigDir?: string
  /** AW_CLAUDE_NAVORE_OAUTH_TOKEN — long-lived token from `claude setup-token`. */
  navoreOAuthToken?: string
}

function navoreDir(src: ClaudeAccountSource): string {
  const override = src.navoreConfigDir?.trim()
  if (override) return override
  return `${src.home.replace(/\/$/, '')}/.claude-example`
}

/**
 * Env overrides to run a spawned agent under a given account. Only `claude`
 * agents under the `example` account get overrides — everything else (other
 * kinds, the default account) runs with no changes, inheriting `~/.claude`.
 */
export function claudeAccountEnv(
  account: ClaudeAccount | undefined,
  kind: string,
  src: ClaudeAccountSource,
): Record<string, string> {
  if (kind !== 'claude' || account !== 'example') return {}
  const out: Record<string, string> = { CLAUDE_CONFIG_DIR: navoreDir(src) }
  const token = src.navoreOAuthToken?.trim()
  if (token) out.CLAUDE_CODE_OAUTH_TOKEN = token
  return out
}

/**
 * Is the Example account usable? On macOS that means a long-lived token is
 * present (the keychain can't hold a second OAuth login). A token always
 * suffices; a config-dir credentials file (Linux) is checked by the caller.
 */
export function navoreLinked(src: ClaudeAccountSource): boolean {
  return !!src.navoreOAuthToken?.trim()
}

/** Map the Control Center workspace context to the Claude account to spawn under. */
export function accountForWorkspace(workspace: 'personal' | 'professional'): ClaudeAccount {
  return workspace === 'professional' ? 'example' : 'default'
}
