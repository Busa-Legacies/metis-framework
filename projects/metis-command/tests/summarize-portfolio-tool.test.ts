import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { summarizePortfolio } from '../lib/summarize-portfolio'
import { assertTelegramSafe } from '../lib/portfolio-render'
import { validateToolCall } from '../lib/tool-routing'
import type { Agent, Workspace } from '../lib/types'

function withTempDispatchStore<T>(fn: () => T): T {
  const prev = process.env.AW_DISPATCH_RUNS_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-summarize-portfolio-'))
  process.env.AW_DISPATCH_RUNS_DIR = dir
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.AW_DISPATCH_RUNS_DIR
    else process.env.AW_DISPATCH_RUNS_DIR = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function workspace(id: string, name: string): Workspace {
  return { id, name, cwd: `/tmp/${id}`, createdAt: '2026-05-09T00:00:00.000Z' }
}

function agent(overrides: Partial<Agent> & Pick<Agent, 'id' | 'workspaceId'>): Agent {
  return {
    name: overrides.id,
    kind: 'claude',
    cwd: '/tmp',
    cmd: 'true',
    args: [],
    status: 'running',
    createdAt: '2026-05-09T16:00:00.000Z',
    ...overrides,
  }
}

describe('summarizePortfolio (Wave-C1 pipeline)', () => {
  it('renders an empty portfolio when no workspaces are tracked', () => {
    withTempDispatchStore(() => {
      const result = summarizePortfolio({
        workspaces: [],
        agents: [],
        generatedAt: '2026-05-09T17:00:00.000Z',
      })
      assert.ok(!('error' in result))
      assert.equal(result.text, 'No workspaces tracked.')
      assertTelegramSafe(result.text)
    })
  })

  it('renders one line per workspace, with actionable workspaces ahead of quiet ones', () => {
    withTempDispatchStore(() => {
      const result = summarizePortfolio({
        workspaces: [workspace('wb', 'Workbench'), workspace('reos', 'REOS')],
        agents: [
          agent({ id: 'forge-1', workspaceId: 'wb', kind: 'claude', status: 'exited', exitCode: 1 }),
          agent({
            id: 'scout-1',
            workspaceId: 'reos',
            kind: 'codex',
            status: 'running',
            lastOutputAt: '2026-05-09T16:59:00.000Z',
          }),
        ],
        generatedAt: '2026-05-09T17:00:00.000Z',
      })
      assert.ok(!('error' in result))
      assertTelegramSafe(result.text)
      const lines = result.text.split('\n')
      assert.equal(lines.length, 2)
      // Workbench has a pending blocked-exit action; REOS is quiet, so Workbench sorts first.
      assert.match(lines[0], /^Workbench /)
      assert.match(lines[0], /Next: forge-1 \(claude\) exited with code 1\.$/)
      assert.match(lines[1], /^REOS /)
      assert.match(lines[1], /1 agent in flight/)
      assert.match(lines[1], /Next: nothing pending\.$/)
    })
  })

  it('actionableOnly omits quiet workspaces', () => {
    withTempDispatchStore(() => {
      const result = summarizePortfolio({
        workspaces: [workspace('wb', 'Workbench'), workspace('reos', 'REOS')],
        agents: [
          agent({ id: 'forge-1', workspaceId: 'wb', status: 'exited', exitCode: 1 }),
        ],
        actionableOnly: true,
        generatedAt: '2026-05-09T17:00:00.000Z',
      })
      assert.ok(!('error' in result))
      const lines = result.text.split('\n')
      assert.equal(lines.length, 1)
      assert.match(lines[0], /^Workbench /)
      assert.match(lines[0], /Next: forge-1 \(claude\) exited with code 1\.$/)
      assertTelegramSafe(result.text)
    })
  })

  it('actionableOnly with no actionable workspaces returns the dedicated empty-state text', () => {
    withTempDispatchStore(() => {
      const result = summarizePortfolio({
        workspaces: [workspace('wb', 'Workbench')],
        agents: [],
        actionableOnly: true,
        generatedAt: '2026-05-09T17:00:00.000Z',
      })
      assert.ok(!('error' in result))
      assert.equal(result.text, 'No workspaces with pending actions.')
      assertTelegramSafe(result.text)
    })
  })

  it('workspaceFilter narrows the summary to a single workspace by name', () => {
    withTempDispatchStore(() => {
      const result = summarizePortfolio({
        workspaces: [workspace('wb', 'Workbench'), workspace('reos', 'REOS')],
        agents: [
          agent({ id: 'a', workspaceId: 'wb', status: 'running' }),
          agent({ id: 'b', workspaceId: 'reos', status: 'running' }),
        ],
        workspaceFilter: 'REOS',
        generatedAt: '2026-05-09T17:00:00.000Z',
      })
      assert.ok(!('error' in result))
      const lines = result.text.split('\n')
      assert.equal(lines.length, 1)
      assert.match(lines[0], /^REOS /)
      assert.match(lines[0], /1 agent in flight/)
      assertTelegramSafe(result.text)
    })
  })

  it('workspaceFilter targeting an unknown workspace returns an error envelope (not a thrown exception)', () => {
    withTempDispatchStore(() => {
      const result = summarizePortfolio({
        workspaces: [workspace('wb', 'Workbench')],
        agents: [],
        workspaceFilter: 'does-not-exist',
        generatedAt: '2026-05-09T17:00:00.000Z',
      })
      assert.ok('error' in result)
      assert.match(result.error, /unknown workspace id\/name: does-not-exist/)
    })
  })

  it('produces a deterministic rollup string for the same input', () => {
    withTempDispatchStore(() => {
      const input = {
        workspaces: [workspace('wb', 'Workbench')],
        agents: [agent({ id: 'a', workspaceId: 'wb', status: 'exited', exitCode: 0 })],
        generatedAt: '2026-05-09T17:00:00.000Z',
      }
      const a = summarizePortfolio(input)
      const b = summarizePortfolio(input)
      assert.ok(!('error' in a) && !('error' in b))
      assert.equal(a.text, b.text)
    })
  })
})

describe('summarize_portfolio validateToolCall', () => {
  it('accepts an empty args object', () => {
    const result = validateToolCall('summarize_portfolio', {})
    assert.deepEqual(result, { tool: 'summarize_portfolio', args: {} })
  })

  it('accepts both workspaceFilter and actionableOnly', () => {
    const result = validateToolCall('summarize_portfolio', {
      workspaceFilter: 'reos',
      actionableOnly: true,
    })
    assert.deepEqual(result, {
      tool: 'summarize_portfolio',
      args: { workspaceFilter: 'reos', actionableOnly: true },
    })
  })

  it('rejects an empty workspaceFilter', () => {
    const result = validateToolCall('summarize_portfolio', { workspaceFilter: '   ' })
    assert.ok('error' in result)
    assert.match(result.error, /workspaceFilter must be a non-empty string/)
  })

  it('rejects a non-boolean actionableOnly', () => {
    const result = validateToolCall('summarize_portfolio', { actionableOnly: 'yes' as unknown as boolean })
    assert.ok('error' in result)
    assert.match(result.error, /actionableOnly must be a boolean/)
  })
})
