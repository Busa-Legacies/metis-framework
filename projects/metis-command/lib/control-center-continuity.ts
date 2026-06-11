import fs from 'node:fs'
import path from 'node:path'
import type { Agent, Workspace } from './types'
import type { ControlCenterAckEntry, ControlCenterReportKind, ControlCenterStoredReportEntry } from './control-center-summary'

interface AckStore {
  acks: ControlCenterAckEntry[]
}

interface ReportStore {
  reports: ControlCenterStoredReportEntry[]
  lastReportAckAtByWorkspace?: Record<string, string>
}

const MAX_REPORTS_PER_WORKSPACE = 50

function stateDir(): string {
  // AW_COCKPIT_STATE_DIR kept as a fallback so an environment still exporting the
  // pre-rename var keeps resolving to the same state dir (no silent data reset).
  return (
    process.env.AW_CONTROL_CENTER_STATE_DIR ||
    process.env.AW_COCKPIT_STATE_DIR ||
    path.join(process.cwd(), 'data')
  )
}

// One-time migration: the persistence files were renamed cockpit-*.json →
// control-center-*.json. If only the legacy file exists, move it into place so
// existing acks/reports survive the rename instead of being orphaned.
function resolveStateFile(name: string, legacyName: string): string {
  const dir = stateDir()
  const next = path.join(dir, name)
  const legacy = path.join(dir, legacyName)
  try {
    if (!fs.existsSync(next) && fs.existsSync(legacy)) {
      fs.renameSync(legacy, next)
    }
  } catch {
    /* best-effort migration — fall through to the new path either way */
  }
  return next
}

function ackFile(): string {
  return resolveStateFile('control-center-acks.json', 'cockpit-acks.json')
}

function reportFile(): string {
  return resolveStateFile('control-center-reports.json', 'cockpit-reports.json')
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function cleanAck(value: unknown): ControlCenterAckEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (!isNonEmptyString(row.workspaceId) || !isNonEmptyString(row.agentId) || !isNonEmptyString(row.ackedAt) || !isNonEmptyString(row.by)) return null
  const out: ControlCenterAckEntry = {
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    ackedAt: row.ackedAt,
    by: row.by,
  }
  if (isNonEmptyString(row.reason)) out.reason = row.reason
  return out
}

function cleanReport(value: unknown): ControlCenterStoredReportEntry | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (!isNonEmptyString(row.workspaceId) || !isNonEmptyString(row.path) || !isNonEmptyString(row.kind) || !isNonEmptyString(row.mtime)) return null
  if (typeof row.sizeBytes !== 'number' || !Number.isFinite(row.sizeBytes)) return null
  const kind = ['markdown', 'json', 'log', 'other'].includes(row.kind) ? row.kind as ControlCenterReportKind : 'other'
  const out: ControlCenterStoredReportEntry = {
    workspaceId: row.workspaceId,
    path: row.path,
    kind,
    mtime: row.mtime,
    sizeBytes: row.sizeBytes,
    unread: row.unread !== false,
  }
  if (isNonEmptyString(row.agentId)) out.agentId = row.agentId
  return out
}

export function readControlCenterAcks(): ControlCenterAckEntry[] {
  const raw = readJson<AckStore>(ackFile(), { acks: [] })
  return Array.isArray(raw.acks) ? raw.acks.map(cleanAck).filter((row): row is ControlCenterAckEntry => !!row) : []
}

export function acknowledgeControlCenterAgent(input: {
  workspaceId: string
  agentId: string
  by?: string
  reason?: string
  now?: string
}): ControlCenterAckEntry {
  const acks = readControlCenterAcks()
  const ack: ControlCenterAckEntry = {
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    ackedAt: input.now ?? new Date().toISOString(),
    by: input.by?.trim() || 'metis-brain',
  }
  const reason = input.reason?.trim()
  if (reason) ack.reason = reason

  const next = acks.filter((row) => row.workspaceId !== input.workspaceId || row.agentId !== input.agentId)
  next.push(ack)
  writeJsonAtomic(ackFile(), { acks: next })
  return ack
}

export function readControlCenterReports(): ControlCenterStoredReportEntry[] {
  const raw = readJson<ReportStore>(reportFile(), { reports: [] })
  return Array.isArray(raw.reports) ? raw.reports.map(cleanReport).filter((row): row is ControlCenterStoredReportEntry => !!row) : []
}

function reportKind(filePath: string): ControlCenterReportKind {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.md') return 'markdown'
  if (ext === '.json') return 'json'
  if (ext === '.log' || ext === '.txt') return 'log'
  return 'other'
}

function likelyAgentId(workspaceId: string, mtimeMs: number, agents: Agent[]): string | undefined {
  const windowMs = 30_000
  const candidates = agents
    .filter((agent) => agent.workspaceId === workspaceId && agent.lastOutputAt)
    .map((agent) => ({ agent, diff: Math.abs(new Date(agent.lastOutputAt as string).getTime() - mtimeMs) }))
    .filter((row) => Number.isFinite(row.diff) && row.diff <= windowMs)
    .sort((a, b) => a.diff - b.diff || a.agent.id.localeCompare(b.agent.id))
  return candidates[0]?.agent.id
}

function boundedReports(reports: ControlCenterStoredReportEntry[]): ControlCenterStoredReportEntry[] {
  const byWorkspace = new Map<string, ControlCenterStoredReportEntry[]>()
  for (const report of reports) {
    const rows = byWorkspace.get(report.workspaceId) ?? []
    rows.push(report)
    byWorkspace.set(report.workspaceId, rows)
  }
  return [...byWorkspace.values()].flatMap((rows) =>
    rows
      .sort((a, b) => b.mtime.localeCompare(a.mtime) || a.path.localeCompare(b.path))
      .slice(0, MAX_REPORTS_PER_WORKSPACE),
  )
}

export function detectControlCenterReports(workspaces: Workspace[], agents: Agent[]): ControlCenterStoredReportEntry[] {
  const existing = readControlCenterReports()
  const byKey = new Map(existing.map((report) => [`${report.workspaceId}:${report.path}`, report]))
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  let changed = false

  for (const workspace of workspaces) {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(workspace.cwd).filter((name) => name.endsWith('.md')).slice(0, 50)
    } catch {
      continue
    }
    for (const name of entries) {
      const filePath = path.join(workspace.cwd, name)
      let stat: fs.Stats
      try {
        stat = fs.statSync(filePath)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.mtimeMs < sevenDaysAgo) continue
      const key = `${workspace.id}:${filePath}`
      const prev = byKey.get(key)
      const mtime = stat.mtime.toISOString()
      if (!prev) {
        byKey.set(key, {
          workspaceId: workspace.id,
          path: filePath,
          agentId: likelyAgentId(workspace.id, stat.mtimeMs, agents),
          kind: reportKind(filePath),
          mtime,
          sizeBytes: stat.size,
          unread: true,
        })
        changed = true
      } else if (prev.mtime !== mtime || prev.sizeBytes !== stat.size) {
        byKey.set(key, {
          ...prev,
          agentId: prev.agentId ?? likelyAgentId(workspace.id, stat.mtimeMs, agents),
          kind: reportKind(filePath),
          mtime,
          sizeBytes: stat.size,
          unread: true,
        })
        changed = true
      }
    }
  }

  const reports = boundedReports([...byKey.values()])
  if (changed) writeJsonAtomic(reportFile(), { reports })
  return reports
}
