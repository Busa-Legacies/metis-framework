/**
 * Selector-generation stability tests — run the buildSelector logic against a
 * synthetic DOM. Uses a minimal Document stub (no jsdom dep): we exercise the
 * pure parts (class stability heuristic) directly and the DOM parts via the
 * controller in the browser smoke instead.
 */
import { test } from 'node:test'
import assert from 'node:assert'
import { isStableClass } from '../lib/overlay-controller.ts'

test('stable: plain utility and BEM-ish classes', () => {
  for (const cls of ['btn', 'panel-header', 'text-cyan', 'nav-item']) {
    assert.equal(isStableClass(cls), true, cls)
  }
})

test('unstable: hashed/generated classes are rejected', () => {
  for (const cls of [
    'css-1q2w3e',            // emotion/styled hash (digits)
    'astro-J3KP2L9',         // astro scoped (digits)
    'module__button',        // css-modules double underscore
    'averyveryverylongclassnamethatkeepsgoing', // >24 chars
    'p-4',                   // tailwind spacing (digit — brittle across edits)
  ]) {
    assert.equal(isStableClass(cls), false, cls)
  }
})
