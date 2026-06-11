import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { hashActionArgs } from './action-ledger'
import type { ToolName } from './tool-routing'

export type DispatchRunStatus = 'running' | 'succeeded' | 'partial_failed' | 'failed' | 'canceled' | 'closed'
export type DispatchActionStatus = 'running' | 'succeeded' | 'partial_failed' | 'failed' | 'already_applied'

export interface DispatchSpawnedAgent {
  id: string
  name?: string
  kind?: string
  laneName?: string
  role?: string
}

export interface DispatchAction {
  actionId: string
  tool: ToolName
  sessionWorkspaceId?: string
  targetWorkspaceId?: string
  explicitTargetWorkspaceId?: string
  argsHash: string
  fingerprint: string
  args: Record<string, unknown>
  status: DispatchActionStatus
  result?: unknown
  error?: string
  spawnedAgents: DispatchSpawnedAgent[]
  failedSpecs?: Array<{ spec: unknown; error: string }>
  createdAt: string
  updatedAt: string
  completedAt?: string
  retryOf?: string
}

export interface DispatchRun {
  runId: string
  workspaceId: string
  sessionWorkspaceId?: string
  targetWorkspaceId?: string
  explicitTargetWorkspaceId?: string
  createdBy: string
  userPrompt: string
  status: DispatchRunStatus
  actions: DispatchAction[]
  expectedDeliverables?: string[]
  acceptanceCriteria?: string[]
  createdAt: string
  updatedAt: string
  retryAt?: string
  canceledAt?: string
  closedAt?: string
}

export interface DispatchStoreData {
  runs: DispatchRun[]
}

export interface BeginDispatchActionResult {
  run: DispatchRun
  action: DispatchAction
  duplicate: boolean
}

const DEFAULT_DIR = path.join(process.cwd(), 'data', 'dispatch-runs')

function storageDir(): string {
  return process.env.AW_DISPATCH_RUNS_DIR || DEFAULT_DIR
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

function readWorkspaceData(workspaceId: string): DispatchStoreData {
  const file = safeWorkspaceFile(workspaceId)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && Array.isArray(parsed.runs)) return parsed as DispatchStoreData
  } catch {}
  return { runs: [] }
}

function writeWorkspaceData(workspaceId: string, data: DispatchStoreData): void {
  const file = safeWorkspaceFile(workspaceId)
  writeJsonAtomic(file, data)
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.${process.hrtime.bigint()}.tmp`)
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
    fs.renameSync(tmp, file)
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
    } catch {}
  }
}

function readAllWorkspaceData(): DispatchStoreData {
  const dir = storageDir()
  try {
    const runs = fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
          return parsed && Array.isArray(parsed.runs) ? parsed.runs as DispatchRun[] : []
        } catch {
          return []
        }
      })
    return { runs }
  } catch {
    return { runs: [] }
  }
}

function summarizeSpawned(result: unknown): DispatchSpawnedAgent[] {
  if (!result || typeof result !== 'object') return []
  const spawned = (result as { spawned?: unknown }).spawned
  if (!Array.isArray(spawned)) return []
  return spawned.flatMap((row) => {
    if (!row || typeof row !== 'object' || !('id' in row)) return []
    const rec = row as Record<string, unknown>
    return [{
      id: String(rec.id),
      name: typeof rec.name === 'string' ? rec.name : undefined,
      kind: typeof rec.kind === 'string' ? rec.kind : undefined,
      laneName: typeof rec.name === 'string' ? rec.name : undefined,
      role: typeof rec.role === 'string' ? rec.role : undefined,
    }]
  })
}

function summarizeFailedSpecs(result: unknown): Array<{ spec: unknown; error: string }> {
  if (!result || typeof result !== 'object') return []
  const spawned = (result as { spawned?: unknown }).spawned
  if (!Array.isArray(spawned)) return []
  return spawned.flatMap((row) => {
    if (!row || typeof row !== 'object' || !('error' in row)) return []
    const rec = row as Record<string, unknown>
    return [{ spec: rec.spec, error: typeof rec.error === 'string' ? rec.error : 'spawn failed' }]
  })
}

function statusFromActions(actions: DispatchAction[]): DispatchRunStatus {
  if (actions.length === 0) return 'running'
  if (actions.some((a) => a.status === 'running')) return 'running'
  if (actions.some((a) => a.status === 'partial_failed')) return 'partial_failed'
  if (actions.some((a) => a.status === 'failed')) return actions.some((a) => a.status === 'succeeded' || a.status === 'already_applied') ? 'partial_failed' : 'failed'
  return 'succeeded'
}

function actionStatus(tool: ToolName, result: unknown, error?: string): DispatchActionStatus {
  if (error) return 'failed'
  if (tool === 'spawn_agents' && summarizeFailedSpecs(result).length > 0) {
    return summarizeSpawned(result).length > 0 ? 'partial_failed' : 'failed'
  }
  if (result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string') return 'failed'
  return 'succeeded'
}

export function synthesizeDispatchRunId(input: { workspaceId?: string; userPrompt?: string; explicitRunId?: string }): string {
  if (input.explicitRunId && input.explicitRunId.trim()) return input.explicitRunId.trim()
  return `run_${shortHash({ workspaceId: input.workspaceId ?? 'global', userPrompt: input.userPrompt ?? '' })}`
}

export function dispatchActionFingerprint(tool: ToolName, args: Record<string, unknown>): string {
  return `${tool}:${hashActionArgs(args)}`
}

export function beginDispatchAction(input: {
  runId: string
  workspaceId: string
  sessionWorkspaceId?: string
  createdBy: string
  userPrompt: string
  actionId: string
  tool: ToolName
  args: Record<string, unknown>
  targetWorkspaceId?: string
  explicitTargetWorkspaceId?: string
  retryOf?: string
}): BeginDispatchActionResult {
  const data = readWorkspaceData(input.workspaceId)
  const timestamp = nowIso()
  let run = data.runs.find((r) => r.runId === input.runId)
  if (!run) {
    run = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      sessionWorkspaceId: input.sessionWorkspaceId,
      targetWorkspaceId: input.targetWorkspaceId,
      explicitTargetWorkspaceId: input.explicitTargetWorkspaceId,
      createdBy: input.createdBy,
      userPrompt: input.userPrompt,
      status: 'running',
      actions: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    data.runs.unshift(run)
  } else if (input.explicitTargetWorkspaceId) {
    run.sessionWorkspaceId ??= input.sessionWorkspaceId
    run.targetWorkspaceId = input.targetWorkspaceId
    run.explicitTargetWorkspaceId = input.explicitTargetWorkspaceId
  } else if (input.sessionWorkspaceId && !run.sessionWorkspaceId) {
    run.sessionWorkspaceId = input.sessionWorkspaceId
    run.targetWorkspaceId ??= input.targetWorkspaceId
  }

  const argsHash = hashActionArgs(input.args)
  const fingerprint = `${input.tool}:${argsHash}`
  const existing = run.actions.find((a) => a.actionId === input.actionId || a.fingerprint === fingerprint)
  if (existing) {
    existing.updatedAt = timestamp
    run.updatedAt = timestamp
    writeWorkspaceData(input.workspaceId, data)
    return { run, action: existing, duplicate: true }
  }

  const action: DispatchAction = {
    actionId: input.actionId,
    tool: input.tool,
    sessionWorkspaceId: input.sessionWorkspaceId,
    targetWorkspaceId: input.targetWorkspaceId,
    explicitTargetWorkspaceId: input.explicitTargetWorkspaceId,
    argsHash,
    fingerprint,
    args: input.args,
    status: 'running',
    spawnedAgents: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    retryOf: input.retryOf,
  }
  run.actions.push(action)
  run.status = statusFromActions(run.actions)
  run.updatedAt = timestamp
  writeWorkspaceData(input.workspaceId, data)
  return { run, action, duplicate: false }
}

export function completeDispatchAction(input: {
  workspaceId: string
  runId: string
  actionId: string
  tool: ToolName
  result?: unknown
  error?: string
}): DispatchAction {
  const data = readWorkspaceData(input.workspaceId)
  const run = data.runs.find((r) => r.runId === input.runId)
  if (!run) throw new Error(`dispatch run not found: ${input.runId}`)
  const action = run.actions.find((a) => a.actionId === input.actionId)
  if (!action) throw new Error(`dispatch action not found: ${input.actionId}`)
  const timestamp = nowIso()
  action.result = input.error ? undefined : input.result
  action.error = input.error
  action.status = actionStatus(input.tool, input.result, input.error)
  action.spawnedAgents = summarizeSpawned(input.result)
  action.failedSpecs = summarizeFailedSpecs(input.result)
  action.completedAt = timestamp
  action.updatedAt = timestamp
  run.status = statusFromActions(run.actions)
  run.updatedAt = timestamp
  writeWorkspaceData(input.workspaceId, data)
  return action
}

export function getDispatchRun(workspaceId: string, runId: string): DispatchRun | null {
  return readWorkspaceData(workspaceId).runs.find((r) => r.runId === runId) ?? null
}

export function listDispatchRuns(workspaceId: string, limit = 10): DispatchRun[] {
  return readWorkspaceData(workspaceId).runs.slice(0, Math.max(1, Math.min(50, limit)))
}

export function dispatchRunStatus(workspaceId: string, runId?: string): { run: DispatchRun | null; runs?: DispatchRun[] } {
  if (runId) return { run: getDispatchRun(workspaceId, runId) }
  const runs = listDispatchRuns(workspaceId, 10)
  return { run: runs[0] ?? null, runs }
}

export function dispatchRunStatusForSession(sessionWorkspaceId: string, runId?: string): { run: DispatchRun | null; runs?: DispatchRun[] } {
  const matches = readAllWorkspaceData().runs
    .filter((run) => run.workspaceId === sessionWorkspaceId || run.sessionWorkspaceId === sessionWorkspaceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (runId) return { run: matches.find((run) => run.runId === runId) ?? null }
  const runs = matches.slice(0, 10)
  return { run: runs[0] ?? null, runs }
}
