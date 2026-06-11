import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { recommendLaneName, recommendMissionLane } from '../lib/lane-advisor'

describe('lane advisor', () => {
  it('routes multi-file implementation with tests to Codex Forge builder', () => {
    const rec = recommendMissionLane({
      title: 'Implement mission packet builder',
      description: 'Patch source and add focused tests',
      files: ['lib/mission-packet.ts', 'lib/lane-advisor.ts', 'tests/mission-packet.test.ts'],
      needsImplementation: true,
      needsTests: true,
    })

    assert.equal(rec.kind, 'codex')
    assert.equal(rec.ownerRole, 'builder')
    assert.equal(rec.confidence, 'high')
    assert.match(rec.reason, /multi-file implementation|test work/)
  })

  it('routes UI review and screenshots to Claude Shield reviewer', () => {
    const rec = recommendMissionLane({
      title: 'UI QA review',
      description: 'Review layout, visual hierarchy, screenshots, and regression risk',
      files: ['components/Workbench.tsx', 'components/PaneGrid.tsx'],
      needsReview: true,
      needsUi: true,
    })

    assert.equal(rec.kind, 'claude')
    assert.equal(rec.ownerRole, 'reviewer')
    assert.equal(rec.confidence, 'high')
    assert.match(rec.reason, /UI review/)
  })

  it('routes read-only architecture work to Claude Scout', () => {
    const rec = recommendMissionLane({
      title: 'Read-only architecture contract',
      description: 'Inspect source and produce a spec without edits',
      readOnly: true,
      files: ['lib/dispatch-runs.ts', 'lib/types.ts'],
    })

    assert.equal(rec.kind, 'claude')
    assert.equal(rec.ownerRole, 'scout')
    assert.match(rec.reason, /read-only architecture/)
  })

  it('routes shell and log work to shell scout', () => {
    const rec = recommendMissionLane({
      title: 'Inspect terminal logs',
      description: 'Run rg over logs and summarize command failures',
      needsShell: true,
    })

    assert.equal(rec.kind, 'shell')
    assert.equal(rec.ownerRole, 'scout')
    assert.equal(rec.confidence, 'high')
  })

  it('routes docs lookup to gemini scout', () => {
    const rec = recommendMissionLane({
      title: 'Latest API docs lookup',
      description: 'Research OpenAI docs and summarize current API constraints',
      needsDocsLookup: true,
    })

    assert.equal(rec.kind, 'gemini')
    assert.equal(rec.ownerRole, 'scout')
    assert.match(rec.reason, /documentation/)
  })

  it('allows Metis Brain override while preserving audit reason', () => {
    const rec = recommendMissionLane({
      title: 'Patch source',
      files: ['lib/foo.ts'],
      preferredKind: 'claude',
      preferredRole: 'reviewer',
    })

    assert.equal(rec.kind, 'claude')
    assert.equal(rec.ownerRole, 'reviewer')
    assert.match(rec.reason, /user override applied/)
  })

  it('generates compact lane names from recommendation role and kind', () => {
    assert.equal(
      recommendLaneName({ title: 'Review UI', description: 'visual QA', needsReview: true, needsUi: true }),
      'Reviewer claude',
    )
  })
})
