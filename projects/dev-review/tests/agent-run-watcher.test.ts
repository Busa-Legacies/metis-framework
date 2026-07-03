/**
 * Run-complete state machine tests (#258) — pure transitions, plain-number
 * clocks (same no-DOM pattern as selector.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { startWatch, stepWatch, DEFAULT_WATCH_OPTIONS } from '../lib/agent-run-watcher.ts'

test('awaiting-output → active on byte growth', () => {
  const now = 1000
  const state = startWatch(now, 0)
  const next = stepWatch(state, { status: 'running', outputBytes: 100 }, now + 1000, DEFAULT_WATCH_OPTIONS)
  assert.strictEqual(next.phase, 'active')
  assert.strictEqual(next.lastSeenBytes, 100)
  assert.strictEqual(next.lastActivityAt, now + 1000)
})

test('active → complete after quiet >= quietMs', () => {
  const now = 1000
  const state = startWatch(now, 0)
  const active = stepWatch(state, { status: 'running', outputBytes: 100 }, now + 1000, DEFAULT_WATCH_OPTIONS)
  const next = stepWatch(active, { status: 'running', outputBytes: 100 }, now + 1000 + 10_000, DEFAULT_WATCH_OPTIONS)
  assert.strictEqual(next.phase, 'complete')
})

test('active stays active while bytes keep growing past quietMs windows', () => {
  const now = 1000
  let s = startWatch(now, 0)
  // bytes grow every 6s — each step lands inside the quiet window and resets it
  s = stepWatch(s, { status: 'running', outputBytes: 100 }, now + 6000, DEFAULT_WATCH_OPTIONS)
  s = stepWatch(s, { status: 'running', outputBytes: 200 }, now + 12_000, DEFAULT_WATCH_OPTIONS)
  s = stepWatch(s, { status: 'running', outputBytes: 300 }, now + 18_000, DEFAULT_WATCH_OPTIONS)
  assert.strictEqual(s.phase, 'active')
  assert.strictEqual(s.lastSeenBytes, 300)
})

test('gave-up on exited meta', () => {
  const state = startWatch(1000, 0)
  const next = stepWatch(state, { status: 'exited' }, 2000, DEFAULT_WATCH_OPTIONS)
  assert.strictEqual(next.phase, 'gave-up')
})

test('gave-up on undefined meta', () => {
  const state = startWatch(1000, 0)
  const next = stepWatch(state, undefined, 2000, DEFAULT_WATCH_OPTIONS)
  assert.strictEqual(next.phase, 'gave-up')
})

test('gave-up after timeoutMs with no completion', () => {
  const state = startWatch(1000, 0)
  const next = stepWatch(state, { status: 'running' }, 1000 + DEFAULT_WATCH_OPTIONS.timeoutMs + 1, DEFAULT_WATCH_OPTIONS)
  assert.strictEqual(next.phase, 'gave-up')
})

test('complete state is terminal — new bytes do not reopen it', () => {
  const now = 1000
  const state = startWatch(now, 0)
  const active = stepWatch(state, { status: 'running', outputBytes: 100 }, now + 1000, DEFAULT_WATCH_OPTIONS)
  const complete = stepWatch(active, { status: 'running', outputBytes: 100 }, now + 1000 + 10_000, DEFAULT_WATCH_OPTIONS)
  assert.strictEqual(complete.phase, 'complete')
  const after = stepWatch(complete, { status: 'running', outputBytes: 300 }, now + 13_000, DEFAULT_WATCH_OPTIONS)
  assert.strictEqual(after.phase, 'complete')
})

test('awaiting-output does NOT complete from quiet alone', () => {
  // An agent that never answered must not signal complete before timeout.
  const state = startWatch(1000, 0)
  const next = stepWatch(state, { status: 'running', outputBytes: 0 }, 1000 + 60_000, DEFAULT_WATCH_OPTIONS)
  assert.strictEqual(next.phase, 'awaiting-output')
})
