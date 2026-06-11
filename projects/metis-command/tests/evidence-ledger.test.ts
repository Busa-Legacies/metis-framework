import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  EVIDENCE_KINDS,
  appendEvidence,
  evidenceCounts,
  getEvidence,
  hasRequiredEvidenceForDone,
  listEvidence,
} from '../lib/evidence-ledger'

function withTempLedger<T>(fn: (dir: string) => T): T {
  const prev = process.env.AW_EVIDENCE_LEDGER_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-evidence-'))
  process.env.AW_EVIDENCE_LEDGER_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (prev === undefined) delete process.env.AW_EVIDENCE_LEDGER_DIR
    else process.env.AW_EVIDENCE_LEDGER_DIR = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('evidence ledger', () => {
  it('persists rows under data/evidence-ledger/<workspaceId>.json with atomic write', () => {
    withTempLedger((dir) => {
      const { row, duplicate } = appendEvidence({
        workspaceId: 'ws_alpha',
        kind: 'report',
        summary: 'Forge wave A2 build report',
        payload: { path: 'WORKBENCH_X.md' },
        missionId: 'mission_1',
        laneId: 'lane_forge',
      })
      assert.equal(duplicate, false)
      assert.equal(row.workspaceId, 'ws_alpha')
      assert.equal(row.kind, 'report')
      assert.match(row.id, /^ev_[a-f0-9]{16}$/)

      const file = path.join(dir, 'ws_alpha.json')
      assert.equal(fs.existsSync(file), true)
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
      assert.equal(persisted.rows.length, 1)
      assert.equal(persisted.rows[0].summary, 'Forge wave A2 build report')

      const noTmpLeft = fs
        .readdirSync(dir)
        .filter((n) => n.includes('.tmp'))
      assert.deepEqual(noTmpLeft, [])
    })
  })

  it('survives a re-read (restart simulation)', () => {
    withTempLedger(() => {
      appendEvidence({
        workspaceId: 'ws_beta',
        kind: 'review',
        summary: 'Shield: pass',
        taskId: 'task_42',
      })
      appendEvidence({
        workspaceId: 'ws_beta',
        kind: 'test',
        summary: 'npm test exit=0',
        taskId: 'task_42',
        payload: { exitCode: 0 },
      })

      const rows = listEvidence('ws_beta')
      assert.equal(rows.length, 2)
      const fetched = getEvidence('ws_beta', rows[0].id)
      assert.ok(fetched)
      assert.equal(fetched?.workspaceId, 'ws_beta')
    })
  })

  it('treats appendEvidence as idempotent on supplied id', () => {
    withTempLedger(() => {
      const a = appendEvidence({
        workspaceId: 'ws_g',
        kind: 'manual_override',
        summary: 'Ant: ship without Shield',
        id: 'ev_fixed_1',
      })
      const b = appendEvidence({
        workspaceId: 'ws_g',
        kind: 'manual_override',
        summary: 'Ant: ship without Shield',
        id: 'ev_fixed_1',
      })
      assert.equal(a.duplicate, false)
      assert.equal(b.duplicate, true)
      assert.equal(b.row.id, 'ev_fixed_1')
      assert.equal(listEvidence('ws_g').length, 1)
    })
  })

  it('rejects an invalid evidence kind', () => {
    withTempLedger(() => {
      assert.throws(
        () =>
          appendEvidence({
            workspaceId: 'ws_x',
            kind: 'bogus' as unknown as (typeof EVIDENCE_KINDS)[number],
            summary: 'nope',
          }),
        /evidence_invalid_kind/,
      )
    })
  })

  it('rejects empty summary and missing workspaceId', () => {
    withTempLedger(() => {
      assert.throws(
        () =>
          appendEvidence({
            workspaceId: 'ws_x',
            kind: 'report',
            summary: '   ',
          }),
        /evidence_invalid/,
      )
      assert.throws(
        () =>
          appendEvidence({
            workspaceId: '',
            kind: 'report',
            summary: 'x',
          }),
        /evidence_invalid/,
      )
    })
  })

  it('filters by mission, lane, task, agent, and kind', () => {
    withTempLedger(() => {
      appendEvidence({ workspaceId: 'ws_f', kind: 'report', summary: 'r1', missionId: 'm1', laneId: 'l1', taskId: 't1', agentId: 'a1' })
      appendEvidence({ workspaceId: 'ws_f', kind: 'review', summary: 'rv1', missionId: 'm1', laneId: 'l1', taskId: 't1', agentId: 'a1' })
      appendEvidence({ workspaceId: 'ws_f', kind: 'test', summary: 'tx', missionId: 'm1', laneId: 'l2', taskId: 't2', agentId: 'a2' })

      assert.equal(listEvidence('ws_f', { missionId: 'm1' }).length, 3)
      assert.equal(listEvidence('ws_f', { laneId: 'l1' }).length, 2)
      assert.equal(listEvidence('ws_f', { taskId: 't2' }).length, 1)
      assert.equal(listEvidence('ws_f', { agentId: 'a1', kind: 'review' }).length, 1)
    })
  })

  it('counts evidence by kind for a filter scope', () => {
    withTempLedger(() => {
      appendEvidence({ workspaceId: 'ws_c', kind: 'report', summary: 'r' , taskId: 't' })
      appendEvidence({ workspaceId: 'ws_c', kind: 'review', summary: 'rv', taskId: 't' })
      appendEvidence({ workspaceId: 'ws_c', kind: 'test', summary: 'tx', taskId: 't' })
      const counts = evidenceCounts('ws_c', { taskId: 't' })
      assert.equal(counts.total, 3)
      assert.equal(counts.byKind.report, 1)
      assert.equal(counts.byKind.review, 1)
      assert.equal(counts.byKind.test, 1)
      assert.equal(counts.byKind.diff, 0)
    })
  })

  it('hasRequiredEvidenceForDone enforces report + (review|manual_override)', () => {
    withTempLedger(() => {
      appendEvidence({ workspaceId: 'ws_d', kind: 'report', summary: 'rep', taskId: 'tA' })
      assert.equal(hasRequiredEvidenceForDone('ws_d', 'tA'), false)
      appendEvidence({ workspaceId: 'ws_d', kind: 'review', summary: 'ok', taskId: 'tA' })
      assert.equal(hasRequiredEvidenceForDone('ws_d', 'tA'), true)

      appendEvidence({ workspaceId: 'ws_d', kind: 'report', summary: 'rep', taskId: 'tB' })
      assert.equal(hasRequiredEvidenceForDone('ws_d', 'tB'), false)
      appendEvidence({ workspaceId: 'ws_d', kind: 'manual_override', summary: 'nick said so', taskId: 'tB' })
      assert.equal(hasRequiredEvidenceForDone('ws_d', 'tB'), true)

      appendEvidence({ workspaceId: 'ws_d', kind: 'review', summary: 'ok', taskId: 'tC' })
      assert.equal(hasRequiredEvidenceForDone('ws_d', 'tC'), false)
    })
  })

  it('sanitizes unsafe characters in workspaceId for filenames', () => {
    withTempLedger((dir) => {
      appendEvidence({
        workspaceId: '../weird/ws id',
        kind: 'report',
        summary: 'safe path test',
      })
      const files = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
      assert.equal(files.length, 1)
      assert.match(files[0], /^[a-zA-Z0-9_.-]+\.json$/)
    })
  })
})
