import { createHash } from 'node:crypto'
import type { AgentKind, AgentRole } from './types'

export type MissionReviewGate = 'required' | 'optional' | 'manual_override'

export interface MissionLane {
  id: string
  title: string
  kind: AgentKind
  ownerRole: AgentRole
  scope: string
  expectedEvidencePath?: string
  evidenceRationale?: string
  selectedKind?: AgentKind
  selectionReason?: string
  budgetMinutes?: number
  stopConditions?: string[]
}

export interface MissionPacket {
  id: string
  workspaceId: string
  title: string
  goal: string
  lanes: MissionLane[]
  constraints: string[]
  expectedDeliverables: string[]
  acceptanceCriteria: string[]
  reviewGate: MissionReviewGate
  createdAt?: string
  budgetMinutes?: number
  metadata?: Record<string, JsonSafeValue>
}

export type JsonSafeValue =
  | string
  | number
  | boolean
  | null
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue }

export interface BuildMissionLaneInput {
  id?: string
  title: string
  kind: AgentKind
  ownerRole: AgentRole
  scope: string
  expectedEvidencePath?: string
  evidenceRationale?: string
  selectedKind?: AgentKind
  selectionReason?: string
  budgetMinutes?: number
  stopConditions?: string[]
}

export interface BuildMissionPacketInput {
  id?: string
  workspaceId: string
  title: string
  goal: string
  lanes: BuildMissionLaneInput[]
  constraints?: string[]
  expectedDeliverables?: string[]
  acceptanceCriteria?: string[]
  reviewGate?: MissionReviewGate
  createdAt?: string
  budgetMinutes?: number
  metadata?: Record<string, unknown>
}

export interface MissionValidationIssue {
  path: string
  message: string
}

export interface MissionValidationResult {
  ok: boolean
  issues: MissionValidationIssue[]
}

const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'shell', 'gemini', 'python', 'custom'] as const
const AGENT_ROLES: readonly AgentRole[] = ['builder', 'reviewer', 'scout', 'coordinator'] as const
const REVIEW_GATES: readonly MissionReviewGate[] = ['required', 'optional', 'manual_override'] as const

function stableJson(value: JsonSafeValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function shortHash(value: JsonSafeValue): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16)
}

function compactString(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function compactStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => {
    const text = compactString(value)
    return text ? [text] : []
  })
}

function maybePositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function normalizeUnknown(value: unknown, seen = new WeakSet<object>()): JsonSafeValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map((entry) => normalizeUnknown(entry, seen))
  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out: { [key: string]: JsonSafeValue } = {}
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol') continue
      out[key] = normalizeUnknown(entry, seen)
    }
    seen.delete(value)
    return out
  }
  return null
}

function laneHashInput(input: Pick<BuildMissionLaneInput, 'title' | 'kind' | 'ownerRole' | 'scope'>): JsonSafeValue {
  return {
    title: compactString(input.title),
    kind: input.kind,
    ownerRole: input.ownerRole,
    scope: compactString(input.scope),
  }
}

export function normalizeJsonSafe(value: unknown): JsonSafeValue {
  return normalizeUnknown(value)
}

export function deriveMissionLaneId(input: Pick<BuildMissionLaneInput, 'title' | 'kind' | 'ownerRole' | 'scope'>): string {
  return `lane_${shortHash(laneHashInput(input))}`
}

export function deriveMissionId(input: Omit<BuildMissionPacketInput, 'id' | 'createdAt'>): string {
  const normalized = normalizeMissionPacket({ ...input, id: 'mission_pending' })
  return `mission_${shortHash({
    workspaceId: normalized.workspaceId,
    title: normalized.title,
    goal: normalized.goal,
    lanes: normalized.lanes.map((lane) => ({
      title: lane.title,
      kind: lane.kind,
      ownerRole: lane.ownerRole,
      scope: lane.scope,
      expectedEvidencePath: lane.expectedEvidencePath ?? null,
      evidenceRationale: lane.evidenceRationale ?? null,
    })),
    constraints: normalized.constraints,
    expectedDeliverables: normalized.expectedDeliverables,
    acceptanceCriteria: normalized.acceptanceCriteria,
    reviewGate: normalized.reviewGate,
    budgetMinutes: normalized.budgetMinutes ?? null,
    metadata: normalized.metadata ?? {},
  })}`
}

export function normalizeMissionLane(input: BuildMissionLaneInput): MissionLane {
  const lane: MissionLane = {
    id: compactString(input.id) || deriveMissionLaneId(input),
    title: compactString(input.title),
    kind: input.kind,
    ownerRole: input.ownerRole,
    scope: compactString(input.scope),
  }
  const expectedEvidencePath = compactString(input.expectedEvidencePath)
  const evidenceRationale = compactString(input.evidenceRationale)
  const selectionReason = compactString(input.selectionReason)
  const stopConditions = compactStringList(input.stopConditions)
  if (expectedEvidencePath) lane.expectedEvidencePath = expectedEvidencePath
  if (evidenceRationale) lane.evidenceRationale = evidenceRationale
  if (input.selectedKind) lane.selectedKind = input.selectedKind
  if (selectionReason) lane.selectionReason = selectionReason
  const budgetMinutes = maybePositiveInteger(input.budgetMinutes)
  if (budgetMinutes) lane.budgetMinutes = budgetMinutes
  if (stopConditions.length > 0) lane.stopConditions = stopConditions
  return lane
}

export function normalizeMissionPacket(input: BuildMissionPacketInput): MissionPacket {
  const packet: MissionPacket = {
    id: compactString(input.id) || 'mission_pending',
    workspaceId: compactString(input.workspaceId),
    title: compactString(input.title),
    goal: compactString(input.goal),
    lanes: input.lanes.map(normalizeMissionLane),
    constraints: compactStringList(input.constraints),
    expectedDeliverables: compactStringList(input.expectedDeliverables),
    acceptanceCriteria: compactStringList(input.acceptanceCriteria),
    reviewGate: input.reviewGate ?? 'required',
  }
  const createdAt = compactString(input.createdAt)
  const budgetMinutes = maybePositiveInteger(input.budgetMinutes)
  if (createdAt) packet.createdAt = createdAt
  if (budgetMinutes) packet.budgetMinutes = budgetMinutes
  if (input.metadata) packet.metadata = normalizeJsonSafe(input.metadata) as Record<string, JsonSafeValue>
  return packet
}

export function buildMissionPacket(input: BuildMissionPacketInput): MissionPacket {
  const packet = normalizeMissionPacket(input)
  if (packet.id === 'mission_pending') {
    packet.id = deriveMissionId(input)
  }
  const validation = validateMissionPacket(packet)
  if (!validation.ok) {
    const detail = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    throw new Error(`mission_packet_invalid: ${detail}`)
  }
  return packet
}

export function validateMissionPacket(packet: MissionPacket): MissionValidationResult {
  const issues: MissionValidationIssue[] = []
  if (!packet.id.trim()) issues.push({ path: 'id', message: 'mission id is required' })
  if (!packet.workspaceId.trim()) issues.push({ path: 'workspaceId', message: 'workspace id is required' })
  if (!packet.title.trim()) issues.push({ path: 'title', message: 'title is required' })
  if (!packet.goal.trim()) issues.push({ path: 'goal', message: 'goal is required' })
  if (!REVIEW_GATES.includes(packet.reviewGate)) issues.push({ path: 'reviewGate', message: 'review gate is invalid' })
  if (packet.lanes.length === 0) issues.push({ path: 'lanes', message: 'at least one lane is required' })

  const ids = new Set<string>()
  packet.lanes.forEach((lane, index) => {
    const path = `lanes[${index}]`
    if (!lane.id.trim()) issues.push({ path: `${path}.id`, message: 'lane id is required' })
    if (ids.has(lane.id)) issues.push({ path: `${path}.id`, message: `duplicate lane id ${lane.id}` })
    ids.add(lane.id)
    if (!lane.title.trim()) issues.push({ path: `${path}.title`, message: 'lane title is required' })
    if (!(AGENT_KINDS as readonly string[]).includes(lane.kind)) issues.push({ path: `${path}.kind`, message: 'lane kind is invalid' })
    if (!(AGENT_ROLES as readonly string[]).includes(lane.ownerRole)) issues.push({ path: `${path}.ownerRole`, message: 'owner role is required and must be valid' })
    if (!lane.scope.trim()) issues.push({ path: `${path}.scope`, message: 'scope is required' })
    if (!compactString(lane.expectedEvidencePath) && !compactString(lane.evidenceRationale)) {
      issues.push({
        path: `${path}.expectedEvidencePath`,
        message: 'expected evidence path or explicit rationale is required',
      })
    }
  })

  return { ok: issues.length === 0, issues }
}

export function missionPacketToStableJson(packet: MissionPacket): string {
  return stableJson(normalizeJsonSafe(normalizeMissionPacket(packet)))
}
