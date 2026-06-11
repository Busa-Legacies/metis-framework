import { NextRequest, NextResponse } from 'next/server'
import { normalizeAssistantPersona, readSettings, type NormalizedAssistantPersona } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * One-shot voice transcript → Metis Brain (auto mode) → reply.
 * For external bridges (Voice HUD, Telegram). Each call is stateless;
 * caller may pass a sessionId so we maintain a small in-memory window of recent
 * turns for that session.
 */

interface VoiceTurn { role: 'user' | 'assistant'; content: string; t: number }
const sessions = new Map<string, VoiceTurn[]>()
const MAX_PER_SESSION = 16
const TTL_MS = 30 * 60_000 // 30 minutes

function getHistory(sid: string): VoiceTurn[] {
  const now = Date.now()
  let h = sessions.get(sid) ?? []
  h = h.filter((t) => now - t.t < TTL_MS)
  sessions.set(sid, h)
  return h
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const transcript: string = String(body.transcript ?? '').trim()
  const sessionId: string = String(body.sessionId ?? 'default')
  const persona: NormalizedAssistantPersona = normalizeAssistantPersona(body.persona ?? 'metis-brain')
  const auto: boolean = body.auto !== false
  if (!transcript) return NextResponse.json({ error: 'transcript is required' }, { status: 400 })

  // Auth gate (mirrors /api/assistant): non-localhost requests need bridge key.
  const settings = readSettings()
  if (settings.bridgeApiKey) {
    const got = req.headers.get('authorization')?.replace(/^bearer\s+/i, '')
    const host = req.headers.get('host') || ''
    const isLocal = host.startsWith('127.0.0.1') || host.startsWith('localhost')
    if (!isLocal && got !== settings.bridgeApiKey) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  const history = getHistory(sessionId)
  history.push({ role: 'user', content: transcript, t: Date.now() })
  const messages = history.slice(-MAX_PER_SESSION).map(({ role, content }) => ({ role, content }))

  const url = new URL('/api/assistant', req.nextUrl.origin)
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(settings.bridgeApiKey ? { authorization: `Bearer ${settings.bridgeApiKey}` } : {}) },
    body: JSON.stringify({ messages, persona, auto, activeWorkspaceId: body.activeWorkspaceId }),
  })
  const data = await r.json()
  if (!r.ok) return NextResponse.json({ error: data.error || 'assistant failed' }, { status: r.status })

  const reply: string = (data.message?.content as string) ?? ''
  history.push({ role: 'assistant', content: reply, t: Date.now() })
  sessions.set(sessionId, history.slice(-MAX_PER_SESSION))

  return NextResponse.json({
    reply,
    toolCalls: data.toolCalls ?? [],
    sessionId,
    persona,
  })
}

export async function DELETE(req: NextRequest) {
  const sid = req.nextUrl.searchParams.get('sessionId') ?? 'default'
  sessions.delete(sid)
  return NextResponse.json({ ok: true })
}
