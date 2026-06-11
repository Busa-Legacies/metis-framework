import 'server-only'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'

export interface GatewayChatResult {
  ok: boolean
  text: string
  runId?: string
  events?: Array<{ event: string; payload: any }>
  error?: string
}

function readEnvFile(): Record<string, string> {
  const file = path.join(os.homedir(), '.openclaw', '.env')
  try {
    const out: Record<string, string> = {}
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx <= 0) continue
      const key = trimmed.slice(0, idx).trim()
      let val = trimmed.slice(idx + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
      out[key] = val
    }
    return out
  } catch {
    return {}
  }
}

function readOpenClawConfig(): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'))
  } catch {
    return {}
  }
}

function gatewayAuth() {
  const envFile = readEnvFile()
  const cfg = readOpenClawConfig()
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || envFile.OPENCLAW_GATEWAY_TOKEN || cfg?.gateway?.auth?.token
  const password = process.env.OPENCLAW_GATEWAY_PASSWORD || envFile.OPENCLAW_GATEWAY_PASSWORD || cfg?.gateway?.auth?.password
  return { token, password }
}

function gatewayUrl() {
  const cfg = readOpenClawConfig()
  const port = cfg?.gateway?.port || 18789
  return process.env.OPENCLAW_GATEWAY_URL || process.env.AW_OPENCLAW_GATEWAY_URL || `ws://127.0.0.1:${port}`
}

function textFromMessage(message: any): string {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('')
      .trim()
  }
  if (typeof message.text === 'string') return message.text.trim()
  return ''
}

class MiniGatewayClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timeout: NodeJS.Timeout }>()
  private eventHandlers = new Set<(evt: { event: string; payload: any }) => void>()

  constructor(private opts: { url: string; token?: string; password?: string; timeoutMs: number }) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(this.opts.url)
    this.ws = ws
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('gateway connect timeout')), Math.min(this.opts.timeoutMs, 30_000))
      ws.on('error', (err) => { clearTimeout(timeout); reject(err instanceof Error ? err : new Error(String(err))) })
      ws.on('close', (code, reason) => {
        const text = reason?.toString?.() || ''
        for (const p of this.pending.values()) p.reject(new Error(`gateway closed (${code}) ${text}`.trim()))
        this.pending.clear()
      })
      ws.on('message', (data) => this.handleMessage(data.toString('utf8'), resolve, reject, timeout))
    })
  }

  close() {
    try { this.ws?.close() } catch {}
    this.ws = null
  }

  onEvent(fn: (evt: { event: string; payload: any }) => void) {
    this.eventHandlers.add(fn)
    return () => this.eventHandlers.delete(fn)
  }

  private handleMessage(raw: string, connectResolve?: () => void, connectReject?: (e: Error) => void, connectTimeout?: NodeJS.Timeout) {
    let parsed: any
    try { parsed = JSON.parse(raw) } catch { return }

    if (parsed?.type === 'event') {
      if (parsed.event === 'connect.challenge') {
        const nonce = parsed.payload?.nonce
        if (!nonce) {
          connectReject?.(new Error('gateway challenge missing nonce'))
          return
        }
        this.request('connect', {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            // Gateway validates client ids against its known protocol enum.
            // Use backend client semantics server-side; chat.send still marks the message as webchat.
            id: 'gateway-client',
            displayName: 'Metis Command Center',
            version: '0.1.0',
            platform: process.platform,
            mode: 'backend',
          },
          caps: ['tool-events'],
          auth: this.opts.token || this.opts.password ? { token: this.opts.token, password: this.opts.password } : undefined,
          role: 'operator',
          scopes: ['operator.admin'],
        }, { timeoutMs: Math.min(this.opts.timeoutMs, 30_000) })
          .then(() => { if (connectTimeout) clearTimeout(connectTimeout); connectResolve?.() })
          .catch((e) => { if (connectTimeout) clearTimeout(connectTimeout); connectReject?.(e instanceof Error ? e : new Error(String(e))) })
        return
      }
      for (const fn of this.eventHandlers) fn({ event: parsed.event, payload: parsed.payload })
      return
    }

    if (parsed?.type === 'res') {
      const p = this.pending.get(parsed.id)
      if (!p) return
      this.pending.delete(parsed.id)
      clearTimeout(p.timeout)
      if (parsed.ok) p.resolve(parsed.payload)
      else p.reject(new Error(parsed.error?.message || parsed.error?.code || 'gateway request failed'))
    }
  }

  request(method: string, params: any = {}, opts: { timeoutMs?: number } = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('gateway not connected'))
    const id = randomUUID()
    const timeout = setTimeout(() => {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      p.reject(new Error(`gateway request timeout for ${method}`))
    }, opts.timeoutMs ?? this.opts.timeoutMs)
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, timeout }))
    this.ws.send(JSON.stringify({ type: 'req', id, method, params }))
    return promise
  }
}

export async function runOpenClawGatewayChat(opts: {
  message: string
  sessionKey?: string
  metadata?: object
  timeoutMs?: number
}): Promise<GatewayChatResult> {
  const timeoutMs = Math.max(30_000, Math.min(30 * 60_000, opts.timeoutMs ?? 600_000))
  const { token, password } = gatewayAuth()
  const client = new MiniGatewayClient({ url: gatewayUrl(), token, password, timeoutMs })
  const idempotencyKey: string = randomUUID()
  let runId: string = idempotencyKey
  let activeRunId: string | undefined
  const bufferedEvents: Array<{ event: string; payload: any }> = []
  const events: Array<{ event: string; payload: any }> = []

  try {
    await client.connect()
    const finalPromise = new Promise<GatewayChatResult>((resolve, reject) => {
      let latestText = ''
      let settled = false
      const settle = (result: GatewayChatResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        if (latestText.trim()) {
          settle({ ok: true, text: latestText.trim(), runId, events })
          return
        }
        reject(new Error('gateway chat final timeout'))
      }, timeoutMs)
      client.onEvent((evt) => {
        if (evt.event !== 'chat' && evt.event !== 'agent') return
        bufferedEvents.push(evt)
        const payload = evt.payload
        if (!payload) return
        if (activeRunId && payload.runId !== activeRunId) return
        if (!activeRunId && payload.runId && payload.runId !== idempotencyKey) return
        events.push(evt)
        if (evt.event === 'chat' && payload.message) {
          const text = textFromMessage(payload.message)
          if (text) latestText = text
        }
        if (evt.event === 'chat' && payload.state === 'final') {
          settle({ ok: true, text: latestText || textFromMessage(payload.message), runId, events })
        } else if (evt.event === 'chat' && payload.state === 'error') {
          clearTimeout(timer)
          reject(new Error(payload.errorMessage || 'gateway chat error'))
        } else if (evt.event === 'chat' && payload.state === 'aborted') {
          clearTimeout(timer)
          reject(new Error('gateway chat aborted'))
        }
      })
    })

    const sendResult = await client.request('chat.send', {
      // Do not default to `main`: that session can carry Telegram/WebChat delivery context.
      // Command Center needs its own stable surface session while still using the same Metis Brain runtime.
      sessionKey: opts.sessionKey || process.env.AW_OPENCLAW_SESSION_KEY || 'workbench',
      message: opts.message,
      metadata: opts.metadata,
      deliver: false,
      timeoutMs,
      idempotencyKey,
    }, { timeoutMs: 30_000 })

    activeRunId = sendResult?.runId || sendResult?.id || sendResult?.run?.id || idempotencyKey
    runId = activeRunId || idempotencyKey

    return await finalPromise
  } catch (e) {
    return { ok: false, text: '', runId, events, error: e instanceof Error ? e.message : String(e) }
  } finally {
    client.close()
  }
}
