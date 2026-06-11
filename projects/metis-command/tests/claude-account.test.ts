import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { claudeAccountEnv, navoreLinked, accountForWorkspace } from '../lib/claude-account'

const HOME = '$HOME'

describe('claude-account', () => {
  it('default account / non-claude kinds get no env overrides', () => {
    assert.deepEqual(claudeAccountEnv('default', 'claude', { home: HOME }), {})
    assert.deepEqual(claudeAccountEnv('navore', 'codex', { home: HOME }), {})
    assert.deepEqual(claudeAccountEnv(undefined, 'claude', { home: HOME }), {})
    assert.deepEqual(claudeAccountEnv('navore', 'shell', { home: HOME }), {})
  })

  it('navore claude gets a config dir (default location) and no token when unset', () => {
    const env = claudeAccountEnv('navore', 'claude', { home: HOME })
    assert.equal(env.CLAUDE_CONFIG_DIR, '$HOME/.claude-navore')
    assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false)
  })

  it('navore claude injects the long-lived token when present', () => {
    const env = claudeAccountEnv('navore', 'claude', { home: HOME, navoreOAuthToken: 'sk-ant-oat-xyz' })
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-xyz')
    assert.equal(env.CLAUDE_CONFIG_DIR, '$HOME/.claude-navore')
  })

  it('honors a config-dir override', () => {
    const env = claudeAccountEnv('navore', 'claude', { home: HOME, navoreConfigDir: '/opt/navore-claude' })
    assert.equal(env.CLAUDE_CONFIG_DIR, '/opt/navore-claude')
  })

  it('navoreLinked is true only when a non-empty token is present', () => {
    assert.equal(navoreLinked({ home: HOME }), false)
    assert.equal(navoreLinked({ home: HOME, navoreOAuthToken: '   ' }), false)
    assert.equal(navoreLinked({ home: HOME, navoreOAuthToken: 'tok' }), true)
  })

  it('routes professional → navore, personal → default', () => {
    assert.equal(accountForWorkspace('professional'), 'navore')
    assert.equal(accountForWorkspace('personal'), 'default')
  })
})
