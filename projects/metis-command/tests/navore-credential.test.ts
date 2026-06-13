import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sanitizeToken, navoreTokenLooksValid } from '../lib/example-credential'

describe('example-credential token sanitization', () => {
  it('strips internal whitespace from a wrapped paste', () => {
    // A terminal-wrapped token: a space/newline landed mid-string.
    assert.equal(sanitizeToken('sk-ant-oat01-AAAA BBBB'), 'sk-ant-oat01-AAAABBBB')
    assert.equal(sanitizeToken('sk-ant-oat01-AAAA\nBBBB'), 'sk-ant-oat01-AAAABBBB')
    assert.equal(sanitizeToken('  sk-ant-oat01-AAAA\r\nBBBB\t'), 'sk-ant-oat01-AAAABBBB')
  })

  it('returns undefined for empty/whitespace-only/missing input', () => {
    assert.equal(sanitizeToken(undefined), undefined)
    assert.equal(sanitizeToken(''), undefined)
    assert.equal(sanitizeToken('   \n\t '), undefined)
  })

  it('validates token shape (setup-token prefix)', () => {
    assert.equal(navoreTokenLooksValid('sk-ant-oat01-AAAABBBB'), true)
    assert.equal(navoreTokenLooksValid('sk-ant-api03-AAAABBBB'), false) // API key, not OAuth token
    assert.equal(navoreTokenLooksValid('garbage'), false)
    assert.equal(navoreTokenLooksValid(undefined), false)
    assert.equal(navoreTokenLooksValid(''), false)
  })
})
