import type { MetisAll } from './metis-api-types'
import type { Severity } from './metis-api'

/**
 * Derive integration/auth health from the typed /api/all (PLAN §8.5 — surface
 * the exact missing capability/env var, not a blank panel). Pure + unit-tested;
 * reads the loosely-typed integration sub-objects via safe field access.
 */
export interface IntegrationStatus {
  name: string
  severity: Severity
  detail: string
}

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined
}

export function integrationStatuses(data: MetisAll): IntegrationStatus[] {
  const out: IntegrationStatus[] = []

  const ms365Err = field(data.ms365, 'error')
  out.push(ms365Err
    ? { name: 'Microsoft 365', severity: 'warn', detail: String(ms365Err) }
    : { name: 'Microsoft 365', severity: 'ok', detail: 'connected' })

  const finErr = field(data.finance, 'error')
  out.push(finErr
    ? { name: 'Finance (Tiller)', severity: 'warn', detail: String(finErr) }
    : { name: 'Finance (Tiller)', severity: 'ok', detail: 'connected' })

  const gErr = field(data.garmin, 'last_error')
  out.push(gErr
    ? { name: 'Garmin', severity: 'warn', detail: String(gErr) }
    : { name: 'Garmin', severity: 'ok', detail: 'synced' })

  const fbErr = field(data.fitbod, 'last_error')
  out.push(fbErr
    ? { name: 'Fitbod', severity: 'warn', detail: String(fbErr) }
    : { name: 'Fitbod', severity: 'ok', detail: 'synced' })

  const cuCounts = field(data.clickup, 'counts')
  out.push(cuCounts
    ? { name: 'ClickUp', severity: 'ok', detail: 'connected' }
    : { name: 'ClickUp', severity: 'warn', detail: 'no data' })

  const chunks = data.memory?.chunks_indexed ?? 0
  out.push(chunks > 0
    ? { name: 'Memory RAG', severity: 'ok', detail: `${chunks.toLocaleString()} chunks indexed` }
    : { name: 'Memory RAG', severity: 'warn', detail: 'not indexed' })

  return out
}
