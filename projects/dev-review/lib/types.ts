export type AgentKind = 'claude' | 'codex' | 'shell' | 'gemini' | 'python' | 'custom'
export type AgentStatus = 'starting' | 'running' | 'exited'
export type AgentRole = 'builder' | 'reviewer' | 'scout' | 'coordinator'

export interface Workspace {
  id: string
  name: string
  cwd: string
  createdAt: string
}

export interface Agent {
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
  lastOutputAt?: string
  outputBytes?: number
  role?: AgentRole
  taskId?: string
  lastOutput?: string
}

export type TaskStatus = 'todo' | 'building' | 'review' | 'done'

export type EvidenceKind =
  | 'report'
  | 'test'
  | 'diff'
  | 'review'
  | 'manual_override'
  | 'commit_approval'
  | 'push_approval'

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

export interface Task {
  id: string
  workspaceId: string
  title: string
  description?: string
  status: TaskStatus
  ownerId?: string
  files?: string[]
  createdAt: string
  updatedAt: string
}

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface Attachment {
  type: 'image'
  dataUrl: string // data:image/...;base64,...
  name: string
  size: number
}

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  attachments?: Attachment[]
  toolCalls?: { id: string; name: string; arguments: string; result?: string }[]
  createdAt: string
}

// ---------- pane layout tree ----------

export type SplitDir = 'horizontal' | 'vertical'

export type LayoutNode =
  | { kind: 'leaf'; id: string; agentId: string | null; url?: string | null; title?: string | null }
  | { kind: 'split'; id: string; dir: SplitDir; sizes: number[]; children: LayoutNode[] }

/** A workspace's persisted multi-pane layout + the metadata to resume agents on next open. */
export interface WorkspaceLayout {
  root: LayoutNode
  // last known agent specs in this workspace, for "resume" after the app closes.
  resumeSpecs: Array<{
    paneId: string
    kind: AgentKind
    name: string
    cwd: string
    cmd?: string
    args?: string[]
  }>
}
