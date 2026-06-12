import type { MetisAll } from './metis-api-types'
import type { Severity } from './metis-api'

/**
 * Derive integration/auth health from the typed /api/all (PLAN §8.5 — surface
 * the exact missing capability/env var, not a blank panel). Pure + unit-tested;
 * reads the loosely-typed integration sub-objects via safe field access.
 */
/** Where to go to remediate a degraded integration — an external service console
 *  or an in-repo doc/config path (metis:// opens it in the desktop app). */
export interface IntegrationFix {
  label: string
  href: string
}

export interface IntegrationStatus {
  name: string
  severity: Severity
  detail: string
  /** Present only when degraded — the concrete next step to restore the connection. */
  fix?: IntegrationFix
}

// Per-service remediation target. SaaS integrations point at their own console;
// local ones (RAG) point at the doc/script that re-establishes them.
const FIXES: Record<string, IntegrationFix> = {
  'Microsoft 365': { label: 'Reconnect MS365 token on Jay', href: 'metis://open?path=docs/process/infrastructure-state.md' },
  'Finance (Tiller)': { label: 'Open Tiller console', href: 'https://my.tillerhq.com' },
  'Garmin': { label: 'Open Garmin Connect', href: 'https://connect.garmin.com' },
  'Fitbod': { label: 'Reconnect Fitbod sync', href: 'metis://open?path=docs/process/infrastructure-state.md' },
  'ClickUp': { label: 'Open ClickUp workspace', href: 'https://app.clickup.com' },
  'Memory RAG': { label: 'Re-index memory store', href: 'metis://open?path=docs/process/infrastructure-state.md' },
}

function field(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined
}

export function integrationStatuses(data: MetisAll): IntegrationStatus[] {
  const out: IntegrationStatus[] = []

  const ms365Err = field(data.ms365, 'error')
  out.push(ms365Err
    ? { name: 'Microsoft 365', severity: 'warn', detail: String(ms365Err), fix: FIXES['Microsoft 365'] }
    : { name: 'Microsoft 365', severity: 'ok', detail: 'connected' })

  const finErr = field(data.finance, 'error')
  out.push(finErr
    ? { name: 'Finance (Tiller)', severity: 'warn', detail: String(finErr), fix: FIXES['Finance (Tiller)'] }
    : { name: 'Finance (Tiller)', severity: 'ok', detail: 'connected' })

  const gErr = field(data.garmin, 'last_error')
  out.push(gErr
    ? { name: 'Garmin', severity: 'warn', detail: String(gErr), fix: FIXES['Garmin'] }
    : { name: 'Garmin', severity: 'ok', detail: 'synced' })

  const fbErr = field(data.fitbod, 'last_error')
  out.push(fbErr
    ? { name: 'Fitbod', severity: 'warn', detail: String(fbErr), fix: FIXES['Fitbod'] }
    : { name: 'Fitbod', severity: 'ok', detail: 'synced' })

  const cuCounts = field(data.clickup, 'counts')
  out.push(cuCounts
    ? { name: 'ClickUp', severity: 'ok', detail: 'connected' }
    : { name: 'ClickUp', severity: 'warn', detail: 'no data', fix: FIXES['ClickUp'] })

  const chunks = data.memory?.chunks_indexed ?? 0
  out.push(chunks > 0
    ? { name: 'Memory RAG', severity: 'ok', detail: `${chunks.toLocaleString()} chunks indexed` }
    : { name: 'Memory RAG', severity: 'warn', detail: 'not indexed', fix: FIXES['Memory RAG'] })

  return out
}
