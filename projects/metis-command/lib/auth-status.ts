import 'server-only'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readSettings } from './settings'
import { navoreOAuthToken, navoreConfigDir, navoreTokenLooksValid } from './example-credential'

export interface AuthStatus {
  claude: { installed: boolean; signedIn: boolean }
  codex: { installed: boolean; signedIn: boolean }
  gemini: { installed: boolean; signedIn: boolean }
  openai: { hasKey: boolean }
  /** Example (professional workspace) Claude account — linked when a long-lived
   *  token is set (macOS) or a credentials file exists in its config dir (Linux). */
  claudeNavore: { linked: boolean }
}

function which(cmd: string): boolean {
  return new Promise<boolean>((resolve) => {
    const p = spawn('/usr/bin/which', [cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    p.on('exit', (c) => resolve(c === 0))
    p.on('error', () => resolve(false))
  }) as unknown as boolean
}

function fileExists(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

async function whichAsync(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn('/usr/bin/which', [cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    p.on('exit', (c) => resolve(c === 0))
    p.on('error', () => resolve(false))
  })
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const home = os.homedir()
  const [claudeBin, codexBin, geminiBin] = await Promise.all([
    whichAsync('claude'),
    whichAsync('codex'),
    whichAsync('gemini'),
  ])

  // Heuristic auth detection — credential files persisted by each CLI on login.
  const claudeAuth =
    fileExists(path.join(home, '.claude', 'credentials.json')) ||
    fileExists(path.join(home, '.claude.json')) ||
    dirExists(path.join(home, '.claude', 'sessions'))
  const codexAuth =
    fileExists(path.join(home, '.codex', 'auth.json')) ||
    fileExists(path.join(home, '.codex', 'session.json')) ||
    dirExists(path.join(home, '.codex'))
  const geminiAuth =
    fileExists(path.join(home, '.config', 'gcloud', 'application_default_credentials.json')) ||
    fileExists(path.join(home, '.config', 'gemini', 'credentials.json'))

  const settings = readSettings()
  const hasKey = !!settings.openaiApiKey || !!process.env.OPENAI_API_KEY

  // Example Claude account: a valid-looking long-lived token (macOS-safe path, env
  // or secret file) or a credentials file in its isolated config dir (Linux).
  // Shape-check the token so a malformed paste reads as not-linked (amber) rather
  // than a green badge that fails at spawn time.
  const navoreDir = navoreConfigDir() || path.join(home, '.claude-example')
  const navoreLinked =
    navoreTokenLooksValid(navoreOAuthToken()) ||
    fileExists(path.join(navoreDir, '.credentials.json'))

  return {
    claude: { installed: claudeBin, signedIn: claudeBin && claudeAuth },
    codex: { installed: codexBin, signedIn: codexBin && codexAuth },
    gemini: { installed: geminiBin, signedIn: geminiBin && geminiAuth },
    openai: { hasKey },
    claudeNavore: { linked: navoreLinked },
  }
}
