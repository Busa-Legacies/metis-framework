import 'server-only'
import { spawn } from 'node:child_process'

export interface OpenClawRunResult {
  ok: boolean
  text: string
  error?: string
  raw?: string
  exitCode?: number
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const p = payload as Record<string, any>
  const candidates = [
    p.text,
    p.reply,
    p.message,
    p.content,
    p.assistantText,
    p.output,
    p.result?.text,
    p.result?.reply,
    p.result?.message,
    p.result?.content,
    p.response?.text,
    p.response?.message,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  const msg = p.message
  if (msg && typeof msg === 'object') {
    const content = msg.content
    if (typeof content === 'string' && content.trim()) return content.trim()
    if (Array.isArray(content)) {
      const text = content
        .map((part) => typeof part?.text === 'string' ? part.text : '')
        .filter(Boolean)
        .join('')
        .trim()
      if (text) return text
    }
  }
  return ''
}

function parseOpenClawJson(stdout: string): string {
  const trimmed = stdout.trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed)
    const text = extractText(parsed)
    if (text) return text
  } catch {}

  // Some CLI paths may print log lines before/after JSON. Try the last JSON object block.
  const start = trimmed.lastIndexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1))
      const text = extractText(parsed)
      if (text) return text
    } catch {}
  }
  return trimmed
}

export async function runOpenClawMetisBrainTurn(opts: {
  message: string
  agentId?: string
  sessionKey?: string
  timeoutSeconds?: number
  cwd?: string
}): Promise<OpenClawRunResult> {
  const agentId = opts.agentId || process.env.AW_OPENCLAW_AGENT || 'main'
  const timeoutSeconds = Math.max(30, Math.min(1800, opts.timeoutSeconds ?? 600))
  const args = [
    'agent',
    '--agent', agentId,
    '--session-id', opts.sessionKey || process.env.AW_OPENCLAW_SESSION_ID || 'workbench:global',
    '--message', opts.message,
    '--json',
    '--timeout', String(timeoutSeconds),
  ]

  return await new Promise<OpenClawRunResult>((resolve) => {
    const proc = spawn(process.env.AW_OPENCLAW_CMD || 'openclaw', args, {
      cwd: opts.cwd || process.env.METIS_BRAIN_CWD || process.env.AW_JARVIS_CWD || `${process.env.HOME}/.openclaw/workspace`,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (b) => { out += b.toString('utf8') })
    proc.stderr.on('data', (b) => { err += b.toString('utf8') })
    proc.on('error', (e) => resolve({ ok: false, text: '', error: e.message }))
    proc.on('exit', (code) => {
      const text = parseOpenClawJson(out)
      if (code === 0) {
        resolve({ ok: true, text, raw: out, exitCode: 0 })
        return
      }
      resolve({
        ok: false,
        text,
        raw: out,
        error: err.trim() || text || `openclaw agent exited ${code}`,
        exitCode: code ?? -1,
      })
    })
  })
}
