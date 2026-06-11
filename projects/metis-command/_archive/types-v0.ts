export type TaskStatus = 'inbox' | 'ready' | 'running' | 'review' | 'done' | 'blocked'
export type AgentTarget = 'claude-desktop' | 'codex-desktop' | 'jarvis-openclaw' | 'terminal'
export type LaneStatus = 'idle' | 'queued' | 'running' | 'blocked' | 'review-ready' | 'done'
export type VoiceState = 'Idle' | 'Listening' | 'Transcribing' | 'Targeting Claude' | 'Targeting Codex' | 'Dispatching' | 'Thinking' | 'Review Ready'

export interface EvidenceItem {
  id: string
  kind: 'diff' | 'test' | 'screenshot' | 'log' | 'qa' | 'artifact'
  label: string
  value: string
  status: 'missing' | 'linked' | 'passed' | 'failed'
}

export interface WorkbenchTask {
  id: string
  title: string
  status: TaskStatus
  priority: 'critical' | 'high' | 'medium' | 'low'
  project: string
  summary: string
  instructions: string[]
  knowledge: string[]
  artifacts: EvidenceItem[]
  updatedAt: string
}

export interface AgentLane {
  id: AgentTarget
  label: string
  role: string
  model: string
  status: LaneStatus
  currentTaskId?: string
  prompt?: string
  lastEvent: string
  color: 'violet' | 'cyan' | 'amber' | 'emerald'
}

export interface DispatchEvent {
  id: string
  taskId: string
  target: AgentTarget
  timestampCt: string
  promptPreview: string
  promptHash: string
  status: 'prepared' | 'sent' | 'blocked' | 'acknowledged'
  approvalRequired: boolean
}

export interface WorkbenchState {
  voice: {
    state: VoiceState
    transcriptPreview: string
    target?: AgentTarget
  }
  tasks: WorkbenchTask[]
  lanes: AgentLane[]
  dispatches: DispatchEvent[]
}
