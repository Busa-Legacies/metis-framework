import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentStatusLabel, workspaceActivityCounts, workspaceTaskCounts } from '../lib/workspace-activity'
import type { Agent, Task } from '../lib/types'

function agent(id: string, workspaceId: string, status: Agent['status'], exitCode?: number): Agent {
  return {
    id,
    name: id,
    kind: 'codex',
    workspaceId,
    cwd: '/tmp',
    cmd: 'codex',
    args: [],
    status,
    createdAt: '2026-05-10T00:00:00.000Z',
    ...(exitCode === undefined ? {} : { exitCode }),
  }
}

function task(id: string, workspaceId: string, status: Task['status']): Task {
  return {
    id,
    workspaceId,
    title: id,
    status,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  }
}

describe('workspace activity visibility helpers', () => {
  it('counts active and exited agents per workspace without leaking other workspaces', () => {
    const agents = [
      agent('a', 'ws1', 'running'),
      agent('b', 'ws1', 'starting'),
      agent('c', 'ws1', 'exited', 0),
      agent('d', 'ws2', 'running'),
      agent('e', 'ws2', 'exited', 1),
    ]

    assert.deepEqual(workspaceActivityCounts(agents, 'ws1'), { active: 2, exited: 1, total: 3 })
    assert.deepEqual(workspaceActivityCounts(agents, 'ws2'), { active: 1, exited: 1, total: 2 })
    assert.deepEqual(workspaceActivityCounts(agents, 'missing'), { active: 0, exited: 0, total: 0 })
  })

  it('counts task status buckets per workspace', () => {
    const tasks = [
      task('a', 'ws1', 'todo'),
      task('b', 'ws1', 'building'),
      task('c', 'ws1', 'review'),
      task('d', 'ws1', 'done'),
      task('e', 'ws2', 'building'),
      task('f', 'ws2', 'done'),
    ]

    assert.deepEqual(workspaceTaskCounts(tasks, 'ws1'), {
      todo: 1,
      building: 1,
      review: 1,
      done: 1,
      active: 3,
      total: 4,
    })
    assert.deepEqual(workspaceTaskCounts(tasks, 'ws2'), {
      todo: 0,
      building: 1,
      review: 0,
      done: 1,
      active: 1,
      total: 2,
    })
    assert.deepEqual(workspaceTaskCounts(tasks, 'missing'), {
      todo: 0,
      building: 0,
      review: 0,
      done: 0,
      active: 0,
      total: 0,
    })
  })

  it('uses explicit user-facing agent status labels', () => {
    assert.equal(agentStatusLabel(agent('starting', 'ws1', 'starting')), 'starting')
    assert.equal(agentStatusLabel(agent('running', 'ws1', 'running')), 'active')
    assert.equal(agentStatusLabel(agent('done', 'ws1', 'exited', 0)), 'exited 0')
    assert.equal(agentStatusLabel(agent('unknown', 'ws1', 'exited')), 'exited ?')
  })
})
