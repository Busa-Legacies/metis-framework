import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type EvidenceKind =
  | 'report'
  | 'test'
  | 'diff'
  | 'review'
  | 'manual_override'
  | 'commit_approval'
  | 'push_approval'

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'report',
  'test',
  'diff',
  'review',
  'manual_override',
  'commit_approval',
  'push_approval',
] as const

export interface EvidenceRow {
  id: string
  workspaceId: string
  missionId?: string
  laneId?: string
  taskId?: string
  agentId?: string
  kind: EvidenceKind
  summary: string
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface EvidenceStoreData {
  rows: EvidenceRow[]
}

export interface AppendEvidenceInput {
  workspaceId: string
  kind: EvidenceKind
  summary: string
  payload?: Record<string, unknown>
  missionId?: string
  laneId?: string
  taskId?: string
  agentId?: string
  id?: string
}

export interface AppendEvidenceResult {
  row: EvidenceRow
  duplicate: boolean
}

const DEFAULT_DIR = path.join(process.cwd(), 'data', 'evidence-ledger')

function storageDir(): string {
  return process.env.AW_EVIDENCE_LEDGER_DIR || DEFAULT_DIR
}

function nowIso(): string {
  return new Date().toISOString()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function shortHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16)
}

function safeWorkspaceFile(workspaceId: string): string {
  const safe = workspaceId.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'global'
  return path.join(storageDir(), `${safe}.json`)
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${process.hrtime.bigint()}.tmp`,
  )
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
    fs.renameSync(tmp, file)
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
    } catch {}
  }
}

function readWorkspaceData(workspaceId: string): EvidenceStoreData {
  const file = safeWorkspaceFile(workspaceId)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && Array.isArray(parsed.rows)) {
      const rows = (parsed.rows as unknown[]).flatMap((row) =>
        isValidStoredRow(row) ? [row] : [],
      )
      return { rows }
    }
  } catch {}
  return { rows: [] }
}

function writeWorkspaceData(workspaceId: string, data: EvidenceStoreData): void {
  writeJsonAtomic(safeWorkspaceFile(workspaceId), data)
}

function isValidStoredRow(row: unknown): row is EvidenceRow {
  if (!row || typeof row !== 'object') return false
  const r = row as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.workspaceId === 'string' &&
    typeof r.kind === 'string' &&
    (EVIDENCE_KINDS as readonly string[]).includes(r.kind) &&
    typeof r.summary === 'string' &&
    typeof r.createdAt === 'string' &&
    typeof r.updatedAt === 'string'
  )
}

function deriveEvidenceId(input: AppendEvidenceInput, createdAt: string): string {
  if (input.id && input.id.trim()) return input.id.trim()
  return `ev_${shortHash({
    workspaceId: input.workspaceId,
    missionId: input.missionId ?? null,
    laneId: input.laneId ?? null,
    taskId: input.taskId ?? null,
    agentId: input.agentId ?? null,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload ?? null,
    createdAt,
  })}`
}

export function appendEvidence(input: AppendEvidenceInput): AppendEvidenceResult {
  if (!input.workspaceId || typeof input.workspaceId !== 'string') {
    throw new Error('evidence_invalid: workspaceId required')
  }
  if (!(EVIDENCE_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`evidence_invalid_kind: ${input.kind}`)
  }
  if (typeof input.summary !== 'string' || input.summary.trim().length === 0) {
    throw new Error('evidence_invalid: summary required')
  }

  const data = readWorkspaceData(input.workspaceId)
  const timestamp = nowIso()
  const id = deriveEvidenceId(input, timestamp)
  const existing = data.rows.find((r) => r.id === id)
  if (existing) {
    existing.updatedAt = timestamp
    writeWorkspaceData(input.workspaceId, data)
    return { row: existing, duplicate: true }
  }

  const row: EvidenceRow = {
    id,
    workspaceId: input.workspaceId,
    missionId: input.missionId,
    laneId: input.laneId,
    taskId: input.taskId,
    agentId: input.agentId,
    kind: input.kind,
    summary: input.summary,
    payload: input.payload ?? {},
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  data.rows.unshift(row)
  writeWorkspaceData(input.workspaceId, data)
  return { row, duplicate: false }
}

export interface ListEvidenceFilter {
  missionId?: string
  laneId?: string
  taskId?: string
  agentId?: string
  kind?: EvidenceKind
}

export function listEvidence(workspaceId: string, filter: ListEvidenceFilter = {}): EvidenceRow[] {
  const rows = readWorkspaceData(workspaceId).rows
  return rows.filter((r) => {
    if (filter.missionId && r.missionId !== filter.missionId) return false
    if (filter.laneId && r.laneId !== filter.laneId) return false
    if (filter.taskId && r.taskId !== filter.taskId) return false
    if (filter.agentId && r.agentId !== filter.agentId) return false
    if (filter.kind && r.kind !== filter.kind) return false
    return true
  })
}

export function getEvidence(workspaceId: string, id: string): EvidenceRow | null {
  return readWorkspaceData(workspaceId).rows.find((r) => r.id === id) ?? null
}

export interface EvidenceCounts {
  total: number
  byKind: Record<EvidenceKind, number>
}

export function evidenceCounts(workspaceId: string, filter: ListEvidenceFilter = {}): EvidenceCounts {
  const byKind = EVIDENCE_KINDS.reduce<Record<EvidenceKind, number>>((acc, k) => {
    acc[k] = 0
    return acc
  }, {} as Record<EvidenceKind, number>)
  const rows = listEvidence(workspaceId, filter)
  for (const r of rows) byKind[r.kind] += 1
  return { total: rows.length, byKind }
}

export function hasRequiredEvidenceForDone(workspaceId: string, taskId: string): boolean {
  const rows = listEvidence(workspaceId, { taskId })
  const hasReport = rows.some((r) => r.kind === 'report')
  const hasReviewOrOverride = rows.some(
    (r) => r.kind === 'review' || r.kind === 'manual_override',
  )
  return hasReport && hasReviewOrOverride
}
