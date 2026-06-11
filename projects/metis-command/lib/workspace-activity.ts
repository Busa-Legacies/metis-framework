import type { Agent, Task, TaskStatus } from './types'

export interface WorkspaceActivityCounts {
  active: number
  exited: number
  total: number
}

export type WorkspaceTaskCounts = Record<TaskStatus, number> & {
  active: number
  total: number
}

export function workspaceActivityCounts(agents: Agent[], workspaceId: string): WorkspaceActivityCounts {
  const workspaceAgents = agents.filter((agent) => agent.workspaceId === workspaceId)
  return {
    active: workspaceAgents.filter((agent) => agent.status === 'running' || agent.status === 'starting').length,
    exited: workspaceAgents.filter((agent) => agent.status === 'exited').length,
    total: workspaceAgents.length,
  }
}

export function workspaceTaskCounts(tasks: Task[], workspaceId: string): WorkspaceTaskCounts {
  const counts: WorkspaceTaskCounts = {
    todo: 0,
    building: 0,
    review: 0,
    done: 0,
    active: 0,
    total: 0,
  }
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId) continue
    counts[task.status] += 1
    counts.total += 1
    if (task.status !== 'done') counts.active += 1
  }
  return counts
}

export function agentStatusLabel(agent: Pick<Agent, 'status' | 'exitCode'>): string {
  if (agent.status === 'starting') return 'starting'
  if (agent.status === 'running') return 'active'
  return `exited ${agent.exitCode ?? '?'}`
}
