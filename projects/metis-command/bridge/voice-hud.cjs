#!/usr/bin/env node
/**
 * Voice HUD ↔ Metis Command Center bridge.
 *
 * Tiny HTTP listener that the existing voice HUD (or any STT pipeline) can POST
 * transcripts to. Forwards to the Command Center's /api/voice/transcript with
 * Metis Brain persona + auto mode. Optionally speaks the reply via macOS `say`.
 *
 * Usage:
 *   AW_BRIDGE_KEY=<secret> AW_URL=http://127.0.0.1:3747 \
 *   AW_VOICE_PORT=3749 \
 *   node bridge/voice-hud.cjs
 *
 * Then point the voice HUD at:
 *   POST http://127.0.0.1:3749/transcript
 *   body: { "transcript": "...", "sessionId": "fnf7" }
 *
 * Or call the workbench endpoint directly:
 *   POST http://127.0.0.1:3747/api/voice/transcript
 *   headers: Authorization: Bearer <AW_BRIDGE_KEY>
 *   body: { "transcript": "...", "sessionId": "fnf7" }
 */

const http = require('node:http')
const { spawn } = require('node:child_process')

const AW_URL = process.env.AW_URL || 'http://127.0.0.1:3747'
const BRIDGE_KEY = process.env.AW_BRIDGE_KEY || ''
const PORT = Number(process.env.AW_VOICE_PORT || 3749)
const SPEAK = process.env.AW_VOICE_SPEAK !== '0'
const VOICE_NAME = process.env.AW_VOICE_NAME || 'Samantha'

function speak(text) {
  if (!SPEAK || !text) return
  // Trim to 600 chars so TTS doesn't drone. macOS `say`.
  const trimmed = text.slice(0, 600)
  const p = spawn('say', ['-v', VOICE_NAME, trimmed], { stdio: 'ignore' })
  p.on('error', () => {})
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

async function forward(transcript, sessionId, activeWorkspaceId) {
  const headers = { 'content-type': 'application/json' }
  if (BRIDGE_KEY) headers.authorization = `Bearer ${BRIDGE_KEY}`
  const r = await fetch(`${AW_URL}/api/voice/transcript`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ transcript, sessionId, activeWorkspaceId, persona: 'metis-brain', auto: true }),
  })
  return r.json()
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/transcript') {
    const body = await readBody(req)
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}
    const t = String(parsed.transcript || '').trim()
    if (!t) { res.writeHead(400); res.end('transcript required'); return }
    console.log(`[voice] heard: "${t.slice(0, 80)}${t.length > 80 ? '…' : ''}"`)
    try {
      const data = await forward(t, parsed.sessionId || 'voice-hud', parsed.activeWorkspaceId)
      console.log(`[voice] reply: "${(data.reply || '').slice(0, 80)}…"`)
      speak(data.reply)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(data))
    } catch (e) {
      res.writeHead(500); res.end(String(e))
    }
    return
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, awUrl: AW_URL, hasBridgeKey: !!BRIDGE_KEY, speak: SPEAK }))
    return
  }
  res.writeHead(404); res.end('not found')
})

server.listen(PORT, () => {
  console.log(`[voice-bridge] listening on :${PORT} → ${AW_URL} (speak=${SPEAK})`)
})
