#!/usr/bin/env node
/**
 * Metis Command Center → Telegram bridge.
 *
 * Lets you chat with the in-app **Metis Brain** assistant from Telegram. Messages get
 * forwarded to the local /api/assistant endpoint with persona=metis-brain + auto=true,
 * so a single Telegram message can spawn an entire agent swarm and report back.
 *
 * Usage:
 *   AW_TG_TOKEN=<bot-token> \
 *   AW_TG_ALLOW=<your-chat-id> \
 *   AW_BRIDGE_KEY=<bridge-api-key> \
 *   AW_URL=http://127.0.0.1:3747 \
 *   node bridge/telegram.cjs
 *
 * Setup:
 *   1. Create a bot via @BotFather, save the token.
 *   2. Send any message to the bot, then visit
 *      https://api.telegram.org/bot<TOKEN>/getUpdates
 *      → grab "chat":{"id":...} — that's your AW_TG_ALLOW value.
 *   3. In the Command Center Settings drawer, set "Bridge API key" — use the same value
 *      for AW_BRIDGE_KEY here.
 *   4. Run this file. It long-polls Telegram and stays connected.
 */

const TG_TOKEN = process.env.AW_TG_TOKEN
const ALLOW_CHAT = process.env.AW_TG_ALLOW
const AW_URL = process.env.AW_URL || 'http://127.0.0.1:3747'
const BRIDGE_KEY = process.env.AW_BRIDGE_KEY || ''
const PERSONA = process.env.AW_PERSONA || 'metis-brain'
const AUTO = process.env.AW_AUTO !== '0'
const MIRROR_FINAL = process.env.AW_TG_MIRROR_FINAL !== '0'

if (require.main === module && !TG_TOKEN) {
  console.error('AW_TG_TOKEN is required')
  process.exit(1)
}

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`
const userHistory = new Map() // chatId -> messages[]

function logTime() { return new Date().toISOString().slice(11, 19) }

function redactChatId(chatId) {
  const s = String(chatId ?? '')
  if (s.length <= 4) return 'chat:****'
  return `chat:****${s.slice(-4)}`
}

function isFinalMirrorEnabled(env = process.env) {
  return env.AW_TG_MIRROR_FINAL !== '0'
}

async function tg(method, body, fetchImpl = fetch) {
  const r = await fetchImpl(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }))
  if (!r.ok || data.ok === false) {
    const err = new Error(data.description || `Telegram ${method} failed`)
    err.response = data
    err.status = r.status
    throw err
  }
  return data
}

async function sendMessage(chatId, text, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch
  // Telegram limit is 4096 chars; chunk if needed. Prefer plain text because
  // arbitrary assistant Markdown can contain unescaped characters that Telegram
  // rejects, causing silent drops.
  const chunks = []
  let s = text || '(no response)'
  while (s.length > 0) {
    chunks.push(s.slice(0, 3500))
    s = s.slice(3500)
  }
  const messageIds = []
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    try {
      const data = await tg('sendMessage', { chat_id: chatId, text: c, disable_web_page_preview: true }, fetchImpl)
      if (data.result && data.result.message_id !== undefined) messageIds.push(data.result.message_id)
    } catch (e) {
      e.delivery = { ok: false, chat: redactChatId(chatId), chunk: i + 1, chunks: chunks.length }
      console.error(`[${logTime()}] sendMessage failed ${redactChatId(chatId)} chunk=${i + 1}/${chunks.length}:`, e.message || e)
      throw e
    }
  }
  return { ok: true, chat: redactChatId(chatId), chunks: chunks.length, messageIds }
}

async function deliverFinalReply(chatId, text, opts = {}) {
  const mirrorFinal = opts.mirrorFinal ?? MIRROR_FINAL
  if (!mirrorFinal) {
    const status = { ok: false, skipped: true, reason: 'mirror_final_disabled', chat: redactChatId(chatId), chunks: 0 }
    console.log(`[${logTime()}] final_delivery status=skipped ${status.chat} reason=${status.reason}`)
    return status
  }
  try {
    const status = await sendMessage(chatId, text, opts)
    console.log(`[${logTime()}] final_delivery status=ok ${status.chat} chunks=${status.chunks}`)
    return status
  } catch (e) {
    const status = e.delivery || { ok: false, chat: redactChatId(chatId), chunks: 0 }
    console.error(`[${logTime()}] final_delivery status=failed ${status.chat} chunk=${status.chunk || 0}/${status.chunks || 0}:`, e.message || e)
    throw e
  }
}

async function sendChatAction(chatId, action) {
  return tg('sendChatAction', { chat_id: chatId, action }).catch(() => {})
}

async function callAssistant(chatId, userText, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch
  const awUrl = opts.awUrl || AW_URL
  const mirrorFinal = opts.mirrorFinal ?? MIRROR_FINAL
  const history = userHistory.get(chatId) || []
  const next = [...history, { role: 'user', content: userText }].slice(-30)
  userHistory.set(chatId, next)

  const headers = { 'content-type': 'application/json' }
  if (BRIDGE_KEY) headers.authorization = `Bearer ${BRIDGE_KEY}`

  const res = await fetchImpl(`${awUrl}/api/assistant`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: next,
      persona: PERSONA,
      auto: AUTO,
      telegramBridge: {
        source: 'telegram',
        mirrorFinal,
        finalDelivery: 'standalone-bridge',
      },
    }),
  })
  const data = await res.json()
  if (!res.ok) return `⚠️ ${data.error || res.statusText}`

  const reply = (data.message && data.message.content) || '(no response)'
  next.push({ role: 'assistant', content: reply })
  userHistory.set(chatId, next.slice(-30))

  let toolNote = ''
  if (Array.isArray(data.toolCalls) && data.toolCalls.length) {
    const names = data.toolCalls.map((t) => t.name).join(', ')
    toolNote = `\n\n_tools: ${names}_`
  }
  return reply + toolNote
}

async function poll() {
  let offset = 0
  console.log(`[${logTime()}] tg-bridge online. workbench=${AW_URL} persona=${PERSONA} auto=${AUTO} mirrorFinal=${MIRROR_FINAL}`)
  // sanity check
  try {
    const me = await tg('getMe', {})
    if (me.ok) console.log(`[${logTime()}] connected as @${me.result.username}`)
  } catch {}
  while (true) {
    try {
      const r = await fetch(`${TG_API}/getUpdates?timeout=25&offset=${offset}`)
      const d = await r.json()
      if (!d.ok) { await new Promise((r) => setTimeout(r, 2000)); continue }
      for (const upd of d.result) {
        offset = upd.update_id + 1
        const msg = upd.message
        if (!msg || !msg.text) continue
        const chatId = String(msg.chat.id)
        if (ALLOW_CHAT && chatId !== ALLOW_CHAT) {
          console.log(`[${logTime()}] reject ${redactChatId(chatId)} (not in AW_TG_ALLOW)`)
          continue
        }
        const text = msg.text.trim()
        if (!text) continue
        if (text === '/start' || text === '/help') {
          await sendMessage(chatId, 'Metis Brain here. Tell me what to build and I will spawn the agent swarm. Try: "open 2 claude in a new workspace and start drafting the landing page".')
          continue
        }
        if (text === '/clear') {
          userHistory.delete(chatId)
          await sendMessage(chatId, 'cleared.')
          continue
        }
        console.log(`[${logTime()}] ← ${redactChatId(chatId)}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}`)
        sendChatAction(chatId, 'typing').catch(() => {})
        const reply = await callAssistant(chatId, text).catch((e) => `⚠️ ${e.message || 'request failed'}`)
        console.log(`[${logTime()}] → ${redactChatId(chatId)}: ${reply.slice(0, 80)}${reply.length > 80 ? '…' : ''}`)
        await deliverFinalReply(chatId, reply).catch(() => {})
      }
    } catch (e) {
      console.error(`[${logTime()}] poll error:`, e.message || e)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

if (require.main === module) {
  poll().catch((e) => { console.error('fatal:', e); process.exit(1) })
}

module.exports = {
  callAssistant,
  deliverFinalReply,
  isFinalMirrorEnabled,
  redactChatId,
  sendMessage,
  tg,
}
