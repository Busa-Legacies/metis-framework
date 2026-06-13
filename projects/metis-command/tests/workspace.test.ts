import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_WORKSPACE,
  WORKSPACES,
  normalizeWorkspace,
  otherWorkspace,
  workspaceMeta,
  isProfessional,
} from '../lib/workspace'

describe('workspace model', () => {
  it('defaults to personal', () => {
    assert.equal(DEFAULT_WORKSPACE, 'personal')
  })

  it('normalizes unknown/empty values to personal, only "professional" flips', () => {
    assert.equal(normalizeWorkspace(null), 'personal')
    assert.equal(normalizeWorkspace(undefined), 'personal')
    assert.equal(normalizeWorkspace(''), 'personal')
    assert.equal(normalizeWorkspace('garbage'), 'personal')
    assert.equal(normalizeWorkspace('professional'), 'professional')
  })

  it('toggles to the other context', () => {
    assert.equal(otherWorkspace('personal'), 'professional')
    assert.equal(otherWorkspace('professional'), 'personal')
  })

  it('exposes Example branding + amber accent for the professional context', () => {
    const pro = workspaceMeta('professional')
    assert.equal(pro.label, 'Example')
    assert.equal(pro.accent, 'amber')
    assert.equal(workspaceMeta('personal').accent, 'cyan')
  })

  it('isProfessional matches the professional id only', () => {
    assert.equal(isProfessional('professional'), true)
    assert.equal(isProfessional('personal'), false)
  })

  it('has exactly the two known workspaces', () => {
    assert.deepEqual(Object.keys(WORKSPACES).sort(), ['personal', 'professional'])
  })
})
