import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

const require = createRequire(import.meta.url)
const bridge = require('../bridge/telegram.cjs')

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

describe('telegram bridge delivery', () => {
  it('sends arbitrary assistant text as plain text chunks with delivery status', async () => {
    const calls = []
    const fetchImpl = async (_url, init) => {
      calls.push(JSON.parse(init.body))
      return jsonResponse({ ok: true, result: { message_id: 7000 + calls.length } })
    }

    const status = await bridge.sendMessage('1234567890', 'x'.repeat(3601), { fetchImpl })

    assert.equal(status.ok, true)
    assert.equal(status.chat, 'chat:****7890')
    assert.equal(status.chunks, 2)
    assert.deepEqual(status.messageIds, [7001, 7002])
    assert.equal(calls.length, 2)
    assert.equal(calls[0].chat_id, '1234567890')
    assert.equal(calls[0].disable_web_page_preview, true)
    assert.equal(Object.hasOwn(calls[0], 'parse_mode'), false)
  })

  it('throws Telegram API failures instead of silently dropping final replies', async () => {
    const fetchImpl = async () => jsonResponse({ ok: false, description: 'Bad Request: message text is empty' }, 400)

    await assert.rejects(
      () => bridge.sendMessage('1234567890', 'hello', { fetchImpl }),
      /Bad Request: message text is empty/,
    )
  })

  it('can explicitly skip final mirroring and reports skipped status', async () => {
    const fetchImpl = async () => {
      throw new Error('fetch should not be called')
    }

    const status = await bridge.deliverFinalReply('1234567890', 'hello', { fetchImpl, mirrorFinal: false })

    assert.equal(status.ok, false)
    assert.equal(status.skipped, true)
    assert.equal(status.reason, 'mirror_final_disabled')
    assert.equal(status.chat, 'chat:****7890')
  })

  it('passes the explicit mirror opt-in marker to the assistant request', async () => {
    let assistantRequest
    const fetchImpl = async (_url, init) => {
      assistantRequest = JSON.parse(init.body)
      return jsonResponse({ message: { content: 'done' } })
    }

    const reply = await bridge.callAssistant('1234567890', 'ship it', {
      awUrl: 'http://127.0.0.1:3747',
      fetchImpl,
      mirrorFinal: true,
    })

    assert.equal(reply, 'done')
    assert.equal(assistantRequest.telegramBridge.source, 'telegram')
    assert.equal(assistantRequest.telegramBridge.mirrorFinal, true)
    assert.equal(assistantRequest.telegramBridge.finalDelivery, 'standalone-bridge')
  })

  it('passes mirrorFinal false to the assistant request when final mirroring is disabled', async () => {
    let assistantRequest
    const fetchImpl = async (_url, init) => {
      assistantRequest = JSON.parse(init.body)
      return jsonResponse({ message: { content: 'local only' } })
    }

    const reply = await bridge.callAssistant('1234567890', 'local only please', {
      awUrl: 'http://127.0.0.1:3747',
      fetchImpl,
      mirrorFinal: false,
    })

    assert.equal(reply, 'local only')
    assert.equal(assistantRequest.telegramBridge.mirrorFinal, false)
  })
})
