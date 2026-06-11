import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  coerceEffortLevel,
  effortFlagsForKind,
  isEffortLevel,
} from '../lib/effort-level'
import type { AgentKind } from '../lib/types'

describe('effort-level / constants', () => {
  it('exposes all five canonical levels', () => {
    assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'extra-high', 'max'])
  })

  it('defaults to medium', () => {
    assert.equal(DEFAULT_EFFORT_LEVEL, 'medium')
  })

  it('isEffortLevel narrows valid strings only', () => {
    for (const lvl of EFFORT_LEVELS) assert.equal(isEffortLevel(lvl), true)
    for (const bogus of ['', 'LOW', 'HIGH', 'extra', 'maximum', 'minimal', null, undefined, 0, {}]) {
      assert.equal(isEffortLevel(bogus), false)
    }
  })

  it('coerceEffortLevel falls back to medium on invalid input', () => {
    assert.equal(coerceEffortLevel('low'), 'low')
    assert.equal(coerceEffortLevel('extra-high'), 'extra-high')
    assert.equal(coerceEffortLevel('bogus'), 'medium')
    assert.equal(coerceEffortLevel(undefined), 'medium')
    assert.equal(coerceEffortLevel(null), 'medium')
  })
})

describe('effort-level / claude backend', () => {
  it('low → injects an --append-system-prompt with a LOW hint', () => {
    const flags = effortFlagsForKind('claude', 'low')
    assert.equal(flags[0], '--append-system-prompt')
    assert.equal(flags.length, 2)
    assert.match(flags[1], /Effort budget: LOW/)
  })

  it('medium → no flags (baseline)', () => {
    assert.deepEqual(effortFlagsForKind('claude', 'medium'), [])
  })

  it('high → injects --append-system-prompt with HIGH hint', () => {
    const flags = effortFlagsForKind('claude', 'high')
    assert.equal(flags[0], '--append-system-prompt')
    assert.match(flags[1], /Effort budget: HIGH/)
  })

  it('extra-high → injects --append-system-prompt with EXTRA-HIGH hint', () => {
    const flags = effortFlagsForKind('claude', 'extra-high')
    assert.equal(flags[0], '--append-system-prompt')
    assert.match(flags[1], /Effort budget: EXTRA-HIGH/)
  })

  it('max → injects --append-system-prompt with MAX hint', () => {
    const flags = effortFlagsForKind('claude', 'max')
    assert.equal(flags[0], '--append-system-prompt')
    assert.match(flags[1], /Effort budget: MAX/)
  })
})

describe('effort-level / codex backend', () => {
  it('low → --effort low', () => {
    assert.deepEqual(effortFlagsForKind('codex', 'low'), ['--effort', 'low'])
  })

  it('medium → no flags (baseline matches codex default)', () => {
    assert.deepEqual(effortFlagsForKind('codex', 'medium'), [])
  })

  it('high → --effort high', () => {
    assert.deepEqual(effortFlagsForKind('codex', 'high'), ['--effort', 'high'])
  })

  it('extra-high → --effort high (codex caps at high)', () => {
    assert.deepEqual(effortFlagsForKind('codex', 'extra-high'), ['--effort', 'high'])
  })

  it('max → --effort high (codex caps at high)', () => {
    assert.deepEqual(effortFlagsForKind('codex', 'max'), ['--effort', 'high'])
  })
})

describe('effort-level / no-op backends', () => {
  const noopKinds: AgentKind[] = ['shell', 'python', 'gemini', 'custom']

  for (const kind of noopKinds) {
    it(`${kind} → no flags for any effort level`, () => {
      for (const lvl of EFFORT_LEVELS) {
        assert.deepEqual(effortFlagsForKind(kind, lvl), [], `${kind}/${lvl} should be no-op`)
      }
    })
  }
})

describe('effort-level / does not mutate caller args', () => {
  it('returns a fresh array each call', () => {
    const a = effortFlagsForKind('claude', 'high')
    const b = effortFlagsForKind('claude', 'high')
    assert.notStrictEqual(a, b)
    a.push('mutation')
    assert.equal(b.length, 2)
  })
})
