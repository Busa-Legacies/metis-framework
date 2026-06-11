import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

const repoRoot = process.cwd()

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      server.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0))
    })
  })
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const result = await fn()
      if (result) return result
    } catch (e) {
      lastError = e
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (lastError) throw lastError
  throw new Error('timed out')
}

function startPtyServer(port: number, dataDir: string) {
  const proc = spawn(process.execPath, ['--import', 'tsx', 'server/pty-server.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AW_PTY_PORT: String(port),
      AW_DATA_DIR: dataDir,
      AW_HTTP_LOG: '0',
      AW_KILL_GRACE_MS: '100',
      AW_HEALTH_CHECK_MS: '100',
      AW_EVIDENCE_LEDGER_DIR: path.join(dataDir, 'evidence-ledger'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return proc
}

async function stopPtyServer(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode) return
  proc.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve()
    }, 3000)
    proc.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function api<T>(port: number, pathPart: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${pathPart}`, init)
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

async function apiRaw(port: number, pathPart: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${pathPart}`, init)
}

function isPidAlive(pid?: number) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('PTY server spawn, read, restart scrollback, and kill lifecycle', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  let server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const workspaces = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    const workspaceId = workspaces.workspaces[0].id

    const spawnResp = await api<{ agent: { id: string; pid: number } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        kind: 'custom',
        name: 'lifecycle-test',
        cmd: '/bin/sh',
        args: ['-lc', 'printf "ready-line\\n"; sleep 30'],
      }),
    })

    const firstAgent = spawnResp.agent
    assert.ok(firstAgent.pid > 0)
    await waitFor(async () => {
      const scrollback = await api<{ output: string }>(port, `/agents/${firstAgent.id}/scrollback?lines=20`)
      return scrollback.output.includes('ready-line') ? scrollback : undefined
    })

    await stopPtyServer(server)

    server = startPtyServer(port, dataDir)
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const persisted = await api<{ output: string }>(port, `/agents/${firstAgent.id}/scrollback?lines=20`)
    assert.match(persisted.output, /ready-line/)

    const secondResp = await api<{ agent: { id: string; pid: number } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        kind: 'custom',
        name: 'kill-test',
        cmd: '/bin/sh',
        args: ['-lc', 'printf "kill-ready\\n"; sleep 30'],
      }),
    })
    const secondAgent = secondResp.agent
    await waitFor(async () => {
      const scrollback = await api<{ output: string }>(port, `/agents/${secondAgent.id}/scrollback?lines=20`)
      return scrollback.output.includes('kill-ready') ? scrollback : undefined
    })

    await api<{ ok: boolean }>(port, `/agents/${secondAgent.id}`, { method: 'DELETE' })
    await waitFor(() => !isPidAlive(secondAgent.pid), 5000)
    const health = await api<{ running: number }>(port, '/health')
    assert.equal(health.running, 0)
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('PTY server clear exited removes runtime panes without killing running agents', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  const server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const workspaces = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    const workspaceId = workspaces.workspaces[0].id

    const exitedResp = await api<{ agent: { id: string } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        kind: 'custom',
        name: 'clear-exited-runtime',
        cmd: '/bin/sh',
        args: ['-lc', 'printf "done-clear\\n"'],
      }),
    })
    const runningResp = await api<{ agent: { id: string; pid: number } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        kind: 'custom',
        name: 'clear-running-survives',
        cmd: '/bin/sh',
        args: ['-lc', 'printf "still-running\\n"; sleep 30'],
      }),
    })

    await waitFor(async () => {
      const list = await api<{ agents: { id: string; status: string }[] }>(port, '/agents?include=exited')
      return list.agents.find((a) => a.id === exitedResp.agent.id && a.status === 'exited')
    })
    await waitFor(async () => {
      const scrollback = await api<{ output: string }>(port, `/agents/${runningResp.agent.id}/scrollback?lines=20`)
      return scrollback.output.includes('still-running') ? scrollback : undefined
    })

    const cleared = await api<{ cleared: number }>(port, `/agents/exited?workspaceId=${workspaceId}`, { method: 'DELETE' })
    assert.equal(cleared.cleared, 1)

    const after = await api<{ agents: { id: string; status: string }[] }>(port, '/agents?include=exited')
    assert.equal(after.agents.some((a) => a.id === exitedResp.agent.id), false)
    assert.equal(after.agents.some((a) => a.id === runningResp.agent.id && a.status === 'running'), true)
    assert.equal(isPidAlive(runningResp.agent.pid), true)
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('PTY server DELETE removes an already-exited runtime agent', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  const server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const workspaces = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    const workspaceId = workspaces.workspaces[0].id

    const exitedResp = await api<{ agent: { id: string } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        kind: 'custom',
        name: 'delete-exited-runtime',
        cmd: '/bin/sh',
        args: ['-lc', 'printf "done-delete\\n"'],
      }),
    })

    await waitFor(async () => {
      const list = await api<{ agents: { id: string; status: string }[] }>(port, '/agents?include=exited')
      return list.agents.find((a) => a.id === exitedResp.agent.id && a.status === 'exited')
    })

    await api<{ ok: boolean }>(port, `/agents/${exitedResp.agent.id}`, { method: 'DELETE' })

    const listAfter = await api<{ agents: { id: string }[] }>(port, '/agents?include=exited')
    assert.equal(listAfter.agents.some((a) => a.id === exitedResp.agent.id), false)
    const scrollbackAfter = await apiRaw(port, `/agents/${exitedResp.agent.id}/scrollback?lines=20`)
    assert.equal(scrollbackAfter.status, 404)
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('PTY server resume still works after clearing exited agents in a workspace', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  const server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const workspaces = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    const workspaceId = workspaces.workspaces[0].id

    const exitedResp = await api<{ agent: { id: string } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        kind: 'custom',
        name: 'resume-after-clear',
        cmd: '/bin/sh',
        args: ['-lc', 'printf "resume-source\\n"'],
      }),
    })

    await waitFor(async () => {
      const list = await api<{ agents: { id: string; status: string }[] }>(port, '/agents?include=exited')
      return list.agents.find((a) => a.id === exitedResp.agent.id && a.status === 'exited')
    })

    const beforeSpecs = await api<{ specs: { name: string }[] }>(port, `/workspaces/${workspaceId}/resume-specs`)
    assert.equal(beforeSpecs.specs.some((s) => s.name === 'resume-after-clear'), true)

    const cleared = await api<{ cleared: number }>(port, `/agents/exited?workspaceId=${workspaceId}`, { method: 'DELETE' })
    assert.equal(cleared.cleared, 1)

    const afterClear = await api<{ agents: { id: string }[] }>(port, '/agents?include=exited')
    assert.equal(afterClear.agents.some((a) => a.id === exitedResp.agent.id), false)
    const afterSpecs = await api<{ specs: { name: string }[] }>(port, `/workspaces/${workspaceId}/resume-specs`)
    assert.equal(afterSpecs.specs.some((s) => s.name === 'resume-after-clear'), true)

    const resumed = await api<{ spawned: { id: string; name: string; status: string }[] }>(port, `/workspaces/${workspaceId}/resume`, { method: 'POST' })
    assert.equal(resumed.spawned.length, 1)
    assert.equal(resumed.spawned[0].name, 'resume-after-clear')
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('PTY server clear exited is scoped to the requested workspace', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  const ws1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-clear-ws1-'))
  const ws2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-clear-ws2-'))
  const server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const workspaces = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    const ws1 = workspaces.workspaces[0].id
    await api(port, `/workspaces/${ws1}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ws1Dir }),
    })
    const created = await api<{ workspace: { id: string } }>(port, '/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Second clear workspace', cwd: ws2Dir }),
    })
    const ws2 = created.workspace.id

    const ws1Agent = await api<{ agent: { id: string } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws1, kind: 'custom', name: 'ws1-exited', cmd: '/bin/sh', args: ['-lc', 'printf "ws1-done\\n"'] }),
    })
    const ws2Agent = await api<{ agent: { id: string } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws2, kind: 'custom', name: 'ws2-exited', cmd: '/bin/sh', args: ['-lc', 'printf "ws2-done\\n"'] }),
    })

    await waitFor(async () => {
      const list = await api<{ agents: { id: string; status: string }[] }>(port, '/agents?include=exited')
      const ws1Exited = list.agents.some((a) => a.id === ws1Agent.agent.id && a.status === 'exited')
      const ws2Exited = list.agents.some((a) => a.id === ws2Agent.agent.id && a.status === 'exited')
      return ws1Exited && ws2Exited ? list : undefined
    })

    const cleared = await api<{ cleared: number }>(port, `/agents/exited?workspaceId=${ws1}`, { method: 'DELETE' })
    assert.equal(cleared.cleared, 1)

    const after = await api<{ agents: { id: string; workspaceId: string; status: string }[] }>(port, '/agents?include=exited')
    assert.equal(after.agents.some((a) => a.id === ws1Agent.agent.id), false)
    assert.equal(after.agents.some((a) => a.id === ws2Agent.agent.id && a.workspaceId === ws2 && a.status === 'exited'), true)

    const ws2Scrollback = await api<{ output: string }>(port, `/agents/${ws2Agent.agent.id}/scrollback?lines=20`)
    assert.match(ws2Scrollback.output, /ws2-done/)
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(ws1Dir, { recursive: true, force: true })
    fs.rmSync(ws2Dir, { recursive: true, force: true })
  }
})

test('PTY server creates blank-name workspaces as temporary or cwd-named', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  const namedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-folder-name-'))
  const server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))

    const temporary = await api<{ workspace: { name: string; cwd: string } }>(port, '/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    })
    assert.equal(temporary.workspace.name, '')
    assert.equal(temporary.workspace.cwd, os.homedir())

    const cwdNamed = await api<{ workspace: { name: string; cwd: string } }>(port, '/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '   ', cwd: namedDir }),
    })
    assert.equal(cwdNamed.workspace.name, path.basename(namedDir))
    assert.equal(cwdNamed.workspace.cwd, namedDir)

    const explicit = await api<{ workspace: { name: string } }>(port, '/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Explicit name  ', cwd: namedDir }),
    })
    assert.equal(explicit.workspace.name, 'Explicit name')
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(namedDir, { recursive: true, force: true })
  }
})

test('PTY server deletes workspaces but rejects deleting the last workspace', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-delete-workspace-'))
  const server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const initial = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    const firstId = initial.workspaces[0].id

    const lastRejected = await apiRaw(port, `/workspaces/${firstId}`, { method: 'DELETE' })
    assert.equal(lastRejected.status, 400)
    assert.match(await lastRejected.text(), /cannot delete last workspace/)

    const created = await api<{ workspace: { id: string } }>(port, '/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: wsDir }),
    })

    await api<{ ok: boolean }>(port, `/workspaces/${created.workspace.id}`, { method: 'DELETE' })
    const after = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    assert.deepEqual(after.workspaces.map((w) => w.id), [firstId])
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(wsDir, { recursive: true, force: true })
  }
})

test('PTY server gates done tasks on report plus review evidence', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  const server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const workspaces = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    const workspaceId = workspaces.workspaces[0].id
    const created = await api<{ task: { id: string; status: string } }>(port, `/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'evidence gated task', status: 'review' }),
    })
    const taskId = created.task.id

    const rejected = await apiRaw(port, `/workspaces/${workspaceId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    assert.equal(rejected.status, 409)
    assert.match(await rejected.text(), /requires_evidence/)

    await api(port, `/workspaces/${workspaceId}/tasks/${taskId}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'report', summary: 'implementation report', payload: { path: 'WORKBENCH_TASK.md' } }),
    })
    const reportOnlyRejected = await apiRaw(port, `/workspaces/${workspaceId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    assert.equal(reportOnlyRejected.status, 409)

    await api(port, `/workspaces/${workspaceId}/tasks/${taskId}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'review', summary: 'review approved' }),
    })
    const done = await api<{ task: { status: string } }>(port, `/workspaces/${workspaceId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    assert.equal(done.task.status, 'done')

    const evidence = await api<{ evidence: { kind: string; summary: string }[] }>(port, `/workspaces/${workspaceId}/tasks/${taskId}/evidence`)
    assert.deepEqual(evidence.evidence.map((row) => row.kind).sort(), ['report', 'review'])
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('PTY server allows done override only with an explicit reason and records evidence', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  const server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const workspaces = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    const workspaceId = workspaces.workspaces[0].id
    const created = await api<{ task: { id: string } }>(port, `/workspaces/${workspaceId}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'override task' }),
    })

    const missingReason = await apiRaw(port, `/workspaces/${workspaceId}/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done', overrideDoneGate: true }),
    })
    assert.equal(missingReason.status, 400)
    assert.match(await missingReason.text(), /override_reason_required/)

    const done = await api<{ task: { status: string } }>(port, `/workspaces/${workspaceId}/tasks/${created.task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done', overrideDoneGate: true, overrideReason: 'PM accepted risk for demo cutoff' }),
    })
    assert.equal(done.task.status, 'done')

    const evidence = await api<{ evidence: { kind: string; summary: string; payload: { gate?: string } }[] }>(port, `/workspaces/${workspaceId}/tasks/${created.task.id}/evidence`)
    assert.equal(evidence.evidence.length, 1)
    assert.equal(evidence.evidence[0].kind, 'manual_override')
    assert.equal(evidence.evidence[0].summary, 'PM accepted risk for demo cutoff')
    assert.equal(evidence.evidence[0].payload.gate, 'task_done')
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('PTY server isolates broadcasts by workspace and rejects unknown agent input', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  const ws1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ws1-'))
  const ws2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-ws2-'))
  const server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const workspaces = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    const ws1 = workspaces.workspaces[0].id
    await api(port, `/workspaces/${ws1}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: ws1Dir }),
    })
    const created = await api<{ workspace: { id: string } }>(port, '/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Second', cwd: ws2Dir }),
    })
    const ws2 = created.workspace.id

    const unknownInput = await apiRaw(port, '/agents/ag_missing/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x\n' }),
    })
    assert.equal(unknownInput.status, 404)

    const readerArgs = ['-lc', 'while IFS= read -r line; do printf "recv:%s\\n" "$line"; done']
    const a1 = await api<{ agent: { id: string } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws1, kind: 'custom', name: 'ws1-reader', cmd: '/bin/sh', args: readerArgs }),
    })
    const a2 = await api<{ agent: { id: string } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: ws2, kind: 'custom', name: 'ws2-reader', cmd: '/bin/sh', args: readerArgs }),
    })

    const broadcast = await api<{ count: number; ids: string[] }>(port, `/workspaces/${ws1}/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello-ws1\n' }),
    })
    assert.equal(broadcast.count, 1)
    assert.deepEqual(broadcast.ids, [a1.agent.id])

    await waitFor(async () => {
      const scrollback = await api<{ output: string }>(port, `/agents/${a1.agent.id}/scrollback?lines=20`)
      return scrollback.output.includes('recv:hello-ws1') ? scrollback : undefined
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    const ws2Scrollback = await api<{ output: string }>(port, `/agents/${a2.agent.id}/scrollback?lines=20`)
    assert.equal(ws2Scrollback.output.includes('recv:hello-ws1'), false)
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(ws1Dir, { recursive: true, force: true })
    fs.rmSync(ws2Dir, { recursive: true, force: true })
  }
})

test('PTY server validates spawn cwd against workspace root and pinned roots', async () => {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pty-test-'))
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-root-'))
  const childDir = fs.mkdtempSync(path.join(workspaceDir, 'child-'))
  const pinnedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-pinned-'))
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-outside-'))
  const server = startPtyServer(port, dataDir)
  try {
    await waitFor(() => api<{ ok: boolean }>(port, '/health').then((h) => h.ok))
    const workspaces = await api<{ workspaces: { id: string }[] }>(port, '/workspaces')
    const workspaceId = workspaces.workspaces[0].id
    await api(port, `/workspaces/${workspaceId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: workspaceDir }),
    })

    const rejected = await apiRaw(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, kind: 'custom', name: 'bad-cwd', cwd: outsideDir, cmd: '/bin/sh', args: ['-lc', 'true'] }),
    })
    assert.equal(rejected.ok, false)
    assert.match(await rejected.text(), /outside workspace boundary/)

    const childSpawn = await api<{ agent: { cwd: string } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, kind: 'custom', name: 'child-cwd', cwd: childDir, cmd: '/bin/sh', args: ['-lc', 'sleep 1'] }),
    })
    assert.equal(childSpawn.agent.cwd, childDir)

    await api(port, `/workspaces/${workspaceId}/pinned-roots`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roots: [pinnedDir] }),
    })
    const pinnedSpawn = await api<{ agent: { cwd: string } }>(port, '/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, kind: 'custom', name: 'pinned-cwd', cwd: pinnedDir, cmd: '/bin/sh', args: ['-lc', 'sleep 1'] }),
    })
    assert.equal(pinnedSpawn.agent.cwd, pinnedDir)
  } finally {
    await stopPtyServer(server)
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(workspaceDir, { recursive: true, force: true })
    fs.rmSync(pinnedDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})
