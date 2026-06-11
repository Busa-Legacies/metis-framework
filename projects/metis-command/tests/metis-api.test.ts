import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { utilSeverity, topAlertSeverity, ageLabel, goalProgressPct, untilLabel } from '../lib/metis-api'

describe('metis-api / utilSeverity', () => {
  it('bands utilization into ok/warn/critical', () => {
    assert.equal(utilSeverity(10), 'ok')
    assert.equal(utilSeverity(74.9), 'ok')
    assert.equal(utilSeverity(75), 'warn')
    assert.equal(utilSeverity(89.9), 'warn')
    assert.equal(utilSeverity(90), 'critical')
    assert.equal(utilSeverity(100), 'critical')
  })

  it('honors custom thresholds', () => {
    assert.equal(utilSeverity(50, 40, 60), 'warn')
    assert.equal(utilSeverity(65, 40, 60), 'critical')
  })
})

describe('metis-api / topAlertSeverity', () => {
  it('is ok for empty/undefined', () => {
    assert.equal(topAlertSeverity(undefined), 'ok')
    assert.equal(topAlertSeverity([]), 'ok')
  })

  it('elevates to the highest present level', () => {
    assert.equal(topAlertSeverity([{ level: 'info' }]), 'ok')
    assert.equal(topAlertSeverity([{ level: 'warning' }, { level: 'info' }]), 'warn')
    assert.equal(topAlertSeverity([{ level: 'warn' }]), 'warn')
    assert.equal(topAlertSeverity([{ level: 'info' }, { level: 'critical' }, { level: 'warning' }]), 'critical')
  })
})

describe('metis-api / ageLabel', () => {
  const now = Date.parse('2026-06-08T12:00:00.000Z')

  it('returns em-dash for missing/invalid timestamps', () => {
    assert.equal(ageLabel(undefined, now), '—')
    assert.equal(ageLabel('not-a-date', now), '—')
  })

  it('formats seconds, minutes, and hours', () => {
    assert.equal(ageLabel('2026-06-08T11:59:30.000Z', now), '30s ago')
    assert.equal(ageLabel('2026-06-08T11:55:00.000Z', now), '5m ago')
    assert.equal(ageLabel('2026-06-08T10:00:00.000Z', now), '2h ago')
  })

  it('clamps future timestamps to 0s rather than going negative', () => {
    assert.equal(ageLabel('2026-06-08T12:00:30.000Z', now), '0s ago')
  })
})

describe('metis-api / untilLabel', () => {
  const now = Date.parse('2026-06-08T12:00:00.000Z')

  it('returns em-dash / now for missing/invalid/past', () => {
    assert.equal(untilLabel(undefined, now), '—')
    assert.equal(untilLabel('nope', now), '—')
    assert.equal(untilLabel('2026-06-08T11:59:00.000Z', now), 'now')
  })

  it('formats future seconds, minutes, hours', () => {
    assert.equal(untilLabel('2026-06-08T12:00:30.000Z', now), 'in 30s')
    assert.equal(untilLabel('2026-06-08T12:05:00.000Z', now), 'in 5m')
    assert.equal(untilLabel('2026-06-08T14:00:00.000Z', now), 'in 2h')
  })

  it('accepts bare epoch-seconds strings (ratelimits resets_at format)', () => {
    const nowS = Math.floor(now / 1000)
    assert.equal(untilLabel(String(nowS + 300), now), 'in 5m')
    assert.equal(untilLabel(String(nowS + 7200), now), 'in 2h')
    assert.equal(untilLabel(String(nowS - 60), now), 'now')
  })

  it('rolls to days past 48h (weekly reset windows)', () => {
    const nowS = Math.floor(now / 1000)
    assert.equal(untilLabel(String(nowS + 47 * 3600), now), 'in 47h')
    assert.equal(untilLabel(String(nowS + 52 * 3600), now), 'in 2d')
  })
})

describe('metis-api / goalProgressPct', () => {
  it('is 0 when nothing is tracked (no NaN)', () => {
    assert.equal(goalProgressPct({ done: 0, active: 0, in_progress: 0, blocked: 0 }), 0)
  })

  it('computes done over all tracked tasks', () => {
    assert.equal(goalProgressPct({ done: 3, active: 1, in_progress: 0, blocked: 0 }), 75)
    assert.equal(goalProgressPct({ done: 1, active: 1, in_progress: 1, blocked: 1 }), 25)
    assert.equal(goalProgressPct({ done: 5, active: 0, in_progress: 0, blocked: 0 }), 100)
  })
})
