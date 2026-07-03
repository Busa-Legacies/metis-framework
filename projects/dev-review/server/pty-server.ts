/**
 * Metis Command PTY sidecar.
 * - HTTP REST for agent + workspace CRUD
 * - WebSocket for terminal I/O at /ws/:agentId
 * Runs on AW_PTY_PORT (default 3761). Persists workspaces to ~/.openclaw/dev-review/state.json.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { URL } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { execFile } from 'node:child_process'
import * as nodePty from 'node-pty'
import type { IPty } from 'node-pty'
import { isBroadcastKind, selectBroadcastTargets } from '../lib/tool-routing.ts'
import { validateWorkspaceCwd } from '../lib/workspace-boundary.ts'
import { coerceEffortLevel, effortFlagsForKind, type EffortLevel } from '../lib/effort-level.ts'
import { RUNTIME_GUARDRAILS, trimOutputLine as trimRuntimeOutputLine, trimPersistedOutputLines as trimRuntimePersistedOutputLines } from '../lib/runtime-guardrails.ts'
import { appendEvidence, hasRequiredEvidenceForDone, listEvidence, type EvidenceKind } from '../lib/evidence-ledger.ts'
import { captureCrop, verifySelectors, cropFileFor, slugFor } from './preview-capture.ts'
import { loadOrMintToken, httpAuthorized, wsAuthorized, WS_PROTOCOL_PLAIN, TOKEN_FILE_NAME, TOKEN_HEADER } from './sidecar-auth.ts'
import { discoverMemoryDir, listMemoryNotes, searchMemoryNotes, type MemoryNote } from '../lib/workbench-memory.ts'

function execGit(cwd: string, args: string[], timeoutMs = 1500): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => {
      if (err) resolve('')
      else resolve(String(stdout))
    })
  })
}

async function gitStatus(cwd: string) {
  const inRepo = (await execGit(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  if (!inRepo) return { inRepo: false as const }
  const branch = (await execGit(cwd, ['branch', '--show-current'])).trim() || null
  const porcelain = await execGit(cwd, ['status', '--porcelain', '--untracked-files=normal'])
  const lines = porcelain.split('\n').filter(Boolean)
  let modified = 0, untracked = 0
  for (const l of lines) {
    if (l.startsWith('??')) untracked++
    else modified++
  }
  // ahead/behind
  let ahead = 0, behind = 0
  if (branch) {
    const ab = (await execGit(cwd, ['rev-list', '--left-right', '--count', `@{upstream}...HEAD`])).trim()
    const m = ab.match(/^(\d+)\s+(\d+)$/)
    if (m) { behind = Number(m[1]); ahead = Number(m[2]) }
  }
  return { inRepo: true as const, branch, modified, untracked, dirty: modified + untracked, ahead, behind }
}

function memoryPreview(body: string, max = 260) {
  const clean = body.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trim()}...`
}

function serializeMemoryNote(note: MemoryNote, score?: number, matches: string[] = []) {
  return {
    id: note.metadata.id,
    title: note.metadata.title,
    tags: note.metadata.tags,
    relativePath: note.relativePath,
    sourceName: path.basename(path.dirname(note.filePath)),
    sourcePath: path.dirname(note.filePath),
    updatedAt: note.metadata.updatedAt,
    preview: memoryPreview(note.body),
    wikilinks: note.wikilinks.length,
    score,
    matches,
  }
}

interface KnowledgeRoot {
  name: string
  path: string
  kind: 'workspace' | 'memory' | 'obsidian' | 'openclaw' | 'claude' | 'codex' | 'pinned'
}

interface KnowledgeDoc {
  id: string
  title: string
  tags: string[]
  relativePath: string
  sourceName: string
  sourcePath: string
  updatedAt: string
  preview: string
  wikilinks: number
  score?: number
  matches: string[]
}

interface SkillInfo {
  name: string
  path: string
  root: string
  description: string
  updatedAt: string
}

const KNOWLEDGE_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.log'])
const KNOWLEDGE_SKIP_DIRS = new Set([
  '.git',
  '.next',
  'dist',
  'dist-app',
  'node_modules',
  'Library',
  'Caches',
  'Trash',
  'tmp',
])
const KNOWLEDGE_SECRET_RE = /(auth|token|secret|credential|password|session|cookie|keychain|api[-_]?key)/i

function isDirectorySafe(candidate: string) {
  try { return fs.statSync(candidate).isDirectory() } catch { return false }
}

function findObsidianVaultRoots(home: string): KnowledgeRoot[] {
  const roots: KnowledgeRoot[] = []
  const searchRoots = [path.join(home, '.openclaw'), path.join(home, 'Documents'), home]
  const seen = new Set<string>()
  for (const searchRoot of searchRoots) {
    if (!isDirectorySafe(searchRoot)) continue
    const queue = [searchRoot]
    while (queue.length > 0 && roots.length < 12) {
      const cur = queue.shift()!
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
      if (entries.some((entry) => entry.isDirectory() && entry.name === '.obsidian')) {
        const resolved = path.resolve(cur)
        if (!seen.has(resolved)) {
          seen.add(resolved)
          roots.push({ name: `Obsidian: ${path.basename(resolved) || resolved}`, path: resolved, kind: 'obsidian' })
        }
        continue
      }
      const depth = path.relative(searchRoot, cur).split(path.sep).filter(Boolean).length
      if (depth >= 3) continue
      for (const entry of entries) {
        if (!entry.isDirectory() || KNOWLEDGE_SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.openclaw') continue
        queue.push(path.join(cur, entry.name))
      }
    }
  }
  return roots
}

function knowledgeRootsForWorkspace(ws: Workspace, pinnedRoots: string[] = []): KnowledgeRoot[] {
  const home = os.homedir()
  const candidates: KnowledgeRoot[] = [
    { name: 'Workspace', path: ws.cwd, kind: 'workspace' },
    { name: 'OpenClaw', path: path.join(home, '.openclaw'), kind: 'openclaw' },
    { name: 'Claude', path: path.join(home, '.claude'), kind: 'claude' },
    { name: 'Codex', path: path.join(home, '.codex'), kind: 'codex' },
    ...findObsidianVaultRoots(home),
    ...pinnedRoots.map((root) => ({ name: `Pinned: ${path.basename(root) || root}`, path: root, kind: 'pinned' as const })),
  ]

  const memory = discoverMemoryDir(ws.cwd, { create: false })
  if (memory.existed) candidates.splice(1, 0, { name: memory.name, path: memory.dir, kind: 'memory' })

  const seen = new Set<string>()
  const roots: KnowledgeRoot[] = []
  for (const candidate of candidates) {
    const resolved = path.resolve(expandHome(candidate.path))
    if (seen.has(resolved) || !isDirectorySafe(resolved)) continue
    seen.add(resolved)
    roots.push({ ...candidate, path: resolved })
  }
  return roots
}

function skillRootsForWorkspace(ws: Workspace, pinnedRoots: string[] = []) {
  const home = os.homedir()
  const candidates = [
    path.join(home, '.openclaw', 'workspace', 'skills'),
    path.join(home, '.openclaw', 'skills'),
    path.join(home, '.codex', 'skills'),
    path.join(ws.cwd, 'skills'),
    path.join(ws.cwd, '.codex', 'skills'),
    path.join(ws.cwd, '.agents', 'skills'),
    ...pinnedRoots.map((root) => path.join(root, 'skills')),
    ...pinnedRoots.map((root) => path.join(root, '.codex', 'skills')),
    ...pinnedRoots.map((root) => path.join(root, '.agents', 'skills')),
  ]
  const seen = new Set<string>()
  return candidates
    .map((candidate) => path.resolve(expandHome(candidate)))
    .filter((candidate) => {
      if (seen.has(candidate) || !isDirectorySafe(candidate)) return false
      seen.add(candidate)
      return true
    })
}

function parseSkillDescription(raw: string) {
  const descriptionLine = raw.match(/^description:\s*(.+)$/im)?.[1]?.trim()
  if (descriptionLine) return descriptionLine.replace(/^["']|["']$/g, '').slice(0, 260)
  const lines = raw
    .replace(/^---[\s\S]*?---\s*/, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  return (lines[0] ?? '').slice(0, 260)
}

function discoverSkills(ws: Workspace, pinnedRoots: string[] = [], limit = 120): { roots: string[]; skills: SkillInfo[] } {
  const roots = skillRootsForWorkspace(ws, pinnedRoots)
  const skills: SkillInfo[] = []
  for (const root of roots) {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = path.join(root, entry.name, 'SKILL.md')
      try {
        const stat = fs.statSync(skillPath)
        if (!stat.isFile()) continue
        const raw = fs.readFileSync(skillPath, 'utf8').slice(0, 4000)
        const heading = raw.match(/^#\s+(.+)$/m)?.[1]?.trim()
        skills.push({
          name: heading || entry.name,
          path: skillPath,
          root,
          description: parseSkillDescription(raw),
          updatedAt: stat.mtime.toISOString(),
        })
      } catch {}
      if (skills.length >= limit) break
    }
    if (skills.length >= limit) break
  }
  return {
    roots,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function skillsBrief(ws: Workspace, pinnedRoots: string[] = []) {
  const { roots, skills } = discoverSkills(ws, pinnedRoots, 60)
  const preferredRoot = roots.find((root) => root.includes(path.join('.openclaw', 'workspace', 'skills'))) ?? roots[0] ?? path.join(os.homedir(), '.openclaw', 'workspace', 'skills')
  const rootLines = roots.length > 0 ? roots.map((root) => `- ${root}`).join('\n') : `- ${preferredRoot} (create if needed)`
  const skillLines = skills.slice(0, 40).map((skill) => `- ${skill.name}: ${skill.description || skill.path}`).join('\n')
  return `# Skills and MCP operating protocol\nSkill roots:\n${rootLines}\n\nAvailable local skills${skills.length > 40 ? ` (showing 40 of ${skills.length})` : ''}:\n${skillLines || '- none discovered yet'}\n\nWhen a task matches a skill, read that skill's SKILL.md first and follow it. If no suitable skill exists, you may create one under ${preferredRoot}/<slug>/SKILL.md. Before creating a new skill, research the local repo and, when network/GitHub tools are available, inspect relevant public examples. Do not overwrite an existing skill. Keep the skill narrow, include trigger criteria and a concrete workflow, then report the new path and why it was needed.\n\nMCP servers are configured in this Workbench's MCP tab and are auto-injected into Claude agents. If a task needs a missing MCP, propose the server config first, including command, args, env vars, and safety implications.`
}

function titleFromFile(filePath: string) {
  const base = path.basename(filePath).replace(/\.(mdx?|txt|log)$/i, '')
  return base.replace(/[-_]+/g, ' ').trim() || path.basename(filePath)
}

function readKnowledgePreview(filePath: string, query: string) {
  let raw = ''
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > 1_000_000) return null
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  const body = raw.replace(/^---[\s\S]*?---\s*/, '')
  if (!query) return { preview: memoryPreview(body), score: 0, matches: [] }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = `${path.basename(filePath)}\n${body}`.toLowerCase()
  if (terms.some((term) => !haystack.includes(term))) return null
  let score = 0
  const matches: string[] = []
  for (const term of terms) {
    if (path.basename(filePath).toLowerCase().includes(term)) {
      score += 6
      matches.push(`path:${term}`)
    }
    if (body.toLowerCase().includes(term)) {
      score += 2
      matches.push(`body:${term}`)
    }
  }
  const firstTerm = terms.find((term) => body.toLowerCase().includes(term))
  if (!firstTerm) return { preview: memoryPreview(body), score, matches }
  const ix = body.toLowerCase().indexOf(firstTerm)
  const start = Math.max(0, ix - 120)
  return { preview: memoryPreview(body.slice(start), 260), score, matches }
}

function listKnowledgeDocs(roots: KnowledgeRoot[], query: string, limit: number): KnowledgeDoc[] {
  const docs: KnowledgeDoc[] = []
  for (const root of roots) {
    const queue = [root.path]
    while (queue.length > 0 && docs.length < limit * 6) {
      const dir = queue.shift()!
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!KNOWLEDGE_SKIP_DIRS.has(entry.name) && !KNOWLEDGE_SECRET_RE.test(entry.name)) queue.push(full)
          continue
        }
        if (!entry.isFile()) continue
        if (!KNOWLEDGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
        if (KNOWLEDGE_SECRET_RE.test(entry.name)) continue
        const hit = readKnowledgePreview(full, query)
        if (!hit) continue
        let stat: fs.Stats
        try { stat = fs.statSync(full) } catch { continue }
        const rel = path.relative(root.path, full) || entry.name
        docs.push({
          id: `${root.kind}:${rel}`,
          title: titleFromFile(full),
          tags: [root.kind],
          relativePath: rel,
          sourceName: root.name,
          sourcePath: root.path,
          updatedAt: stat.mtime.toISOString(),
          preview: hit.preview,
          wikilinks: 0,
          score: hit.score,
          matches: hit.matches,
        })
        if (docs.length >= limit * 6) break
      }
    }
  }
  return docs
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
}

function knowledgeRootsBrief(ws: Workspace, pinnedRoots: string[] = []) {
  const roots = knowledgeRootsForWorkspace(ws, pinnedRoots)
  if (roots.length === 0) return ''
  const lines = roots.map((root) => `- ${root.name} (${root.kind}): ${root.path}`).join('\n')
  return `# Local knowledge roots\nWhen the user mentions a product, project, note, vault item, OpenClaw memory, Claude/Codex memory, or anything they are working on locally, resolve it against these roots before assuming it is unknown. Prefer searching and reading the relevant local files over asking the user to restate context.\n\n${lines}`
}

type AgentKind = 'claude' | 'codex' | 'shell' | 'gemini' | 'python' | 'custom'
type AgentStatus = 'starting' | 'running' | 'exited'
type AgentRole = 'builder' | 'reviewer' | 'scout' | 'coordinator'
type TaskStatus = 'todo' | 'building' | 'review' | 'done'

const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'building', 'review', 'done'] as const

const ROLE_PROMPTS: Record<AgentRole, string> = {
  builder: 'You are the BUILDER. Implement the assigned task as the smallest viable change. Touch only files in your declared scope. Run tests after each substantial change. When done, summarize the diff in one paragraph and update the task status.',
  reviewer: 'You are the REVIEWER. Read the diff for the assigned task. Check correctness, security, and consistency. Block substandard work; explain exactly what to fix. Approve concise, well-tested changes. Be specific — cite file:line.',
  scout: 'You are the SCOUT. Read-only research. Map the relevant code, surface gotchas, and report findings as a tight bulleted list with file:line references. Do not edit anything.',
  coordinator: 'You are the COORDINATOR. Decompose the goal into parallel-safe tasks with explicit file scopes and dependencies. Assign owners, track status. Keep the task list current.',
}

interface Workspace {
  id: string
  name: string
  cwd: string
  createdAt: string
}

interface AgentMeta {
  id: string
  name: string
  kind: AgentKind
  workspaceId: string
  cwd: string
  cmd: string
  args: string[]
  status: AgentStatus
  exitCode?: number
  createdAt: string
  pid?: number
  lastOutputAt?: string // ISO timestamp of most recent stdout
  outputBytes?: number
  role?: AgentRole
  taskId?: string
  lastOutput?: string // last ~200 chars of stdout, ANSI-stripped, for tooltip surfacing
}

interface ResumeSpec {
  kind: AgentKind
  name: string
  cwd: string
  cmd?: string
  args?: string[]
  role?: AgentRole
  taskId?: string
}

interface Task {
  id: string
  workspaceId: string
  title: string
  description?: string
  status: TaskStatus
  ownerId?: string // agent id
  files?: string[] // file paths claimed by this task (relative to workspace cwd)
  createdAt: string
  updatedAt: string
}
interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolCalls?: { id: string; name: string; arguments: string; result?: unknown }[]
  createdAt: string
}
interface McpServer {
  id: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  enabled: boolean
}
interface PersistedState {
  workspaces: Workspace[]
  // last-known agents per workspace (for "Resume" after app restart)
  resume?: Record<string, ResumeSpec[]>
  // free-form layout blob per workspace, owned by the renderer
  layouts?: Record<string, unknown>
  // assistant chat history per workspace (persisted across sessions)
  chats?: Record<string, ChatTurn[]>
  // markdown notes per workspace; injected into spawned agents as system context
  notes?: Record<string, string>
  // pinned extra root folders per workspace, shown in file tree
  pinnedRoots?: Record<string, string[]>
  // MCP servers per workspace; auto-injected via --mcp-config when spawning claude
  mcpServers?: Record<string, McpServer[]>
  // recent terminal output by agent id, retained so scrollback reads survive server restarts
  outputTails?: Record<string, PersistedAgentOutput>
  // kanban task list per workspace
  tasks?: Record<string, Task[]>
}
interface PersistedAgentOutput {
  meta: AgentMeta
  lines: string[]
  updatedAt: string
}

const PORT = Number(process.env.AW_PTY_PORT ?? 3761)
const HOST = process.env.AW_PTY_HOST ?? '127.0.0.1'
const DATA_DIR = expandHome(process.env.AW_DATA_DIR ?? path.join(os.homedir(), '.openclaw', 'dev-review'))
// #259 trust gate: every HTTP route and the WS upgrade require this token (default-deny).
const SIDECAR_TOKEN = loadOrMintToken(DATA_DIR)
const LOG_DIR = path.join(DATA_DIR, 'logs')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const RING_BYTES = Number(process.env.AW_RING_BYTES ?? 128 * 1024)
// Keep PTY output persistence bounded. Spinner-heavy CLIs can emit huge
// carriage-return-only lines; persisting those into state.json on every
// debounce can make the Workbench bridge sluggish for control traffic.
const {
  chatTurnsMax: CHAT_TURNS_MAX,
  chatTurnChars: CHAT_TURN_CHARS,
  resumeSpecsMax: RESUME_SPECS_MAX,
} = RUNTIME_GUARDRAILS
const STATE_SAVE_DEBOUNCE_MS = Number(process.env.AW_STATE_SAVE_DEBOUNCE_MS ?? 1500)
const KILL_GRACE_MS = Number(process.env.AW_KILL_GRACE_MS ?? 1500)
const HEALTH_CHECK_MS = Number(process.env.AW_HEALTH_CHECK_MS ?? 5000)

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(LOG_DIR, { recursive: true })

function nowIso() {
  return new Date().toISOString()
}

/** Expand a leading ~ to the user's home dir so chdir() doesn't fail with literal "~". */
function expandHome(p: string): string {
  if (!p) return p
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function rid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

function workspaceNameFromInput(name: unknown, cwd: string, cwdWasProvided: boolean) {
  if (typeof name === 'string' && name.trim()) return name.trim()
  if (cwdWasProvided) {
    const base = path.basename(cwd)
    if (base && base !== path.parse(cwd).root) return base
  }
  return ''
}

function loadState(): PersistedState {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    return JSON.parse(raw) as PersistedState
  } catch {
    const init: PersistedState = {
      workspaces: [
        { id: rid('ws'), name: 'Default', cwd: os.homedir(), createdAt: nowIso() },
      ],
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(init, null, 2))
    return init
  }
}

function saveState(state: PersistedState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

const state = loadState()

// Migrate any workspace cwds that were stored as literal "~" → real home path.
let migrated = false
for (const w of state.workspaces) {
  const expanded = expandHome(w.cwd)
  if (expanded !== w.cwd) { w.cwd = expanded; migrated = true }
}
if (migrated) saveState(state)

function defaultCommandFor(kind: AgentKind, ctx: { cwd: string; addDirs: string[]; resume: boolean; role?: AgentRole; initialPrompt?: string }): { cmd: string; args: string[] } {
  const claudeDirArgs: string[] = []
  for (const d of ctx.addDirs) {
    const ed = expandHome(d)
    if (ed && ed !== ctx.cwd) claudeDirArgs.push('--add-dir', ed)
  }
  switch (kind) {
    case 'claude': {
      const permissionMode = process.env.AW_CLAUDE_PERMISSION_MODE ?? 'dontAsk'
      const args = ['--permission-mode', permissionMode, ...claudeDirArgs]
      if (ctx.resume) args.push('--continue')
      return { cmd: process.env.AW_CLAUDE_CMD ?? 'claude', args }
    }
    case 'codex': {
      // Codex doesn't have multi --add-dir; the workspace cwd (set as the spawn cwd)
      // is what determines where it operates. Pinned roots reach codex via filesystem,
      // not flags.
      // When an explicit task prompt is supplied, use non-interactive exec mode so the
      // prompt cannot be swallowed by interactive update banners or TUI interstitials.
      if (ctx.initialPrompt && ctx.initialPrompt.trim()) {
        return {
          cmd: process.env.AW_CODEX_CMD ?? 'codex',
          args: ['exec', '--sandbox', 'workspace-write', ctx.initialPrompt],
        }
      }
      if (ctx.resume) return { cmd: process.env.AW_CODEX_CMD ?? 'codex', args: ['resume', '--last'] }
      return { cmd: process.env.AW_CODEX_CMD ?? 'codex', args: [] }
    }
    case 'gemini':
      return { cmd: process.env.AW_GEMINI_CMD ?? 'gemini', args: [] }
    case 'python':
      return { cmd: 'python3', args: ['-i'] }
    case 'shell':
    default:
      return { cmd: process.env.SHELL ?? '/bin/zsh', args: ['-l'] }
  }
}

function defaultAddDirs(workspaceCwd: string): string[] {
  const home = os.homedir()
  const dirs = [
    home,
    workspaceCwd,
    path.join(home, '.openclaw'),
    path.join(home, '.openclaw', 'workspace'),
    path.join(home, '.claude'),
    path.join(home, '.codex'),
  ]
  const memDir = path.join(home, '.openclaw', 'workspace', 'memory')
  try { if (fs.statSync(memDir).isDirectory()) dirs.push(memDir) } catch {}
  return [...new Set(dirs)]
}

interface RuntimeAgent {
  meta: AgentMeta
  pty: IPty
  ring: Buffer[]
  ringSize: number
  logStream: fs.WriteStream
  sockets: Set<WebSocket>
  killTimer?: NodeJS.Timeout
  cleanedUp?: boolean
}

const agents = new Map<string, RuntimeAgent>()

function appendRing(agent: RuntimeAgent, chunk: Buffer) {
  if (chunk.length > RING_BYTES) chunk = chunk.subarray(chunk.length - RING_BYTES)
  agent.ring.push(chunk)
  agent.ringSize += chunk.length
  while (agent.ringSize > RING_BYTES && agent.ring.length > 0) {
    const dropped = agent.ring.shift()!
    agent.ringSize -= dropped.length
  }
}

let saveTimer: NodeJS.Timeout | null = null
function scheduleStateSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveState(state)
  }, STATE_SAVE_DEBOUNCE_MS)
  saveTimer.unref?.()
}

function flushStateSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saveState(state)
}

function trimOutputLine(line: string) {
  return trimRuntimeOutputLine(line, RUNTIME_GUARDRAILS)
}

function trimPersistedOutputLines(lines: string[]) {
  return trimRuntimePersistedOutputLines(lines, RUNTIME_GUARDRAILS)
}

function trimChatTurn(turn: ChatTurn): ChatTurn {
  return {
    ...turn,
    content: String(turn.content ?? '').slice(-CHAT_TURN_CHARS),
    toolCalls: Array.isArray(turn.toolCalls)
      ? turn.toolCalls.slice(-20).map((tc) => ({
        ...tc,
        arguments: String(tc.arguments ?? '').slice(-CHAT_TURN_CHARS),
        result: typeof tc.result === 'string' ? tc.result.slice(-CHAT_TURN_CHARS) : tc.result,
      }))
      : undefined,
  }
}

function trimChatHistory(chat: ChatTurn[]) {
  return chat.slice(-CHAT_TURNS_MAX).map(trimChatTurn)
}

function appendPersistedOutput(agent: RuntimeAgent, text: string) {
  if (!state.outputTails) state.outputTails = {}
  const rec = state.outputTails[agent.meta.id] ?? {
    meta: { ...agent.meta },
    lines: [],
    updatedAt: nowIso(),
  }
  const normalized = text.replace(/\r(?!\n)/g, '\n')
  const parts = normalized.split('\n')
  if (rec.lines.length === 0) rec.lines.push('')
  rec.lines[rec.lines.length - 1] = trimOutputLine(rec.lines[rec.lines.length - 1] + parts[0])
  for (const part of parts.slice(1)) rec.lines.push(trimOutputLine(part))
  rec.lines = trimPersistedOutputLines(rec.lines)
  rec.meta = { ...agent.meta }
  rec.updatedAt = nowIso()
  state.outputTails[agent.meta.id] = rec
  scheduleStateSave()
}

function readPersistedScrollback(id: string, wantLines: number) {
  const rec = state.outputTails?.[id]
  if (!rec) return null
  const raw = rec.lines.slice(-wantLines).join('\n')
  const output = cleanTerminalOutput(raw)
  return { id: rec.meta.id, name: rec.meta.name, kind: rec.meta.kind, lineCount: rec.lines.length, output }
}

function cleanTerminalOutput(raw: string) {
  return raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\r(?!\n)/g, '\n')
}

function isPidAlive(pid?: number) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function signalProcessTree(agent: RuntimeAgent, signal: NodeJS.Signals) {
  const pid = agent.meta.pid
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal)
      return
    } catch {}
  }
  try { agent.pty.kill(signal) } catch {}
}

function broadcast(agent: RuntimeAgent, data: Buffer) {
  const payload = data.toString('utf8')
  for (const ws of agent.sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'data', data: payload }))
    }
  }
}

function spawnAgent(input: {
  name: string
  kind: AgentKind
  workspaceId: string
  cwd?: string
  cmd?: string
  args?: string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
  addDirs?: string[]
  resume?: boolean
  role?: AgentRole
  taskId?: string
  initialPrompt?: string // injected as --append-system-prompt for claude (e.g. reviewer task brief)
  effortLevel?: EffortLevel
}): AgentMeta {
  const ws = state.workspaces.find((w) => w.id === input.workspaceId)
  if (!ws) throw new Error(`workspace not found: ${input.workspaceId}`)
  const pinned = (state.pinnedRoots?.[input.workspaceId] ?? []).map(expandHome)
  const cwdValidation = validateWorkspaceCwd({
    requestedCwd: input.cwd,
    workspaceCwd: ws.cwd,
    pinnedRoots: pinned,
    homeDir: os.homedir(),
  })
  if (!cwdValidation.ok) throw new Error(cwdValidation.error)
  const cwd = cwdValidation.cwd
  let safeCwd = cwd
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`)
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : `cwd is not accessible: ${cwd}`)
  }
  const addDirs = input.addDirs ?? [...new Set([...defaultAddDirs(safeCwd), ...pinned])]
  const knowledgeBrief = knowledgeRootsBrief(ws, pinned)
  const skillBrief = skillsBrief(ws, pinned)
  const operationalBrief = [knowledgeBrief, skillBrief].filter((brief) => brief.trim()).join('\n\n')
  const effectiveInitialPrompt = input.kind === 'codex' && input.initialPrompt && operationalBrief
    ? `${operationalBrief}\n\n${input.initialPrompt}`
    : input.initialPrompt
  const def = defaultCommandFor(input.kind, { cwd: safeCwd, addDirs, resume: !!input.resume, role: input.role, initialPrompt: effectiveInitialPrompt })
  const cmd = input.cmd ?? def.cmd
  let args = input.args ?? def.args

  // Workbench Claude panes are operator-controlled local workers. Default them to
  // non-interactive permission acceptance so routine repo-local reads/tests/edits do
  // not stall behind Claude's Bash approval prompt. Operators can override with
  // AW_CLAUDE_PERMISSION_MODE=auto|acceptEdits|default|dontAsk|plan|bypassPermissions.
  if (input.kind === 'claude' && !args.includes('--permission-mode')) {
    args = ['--permission-mode', process.env.AW_CLAUDE_PERMISSION_MODE ?? 'dontAsk', ...args]
  }

  // Inject workspace notes as an appended system prompt for claude (continuity / memory).
  if (input.kind === 'claude' && !input.cmd) {
    // Role-specific system prompt (builder/reviewer/scout/coordinator).
    if (input.role && ROLE_PROMPTS[input.role]) {
      args = ['--append-system-prompt', `# Role: ${input.role}\n\n${ROLE_PROMPTS[input.role]}`, ...args]
    }
    // Per-spawn brief (e.g. reviewer task context: "review changes for task X (files: ...)").
    if (effectiveInitialPrompt && effectiveInitialPrompt.trim()) {
      args = ['--append-system-prompt', effectiveInitialPrompt, ...args]
    }
    const notes = state.notes?.[input.workspaceId]
    if (notes && notes.trim()) {
      const briefHeader = `# Workspace context\nProject: ${ws.name}\nWorkbench cwd: ${cwd}\n\nThe following notes are this workspace's brief, written by the user. Treat as authoritative project context. Read it before answering.\n\n${notes}`
      args = ['--append-system-prompt', briefHeader, ...args]
    }
    if (knowledgeBrief) args = ['--append-system-prompt', knowledgeBrief, ...args]
    if (skillBrief) args = ['--append-system-prompt', skillBrief, ...args]
    // Inject enabled MCP servers via --mcp-config <generated.json>
    const mcps = (state.mcpServers?.[input.workspaceId] ?? []).filter((s) => s.enabled)
    if (mcps.length > 0) {
      const mcpDir = path.join(DATA_DIR, 'mcp')
      fs.mkdirSync(mcpDir, { recursive: true })
      const cfgPath = path.join(mcpDir, `${input.workspaceId}.json`)
      const cfg = {
        mcpServers: Object.fromEntries(mcps.map((s) => [s.name, {
          command: s.command,
          args: s.args ?? [],
          env: s.env ?? {},
        }])),
      }
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
      args = ['--mcp-config', cfgPath, ...args]
    }
  }
  // Per-pane effort selector (low/medium/high/extra-high/max). Default 'medium' is a no-op
  // for every backend so unselected spawns behave exactly as before.
  {
    const level = coerceEffortLevel(input.effortLevel)
    const effortFlags = effortFlagsForKind(input.kind, level)
    if (effortFlags.length > 0) args = [...args, ...effortFlags]
  }
  const id = rid('ag')
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_UPDATE_NOTIFIER: process.env.NO_UPDATE_NOTIFIER ?? '1',
    ...(input.env ?? {}),
    TERM: 'xterm-256color',
  }
  // When the workbench is launched by macOS at login (Login Item / launchd), it
  // inherits the bare launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — so user-
  // installed CLIs like `claude`, `codex`, `gh`, `gemini` aren't on PATH and
  // PTY spawn exits immediately with code 1. Prepend the standard user bin dirs
  // (Homebrew, /usr/local, ~/.local/bin, npm global) so spawns work regardless
  // of how the app itself was launched.
  {
    const extras = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), '.npm-global', 'bin'),
    ].filter((p: string) => { try { return fs.statSync(p).isDirectory() } catch { return false } })
    const existing = (env.PATH ?? '').split(':').filter(Boolean)
    const merged = [...extras, ...existing.filter((p) => !extras.includes(p))]
    env.PATH = merged.join(':')
  }

  const pty = nodePty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: input.cols ?? 100,
    rows: input.rows ?? 30,
    cwd: safeCwd,
    env: env as { [key: string]: string },
  })

  const meta: AgentMeta = {
    id,
    name: input.name || `${input.kind}-${id.slice(-4)}`,
    kind: input.kind,
    workspaceId: input.workspaceId,
    cwd: safeCwd,
    cmd,
    args,
    status: 'running',
    createdAt: nowIso(),
    pid: pty.pid,
  }
  if (input.role) meta.role = input.role
  if (input.taskId) meta.taskId = input.taskId

  // remember the spec so we can resume on next session
  if (!state.resume) state.resume = {}
  const arr = state.resume[input.workspaceId] ?? (state.resume[input.workspaceId] = [])
  // dedupe by name+kind so repeated spawns don't bloat
  const dupIx = arr.findIndex((s) => s.name === meta.name && s.kind === meta.kind)
  const spec: ResumeSpec = { kind: meta.kind, name: meta.name, cwd: meta.cwd }
  if (input.cmd) spec.cmd = input.cmd
  if (input.args) spec.args = input.args
  if (input.role) spec.role = input.role
  if (input.taskId) spec.taskId = input.taskId
  if (dupIx >= 0) arr[dupIx] = spec; else arr.push(spec)
  if (arr.length > RESUME_SPECS_MAX) arr.splice(0, arr.length - RESUME_SPECS_MAX)
  saveState(state)

  const logStream = fs.createWriteStream(path.join(LOG_DIR, `${id}.log`), { flags: 'a' })
  logStream.write(`\n--- agent ${id} (${meta.kind}) "${meta.name}" started ${meta.createdAt} cmd=${cmd} ${args.join(' ')} cwd=${cwd}\n`)

  const runtime: RuntimeAgent = {
    meta,
    pty,
    ring: [],
    ringSize: 0,
    logStream,
    sockets: new Set(),
  }
  agents.set(id, runtime)

  pty.onData((data: string) => {
    const buf = Buffer.from(data, 'utf8')
    appendRing(runtime, buf)
    logStream.write(buf)
    broadcast(runtime, buf)
    runtime.meta.lastOutputAt = nowIso()
    runtime.meta.outputBytes = (runtime.meta.outputBytes ?? 0) + buf.length
    // Keep last ~200 chars of clean output for UI tooltip surfacing (esp. exit diagnostics).
    {
      const clean = cleanTerminalOutput(data).replace(/\s+/g, ' ').trim()
      if (clean) {
        const combined = ((runtime.meta.lastOutput ?? '') + ' ' + clean).trim()
        runtime.meta.lastOutput = combined.length > 200 ? combined.slice(-200) : combined
      }
    }
    appendPersistedOutput(runtime, data)
  })

  pty.onExit(({ exitCode, signal }) => {
    markAgentExited(runtime, exitCode, signal)
  })

  return meta
}

function markAgentExited(agent: RuntimeAgent, exitCode?: number, signal?: number | string) {
  if (agent.cleanedUp) return
  agent.meta.status = 'exited'
  agent.meta.exitCode = exitCode
  const tail = `\n[agent exited code=${exitCode ?? 'unknown'}${signal ? ` signal=${signal}` : ''} at ${nowIso()}]\n`
  try { agent.logStream.write(tail) } catch {}
  appendPersistedOutput(agent, tail)
  if (agent.killTimer) {
    clearTimeout(agent.killTimer)
    agent.killTimer = undefined
  }
  for (const ws of agent.sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', exitCode, signal }))
    }
  }
  try { agent.logStream.end() } catch {}
  agent.cleanedUp = true
}

function removeRuntimeAgent(id: string) {
  const agent = agents.get(id)
  if (!agent) return
  if (agent.killTimer) clearTimeout(agent.killTimer)
  for (const ws of agent.sockets) {
    try { ws.close() } catch {}
  }
  try { agent.logStream.end() } catch {}
  agents.delete(id)
}

function killAgent(id: string): boolean {
  const agent = agents.get(id)
  if (!agent) {
    if (state.outputTails?.[id]) {
      delete state.outputTails[id]
      saveState(state)
      return true
    }
    return false
  }
  if (agent.meta.status === 'exited') {
    if (state.outputTails?.[id]) delete state.outputTails[id]
    removeRuntimeAgent(id)
    saveState(state)
    return true
  }
  signalProcessTree(agent, 'SIGTERM')
  agent.killTimer = setTimeout(() => {
    if (isPidAlive(agent.meta.pid)) signalProcessTree(agent, 'SIGKILL')
    setTimeout(() => {
      if (!isPidAlive(agent.meta.pid)) {
        markAgentExited(agent, agent.meta.exitCode, 'SIGKILL')
        removeRuntimeAgent(id)
        flushStateSave()
      }
    }, 250).unref?.()
  }, KILL_GRACE_MS)
  agent.killTimer.unref?.()
  return true
}

function listAgents(opts: { includeExited?: boolean } = {}): AgentMeta[] {
  reconcileAgentHealth()
  const live = [...agents.values()].map((a) => a.meta)
  if (!opts.includeExited) return live
  const liveIds = new Set(live.map((a) => a.id))
  const recovered = Object.values(state.outputTails ?? {})
    .map((r) => ({ ...r.meta, status: 'exited' as AgentStatus, pid: undefined }))
    .filter((m) => !liveIds.has(m.id))
  return [...live, ...recovered]
}

function clearExitedAgents(workspaceId?: string): number {
  reconcileAgentHealth()
  const clearedIds = new Set<string>()

  for (const agent of [...agents.values()]) {
    if (agent.meta.status !== 'exited') continue
    if (workspaceId && agent.meta.workspaceId !== workspaceId) continue
    if (state.outputTails?.[agent.meta.id]) delete state.outputTails[agent.meta.id]
    removeRuntimeAgent(agent.meta.id)
    clearedIds.add(agent.meta.id)
  }

  const runtimeIds = new Set([...agents.values()].map((a) => a.meta.id))
  const outputTails = state.outputTails
  if (outputTails) {
    for (const [id, rec] of Object.entries(outputTails)) {
      if (runtimeIds.has(id)) continue
      if (workspaceId && rec.meta.workspaceId !== workspaceId) continue
      delete outputTails[id]
      clearedIds.add(id)
    }
  }
  const cleared = clearedIds.size
  if (cleared > 0) saveState(state)
  return cleared
}

function findAgent(id: string): RuntimeAgent | undefined {
  return agents.get(id)
}

// ---------- HTTP ----------

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': `content-type, ${TOKEN_HEADER}, authorization`,
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  })
  res.end(JSON.stringify(body))
}

function doneStatusBlock(workspaceId: string, taskId: string, body: Record<string, unknown>): { status: number; body: Record<string, unknown> } | null {
  if (hasRequiredEvidenceForDone(workspaceId, taskId)) return null

  const override = body.overrideDoneGate === true || body.override === true
  const reasonRaw = typeof body.overrideReason === 'string'
    ? body.overrideReason
    : typeof body.doneOverrideReason === 'string'
      ? body.doneOverrideReason
      : ''
  const reason = reasonRaw.trim()
  if (!override) {
    return {
      status: 409,
      body: {
        error: 'requires_evidence',
        message: 'moving task to done requires report evidence plus review evidence, or an explicit override reason',
        requiredEvidence: ['report', 'review_or_manual_override'],
      },
    }
  }
  if (!reason) {
    return {
      status: 400,
      body: {
        error: 'override_reason_required',
        message: 'overrideReason is required when overrideDoneGate is true',
      },
    }
  }
  appendEvidence({
    workspaceId,
    taskId,
    kind: 'manual_override',
    summary: reason,
    payload: {
      gate: 'task_done',
      suppliedAt: nowIso(),
    },
  })
  return null
}

function reconcileAgentHealth() {
  for (const agent of agents.values()) {
    if (agent.meta.status === 'running' && !isPidAlive(agent.meta.pid)) {
      markAgentExited(agent, undefined, 'missing')
    }
  }
}

const healthTimer = setInterval(reconcileAgentHealth, HEALTH_CHECK_MS)
healthTimer.unref?.()

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {})
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
    const p = url.pathname
    if (process.env.AW_HTTP_LOG !== '0') console.log(`[pty-http] ${req.method} ${p}`)

    // #259 trust gate: default-deny, no allowlist (incl. /health). OPTIONS stays
    // open above — CORS preflights cannot carry custom headers, and a preflight
    // discloses nothing.
    if (!httpAuthorized(req.headers, SIDECAR_TOKEN)) {
      return send(res, 401, { error: `unauthorized: missing or invalid ${TOKEN_HEADER}` })
    }

    if (p === '/health') {
      reconcileAgentHealth()
      const metas = listAgents()
      return send(res, 200, {
        ok: true,
        agents: metas.length,
        running: metas.filter((a) => a.status === 'running').length,
        exited: metas.filter((a) => a.status === 'exited').length,
        workspaces: state.workspaces.length,
      })
    }

    if (p === '/workspaces' && req.method === 'GET') {
      return send(res, 200, { workspaces: state.workspaces })
    }
    if (p === '/workspaces' && req.method === 'POST') {
      const body = await readJson(req)
      const cwdWasProvided = typeof body.cwd === 'string' && body.cwd.trim().length > 0
      const cwdRaw = cwdWasProvided ? body.cwd.trim() : os.homedir()
      const cwd = expandHome(cwdRaw)
      const ws: Workspace = {
        id: rid('ws'),
        name: workspaceNameFromInput(body.name, cwd, cwdWasProvided),
        cwd,
        createdAt: nowIso(),
      }
      state.workspaces.push(ws)
      saveState(state)
      return send(res, 201, { workspace: ws })
    }
    const wsMatch = p.match(/^\/workspaces\/([^/]+)$/)
    if (wsMatch) {
      const id = wsMatch[1]
      const idx = state.workspaces.findIndex((w) => w.id === id)
      if (idx < 0) return send(res, 404, { error: 'workspace not found' })
      if (req.method === 'PATCH') {
        const body = await readJson(req)
        if (typeof body.name === 'string') state.workspaces[idx].name = body.name
        if (typeof body.cwd === 'string') state.workspaces[idx].cwd = expandHome(body.cwd.trim())
        saveState(state)
        return send(res, 200, { workspace: state.workspaces[idx] })
      }
      if (req.method === 'DELETE') {
        if (state.workspaces.length <= 1) return send(res, 400, { error: 'cannot delete last workspace' })
        const removed = state.workspaces.splice(idx, 1)[0]
        for (const a of [...agents.values()]) if (a.meta.workspaceId === removed.id) killAgent(a.meta.id)
        saveState(state)
        return send(res, 200, { ok: true })
      }
    }

    if (p === '/agents' && req.method === 'GET') {
      const includeExited = url.searchParams.get('include') === 'exited' || url.searchParams.get('includeExited') === '1'
      return send(res, 200, { agents: listAgents({ includeExited }) })
    }
    if (p === '/agents/exited' && req.method === 'DELETE') {
      const wsId = url.searchParams.get('workspaceId') || undefined
      const cleared = clearExitedAgents(wsId)
      return send(res, 200, { cleared })
    }
    if (p === '/agents' && req.method === 'POST') {
      const body = await readJson(req)
      if (!body.workspaceId) return send(res, 400, { error: 'workspaceId required' })
      try {
        const meta = spawnAgent({
          name: body.name,
          kind: (body.kind ?? 'shell') as AgentKind,
          workspaceId: body.workspaceId,
          cwd: body.cwd,
          cmd: body.cmd,
          args: body.args,
          env: body.env,
          cols: body.cols,
          rows: body.rows,
          addDirs: body.addDirs,
          resume: body.resume,
          role: body.role as AgentRole | undefined,
          taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
          initialPrompt: typeof body.initialPrompt === 'string' ? body.initialPrompt : undefined,
          effortLevel: coerceEffortLevel(body.effortLevel),
        })
        return send(res, 201, { agent: meta })
      } catch (e) {
        return send(res, 500, { error: e instanceof Error ? e.message : 'spawn failed' })
      }
    }

    // ---- workspace layout (renderer-owned blob) ----
    const layoutMatch = p.match(/^\/workspaces\/([^/]+)\/layout$/)
    if (layoutMatch) {
      const id = layoutMatch[1]
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return send(res, 404, { error: 'workspace not found' })
      if (req.method === 'GET') {
        const layout = state.layouts?.[id] ?? null
        return send(res, 200, { layout })
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        if (!body || typeof body !== 'object' || !('layout' in body)) return send(res, 400, { error: 'layout required' })
        if (!state.layouts) state.layouts = {}
        state.layouts[id] = body.layout ?? null
        saveState(state)
        return send(res, 200, { ok: true })
      }
    }

    // ---- broadcast input to N agents in a workspace ----
    const broadcastMatch = p.match(/^\/workspaces\/([^/]+)\/broadcast$/)
    if (broadcastMatch && req.method === 'POST') {
      const id = broadcastMatch[1]
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return send(res, 404, { error: 'workspace not found' })
      const body = await readJson(req)
      const text = body.text ?? ''
      if (typeof text !== 'string') return send(res, 400, { error: 'text must be a string' })
      const filterKind: AgentKind | undefined = body.kind
      if (filterKind !== undefined && !isBroadcastKind(filterKind)) return send(res, 400, { error: 'kind must be one of claude, codex, shell, gemini, python' })
      const targetMetas = selectBroadcastTargets([...agents.values()].map((a) => a.meta), id, filterKind)
      const targetIds = new Set(targetMetas.map((a) => a.id))
      const targets = [...agents.values()].filter((a) => targetIds.has(a.meta.id))
      for (const t of targets) {
        try { t.pty.write(text) } catch {}
      }
      return send(res, 200, { count: targets.length, ids: targets.map((t) => t.meta.id) })
    }

    // ---- workspace file tree (lazy expand) ----
    // Optional ?root=<absolute> to read from a pinned root instead of the workspace cwd.
    const filesMatch = p.match(/^\/workspaces\/([^/]+)\/files$/)
    if (filesMatch && req.method === 'GET') {
      const id = filesMatch[1]
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return send(res, 404, { error: 'workspace not found' })
      const rel = url.searchParams.get('path') ?? ''
      const requestedRoot = url.searchParams.get('root')
      const allowedRoots = [path.resolve(ws.cwd), ...(state.pinnedRoots?.[id] ?? []).map((r) => path.resolve(r))]
      const root = requestedRoot ? path.resolve(requestedRoot) : path.resolve(ws.cwd)
      if (!allowedRoots.includes(root)) return send(res, 403, { error: 'root not pinned' })
      const target = path.resolve(root, rel)
      if (!target.startsWith(root)) return send(res, 400, { error: 'path escape' })
      try {
        const list = fs.readdirSync(target, { withFileTypes: true })
        const SKIP = new Set(['node_modules', '.git', '.next', 'dist-app', '.DS_Store'])
        const entries = list
          .filter((e) => !SKIP.has(e.name))
          .slice(0, 500)
          .map((e) => ({
            name: e.name,
            isDir: e.isDirectory(),
            path: path.posix.join(rel.replace(/\\/g, '/'), e.name),
          }))
          .sort((a, b) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name))
        return send(res, 200, { root, rel, entries })
      } catch (e) {
        return send(res, 500, { error: e instanceof Error ? e.message : 'fs error' })
      }
    }

    // ---- workspace shared memory / local knowledge graph ----
    const memoryMatch = p.match(/^\/workspaces\/([^/]+)\/memory$/)
    if (memoryMatch && req.method === 'GET') {
      const id = memoryMatch[1]
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return send(res, 404, { error: 'workspace not found' })
      const query = (url.searchParams.get('q') ?? '').trim()
      const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '30', 10)
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 30
      try {
        const roots = knowledgeRootsForWorkspace(ws, state.pinnedRoots?.[id] ?? [])
        const memory = discoverMemoryDir(ws.cwd, { create: false })
        const memoryLimit = memory.existed ? (query ? Math.ceil(limit / 2) : Math.min(10, limit)) : 0
        const memoryNotes = memory.existed && query
          ? searchMemoryNotes({ memoryDir: memory.dir, text: query, limit: memoryLimit }).map((result) =>
              serializeMemoryNote(result.note, result.score, result.matches),
            )
          : memory.existed
            ? listMemoryNotes(memory.dir).slice(0, memoryLimit).map((note) => serializeMemoryNote(note))
            : []
        const broaderDocs = listKnowledgeDocs(roots, query, Math.max(0, limit - memoryNotes.length))
        const notes = [...memoryNotes, ...broaderDocs]
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, limit)
        return send(res, 200, {
          workspaceId: id,
          workspaceName: ws.name,
          memoryDirName: memory.name,
          memoryDir: memory.dir,
          existed: memory.existed || roots.length > 0,
          roots,
          notes,
        })
      } catch (e) {
        return send(res, 500, { error: e instanceof Error ? e.message : 'memory read failed' })
      }
    }

    // ---- workspace skill discovery ----
    const skillsMatch = p.match(/^\/workspaces\/([^/]+)\/skills$/)
    if (skillsMatch && req.method === 'GET') {
      const id = skillsMatch[1]
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return send(res, 404, { error: 'workspace not found' })
      const limitParam = Number.parseInt(url.searchParams.get('limit') ?? '160', 10)
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 300) : 160
      const result = discoverSkills(ws, state.pinnedRoots?.[id] ?? [], limit)
      return send(res, 200, result)
    }

    // ---- workspace git status (brief) ----
    const gitMatch = p.match(/^\/workspaces\/([^/]+)\/git-status$/)
    if (gitMatch && req.method === 'GET') {
      const id = gitMatch[1]
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return send(res, 404, { error: 'workspace not found' })
      try {
        const status = await gitStatus(ws.cwd)
        return send(res, 200, status)
      } catch (e) {
        return send(res, 200, { inRepo: false })
      }
    }

    // ---- MCP discovery (read existing configs from claude/openclaw/codex) ----
    if (p === '/mcp/discover' && req.method === 'GET') {
      const found: { source: string; name: string; command: string; args?: string[]; env?: Record<string, string> }[] = []
      const seen = new Set<string>()

      // 1. Claude desktop / per-project: ~/.claude.json → projects[*].mcpServers
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'))
        const projects = raw.projects || {}
        for (const [projPath, projVal] of Object.entries(projects as Record<string, any>)) {
          const mcpServers = (projVal && projVal.mcpServers) || {}
          for (const [name, cfg] of Object.entries(mcpServers as Record<string, any>)) {
            const key = `${name}:${cfg.command || ''}`
            if (seen.has(key)) continue
            seen.add(key)
            found.push({
              source: `~/.claude.json (${projPath})`,
              name,
              command: cfg.command || '',
              args: Array.isArray(cfg.args) ? cfg.args : [],
              env: cfg.env || {},
            })
          }
        }
      } catch {}

      // 2. Top-level Claude config (~/.claude.json :: mcpServers)
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'))
        const mcpServers = raw.mcpServers || {}
        for (const [name, cfg] of Object.entries(mcpServers as Record<string, any>)) {
          const key = `${name}:${cfg.command || ''}`
          if (seen.has(key)) continue
          seen.add(key)
          found.push({
            source: `~/.claude.json (global)`,
            name,
            command: cfg.command || '',
            args: Array.isArray(cfg.args) ? cfg.args : [],
            env: cfg.env || {},
          })
        }
      } catch {}

      // 3. OpenClaw mcp config: ~/.openclaw/workspace/.config/mcp.json
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw/workspace/.config/mcp.json'), 'utf8'))
        const mcpServers = raw.mcpServers || {}
        for (const [name, cfg] of Object.entries(mcpServers as Record<string, any>)) {
          const key = `${name}:${cfg.command || ''}`
          if (seen.has(key)) continue
          seen.add(key)
          found.push({
            source: `~/.openclaw/workspace/.config/mcp.json`,
            name,
            command: cfg.command || '',
            args: Array.isArray(cfg.args) ? cfg.args : [],
            env: cfg.env || {},
          })
        }
      } catch {}

      // 4. Claude desktop (~/Library/Application Support/Claude/claude_desktop_config.json)
      try {
        const cdcPath = path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json')
        const raw = JSON.parse(fs.readFileSync(cdcPath, 'utf8'))
        const mcpServers = raw.mcpServers || {}
        for (const [name, cfg] of Object.entries(mcpServers as Record<string, any>)) {
          const key = `${name}:${cfg.command || ''}`
          if (seen.has(key)) continue
          seen.add(key)
          found.push({
            source: `Claude Desktop config`,
            name,
            command: cfg.command || '',
            args: Array.isArray(cfg.args) ? cfg.args : [],
            env: cfg.env || {},
          })
        }
      } catch {}

      // 5. Codex config.toml mcp_servers (best-effort TOML scan)
      try {
        const raw = fs.readFileSync(path.join(os.homedir(), '.codex/config.toml'), 'utf8')
        const blockRe = /\[mcp_servers\.([^\]]+)\]([^\[]*)/g
        let m: RegExpExecArray | null
        while ((m = blockRe.exec(raw)) !== null) {
          const name = m[1].trim().replace(/^"|"$/g, '')
          const body = m[2]
          const cmdMatch = body.match(/command\s*=\s*"([^"]+)"/)
          const argsMatch = body.match(/args\s*=\s*\[([^\]]*)\]/)
          const args = argsMatch ? argsMatch[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean) : []
          const key = `${name}:${cmdMatch ? cmdMatch[1] : ''}`
          if (seen.has(key)) continue
          seen.add(key)
          found.push({
            source: `~/.codex/config.toml`,
            name,
            command: cmdMatch ? cmdMatch[1] : '',
            args,
            env: {},
          })
        }
      } catch {}

      return send(res, 200, { discovered: found })
    }

    // ---- workspace MCP servers ----
    const mcpMatch = p.match(/^\/workspaces\/([^/]+)\/mcp-servers$/)
    if (mcpMatch) {
      const id = mcpMatch[1]
      if (req.method === 'GET') return send(res, 200, { servers: state.mcpServers?.[id] ?? [] })
      if (req.method === 'PUT') {
        const body = await readJson(req)
        if (!state.mcpServers) state.mcpServers = {}
        const list: McpServer[] = Array.isArray(body.servers) ? body.servers.map((s: any) => ({
          id: String(s.id || rid('mcp')),
          name: String(s.name || 'unnamed'),
          command: String(s.command || ''),
          args: Array.isArray(s.args) ? s.args.map(String) : [],
          env: s.env && typeof s.env === 'object' ? Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, String(v)])) : {},
          enabled: s.enabled !== false,
        })) : []
        state.mcpServers[id] = list
        saveState(state)
        return send(res, 200, { servers: list })
      }
    }

    // ---- workspace notes (markdown brief, persisted, injected into spawned agents) ----
    const notesMatch = p.match(/^\/workspaces\/([^/]+)\/notes$/)
    if (notesMatch) {
      const id = notesMatch[1]
      if (req.method === 'GET') return send(res, 200, { notes: state.notes?.[id] ?? '' })
      if (req.method === 'PUT') {
        const body = await readJson(req)
        if (!state.notes) state.notes = {}
        state.notes[id] = String(body.notes ?? '').slice(0, 200_000)
        saveState(state)
        return send(res, 200, { ok: true })
      }
    }

    // ---- workspace pinned roots (extra folders shown in the file tree) ----
    const pinsMatch = p.match(/^\/workspaces\/([^/]+)\/pinned-roots$/)
    if (pinsMatch) {
      const id = pinsMatch[1]
      if (req.method === 'GET') return send(res, 200, { roots: state.pinnedRoots?.[id] ?? [] })
      if (req.method === 'PUT') {
        const body = await readJson(req)
        if (!state.pinnedRoots) state.pinnedRoots = {}
        const list: string[] = Array.isArray(body.roots) ? body.roots.map((s: unknown) => String(s)) : []
        state.pinnedRoots[id] = [...new Set(list.filter(Boolean))]
        saveState(state)
        return send(res, 200, { ok: true })
      }
    }

    // ---- workspace chat history ----
    const chatMatch = p.match(/^\/workspaces\/([^/]+)\/chat$/)
    if (chatMatch) {
      const id = chatMatch[1]
      if (req.method === 'GET') {
        const chat = state.chats?.[id] ?? []
        return send(res, 200, { chat })
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        if (!state.chats) state.chats = {}
        state.chats[id] = Array.isArray(body.chat) ? trimChatHistory(body.chat as ChatTurn[]) : []
        saveState(state)
        return send(res, 200, { ok: true })
      }
      if (req.method === 'DELETE') {
        if (state.chats) delete state.chats[id]
        saveState(state)
        return send(res, 200, { ok: true })
      }
    }

    // ---- workspace resume ----
    const resumeListMatch = p.match(/^\/workspaces\/([^/]+)\/resume-specs$/)
    if (resumeListMatch && req.method === 'GET') {
      const id = resumeListMatch[1]
      const specs = state.resume?.[id] ?? []
      return send(res, 200, { specs })
    }
    const resumeRunMatch = p.match(/^\/workspaces\/([^/]+)\/resume$/)
    if (resumeRunMatch && req.method === 'POST') {
      const id = resumeRunMatch[1]
      const ws = state.workspaces.find((w) => w.id === id)
      if (!ws) return send(res, 404, { error: 'workspace not found' })
      const specs = state.resume?.[id] ?? []
      const spawned: AgentMeta[] = []
      for (const s of specs) {
        try {
          const m = spawnAgent({
            workspaceId: id,
            kind: s.kind as AgentKind,
            name: s.name,
            cwd: s.cwd,
            cmd: s.cmd,
            args: s.args,
            role: s.role,
            taskId: s.taskId,
            resume: s.kind === 'claude' || s.kind === 'codex',
          })
          spawned.push(m)
        } catch {}
      }
      return send(res, 200, { spawned })
    }
    const resumeClearMatch = p.match(/^\/workspaces\/([^/]+)\/resume-specs$/)
    if (resumeClearMatch && req.method === 'DELETE') {
      const id = resumeClearMatch[1]
      if (state.resume) delete state.resume[id]
      saveState(state)
      return send(res, 200, { ok: true })
    }
    // ---- workspace tasks (kanban) ----
    const tasksMatch = p.match(/^\/workspaces\/([^/]+)\/tasks$/)
    if (tasksMatch) {
      const wsId = tasksMatch[1]
      if (!state.workspaces.find((w) => w.id === wsId)) return send(res, 404, { error: 'workspace not found' })
      if (req.method === 'GET') return send(res, 200, { tasks: state.tasks?.[wsId] ?? [] })
      if (req.method === 'POST') {
        const body = await readJson(req)
        const title = String(body.title ?? '').trim()
        if (!title) return send(res, 400, { error: 'title required' })
        const status = body.status === undefined ? 'todo' : body.status
        if (!isTaskStatus(status)) return send(res, 400, { error: 'invalid task status' })
        if (!state.tasks) state.tasks = {}
        if (!state.tasks[wsId]) state.tasks[wsId] = []
        const task: Task = {
          id: rid('tk'),
          workspaceId: wsId,
          title,
          description: typeof body.description === 'string' ? body.description : undefined,
          status,
          ownerId: typeof body.ownerId === 'string' ? body.ownerId : undefined,
          files: Array.isArray(body.files) ? body.files.map(String) : undefined,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        if (task.status === 'done') {
          const blocked = doneStatusBlock(wsId, task.id, body)
          if (blocked) return send(res, blocked.status, blocked.body)
        }
        state.tasks[wsId].push(task)
        saveState(state)
        return send(res, 201, { task })
      }
    }
    const taskItemMatch = p.match(/^\/workspaces\/([^/]+)\/tasks\/([^/]+)$/)
    if (taskItemMatch) {
      const wsId = taskItemMatch[1]
      const taskId = taskItemMatch[2]
      const list = state.tasks?.[wsId] ?? []
      const idx = list.findIndex((t) => t.id === taskId)
      if (idx < 0) return send(res, 404, { error: 'task not found' })
      if (req.method === 'PATCH') {
        const body = await readJson(req)
        const t = list[idx]
        if (typeof body.title === 'string' && body.title.trim()) t.title = body.title.trim()
        if (typeof body.description === 'string') t.description = body.description
        if (body.status !== undefined) {
          if (!isTaskStatus(body.status)) return send(res, 400, { error: 'invalid task status' })
          if (body.status === 'done' && t.status !== 'done') {
            const blocked = doneStatusBlock(wsId, taskId, body)
            if (blocked) return send(res, blocked.status, blocked.body)
          }
          t.status = body.status
        }
        if (typeof body.ownerId === 'string' || body.ownerId === null) t.ownerId = body.ownerId || undefined
        if (Array.isArray(body.files)) t.files = body.files.map(String)
        t.updatedAt = nowIso()
        saveState(state)
        return send(res, 200, { task: t })
      }
      if (req.method === 'DELETE') {
        list.splice(idx, 1)
        saveState(state)
        return send(res, 200, { ok: true })
      }
    }
    const taskEvidenceMatch = p.match(/^\/workspaces\/([^/]+)\/tasks\/([^/]+)\/evidence$/)
    if (taskEvidenceMatch) {
      const wsId = taskEvidenceMatch[1]
      const taskId = taskEvidenceMatch[2]
      const list = state.tasks?.[wsId] ?? []
      const t = list.find((x) => x.id === taskId)
      if (!t) return send(res, 404, { error: 'task not found' })
      if (req.method === 'GET') {
        const kind = url.searchParams.get('kind') || undefined
        const rows = listEvidence(wsId, {
          taskId,
          kind: kind as EvidenceKind | undefined,
        })
        return send(res, 200, { evidence: rows })
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        try {
          const result = appendEvidence({
            workspaceId: wsId,
            taskId,
            kind: body.kind as EvidenceKind,
            summary: String(body.summary ?? ''),
            payload: body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : undefined,
            missionId: typeof body.missionId === 'string' ? body.missionId : undefined,
            laneId: typeof body.laneId === 'string' ? body.laneId : undefined,
            agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
            id: typeof body.id === 'string' ? body.id : undefined,
          })
          return send(res, result.duplicate ? 200 : 201, result)
        } catch (e) {
          return send(res, 400, { error: e instanceof Error ? e.message : 'evidence append failed' })
        }
      }
    }
    // POST /workspaces/:wsId/tasks/:taskId/claim — declare files this task owns; rejects if any
    // file is already claimed by another non-done task in the same workspace.
    const taskClaimMatch = p.match(/^\/workspaces\/([^/]+)\/tasks\/([^/]+)\/claim$/)
    if (taskClaimMatch && req.method === 'POST') {
      const wsId = taskClaimMatch[1]
      const taskId = taskClaimMatch[2]
      const list = state.tasks?.[wsId] ?? []
      const t = list.find((x) => x.id === taskId)
      if (!t) return send(res, 404, { error: 'task not found' })
      const body = await readJson(req)
      const files = Array.isArray(body.files) ? body.files.map(String) : []
      const conflicts: { file: string; taskId: string; title: string }[] = []
      for (const f of files) {
        for (const other of list) {
          if (other.id === t.id) continue
          if (other.status === 'done') continue
          if ((other.files ?? []).includes(f)) {
            conflicts.push({ file: f, taskId: other.id, title: other.title })
          }
        }
      }
      if (conflicts.length > 0) return send(res, 409, { error: 'file ownership conflict', conflicts })
      t.files = Array.from(new Set<string>(files))
      t.updatedAt = nowIso()
      saveState(state)
      return send(res, 200, { task: t })
    }
    // POST /workspaces/:wsId/tasks/:taskId/build — spawn a Codex builder with task context.
    const taskBuildMatch = p.match(/^\/workspaces\/([^/]+)\/tasks\/([^/]+)\/build$/)
    if (taskBuildMatch && req.method === 'POST') {
      const wsId = taskBuildMatch[1]
      const taskId = taskBuildMatch[2]
      const list = state.tasks?.[wsId] ?? []
      const t = list.find((x) => x.id === taskId)
      if (!t) return send(res, 404, { error: 'task not found' })
      const ws = state.workspaces.find((w) => w.id === wsId)
      if (!ws) return send(res, 404, { error: 'workspace not found' })
      const fileList = (t.files ?? []).map((f) => `- ${f}`).join('\n') || '(no files declared — inspect the repo and keep the change tightly scoped)'
      const brief = [
        `# Build task: ${t.title}`,
        '',
        t.description ? `${t.description}\n` : '',
        `Workspace: ${ws.name}`,
        `Cwd: ${ws.cwd}`,
        '',
        'Files in scope:',
        fileList,
        '',
        'Workbench protocol:',
        '1. Inspect the repo before editing.',
        '2. Implement the smallest viable change for this task.',
        '3. Preserve unrelated user edits.',
        '4. Run focused checks or explain why checks could not run.',
        '5. Finish with changed files, verification, and remaining risks so the task can move to review.',
      ].filter(Boolean).join('\n')
      try {
        const meta = spawnAgent({
          workspaceId: wsId,
          kind: 'codex',
          name: `build:${t.title.slice(0, 24)}`,
          role: 'builder',
          taskId: t.id,
          initialPrompt: brief,
        })
        if (t.status !== 'done') t.status = 'building'
        t.ownerId = meta.id
        t.updatedAt = nowIso()
        saveState(state)
        return send(res, 201, { agent: meta, task: t })
      } catch (e) {
        return send(res, 500, { error: e instanceof Error ? e.message : 'spawn failed' })
      }
    }
    // POST /workspaces/:wsId/tasks/:taskId/review — spawn a reviewer claude with context.
    const taskReviewMatch = p.match(/^\/workspaces\/([^/]+)\/tasks\/([^/]+)\/review$/)
    if (taskReviewMatch && req.method === 'POST') {
      const wsId = taskReviewMatch[1]
      const taskId = taskReviewMatch[2]
      const list = state.tasks?.[wsId] ?? []
      const t = list.find((x) => x.id === taskId)
      if (!t) return send(res, 404, { error: 'task not found' })
      const ws = state.workspaces.find((w) => w.id === wsId)
      if (!ws) return send(res, 404, { error: 'workspace not found' })
      const fileList = (t.files ?? []).map((f) => `- ${f}`).join('\n') || '(no files declared — review the full working tree diff)'
      const brief = `# Review task: ${t.title}\n\n${t.description ? t.description + '\n\n' : ''}Files in scope:\n${fileList}\n\nRun \`git diff\` (and/or \`git status\`) in the workspace, read the changes, and report: correctness, security, consistency. Be specific — cite file:line. If you approve, say so plainly. If you block, list the exact required fixes.`
      try {
        const meta = spawnAgent({
          workspaceId: wsId,
          kind: 'claude',
          name: `review:${t.title.slice(0, 24)}`,
          role: 'reviewer',
          taskId: t.id,
          initialPrompt: brief,
        })
        // bump task to 'review' status if it isn't already done
        if (t.status !== 'done') t.status = 'review'
        t.updatedAt = nowIso()
        saveState(state)
        return send(res, 201, { agent: meta, task: t })
      } catch (e) {
        return send(res, 500, { error: e instanceof Error ? e.message : 'spawn failed' })
      }
    }

    // ---- headless preview capture/verify (#256/#258) ----
    if (p === '/preview/crop' && req.method === 'POST') {
      const body = await readJson(req)
      if (typeof body.url !== 'string' || typeof body.selector !== 'string' || typeof body.annotationId !== 'string') {
        return send(res, 400, { error: 'url, selector, annotationId required' })
      }
      try {
        const { path: file } = await captureCrop({ url: body.url, selector: body.selector, annotationId: body.annotationId })
        return send(res, 200, { path: file, slug: slugFor(body.url) })
      } catch (e) {
        return send(res, 422, { error: e instanceof Error ? e.message : 'capture failed' })
      }
    }
    if (p === '/preview/verify' && req.method === 'POST') {
      const body = await readJson(req)
      if (typeof body.url !== 'string' || !Array.isArray(body.checks)) {
        return send(res, 400, { error: 'url and checks[] required' })
      }
      try {
        const results = await verifySelectors({ url: body.url, checks: body.checks })
        return send(res, 200, { results })
      } catch (e) {
        return send(res, 422, { error: e instanceof Error ? e.message : 'verify failed' })
      }
    }
    const cropMatch = p.match(/^\/preview\/crops\/([^/]+)\/([^/]+)$/)
    if (cropMatch && req.method === 'GET') {
      const file = cropFileFor(cropMatch[1], cropMatch[2])
      if (!file) return send(res, 404, { error: 'crop not found' })
      res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' })
      fs.createReadStream(file).pipe(res)
      return
    }

    const agentMatch = p.match(/^\/agents\/([^/]+)(?:\/(input|scrollback))?$/)
    if (agentMatch) {
      const id = agentMatch[1]
      const sub = agentMatch[2]
      const agent = agents.get(id)
      if (sub === 'input' && req.method === 'POST') {
        if (!agent) return send(res, 404, { error: 'agent not found' })
        if (agent.meta.status !== 'running') return send(res, 410, { error: 'agent exited' })
        const body = await readJson(req)
        const text: string = body.text ?? ''
        agent.pty.write(text)
        return send(res, 200, { ok: true })
      }
      if (sub === 'scrollback' && req.method === 'GET') {
        const linesParam = url.searchParams.get('lines')
        const wantLines = Math.min(2000, Math.max(1, Number(linesParam ?? 200)))
        if (!agent) {
          const persisted = readPersistedScrollback(id, wantLines)
          if (persisted) return send(res, 200, persisted)
          return send(res, 404, { error: 'agent not found' })
        }
        // Strip ANSI escape sequences for clean readable output
        const raw = Buffer.concat(agent.ring).toString('utf8')
        const stripped = cleanTerminalOutput(raw)
        const lines = stripped.split(/\n/)
        const tail = lines.slice(Math.max(0, lines.length - wantLines)).join('\n')
        return send(res, 200, { id: agent.meta.id, name: agent.meta.name, kind: agent.meta.kind, lineCount: lines.length, output: tail })
      }
      if (!sub && req.method === 'DELETE') {
        const removed = killAgent(id)
        return send(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'agent not found' })
      }
      if (!agent) return send(res, 404, { error: 'agent not found' })
      if (req.method === 'PATCH') {
        const body = await readJson(req)
        if (typeof body.name === 'string') agent.meta.name = body.name
        if (state.outputTails?.[id]) state.outputTails[id].meta = { ...agent.meta }
        scheduleStateSave()
        return send(res, 200, { agent: agent.meta })
      }
    }

    send(res, 404, { error: 'not found' })
  } catch (e) {
    send(res, 500, { error: e instanceof Error ? e.message : 'server error' })
  }
})

const wss = new WebSocketServer({
  noServer: true,
  // Browser clients offer ['drt', 'drt.<token>']; select the plain protocol so
  // the token is never echoed back in the handshake response.
  handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL_PLAIN) ? WS_PROTOCOL_PLAIN : false),
})

server.on('upgrade', (req, socket, head) => {
  // #259 trust gate: same default-deny as HTTP. Browser WS can't set headers,
  // so the token rides the offered subprotocols (never the URL).
  if (!wsAuthorized(req.headers, SIDECAR_TOKEN)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const m = url.pathname.match(/^\/ws\/([^/]+)$/)
  if (!m) { socket.destroy(); return }
  const agentId = m[1]
  const agent = findAgent(agentId)
  if (!agent) { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => {
    agent.sockets.add(ws)
    // replay scrollback
    const replay = Buffer.concat(agent.ring).toString('utf8')
    if (replay.length) ws.send(JSON.stringify({ type: 'data', data: replay }))
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'data' && typeof msg.data === 'string') {
          if (agent.meta.status === 'running') agent.pty.write(msg.data)
        } else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          if (agent.meta.status === 'running') {
            try { agent.pty.resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0)) } catch {}
          }
        }
      } catch {}
    })
    ws.on('close', () => agent.sockets.delete(ws))
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[pty-server] listening on http://${HOST}:${PORT}`)
  // Log where the token lives, never the token itself.
  const source = process.env.DEV_REVIEW_SIDECAR_TOKEN ? 'env DEV_REVIEW_SIDECAR_TOKEN' : path.join(DATA_DIR, TOKEN_FILE_NAME)
  console.log(`[pty-server] trust gate active (#259) — token from ${source}`)
})

function shutdown() {
  for (const a of [...agents.values()]) {
    signalProcessTree(a, 'SIGTERM')
  }
  flushStateSave()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
