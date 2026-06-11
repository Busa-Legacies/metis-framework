#!/usr/bin/env node
import { spawn } from 'node:child_process'
import net from 'node:net'
import { pathToFileURL } from 'node:url'

export function parsePort(value, label) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer port from 1 to 65535`)
  }
  return port
}

export function requestedPort(env = process.env) {
  if (env.AW_NEXT_PORT) return parsePort(env.AW_NEXT_PORT, 'AW_NEXT_PORT')
  if (env.AW_SMOKE_PORT) return parsePort(env.AW_SMOKE_PORT, 'AW_SMOKE_PORT')
  return null
}

export function parseTimeoutMs(value) {
  if (value === undefined) return 30_000
  const timeoutMs = Number(value)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error('AW_SMOKE_TIMEOUT_MS must be a positive number of milliseconds')
  }
  return timeoutMs
}

export function smokeHost(env = process.env) {
  return env.AW_SMOKE_HOST || '127.0.0.1'
}

export async function reserveTcpPort(host, port) {
  const server = net.createServer()
  server.unref()

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(new Error(`browser smoke cannot reserve ${host}:${port || 0}: ${err.message}`))
    })
    server.listen({ host, port, exclusive: true }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error(`browser smoke could not inspect reserved address for ${host}:${port || 0}`))
        return
      }
      resolve({
        port: address.port,
        release: () => new Promise((releaseResolve, releaseReject) => {
          server.close((err) => (err ? releaseReject(err) : releaseResolve()))
        }),
      })
    })
  })
}

export async function buildSmokeConfig(env = process.env) {
  const host = smokeHost(env)
  const requested = requestedPort(env)
  const reservation = await reserveTcpPort(host, requested ?? 0)
  await reservation.release()

  return {
    host,
    port: reservation.port,
    timeoutMs: parseTimeoutMs(env.AW_SMOKE_TIMEOUT_MS),
    deterministicPort: requested !== null,
  }
}

export async function runBrowserSmoke(config, env = process.env) {
  const { host, port, timeoutMs } = config
  const url = `http://${host}:${port}`
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['next', 'dev', '-H', host, '-p', String(port)],
    {
      cwd: process.cwd(),
      env: { ...env, NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let output = ''
  let settled = false
  let timer

  return new Promise((resolve) => {
    function append(chunk) {
      const text = chunk.toString()
      output += text
      process.stdout.write(text)
    }

    function finish(code, message) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.kill('SIGTERM')
      if (message) console.error(message)
      process.exitCode = code
      resolve(code)
    }

    async function probe() {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline && !settled) {
        if (/listen EPERM|EADDRINUSE|Error: listen/i.test(output)) {
          finish(1, `browser smoke server bind failed for ${url}`)
          return
        }

        try {
          const res = await fetch(url, { redirect: 'manual' })
          const html = await res.text()
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          if (!/Agent Workbench|__next/i.test(html)) {
            throw new Error('home page did not look like a rendered Next app')
          }
          finish(0, `browser smoke passed: ${url}`)
          return
        } catch {
          await new Promise((probeResolve) => setTimeout(probeResolve, 500))
        }
      }

      finish(1, `browser smoke timed out after ${timeoutMs}ms waiting for ${url}`)
    }

    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (err) => finish(1, `browser smoke failed to start Next: ${err.message}`))
    child.on('exit', (code, signal) => {
      if (!settled) finish(code || 1, `browser smoke Next exited early: code=${code} signal=${signal}`)
    })

    timer = setTimeout(() => {
      finish(1, `browser smoke timed out after ${timeoutMs}ms waiting for ${url}`)
    }, timeoutMs + 5_000)

    probe()
  })
}

export async function main(env = process.env) {
  try {
    const config = await buildSmokeConfig(env)
    if (!config.deterministicPort) {
      console.error(`browser smoke selected free port ${config.port}`)
    }
    await runBrowserSmoke(config, env)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
