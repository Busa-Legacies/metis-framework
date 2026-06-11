import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ackSwarmMailboxRows,
  appendSwarmMailboxRow,
  listSwarmMailboxRows,
  type SwarmMailboxRow,
} from '../lib/swarm-mailbox'

const scope = {
  workspaceId: 'ws1',
  missionId: 'mission-a',
  laneId: 'lane-builder',
  agentId: 'agent-1',
}

function append(rows: SwarmMailboxRow[], body: string, id: string, extra = {}) {
  return appendSwarmMailboxRow(rows, { ...scope, body, ...extra }, {
    id: () => id,
    now: () => `2026-05-11T10:00:0${id.slice(-1)}.000Z`,
  })
}

describe('swarm mailbox helpers', () => {
  it('appends bounded mailbox rows with mission/lane/agent keys', () => {
    const rows = appendSwarmMailboxRow([], {
      ...scope,
      kind: 'handoff',
      title: 'Implementation handoff',
      body: 'done',
    }, {
      id: () => 'mail_1',
      now: () => '2026-05-11T10:00:00.000Z',
      guardrails: { bodyChars: 3, titleChars: 6 },
    })

    assert.deepEqual(rows, [{
      ...scope,
      id: 'mail_1',
      kind: 'handoff',
      title: 'Implem',
      body: 'don',
      createdAt: '2026-05-11T10:00:00.000Z',
    }])
  })

  it('lists by workspace, mission, lane, agent, ack state, and limit', () => {
    let rows: SwarmMailboxRow[] = []
    rows = append(rows, 'first', 'mail_1')
    rows = append(rows, 'second', 'mail_2', { agentId: 'agent-2' })
    rows = append(rows, 'third', 'mail_3', { laneId: 'lane-reviewer' })

    assert.deepEqual(listSwarmMailboxRows(rows, { workspaceId: 'ws1', laneId: 'lane-builder' }).map((row) => row.id), ['mail_1', 'mail_2'])
    assert.deepEqual(listSwarmMailboxRows(rows, { agentId: 'agent-2' }).map((row) => row.body), ['second'])
    assert.deepEqual(listSwarmMailboxRows(rows, { workspaceId: 'ws1', limit: 2 }).map((row) => row.id), ['mail_2', 'mail_3'])
  })

  it('acks matching unacked rows without mutating existing rows', () => {
    let rows: SwarmMailboxRow[] = []
    rows = append(rows, 'first', 'mail_1')
    rows = append(rows, 'second', 'mail_2')

    const result = ackSwarmMailboxRows(rows, {
      workspaceId: 'ws1',
      missionId: 'mission-a',
      laneId: 'lane-builder',
      ackedBy: 'coordinator',
      now: '2026-05-11T11:00:00.000Z',
    })

    assert.deepEqual(result.ackedIds, ['mail_1', 'mail_2'])
    assert.equal(rows[0].ackedAt, undefined)
    assert.equal(result.rows[0].ackedBy, 'coordinator')
    assert.deepEqual(listSwarmMailboxRows(result.rows, { acked: false }), [])
  })

  it('enforces required keys and bounded row count', () => {
    assert.throws(() => appendSwarmMailboxRow([], { ...scope, workspaceId: '', body: 'x' }), /workspaceId/)
    assert.throws(() => appendSwarmMailboxRow([], { ...scope, body: '   ' }), /body/)

    let rows: SwarmMailboxRow[] = []
    rows = appendSwarmMailboxRow(rows, { ...scope, body: 'one' }, { id: () => 'mail_1', guardrails: { maxRows: 2 } })
    rows = appendSwarmMailboxRow(rows, { ...scope, body: 'two' }, { id: () => 'mail_2', guardrails: { maxRows: 2 } })
    rows = appendSwarmMailboxRow(rows, { ...scope, body: 'three' }, { id: () => 'mail_3', guardrails: { maxRows: 2 } })

    assert.deepEqual(rows.map((row) => row.id), ['mail_2', 'mail_3'])
  })
})

