// #259 trust gate unit tests: token mint/persist + HTTP/WS authorization checks.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadOrMintToken, httpAuthorized, wsAuthorized, timingSafeEq, TOKEN_FILE_NAME } from '../server/sidecar-auth.ts'

const TOKEN = 'a'.repeat(64)

test('loadOrMintToken mints once, persists 0600, and is stable across loads', () => {
  const prevEnv = process.env.DEV_REVIEW_SIDECAR_TOKEN
  delete process.env.DEV_REVIEW_SIDECAR_TOKEN
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-auth-'))
  try {
    const minted = loadOrMintToken(dir)
    assert.match(minted, /^[0-9a-f]{64}$/)
    const mode = fs.statSync(path.join(dir, TOKEN_FILE_NAME)).mode & 0o777
    assert.equal(mode, 0o600)
    assert.equal(loadOrMintToken(dir), minted) // stable across restarts
  } finally {
    if (prevEnv !== undefined) process.env.DEV_REVIEW_SIDECAR_TOKEN = prevEnv
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('env token wins over the file', () => {
  const prevEnv = process.env.DEV_REVIEW_SIDECAR_TOKEN
  process.env.DEV_REVIEW_SIDECAR_TOKEN = 'env-token'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-auth-'))
  try {
    assert.equal(loadOrMintToken(dir), 'env-token')
    assert.equal(fs.existsSync(path.join(dir, TOKEN_FILE_NAME)), false)
  } finally {
    if (prevEnv !== undefined) process.env.DEV_REVIEW_SIDECAR_TOKEN = prevEnv
    else delete process.env.DEV_REVIEW_SIDECAR_TOKEN
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('httpAuthorized: header or Bearer, default-deny otherwise', () => {
  assert.equal(httpAuthorized({ 'x-dev-review-token': TOKEN }, TOKEN), true)
  assert.equal(httpAuthorized({ authorization: `Bearer ${TOKEN}` }, TOKEN), true)
  assert.equal(httpAuthorized({}, TOKEN), false)
  assert.equal(httpAuthorized({ 'x-dev-review-token': 'wrong' }, TOKEN), false)
  assert.equal(httpAuthorized({ authorization: `Bearer wrong` }, TOKEN), false)
  // token must never authorize via the query string — headers only
})

test('wsAuthorized: drt.<token> subprotocol entry or HTTP header', () => {
  assert.equal(wsAuthorized({ 'sec-websocket-protocol': `drt, drt.${TOKEN}` }, TOKEN), true)
  assert.equal(wsAuthorized({ 'sec-websocket-protocol': `drt.${TOKEN}` }, TOKEN), true)
  assert.equal(wsAuthorized({ 'x-dev-review-token': TOKEN }, TOKEN), true)
  assert.equal(wsAuthorized({ 'sec-websocket-protocol': 'drt' }, TOKEN), false)
  assert.equal(wsAuthorized({ 'sec-websocket-protocol': `drt.wrong` }, TOKEN), false)
  assert.equal(wsAuthorized({}, TOKEN), false)
})

test('timingSafeEq compares without length leaks crashing', () => {
  assert.equal(timingSafeEq(TOKEN, TOKEN), true)
  assert.equal(timingSafeEq(TOKEN, TOKEN.slice(0, 10)), false)
  assert.equal(timingSafeEq('', TOKEN), false)
})
