import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assignAgent, buildPresetLayout, leaves, placeAgent } from '../lib/layout'

describe('workbench agent pane placement', () => {
  it('does not duplicate an agent that is already visible', () => {
    const base = buildPresetLayout(2)
    const [first] = leaves(base)
    const seeded = assignAgent(base, first.id, 'agent_a')

    const placed = placeAgent(seeded, 'agent_a')
    const placedLeaves = leaves(placed)

    assert.deepEqual(
      placedLeaves.map((leaf) => leaf.agentId),
      ['agent_a', null],
    )
    assert.equal(placedLeaves.find((leaf) => leaf.agentId === 'agent_a')?.id, first.id)
  })

  it('fills an empty leaf before replacing an occupied pane', () => {
    const base = buildPresetLayout(2)
    const [first, second] = leaves(base)
    const seeded = assignAgent(base, first.id, 'agent_a')

    const placed = placeAgent(seeded, 'agent_b', first.id)
    const placedLeaves = leaves(placed)

    assert.equal(placedLeaves.find((leaf) => leaf.id === first.id)?.agentId, 'agent_a')
    assert.equal(placedLeaves.find((leaf) => leaf.id === second.id)?.agentId, 'agent_b')
  })
})
