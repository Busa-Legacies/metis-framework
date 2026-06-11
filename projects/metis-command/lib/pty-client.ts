/** Browser/server helpers for talking to the PTY sidecar. */
import type { Agent, AgentKind, AgentRole, EvidenceKind, EvidenceRow, Task, TaskStatus, Workspace } from './types'

// Derive the sidecar base from the page at runtime so every serving mode works
// without a build-time env:
//  - https page  → behind the Caddy front door (#273): sidecar is same-origin
//    at /pty/* (Caddy strips the prefix and proxies to 127.0.0.1:3748)
//  - http page   → dev / Electron / direct LAN: hit :3748 on the page host so
//    remote browsers reach the Mac's sidecar instead of their own localhost
function defaultPtyBase(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:3748'
  if (window.location.protocol === 'https:') return `${window.location.origin}/pty`
  return `http://${window.location.hostname}:3748`
}
export const PTY_BASE = process.env.NEXT_PUBLIC_PTY_BASE ?? defaultPtyBase()

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`PTY ${res.status}: ${t || res.statusText}`)
  }
  return res.json() as Promise<T>
}

export const ptyApi = {
  health: () => fetch(`${PTY_BASE}/health`).then(j<{ ok: boolean; agents: number; workspaces: number }>),

  listWorkspaces: () => fetch(`${PTY_BASE}/workspaces`).then(j<{ workspaces: Workspace[] }>),
  createWorkspace: (input: { name?: string | null; cwd?: string }) =>
    fetch(`${PTY_BASE}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(j<{ workspace: Workspace }>),
  updateWorkspace: (id: string, patch: { name?: string; cwd?: string }) =>
    fetch(`${PTY_BASE}/workspaces/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(j<{ workspace: Workspace }>),
  deleteWorkspace: (id: string) =>
    fetch(`${PTY_BASE}/workspaces/${id}`, { method: 'DELETE' }).then(j<{ ok: boolean }>),

  listAgents: (opts: { includeExited?: boolean } = {}) =>
    fetch(`${PTY_BASE}/agents${opts.includeExited ? '?include=exited' : ''}`).then(j<{ agents: Agent[] }>),
  clearExitedAgents: (workspaceId?: string) =>
    fetch(`${PTY_BASE}/agents/exited${workspaceId ? `?workspaceId=${workspaceId}` : ''}`, { method: 'DELETE' }).then(j<{ cleared: number }>),
  getLayout: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/layout`).then(j<{ layout: unknown }>),
  putLayout: (workspaceId: string, layout: unknown) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout }),
    }).then(j<{ ok: boolean }>),
  listFiles: (workspaceId: string, relPath: string = '', root?: string) => {
    const qs = new URLSearchParams({ path: relPath })
    if (root) qs.set('root', root)
    return fetch(`${PTY_BASE}/workspaces/${workspaceId}/files?${qs}`)
      .then(j<{ root: string; rel: string; entries: { name: string; isDir: boolean; path: string }[] }>)
  },
  gitStatus: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/git-status`).then(j<{ inRepo: boolean; branch?: string | null; modified?: number; untracked?: number; dirty?: number; ahead?: number; behind?: number }>),
  listMemory: (workspaceId: string, opts: { q?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (opts.q?.trim()) qs.set('q', opts.q.trim())
    if (opts.limit) qs.set('limit', String(opts.limit))
    const suffix = qs.toString() ? `?${qs}` : ''
    return fetch(`${PTY_BASE}/workspaces/${workspaceId}/memory${suffix}`).then(j<{
      workspaceId: string
      workspaceName: string
      memoryDirName: string
      memoryDir: string
      existed: boolean
      roots?: {
        name: string
        path: string
        kind: 'workspace' | 'memory' | 'obsidian' | 'openclaw' | 'claude' | 'codex' | 'pinned'
      }[]
      notes: {
        id: string
        title: string
        tags: string[]
        relativePath: string
        sourceName?: string
        sourcePath?: string
        updatedAt: string
        preview: string
        wikilinks: number
        score?: number
        matches: string[]
      }[]
    }>)
  },
  discoverMcp: () =>
    fetch(`${PTY_BASE}/mcp/discover`).then(j<{ discovered: { source: string; name: string; command: string; args?: string[]; env?: Record<string, string> }[] }>),
  getMcpServers: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/mcp-servers`).then(j<{ servers: { id: string; name: string; command: string; args?: string[]; env?: Record<string, string>; enabled: boolean }[] }>),
  listSkills: (workspaceId: string, opts: { limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (opts.limit) qs.set('limit', String(opts.limit))
    const suffix = qs.toString() ? `?${qs}` : ''
    return fetch(`${PTY_BASE}/workspaces/${workspaceId}/skills${suffix}`).then(j<{
      roots: string[]
      skills: {
        name: string
        path: string
        root: string
        description: string
        updatedAt: string
      }[]
    }>)
  },
  putMcpServers: (workspaceId: string, servers: any[]) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/mcp-servers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servers }),
    }).then(j<{ servers: any[] }>),
  getNotes: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/notes`).then(j<{ notes: string }>),
  putNotes: (workspaceId: string, notes: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/notes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes }),
    }).then(j<{ ok: boolean }>),
  getPinnedRoots: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/pinned-roots`).then(j<{ roots: string[] }>),
  putPinnedRoots: (workspaceId: string, roots: string[]) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/pinned-roots`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots }),
    }).then(j<{ ok: boolean }>),
  getChat: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/chat`).then(j<{ chat: any[] }>),
  putChat: (workspaceId: string, chat: any[]) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/chat`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat }),
    }).then(j<{ ok: boolean }>),
  clearChat: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/chat`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  resumeSpecs: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/resume-specs`).then(j<{ specs: { kind: AgentKind; name: string; cwd: string; cmd?: string; args?: string[] }[] }>),
  resumeWorkspace: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/resume`, { method: 'POST' }).then(j<{ spawned: Agent[] }>),
  clearResume: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/resume-specs`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  spawnAgent: (input: {
    workspaceId: string
    kind: AgentKind
    name?: string
    cwd?: string
    cmd?: string
    args?: string[]
    cols?: number
    rows?: number
    resume?: boolean
    role?: AgentRole
    taskId?: string
    initialPrompt?: string
    account?: 'default' | 'navore'
  }) =>
    fetch(`${PTY_BASE}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(j<{ agent: Agent }>),

  // ---- tasks (kanban) ----
  listTasks: (workspaceId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks`).then(j<{ tasks: Task[] }>),
  createTask: (workspaceId: string, input: { title: string; description?: string; status?: TaskStatus; ownerId?: string; files?: string[] }) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(j<{ task: Task }>),
  updateTask: (workspaceId: string, taskId: string, patch: Partial<Pick<Task, 'title' | 'description' | 'status' | 'ownerId' | 'files'>> & { overrideDoneGate?: boolean; overrideReason?: string }) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(j<{ task: Task }>),
  deleteTask: (workspaceId: string, taskId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  claimTaskFiles: (workspaceId: string, taskId: string, files: string[]) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files }),
    }).then(async (res) => {
      if (res.status === 409) {
        const data = await res.json()
        throw Object.assign(new Error('file ownership conflict'), { status: 409, conflicts: data.conflicts })
      }
      return j<{ task: Task }>(res)
    }),
  reviewTask: (workspaceId: string, taskId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}/review`, { method: 'POST' })
      .then(j<{ agent: Agent; task: Task }>),
  buildTask: (workspaceId: string, taskId: string) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}/build`, { method: 'POST' })
      .then(j<{ agent: Agent; task: Task }>),
  listTaskEvidence: (workspaceId: string, taskId: string, opts: { kind?: EvidenceKind } = {}) => {
    const qs = new URLSearchParams()
    if (opts.kind) qs.set('kind', opts.kind)
    const suffix = qs.toString() ? `?${qs}` : ''
    return fetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}/evidence${suffix}`)
      .then(j<{ evidence: EvidenceRow[] }>)
  },
  appendTaskEvidence: (workspaceId: string, taskId: string, input: {
    kind: EvidenceKind
    summary: string
    payload?: Record<string, unknown>
    missionId?: string
    laneId?: string
    agentId?: string
    id?: string
  }) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(j<{ row: EvidenceRow; duplicate: boolean }>),
  renameAgent: (id: string, name: string) =>
    fetch(`${PTY_BASE}/agents/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(j<{ agent: Agent }>),
  killAgent: (id: string) =>
    fetch(`${PTY_BASE}/agents/${id}`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  sendInput: (id: string, text: string) =>
    fetch(`${PTY_BASE}/agents/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(j<{ ok: boolean }>),
  scrollback: (id: string, lines: number = 200) =>
    fetch(`${PTY_BASE}/agents/${id}/scrollback?lines=${lines}`).then(
      j<{ id: string; name: string; kind: string; lineCount: number; output: string }>,
    ),
  broadcast: (workspaceId: string, text: string, kind?: AgentKind) =>
    fetch(`${PTY_BASE}/workspaces/${workspaceId}/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, kind }),
    }).then(j<{ count: number; ids: string[] }>),
}

export function agentWsUrl(agentId: string): string {
  const base = PTY_BASE.replace(/^http/, 'ws')
  return `${base}/ws/${agentId}`
}
