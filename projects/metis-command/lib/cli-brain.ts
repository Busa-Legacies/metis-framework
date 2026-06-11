/**
 * Drive `claude -p` or `codex exec` as the assistant brain.
 * The CLI uses the user's OAuth credentials (stored by `claude login` / `codex login`),
 * so no API key is required for the in-app assistant.
 */
import 'server-only'
import { spawn } from 'node:child_process'
import os from 'node:os'

export type CliProvider = 'claude-cli' | 'codex-cli'

interface RunOpts {
  provider: CliProvider
  prompt: string            // full prompt — we collapse history into one
  systemPrompt?: string     // appended/prepended depending on provider
  cwd?: string
  timeoutMs?: number
}

export interface RunResult {
  ok: boolean
  text: string
  error?: string
  exitCode?: number
}

function bin(provider: CliProvider): string {
  if (provider === 'claude-cli') return process.env.AW_CLAUDE_CMD || 'claude'
  return process.env.AW_CODEX_CMD || 'codex'
}

function buildArgs(provider: CliProvider, systemPrompt?: string): string[] {
  if (provider === 'claude-cli') {
    const args = ['-p', '--output-format', 'text']
    if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
    args.push('--allow-dangerously-skip-permissions')
    return args
  }
  // codex: feed the prompt via stdin to `codex exec` which reads from stdin when no PROMPT arg
  return ['exec', '--sandbox', 'danger-full-access', '--ask-for-approval', 'never', '--skip-git-repo-check']
}

export async function runCliBrain(opts: RunOpts): Promise<RunResult> {
  const { provider, prompt, systemPrompt, cwd, timeoutMs = 120_000 } = opts
  const args = buildArgs(provider, systemPrompt)
  const cmd = bin(provider)

  return await new Promise<RunResult>((resolve) => {
    let killed = false
    const proc = spawn(cmd, args, {
      cwd: cwd || os.homedir(),
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const t = setTimeout(() => { killed = true; try { proc.kill('SIGKILL') } catch {} }, timeoutMs)

    proc.stdout.on('data', (b) => { out += b.toString('utf8') })
    proc.stderr.on('data', (b) => { err += b.toString('utf8') })
    proc.on('error', (e) => {
      clearTimeout(t)
      resolve({ ok: false, text: '', error: e.message })
    })
    proc.on('exit', (code) => {
      clearTimeout(t)
      if (killed) {
        resolve({ ok: false, text: out, error: `timeout after ${timeoutMs}ms`, exitCode: code ?? -1 })
        return
      }
      // For codex, prepend system to prompt manually
      resolve({
        ok: code === 0,
        text: out.trim(),
        error: code !== 0 ? (err.trim() || `exit ${code}`) : undefined,
        exitCode: code ?? 0,
      })
    })

    // For codex, prepend system to the prompt body since there's no flag
    let body = prompt
    if (provider === 'codex-cli' && systemPrompt) {
      body = `${systemPrompt}\n\n---\n\n${prompt}`
    }
    proc.stdin.write(body)
    proc.stdin.end()
  })
}
