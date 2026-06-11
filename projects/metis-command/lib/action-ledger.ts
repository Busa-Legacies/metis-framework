import { createHash } from 'node:crypto'
import { parseActionBlockJson, type ActionBlock } from './tool-routing'

export interface TurnActionLedgerEntry {
  actionId: string
  tool: string
  argsHash: string
  result?: unknown
  error?: string
  timestamp: string
  duplicate?: boolean
}

export interface PreparedAction {
  action: ActionBlock
  ledgerEntry: TurnActionLedgerEntry
}

export interface PreparedActionError {
  error: string
  ledgerEntry: TurnActionLedgerEntry
}

export const ACTION_BLOCK_RE = /```aw_action\s*([\s\S]*?)\s*```/g

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function hashActionArgs(args: unknown): string {
  return createHash('sha256').update(stableJson(args ?? {})).digest('hex').slice(0, 16)
}

export function extractCurrentTurnActionBlocks(assistantText: string): string[] {
  return [...assistantText.matchAll(ACTION_BLOCK_RE)].map((m) => m[1].trim())
}

export function prepareCurrentTurnActions(assistantText: string, now: () => string = () => new Date().toISOString()): Array<PreparedAction | PreparedActionError> {
  const blocks = extractCurrentTurnActionBlocks(assistantText)
  const seenIds = new Set<string>()
  const seenFingerprints = new Set<string>()
  const prepared: Array<PreparedAction | PreparedActionError> = []

  blocks.forEach((block, index) => {
    const parsed = parseActionBlockJson(block)
    if ('error' in parsed) {
      prepared.push({
        error: parsed.error,
        ledgerEntry: {
          actionId: `invalid_${index}`,
          tool: 'parse',
          argsHash: hashActionArgs(block),
          error: parsed.error,
          timestamp: now(),
        },
      })
      return
    }

    const explicitId = parsed.id?.trim()
    const argsHash = hashActionArgs(parsed.args ?? {})
    const fingerprint = `${parsed.tool}:${argsHash}`
    const actionId = explicitId || fingerprint
    const duplicate = (explicitId ? seenIds.has(explicitId) : false) || seenFingerprints.has(fingerprint)
    const ledgerEntry: TurnActionLedgerEntry = {
      actionId,
      tool: parsed.tool,
      argsHash,
      timestamp: now(),
      duplicate,
    }

    if (duplicate) {
      ledgerEntry.result = { ignored: true, reason: 'duplicate action in current assistant turn' }
      prepared.push({ error: 'duplicate action in current assistant turn', ledgerEntry })
      return
    }

    if (explicitId) seenIds.add(explicitId)
    seenFingerprints.add(fingerprint)
    prepared.push({ action: parsed, ledgerEntry })
  })

  return prepared
}
