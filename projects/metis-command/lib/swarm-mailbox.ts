export type SwarmMailboxKind =
  | 'message'
  | 'handoff'
  | 'status'
  | 'review-request'
  | 'review-result'

export interface SwarmMailboxScope {
  workspaceId: string
  missionId: string
  laneId: string
  agentId: string
}

export interface SwarmMailboxRow extends SwarmMailboxScope {
  id: string
  kind: SwarmMailboxKind
  body: string
  title?: string
  createdAt: string
  ackedAt?: string
  ackedBy?: string
  metadata?: Record<string, string | number | boolean | null>
}

export interface AppendSwarmMailboxInput extends SwarmMailboxScope {
  kind?: SwarmMailboxKind
  body: string
  title?: string
  metadata?: Record<string, string | number | boolean | null>
}

export interface SwarmMailboxGuardrails {
  maxRows: number
  bodyChars: number
  titleChars: number
}

export const DEFAULT_SWARM_MAILBOX_GUARDRAILS: SwarmMailboxGuardrails = {
  maxRows: 500,
  bodyChars: 6000,
  titleChars: 160,
}

export interface SwarmMailboxOptions {
  now?: () => string
  id?: () => string
  guardrails?: Partial<SwarmMailboxGuardrails>
}

export interface SwarmMailboxFilter {
  workspaceId?: string
  missionId?: string
  laneId?: string
  agentId?: string
  kind?: SwarmMailboxKind
  acked?: boolean
  since?: string
  limit?: number
}

export interface SwarmMailboxAckInput {
  ids?: string[]
  workspaceId?: string
  missionId?: string
  laneId?: string
  agentId?: string
  ackedBy: string
  now?: string
}

export interface SwarmMailboxAckResult {
  rows: SwarmMailboxRow[]
  ackedIds: string[]
}

function guardrailsFrom(options?: SwarmMailboxOptions): SwarmMailboxGuardrails {
  return { ...DEFAULT_SWARM_MAILBOX_GUARDRAILS, ...(options?.guardrails ?? {}) }
}

function fallbackId() {
  return `mail_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-5)}`
}

function requireKey(value: string, name: keyof SwarmMailboxScope): string {
  const trimmed = String(value ?? '').trim()
  if (!trimmed) throw new Error(`swarm mailbox ${name} is required`)
  return trimmed
}

function boundedText(value: string | undefined, maxChars: number): string | undefined {
  if (value == null) return undefined
  const normalized = String(value).replace(/\r\n?/g, '\n').trim()
  if (!normalized) return undefined
  return normalized.length > maxChars ? normalized.slice(0, maxChars) : normalized
}

function matchesFilter(row: SwarmMailboxRow, filter: SwarmMailboxFilter): boolean {
  if (filter.workspaceId && row.workspaceId !== filter.workspaceId) return false
  if (filter.missionId && row.missionId !== filter.missionId) return false
  if (filter.laneId && row.laneId !== filter.laneId) return false
  if (filter.agentId && row.agentId !== filter.agentId) return false
  if (filter.kind && row.kind !== filter.kind) return false
  if (filter.acked !== undefined && Boolean(row.ackedAt) !== filter.acked) return false
  if (filter.since && row.createdAt < filter.since) return false
  return true
}

export function appendSwarmMailboxRow(
  rows: readonly SwarmMailboxRow[],
  input: AppendSwarmMailboxInput,
  options: SwarmMailboxOptions = {},
): SwarmMailboxRow[] {
  const guardrails = guardrailsFrom(options)
  const body = boundedText(input.body, guardrails.bodyChars)
  if (!body) throw new Error('swarm mailbox body is required')

  const row: SwarmMailboxRow = {
    id: options.id?.() ?? fallbackId(),
    workspaceId: requireKey(input.workspaceId, 'workspaceId'),
    missionId: requireKey(input.missionId, 'missionId'),
    laneId: requireKey(input.laneId, 'laneId'),
    agentId: requireKey(input.agentId, 'agentId'),
    kind: input.kind ?? 'message',
    body,
    createdAt: options.now?.() ?? new Date().toISOString(),
    ...(boundedText(input.title, guardrails.titleChars) ? { title: boundedText(input.title, guardrails.titleChars) } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  }

  return [...rows, row].slice(-guardrails.maxRows)
}

export function listSwarmMailboxRows(
  rows: readonly SwarmMailboxRow[],
  filter: SwarmMailboxFilter = {},
): SwarmMailboxRow[] {
  const limit = filter.limit && filter.limit > 0 ? Math.floor(filter.limit) : undefined
  const matched = rows.filter((row) => matchesFilter(row, filter))
  return limit ? matched.slice(-limit) : matched
}

export function ackSwarmMailboxRows(
  rows: readonly SwarmMailboxRow[],
  input: SwarmMailboxAckInput,
): SwarmMailboxAckResult {
  const ackedBy = String(input.ackedBy ?? '').trim()
  if (!ackedBy) throw new Error('swarm mailbox ackedBy is required')

  const ids = new Set(input.ids ?? [])
  const useIds = ids.size > 0
  const ackedAt = input.now ?? new Date().toISOString()
  const ackedIds: string[] = []

  const nextRows = rows.map((row) => {
    const selected = useIds
      ? ids.has(row.id)
      : matchesFilter(row, {
        workspaceId: input.workspaceId,
        missionId: input.missionId,
        laneId: input.laneId,
        agentId: input.agentId,
        acked: false,
      })

    if (!selected || row.ackedAt) return row
    ackedIds.push(row.id)
    return { ...row, ackedAt, ackedBy }
  })

  return { rows: nextRows, ackedIds }
}

