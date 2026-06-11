import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { integrationStatuses } from '../lib/integration-health'
import type { MetisAll } from '../lib/metis-api-types'

// Minimal MetisAll-ish fixture — only the fields integrationStatuses reads.
function fixture(over: Record<string, unknown> = {}): MetisAll {
  return {
    ms365: { error: null },
    finance: { error: null },
    garmin: { last_error: null },
    fitbod: { last_error: null },
    clickup: { counts: { ops: 1 } },
    memory: { chunks_indexed: 100 },
    ...over,
  } as unknown as MetisAll
}

describe('integration-health / integrationStatuses', () => {
  it('reports all ok when nothing is erroring', () => {
    const s = integrationStatuses(fixture())
    assert.equal(s.every((x) => x.severity === 'ok'), true)
    assert.equal(s.length, 6)
  })

  it('surfaces the exact missing-capability message for MS365', () => {
    const s = integrationStatuses(fixture({ ms365: { error: 'Set MS365_PERSONAL_CLIENT_ID' } }))
    const ms = s.find((x) => x.name === 'Microsoft 365')!
    assert.equal(ms.severity, 'warn')
    assert.match(ms.detail, /MS365_PERSONAL_CLIENT_ID/)
  })

  it('flags fitbod last_error and un-indexed memory as warn', () => {
    const s = integrationStatuses(fixture({ fitbod: { last_error: 'no rows parsed from CSV' }, memory: { chunks_indexed: 0 } }))
    assert.equal(s.find((x) => x.name === 'Fitbod')!.severity, 'warn')
    assert.equal(s.find((x) => x.name === 'Memory RAG')!.severity, 'warn')
  })
})
