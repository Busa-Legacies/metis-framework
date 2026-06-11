import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentTarget, DispatchEvent, TaskStatus, WorkbenchState } from './types'

const DATA_DIR = path.join(process.cwd(), 'data')
const STATE_FILE = path.join(DATA_DIR, 'workbench-state.json')

function nowCt() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date()).replace(',', '') + ' CT'
}

const defaultState: WorkbenchState = {
  voice: {
    state: 'Idle',
    transcriptPreview: 'Ready for push-to-talk command dispatch.',
  },
  tasks: [
    {
      id: 'aw-001',
      title: 'Build BridgeMind-style workroom shell',
      status: 'running',
      priority: 'critical',
      project: 'agent-workbench',
      summary: 'Create the task-centered command room with visible Claude/Codex/Jarvis lanes and review gate.',
      instructions: [
        'Keep the human in the loop: no hidden work or fake completion.',
        'Render only active room UI; persistent sessions belong in a session host.',
        'Use dark, high-contrast, OBS-friendly layout.',
      ],
      knowledge: [
        'BridgeMind pattern: task → workspace → agents → review.',
        'Claude Desktop owns UI/UX polish; Codex Desktop owns backend/session host.',
        'Done must require evidence artifacts or QA checks.',
      ],
      artifacts: [
        { id: 'ev-001', kind: 'artifact', label: 'Product brief', value: 'docs/agent-workbench-bridgemind-reference-20260430.md', status: 'linked' },
        { id: 'ev-002', kind: 'test', label: 'Build verification', value: 'npm run build', status: 'missing' },
        { id: 'ev-003', kind: 'qa', label: 'Shield review', value: 'pending', status: 'missing' },
      ],
      updatedAt: nowCt(),
    },
    {
      id: 'aw-002',
      title: 'Implement prompt dispatch ledger',
      status: 'ready',
      priority: 'high',
      project: 'agent-workbench',
      summary: 'Persist target, timestamp, prompt preview/hash, status, and approval requirements for every dispatch.',
      instructions: ['Never blind-send external messages.', 'Keep dispatch observable and auditable.', 'Hash full prompt; show preview only.'],
      knowledge: ['Codex Desktop lane should harden API/persistence/tests.', 'External writes require approval gates.'],
      artifacts: [
        { id: 'ev-004', kind: 'artifact', label: 'Codex handoff', value: 'docs/CODEX_DESKTOP_AGENT_WORKBENCH_HANDOFF_20260430.md', status: 'linked' },
      ],
      updatedAt: nowCt(),
    },
    {
      id: 'aw-003',
      title: 'Wire voice HUD targeting states',
      status: 'review',
      priority: 'high',
      project: 'jarvis-voice-hud',
      summary: 'Expose HUD states for Targeting Claude, Targeting Codex, Dispatching, Thinking, and Review Ready.',
      instructions: ['Reuse existing voice/HUD concepts.', 'Keep overlay small and stream-capturable.', 'Show final command target before dispatch.'],
      knowledge: ['Existing voice HUD supports Idle, Listening, Transcribing, Thinking, Speaking.'],
      artifacts: [
        { id: 'ev-005', kind: 'artifact', label: 'Voice HUD README', value: 'voice/README.md', status: 'linked' },
        { id: 'ev-006', kind: 'screenshot', label: 'HUD visual QA', value: 'pending', status: 'missing' },
      ],
      updatedAt: nowCt(),
    },
    {
      id: 'aw-004',
      title: 'Prevent Done without evidence',
      status: 'blocked',
      priority: 'critical',
      project: 'agent-workbench',
      summary: 'Enforce review gate so tasks cannot move to Done unless artifacts/tests/QA evidence are linked.',
      instructions: ['Block hallucinated progress.', 'Expose missing evidence in the room UI.', 'Codex should add tests around this rule.'],
      knowledge: ['Jarvis operating law: no false completion.'],
      artifacts: [
        { id: 'ev-007', kind: 'test', label: 'Done-gate unit test', value: 'pending', status: 'missing' },
      ],
      updatedAt: nowCt(),
    },
  ],
  lanes: [
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      role: 'Frontend / UX / visual hierarchy',
      model: 'Claude Desktop',
      status: 'running',
      currentTaskId: 'aw-001',
      prompt: 'Polish the workroom shell, task board, agent lanes, voice HUD strip, and review gate.',
      lastEvent: 'Ready to receive UI/UX handoff.',
      color: 'violet',
    },
    {
      id: 'codex-desktop',
      label: 'Codex Desktop',
      role: 'Backend / APIs / persistence / tests',
      model: 'gpt-5.5',
      status: 'queued',
      currentTaskId: 'aw-002',
      prompt: 'Build dispatch ledger, session-host abstractions, and done-gate tests.',
      lastEvent: 'Backend substrate scoped.',
      color: 'cyan',
    },
    {
      id: 'jarvis-openclaw',
      label: 'Jarvis / OpenClaw',
      role: 'Strategy / orchestration / final approval',
      model: 'gpt-5.5',
      status: 'running',
      currentTaskId: 'aw-001',
      lastEvent: 'Creating dedicated app repo and baseline.',
      color: 'amber',
    },
    {
      id: 'terminal',
      label: 'Terminal / Logs',
      role: 'Build, test, sync, runtime logs',
      model: 'local shell',
      status: 'idle',
      lastEvent: 'No active long-running command.',
      color: 'emerald',
    },
  ],
  dispatches: [
    {
      id: 'de-001',
      taskId: 'aw-001',
      target: 'claude-desktop',
      timestampCt: nowCt(),
      promptPreview: 'Build the frontend/UX of our agent workbench. This should feel like a Jarvis command room...',
      promptHash: createHash('sha256').update('claude agent workbench handoff').digest('hex').slice(0, 16),
      status: 'prepared',
      approvalRequired: false,
    },
  ],
}

export async function getState(): Promise<WorkbenchState> {
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    return JSON.parse(raw) as WorkbenchState
  } catch {
    await saveState(defaultState)
    return defaultState
  }
}

export async function saveState(state: WorkbenchState) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
}

export async function updateTaskStatus(taskId: string, status: TaskStatus) {
  const state = await getState()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  if (status === 'done') {
    const hasEvidence = task.artifacts.some((item) => item.status === 'linked' || item.status === 'passed')
    const hasMissingGate = task.artifacts.some((item) => item.kind === 'test' || item.kind === 'qa') && task.artifacts.some((item) => item.status === 'missing' || item.status === 'failed')
    if (!hasEvidence || hasMissingGate) {
      throw new Error('Review gate blocked: Done requires linked artifacts plus passing test/QA evidence.')
    }
  }
  task.status = status
  task.updatedAt = nowCt()
  await saveState(state)
  return task
}

export async function createDispatch(taskId: string, target: AgentTarget, prompt: string): Promise<DispatchEvent> {
  const state = await getState()
  if (!state.tasks.some((task) => task.id === taskId)) throw new Error(`Task not found: ${taskId}`)
  const event: DispatchEvent = {
    id: randomUUID(),
    taskId,
    target,
    timestampCt: nowCt(),
    promptPreview: prompt.length > 180 ? `${prompt.slice(0, 180)}…` : prompt,
    promptHash: createHash('sha256').update(prompt).digest('hex').slice(0, 16),
    status: 'prepared',
    approvalRequired: target === 'terminal',
  }
  state.dispatches.unshift(event)
  state.voice = {
    state: target === 'claude-desktop' ? 'Targeting Claude' : target === 'codex-desktop' ? 'Targeting Codex' : 'Dispatching',
    transcriptPreview: event.promptPreview,
    target,
  }
  await saveState(state)
  return event
}
