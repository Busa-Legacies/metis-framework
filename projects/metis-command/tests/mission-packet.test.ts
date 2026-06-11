import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildMissionPacket,
  deriveMissionId,
  deriveMissionLaneId,
  missionPacketToStableJson,
  normalizeJsonSafe,
  normalizeMissionPacket,
  validateMissionPacket,
} from '../lib/mission-packet'

describe('mission packet contract', () => {
  it('derives stable mission and lane ids independent of object key order', () => {
    const a = deriveMissionId({
      workspaceId: 'ws1',
      title: 'BridgeMind lane contract',
      goal: 'Create durable mission packet helpers',
      lanes: [{
        title: 'Forge implementation',
        kind: 'codex',
        ownerRole: 'builder',
        scope: 'Implement lib helpers and tests',
        expectedEvidencePath: 'WORKBENCH_MISSION_LANE_CONTRACT_20260511.md',
      }],
      metadata: { b: 2, a: 1 },
    })
    const b = deriveMissionId({
      metadata: { a: 1, b: 2 },
      lanes: [{
        expectedEvidencePath: 'WORKBENCH_MISSION_LANE_CONTRACT_20260511.md',
        scope: 'Implement lib helpers and tests',
        ownerRole: 'builder',
        kind: 'codex',
        title: 'Forge implementation',
      }],
      goal: 'Create durable mission packet helpers',
      title: 'BridgeMind lane contract',
      workspaceId: 'ws1',
    })

    assert.equal(a, b)
    assert.match(a, /^mission_[a-f0-9]{16}$/)
    assert.equal(
      deriveMissionLaneId({ title: 'Forge implementation', kind: 'codex', ownerRole: 'builder', scope: 'Implement lib helpers and tests' }),
      deriveMissionLaneId({ scope: 'Implement lib helpers and tests', ownerRole: 'builder', kind: 'codex', title: 'Forge implementation' }),
    )
  })

  it('normalizes packets into JSON-safe deterministic payloads', () => {
    const circular: Record<string, unknown> = { keep: true }
    circular.self = circular
    const packet = normalizeMissionPacket({
      workspaceId: ' ws1 ',
      title: '  Mission   title ',
      goal: 'Ship a contract foundation',
      constraints: [' do not edit UI ', '', 'avoid runtime hooks'],
      expectedDeliverables: [' report '],
      acceptanceCriteria: [' tests pass '],
      lanes: [{
        title: ' Forge ',
        kind: 'codex',
        ownerRole: 'builder',
        scope: ' code + tests ',
        expectedEvidencePath: ' report.md ',
        stopConditions: [' blocked ', ''],
      }],
      metadata: {
        when: new Date('2026-05-11T12:00:00.000Z'),
        nope: undefined,
        nan: Number.NaN,
        circular,
      },
    })

    assert.equal(packet.title, 'Mission title')
    assert.deepEqual(packet.constraints, ['do not edit UI', 'avoid runtime hooks'])
    assert.equal(packet.lanes[0].title, 'Forge')
    assert.deepEqual(packet.lanes[0].stopConditions, ['blocked'])
    assert.deepEqual(packet.metadata, {
      circular: { keep: true, self: '[Circular]' },
      nan: null,
      when: '2026-05-11T12:00:00.000Z',
    })
    assert.doesNotThrow(() => JSON.parse(missionPacketToStableJson(packet)))
  })

  it('builds a valid packet with generated ids and default required review gate', () => {
    const packet = buildMissionPacket({
      workspaceId: 'ws_contract',
      title: 'Mission contract',
      goal: 'Create BridgeMind-style lane contract helpers',
      lanes: [{
        title: 'Forge implementation',
        kind: 'codex',
        ownerRole: 'builder',
        scope: 'Implement pure TypeScript modules and tests',
        expectedEvidencePath: 'WORKBENCH_MISSION_LANE_CONTRACT_20260511.md',
        selectedKind: 'codex',
        selectionReason: 'source patch work maps to Codex',
      }],
    })

    assert.match(packet.id, /^mission_[a-f0-9]{16}$/)
    assert.match(packet.lanes[0].id, /^lane_[a-f0-9]{16}$/)
    assert.equal(packet.reviewGate, 'required')
    assert.equal(validateMissionPacket(packet).ok, true)
  })

  it('requires every lane to have scope, owner role, and evidence path or rationale', () => {
    const packet = normalizeMissionPacket({
      id: 'mission_bad',
      workspaceId: 'ws1',
      title: 'Bad packet',
      goal: 'Show validation',
      lanes: [{
        id: 'lane_bad',
        title: 'Missing fields',
        kind: 'codex',
        ownerRole: '' as never,
        scope: '   ',
      }],
    })
    const result = validateMissionPacket(packet)

    assert.equal(result.ok, false)
    assert.match(result.issues.map((issue) => `${issue.path}:${issue.message}`).join('\n'), /lanes\[0\]\.ownerRole/)
    assert.match(result.issues.map((issue) => `${issue.path}:${issue.message}`).join('\n'), /lanes\[0\]\.scope/)
    assert.match(result.issues.map((issue) => `${issue.path}:${issue.message}`).join('\n'), /expected evidence path/)
  })

  it('accepts an explicit evidence rationale for read-only lanes', () => {
    const packet = buildMissionPacket({
      workspaceId: 'ws1',
      title: 'Read-only architecture scout',
      goal: 'Inspect source and report findings',
      lanes: [{
        title: 'Scout analysis',
        kind: 'claude',
        ownerRole: 'scout',
        scope: 'Read architecture docs and summarize risks',
        evidenceRationale: 'Read-only finding will be included in final mission report instead of a lane artifact',
      }],
    })

    assert.equal(packet.lanes[0].expectedEvidencePath, undefined)
    assert.match(packet.lanes[0].evidenceRationale ?? '', /final mission report/)
  })

  it('converts unsupported JSON values without throwing', () => {
    assert.deepEqual(normalizeJsonSafe({
      fn: () => 'skip',
      sym: Symbol('skip'),
      big: BigInt(12),
      inf: Infinity,
      nested: [undefined, () => null, 'x'],
    }), {
      big: '12',
      inf: null,
      nested: [null, null, 'x'],
    })
  })
})
