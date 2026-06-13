import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { claudeAccountEnv, navoreLinked, accountForWorkspace } from '../lib/claude-account'

const HOME = '$HOME'

describe('claude-account', () => {
  it('default account / non-claude kinds get no env overrides', () => {
    assert.deepEqual(claudeAccountEnv('default', 'claude', { home: HOME }), {})
    assert.deepEqual(claudeAccountEnv('example', 'codex', { home: HOME }), {})
    assert.deepEqual(claudeAccountEnv(undefined, 'claude', { home: HOME }), {})
    assert.deepEqual(claudeAccountEnv('example', 'shell', { home: HOME }), {})
  })

  it('example claude gets a config dir (default location) and no token when unset', () => {
    const env = claudeAccountEnv('example', 'claude', { home: HOME })
    assert.equal(env.CLAUDE_CONFIG_DIR, '$HOME/.claude-example')
    assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false)
  })

  it('example claude injects the long-lived token when present', () => {
    const env = claudeAccountEnv('example', 'claude', { home: HOME, navoreOAuthToken: 'sk-ant-oat-xyz' })
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-xyz')
    assert.equal(env.CLAUDE_CONFIG_DIR, '$HOME/.claude-example')
  })

  it('honors a config-dir override', () => {
    const env = claudeAccountEnv('example', 'claude', { home: HOME, navoreConfigDir: '/opt/example-claude' })
    assert.equal(env.CLAUDE_CONFIG_DIR, '/opt/example-claude')
  })

  it('navoreLinked is true only when a non-empty token is present', () => {
    assert.equal(navoreLinked({ home: HOME }), false)
    assert.equal(navoreLinked({ home: HOME, navoreOAuthToken: '   ' }), false)
    assert.equal(navoreLinked({ home: HOME, navoreOAuthToken: 'tok' }), true)
  })

  it('routes professional → example, personal → default', () => {
    assert.equal(accountForWorkspace('professional'), 'example')
    assert.equal(accountForWorkspace('personal'), 'default')
  })
})
