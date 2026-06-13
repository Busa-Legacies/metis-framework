/** Browser/server helpers for talking to the PTY sidecar. */
import type { Agent, AgentKind, AgentRole, EvidenceKind, EvidenceRow, Task, TaskStatus, Workspace } from './types'

// Derive the sidecar host from wherever the page is served (loopback locally,
// Tailscale IP for a remote browser) — a hardcoded 127.0.0.1 would point a
// remote client at ITS OWN machine. Env override still wins.
export const PTY_BASE =
  process.env.NEXT_PUBLIC_PTY_BASE ??
  (typeof window !== 'undefined' ? `http://${window.location.hostname}:3761` : 'http://127.0.0.1:3761')

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`PTY ${res.status}: ${t || res.statusText}`)
  }
  return res.json() as Promise<T>
}

// ---- #259 trust gate -------------------------------------------------------
// The sidecar is default-deny. Browsers obtain the token from the console's own
// origin (/api/sidecar-token reads the sidecar's 0600 token file server-side);
// server-side callers use the env var. Cached one fetch per page load; the
// cache resets on failure so a sidecar restart self-heals on the next call.
let tokenPromise: Promise<string> | null = null

export function sidecarToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      if (typeof window === 'undefined') {
        const fromEnv = process.env.DEV_REVIEW_SIDECAR_TOKEN?.trim()
        if (fromEnv) return fromEnv
        throw new Error('sidecar token unavailable server-side — set DEV_REVIEW_SIDECAR_TOKEN')
      }
      const res = await fetch('/api/sidecar-token')
      if (!res.ok) throw new Error(`sidecar token unavailable (${res.status})`)
      const data = (await res.json()) as { token?: string }
      if (!data.token) throw new Error('sidecar token unavailable (empty response)')
      return data.token
    })()
    tokenPromise.catch(() => {
      tokenPromise = null
    })
  }
  return tokenPromise
}

async function ptyFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = await sidecarToken()
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
    'x-dev-review-token': token,
  }
  return fetch(input, { ...init, headers })
}

/** Subprotocol list carrying the token for browser WS (headers unavailable there). */
export async function agentWsProtocols(): Promise<string[]> {
  const token = await sidecarToken()
  return ['drt', `drt.${token}`]
}

/** Authenticated image fetch -> object URL (img tags can't send headers). Caller revokes. */
export async function fetchCropObjectUrl(cropSlug: string, annotationId: string): Promise<string> {
  const res = await ptyFetch(`${PTY_BASE}/preview/crops/${cropSlug}/${annotationId}.png`)
  if (!res.ok) throw new Error(`crop fetch failed (${res.status})`)
  return URL.createObjectURL(await res.blob())
}

export const ptyApi = {
  health: () => ptyFetch(`${PTY_BASE}/health`).then(j<{ ok: boolean; agents: number; workspaces: number }>),

  listWorkspaces: () => ptyFetch(`${PTY_BASE}/workspaces`).then(j<{ workspaces: Workspace[] }>),
  createWorkspace: (input: { name?: string | null; cwd?: string }) =>
    ptyFetch(`${PTY_BASE}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(j<{ workspace: Workspace }>),
  updateWorkspace: (id: string, patch: { name?: string; cwd?: string }) =>
    ptyFetch(`${PTY_BASE}/workspaces/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(j<{ workspace: Workspace }>),
  deleteWorkspace: (id: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${id}`, { method: 'DELETE' }).then(j<{ ok: boolean }>),

  listAgents: (opts: { includeExited?: boolean } = {}) =>
    ptyFetch(`${PTY_BASE}/agents${opts.includeExited ? '?include=exited' : ''}`).then(j<{ agents: Agent[] }>),
  clearExitedAgents: (workspaceId?: string) =>
    ptyFetch(`${PTY_BASE}/agents/exited${workspaceId ? `?workspaceId=${workspaceId}` : ''}`, { method: 'DELETE' }).then(j<{ cleared: number }>),
  getLayout: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/layout`).then(j<{ layout: unknown }>),
  putLayout: (workspaceId: string, layout: unknown) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/layout`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layout }),
    }).then(j<{ ok: boolean }>),
  listFiles: (workspaceId: string, relPath: string = '', root?: string) => {
    const qs = new URLSearchParams({ path: relPath })
    if (root) qs.set('root', root)
    return ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/files?${qs}`)
      .then(j<{ root: string; rel: string; entries: { name: string; isDir: boolean; path: string }[] }>)
  },
  gitStatus: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/git-status`).then(j<{ inRepo: boolean; branch?: string | null; modified?: number; untracked?: number; dirty?: number; ahead?: number; behind?: number }>),
  listMemory: (workspaceId: string, opts: { q?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (opts.q?.trim()) qs.set('q', opts.q.trim())
    if (opts.limit) qs.set('limit', String(opts.limit))
    const suffix = qs.toString() ? `?${qs}` : ''
    return ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/memory${suffix}`).then(j<{
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
    ptyFetch(`${PTY_BASE}/mcp/discover`).then(j<{ discovered: { source: string; name: string; command: string; args?: string[]; env?: Record<string, string> }[] }>),
  getMcpServers: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/mcp-servers`).then(j<{ servers: { id: string; name: string; command: string; args?: string[]; env?: Record<string, string>; enabled: boolean }[] }>),
  listSkills: (workspaceId: string, opts: { limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (opts.limit) qs.set('limit', String(opts.limit))
    const suffix = qs.toString() ? `?${qs}` : ''
    return ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/skills${suffix}`).then(j<{
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
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/mcp-servers`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ servers }),
    }).then(j<{ servers: any[] }>),
  getNotes: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/notes`).then(j<{ notes: string }>),
  putNotes: (workspaceId: string, notes: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/notes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notes }),
    }).then(j<{ ok: boolean }>),
  getPinnedRoots: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/pinned-roots`).then(j<{ roots: string[] }>),
  putPinnedRoots: (workspaceId: string, roots: string[]) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/pinned-roots`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots }),
    }).then(j<{ ok: boolean }>),
  getChat: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/chat`).then(j<{ chat: any[] }>),
  putChat: (workspaceId: string, chat: any[]) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/chat`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat }),
    }).then(j<{ ok: boolean }>),
  clearChat: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/chat`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  resumeSpecs: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/resume-specs`).then(j<{ specs: { kind: AgentKind; name: string; cwd: string; cmd?: string; args?: string[] }[] }>),
  resumeWorkspace: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/resume`, { method: 'POST' }).then(j<{ spawned: Agent[] }>),
  clearResume: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/resume-specs`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
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
  }) =>
    ptyFetch(`${PTY_BASE}/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(j<{ agent: Agent }>),

  // ---- tasks (kanban) ----
  listTasks: (workspaceId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks`).then(j<{ tasks: Task[] }>),
  createTask: (workspaceId: string, input: { title: string; description?: string; status?: TaskStatus; ownerId?: string; files?: string[] }) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(j<{ task: Task }>),
  updateTask: (workspaceId: string, taskId: string, patch: Partial<Pick<Task, 'title' | 'description' | 'status' | 'ownerId' | 'files'>> & { overrideDoneGate?: boolean; overrideReason?: string }) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(j<{ task: Task }>),
  deleteTask: (workspaceId: string, taskId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  claimTaskFiles: (workspaceId: string, taskId: string, files: string[]) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}/claim`, {
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
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}/review`, { method: 'POST' })
      .then(j<{ agent: Agent; task: Task }>),
  buildTask: (workspaceId: string, taskId: string) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}/build`, { method: 'POST' })
      .then(j<{ agent: Agent; task: Task }>),
  listTaskEvidence: (workspaceId: string, taskId: string, opts: { kind?: EvidenceKind } = {}) => {
    const qs = new URLSearchParams()
    if (opts.kind) qs.set('kind', opts.kind)
    const suffix = qs.toString() ? `?${qs}` : ''
    return ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}/evidence${suffix}`)
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
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/tasks/${taskId}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(j<{ row: EvidenceRow; duplicate: boolean }>),
  renameAgent: (id: string, name: string) =>
    ptyFetch(`${PTY_BASE}/agents/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(j<{ agent: Agent }>),
  killAgent: (id: string) =>
    ptyFetch(`${PTY_BASE}/agents/${id}`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  sendInput: (id: string, text: string) =>
    ptyFetch(`${PTY_BASE}/agents/${id}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).then(j<{ ok: boolean }>),
  scrollback: (id: string, lines: number = 200) =>
    ptyFetch(`${PTY_BASE}/agents/${id}/scrollback?lines=${lines}`).then(
      j<{ id: string; name: string; kind: string; lineCount: number; output: string }>,
    ),
  // ---- headless preview capture/verify (#256/#258) ----
  captureCrop: (input: { url: string; selector: string; annotationId: string }) =>
    ptyFetch(`${PTY_BASE}/preview/crop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(j<{ path: string; slug: string }>),
  verifyHeadless: (url: string, checks: { id: string; selector: string }[]) =>
    ptyFetch(`${PTY_BASE}/preview/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, checks }),
    }).then(j<{ results: { id: string; matches: number }[] }>),
  broadcast: (workspaceId: string, text: string, kind?: AgentKind) =>
    ptyFetch(`${PTY_BASE}/workspaces/${workspaceId}/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, kind }),
    }).then(j<{ count: number; ids: string[] }>),
}

export function agentWsUrl(agentId: string): string {
  return `${PTY_BASE.replace(/^http/, 'ws')}/ws/${agentId}`
}
