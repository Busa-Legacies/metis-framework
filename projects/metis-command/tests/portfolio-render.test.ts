import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  assertTelegramSafe,
  renderPortfolioForTelegram,
  type PortfolioRollup,
  type PortfolioWorkspaceRollup,
} from '../lib/portfolio-render'

function ws(
  overrides: Partial<PortfolioWorkspaceRollup> & Pick<PortfolioWorkspaceRollup, 'workspaceId' | 'name'>,
): PortfolioWorkspaceRollup {
  return {
    sync: {
      inRepo: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
      dirtyCount: 0,
      untrackedCount: 0,
    },
    inFlightAgents: 0,
    lastShipped: null,
    nextAction: null,
    evidenceCounts: { reportsUnread: 0, reviewsOpen: 0, manualOverrides: 0 },
    ...overrides,
  }
}

function rollup(workspaces: PortfolioWorkspaceRollup[]): PortfolioRollup {
  return { generatedAt: '2026-05-09T17:00:00.000Z', workspaces }
}

describe('renderPortfolioForTelegram', () => {
  it('returns a Telegram-safe placeholder when no workspaces are tracked', () => {
    const text = renderPortfolioForTelegram(rollup([]))
    assert.equal(text, 'No workspaces tracked.')
    assertTelegramSafe(text)
  })

  it('renders one clean workspace as plain prose with next "nothing pending"', () => {
    const text = renderPortfolioForTelegram(
      rollup([ws({ workspaceId: 'wb', name: 'Workbench' })]),
    )
    assert.equal(
      text,
      'Workbench — branch main, clean, no agents in flight. Next: nothing pending.',
    )
    assertTelegramSafe(text)
  })

  it('filters to actionable workspaces and orders them deterministically', () => {
    const text = renderPortfolioForTelegram(
      rollup([
        ws({
          workspaceId: 'wb',
          name: 'Workbench',
          sync: { inRepo: true, branch: 'main', ahead: 1, behind: 0, dirtyCount: 3, untrackedCount: 2 },
          inFlightAgents: 2,
          nextAction: 'approve commit packet',
          evidenceCounts: { reportsUnread: 1, reviewsOpen: 0, manualOverrides: 0 },
        }),
        ws({ workspaceId: 'sw', name: 'Sitework' }),
        ws({
          workspaceId: 'reos',
          name: 'REOS',
          inFlightAgents: 1,
          nextAction: 'checkpoint Forge',
        }),
      ]),
      { filterToActionable: true },
    )
    const lines = text.split('\n')
    assert.equal(lines.length, 2)
    assert.equal(
      lines[0],
      'REOS — branch main, clean, 1 agent in flight. Next: checkpoint Forge.',
    )
    assert.equal(
      lines[1],
      'Workbench — branch main, 1 ahead, 0 behind, 3 dirty, 2 untracked, 2 agents in flight, 1 unread report. Next: approve commit packet.',
    )
    assertTelegramSafe(text)
  })

  it('renders a not-in-repo workspace clearly', () => {
    const text = renderPortfolioForTelegram(
      rollup([
        ws({
          workspaceId: 'sandbox',
          name: 'Sandbox',
          sync: { inRepo: false, branch: null, ahead: 0, behind: 0, dirtyCount: 0, untrackedCount: 0 },
          nextAction: 'init repo',
        }),
      ]),
    )
    assert.equal(text.startsWith('Sandbox — not in a git repo'), true)
    assert.equal(
      text,
      'Sandbox — not in a git repo, no agents in flight. Next: init repo.',
    )
    assertTelegramSafe(text)
  })

  it('produces byte-equal output for the same rollup (T-TGCKPT-4)', () => {
    const r = rollup([
      ws({
        workspaceId: 'a',
        name: 'Alpha',
        nextAction: 'review verdict',
        inFlightAgents: 1,
      }),
      ws({ workspaceId: 'b', name: 'Beta' }),
    ])
    const first = renderPortfolioForTelegram(r)
    const second = renderPortfolioForTelegram(r)
    assert.equal(first, second)
  })

  it('returns the actionable-empty placeholder when filter excludes all', () => {
    const text = renderPortfolioForTelegram(
      rollup([ws({ workspaceId: 'q', name: 'Quiet' })]),
      { filterToActionable: true },
    )
    assert.equal(text, 'No workspaces with pending actions.')
    assertTelegramSafe(text)
  })
})

describe('assertTelegramSafe', () => {
  it('rejects fenced code blocks', () => {
    assert.throws(
      () => assertTelegramSafe('hello\n```\ncode\n```\nbye'),
      /telegram_unsafe: fenced code block/,
    )
  })

  it('rejects ATX headers', () => {
    assert.throws(
      () => assertTelegramSafe('# Heading\nbody'),
      /telegram_unsafe: ATX header/,
    )
  })

  it('rejects setext underline headers', () => {
    assert.throws(
      () => assertTelegramSafe('Heading\n===\n\nbody'),
      /telegram_unsafe: setext header underline/,
    )
  })

  it('rejects markdown table dividers', () => {
    assert.throws(
      () => assertTelegramSafe('a | b\n---|---\n1 | 2'),
      /telegram_unsafe: table divider/,
    )
  })

  it('rejects markdown table pipe rows', () => {
    assert.throws(
      () => assertTelegramSafe('| col1 | col2 |\nvalue rows below'),
      /telegram_unsafe: table pipe-row/,
    )
  })

  it('accepts plain prose with line breaks', () => {
    assertTelegramSafe('Workbench — clean. Next: nothing pending.\nREOS — dirty. Next: review.')
  })
})

describe('portfolio-render module is side-effect-free (T-TGCKPT-5)', () => {
  it('does not import network or fs at the top level', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'lib', 'portfolio-render.ts'),
      'utf8',
    )
    const importRe = /^\s*import[^;]+from\s+['"]([^'"]+)['"]/gm
    const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
    const banned = ['node:net', 'node:http', 'node:https', 'node:fs', 'node:dgram', 'ws', 'undici']
    const found: string[] = []
    let m: RegExpExecArray | null
    while ((m = importRe.exec(source)) !== null) found.push(m[1])
    while ((m = requireRe.exec(source)) !== null) found.push(m[1])
    for (const mod of found) {
      assert.equal(banned.includes(mod), false, `forbidden import: ${mod}`)
    }
    assert.equal(/\bfetch\s*\(/.test(source), false, 'fetch call detected in portfolio-render')
  })
})
