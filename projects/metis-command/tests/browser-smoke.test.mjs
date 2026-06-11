import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parsePort,
  parseTimeoutMs,
  requestedPort,
  reserveTcpPort,
  smokeHost,
} from '../scripts/browser-smoke.mjs'

describe('browser smoke harness configuration', () => {
  it('uses deterministic port overrides with AW_NEXT_PORT taking precedence', () => {
    assert.equal(requestedPort({ AW_NEXT_PORT: '4101', AW_SMOKE_PORT: '4102' }), 4101)
    assert.equal(requestedPort({ AW_SMOKE_PORT: '4102' }), 4102)
    assert.equal(requestedPort({}), null)
  })

  it('validates port and timeout inputs', () => {
    assert.equal(parsePort('65535', 'TEST_PORT'), 65_535)
    assert.throws(() => parsePort('0', 'TEST_PORT'), /integer port from 1 to 65535/)
    assert.throws(() => parsePort('65536', 'TEST_PORT'), /integer port from 1 to 65535/)
    assert.throws(() => parsePort('abc', 'TEST_PORT'), /integer port from 1 to 65535/)

    assert.equal(parseTimeoutMs(undefined), 30_000)
    assert.equal(parseTimeoutMs('1500'), 1500)
    assert.throws(() => parseTimeoutMs('0'), /positive number/)
  })

  it('defaults to loopback host unless explicitly overridden', () => {
    assert.equal(smokeHost({}), '127.0.0.1')
    assert.equal(smokeHost({ AW_SMOKE_HOST: 'localhost' }), 'localhost')
  })

  it('detects occupied ports before the browser probe can hit a foreign app', async () => {
    let reservation
    try {
      reservation = await reserveTcpPort('127.0.0.1', 0)
    } catch (err) {
      assert.match(String(err), /EPERM|EACCES|operation not permitted/i)
      return
    }

    try {
      await assert.rejects(
        () => reserveTcpPort('127.0.0.1', reservation.port),
        /EADDRINUSE|address already in use/i,
      )
    } finally {
      await reservation.release()
    }
  })
})
