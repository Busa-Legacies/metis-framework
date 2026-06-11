import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { leaseHandoffPrompt, taskHandoffPrompt } from '../lib/handoff-prompt'
import type { MetisLease, MetisPriorityItem } from '../lib/metis-api-types'

describe('handoff-prompt / leaseHandoffPrompt', () => {
  const base: MetisLease = {
    taskId: '#185', title: '#185 dev-review-console', agent: 'claude', status: 'checked-out',
    fenceToken: 142, branch: 'codex/x', session: 'abc-123', leaseExpiresAt: null, lastRenewedAt: '2026-06-09T00:35:43Z',
  }

  it('includes taskId, owner, session, fence, and the fencing instruction', () => {
    const p = leaseHandoffPrompt(base)
    assert.match(p, /Take over #185/)
    assert.match(p, /claude/)
    assert.match(p, /session abc-123/)
    assert.match(p, /fence 142/)
    assert.match(p, /higher fence before writing/)
  })

  it('falls back to title when taskId is null and omits empty fields', () => {
    const p = leaseHandoffPrompt({ ...base, taskId: null, title: 'build-trading-backend', branch: null, lastRenewedAt: null })
    assert.match(p, /Take over build-trading-backend/)
    assert.doesNotMatch(p, /branch/)
    assert.doesNotMatch(p, /last renewed/)
  })
})

describe('handoff-prompt / taskHandoffPrompt', () => {
  const t: MetisPriorityItem = { taskId: '#080', title: 'trading-bot-per-trade-exits', priority: 'P1', state: 'queued', goals: ['G4'] }

  it('includes id, title, priority/state, goals, and claim guidance', () => {
    const p = taskHandoffPrompt(t)
    assert.match(p, /Work #080 "trading-bot-per-trade-exits" \(P1, queued\)/)
    assert.match(p, /Goals: G4/)
    assert.match(p, /claim it atomically/)
  })

  it('omits goals when none', () => {
    assert.doesNotMatch(taskHandoffPrompt({ ...t, goals: [] }), /Goals:/)
  })
})
