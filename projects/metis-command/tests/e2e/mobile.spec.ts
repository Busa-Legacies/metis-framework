/**
 * Mobile smoke tests for Metis Command.
 * Runs against http://localhost:3747 (must be running via `npm run dev:lan`).
 * Covers: layout, sidebar drawers, spawn, terminal rendering.
 */
import { test, expect, Page } from '@playwright/test'

const PTY_BASE = process.env.MC_PTY_URL ?? 'http://localhost:3748'

// ── helpers ─────────────────────────────────────────────────────────────────

async function cleanupAgents(page: Page) {
  // Spawned test shells are still RUNNING at teardown, so clearing exited alone
  // leaked one zombie zsh per spawn test (23 piled up by 2026-06-09). Kill the
  // generic test shells first (name 'shell', no taskId — never real work), let
  // the kills settle, then clear exited.
  try {
    const res = await page.request.get(`${PTY_BASE}/agents`)
    const { agents } = await res.json() as { agents: { id: string; kind: string; name: string; taskId?: string }[] }
    for (const a of agents) {
      if (a.kind === 'shell' && a.name === 'shell' && !a.taskId) {
        await page.request.delete(`${PTY_BASE}/agents/${a.id}`).catch(() => {})
      }
    }
  } catch { /* pty server unreachable — nothing to clean */ }
  await page.waitForTimeout(300)
  await page.request.delete(`${PTY_BASE}/agents/exited`).catch(() => {})
}

/** Click reliably regardless of touch vs mouse emulation. */
async function tap(page: Page, locator: ReturnType<Page['locator']>) {
  await locator.waitFor({ state: 'visible', timeout: 8_000 })
  await locator.click({ force: false })
}

async function nav(page: Page, name: string) {
  await page.getByTestId(`mode-nav-${name}`).locator('visible=true').first().dispatchEvent('click')
}

async function mockWorkData(page: Page) {
  await page.route('**/api/metis/all', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ts: new Date().toISOString(),
      priorities: {
        goals: [{ id: 'G1', title: 'AI Ecosystem', system: 1, weight: 1, marker: 'primary line', active: 3, in_progress: 1, blocked: 1, done: 5 }],
        next: [
          { taskId: '#101', title: 'First task', priority: 'P1', state: 'queued' },
          { taskId: '#102', title: 'Second task', priority: 'P2', state: 'queued' },
          { taskId: '#103', title: 'Third task', priority: 'P2', state: 'queued' },
        ],
        blocked: [
          { taskId: '#201', title: 'Blocked task', priority: 'P1', state: 'blocked' },
        ],
        by_system: {},
        systems: {},
        orphans: [],
        blocked_count: 1,
        active_total: 4,
      },
      tasks: { summary: [{ project: 'ops', priority: 'P1', status: 'active', next_up: 'First task' }], sections: [] },
      system: {}, jay: {}, ollama: {}, bot: {}, alerts: [], ratelimits: {}, memory: {}, remote: {},
    }),
  }))
  await page.route('**/api/metis/inbox', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      decisions: [],
      buckets: { decide: [], verify: [], unblock: [], waiting: [] },
      focus: { focusSummary: 'nothing urgent', waitingOnAnt: false, blockerSummary: null, nextSteps: [] },
      counts: { decide: 0, verify: 0, unblock: 0, waiting: 0, decisions: 0, total: 0 },
    }),
  }))
  await page.route('**/api/metis/leases', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ leases: [], count: 0 }) }))
}

// ── layout ───────────────────────────────────────────────────────────────────

test.describe('mobile layout', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', 'mobile-only assertions run only under the mobile project')
  })

  test('page loads and renders at mobile viewport', async ({ page }) => {
    await page.goto('/')

    // viewport meta must be present
    const viewport = await page.$eval(
      'meta[name="viewport"]',
      (el) => el.getAttribute('content') ?? '',
    )
    expect(viewport).toContain('width=device-width')

    // grid must be single-column — both asides hidden on mobile
    const leftAside = page.locator('aside').first()
    await expect(leftAside).toBeHidden()

    const rightAside = page.locator('aside').last()
    await expect(rightAside).toBeHidden()

    // main content area fills the viewport
    const main = page.locator('main')
    await expect(main).toBeVisible()
    const box = await main.boundingBox()
    expect(box).not.toBeNull()
    // main should be ~full viewport width (allow 10px slack for borders)
    expect(box!.width).toBeGreaterThan(page.viewportSize()!.width - 10)
  })

  test('header contains mobile toggle buttons', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTitle('Workspaces & files')).toBeVisible()
    await expect(page.getByTitle('Metis Assistant')).toBeVisible()
    // desktop-only elements should be hidden
    await expect(page.getByTitle('Settings', { exact: true })).toBeHidden()
  })

  test('spawn button is present in tab bar', async ({ page }) => {
    await page.goto('/')
    const spawnBtn = page.getByRole('button', { name: /spawn/i }).first()
    await expect(spawnBtn).toBeVisible()
  })

  test('empty pane shows mobile-friendly hint', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByText('tap spawn to start an agent')).toBeVisible()
  })

  test('Work home fits the mobile viewport without page-level overflow', async ({ page }) => {
    await mockWorkData(page)
    await page.goto('/')
    await nav(page, 'work')
    await expect(page.getByTestId('work-mode')).toBeVisible()

    const metrics = await page.evaluate(() => {
      const work = document.querySelector('[data-testid=work-mode]') as HTMLElement | null
      return {
        bodyW: document.body.scrollWidth,
        htmlW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
        workW: work?.scrollWidth ?? 0,
        workH: work?.scrollHeight ?? 0,
        viewportH: window.innerHeight,
      }
    })
    expect(metrics.bodyW).toBeLessThanOrEqual(metrics.innerW)
    expect(metrics.htmlW).toBeLessThanOrEqual(metrics.innerW)
    expect(metrics.workW).toBeLessThanOrEqual(metrics.innerW)
    expect(metrics.workH).toBeLessThanOrEqual(metrics.viewportH)
  })

  test('mobile Annotate falls back to direct builder dispatch when assistant does not spawn', async ({ page }) => {
    await mockWorkData(page)
    let spawned = false
    await page.route('**/api/assistant', (route) => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ message: { content: 'I dispatched a builder.' }, toolCalls: [] }),
    }))
    await page.route('**:3748/workspaces', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ workspaces: [{ id: 'ws_metis', name: 'metis-os', cwd: '${METIS_HOME}' }] }) })
      } else {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ workspace: { id: 'ws_metis', name: 'metis-os', cwd: '${METIS_HOME}' } }) })
      }
    })
    await page.route('**:3748/agents', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ agents: [] }) })
        return
      }
      spawned = true
      const body = await route.request().postDataJSON()
      expect(body.workspaceId).toBe('ws_metis')
      expect(body.initialPrompt).toContain('UI fix request')
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ agent: { id: 'ag_1', name: 'annotate:work', kind: 'codex', status: 'running', workspaceId: 'ws_metis' } }) })
    })

    await page.goto('/')
    await nav(page, 'work')
    await tap(page, page.getByTestId('annotate-fab'))
    await page.getByPlaceholder(/Fix or add something/i).fill('make this card smaller')
    await tap(page, page.getByLabel('send annotation'))
    await expect(page.getByText(/dispatched builder/i)).toBeVisible({ timeout: 10_000 })
    expect(spawned).toBe(true)
  })
})

// ── sidebar drawers ───────────────────────────────────────────────────────────

test.describe('sidebar drawers', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', 'mobile-only assertions run only under the mobile project')
  })

  test('left panel opens and closes', async ({ page }) => {
    await page.goto('/')
    const leftAside = page.locator('aside').first()
    await expect(leftAside).toBeHidden()

    // open
    await tap(page, page.getByTitle('Workspaces & files'))
    await expect(leftAside).toBeVisible({ timeout: 5_000 })

    // Verify it's a fixed overlay (mobile drawer)
    const cls = await leftAside.getAttribute('class')
    expect(cls).toContain('fixed')

    // Click backdrop outside the aside to dismiss.
    // Left aside is w-72 (288px) from the left edge; x=350 is in backdrop-only territory.
    await page.mouse.click(350, 400)
    await expect(leftAside).toBeHidden({ timeout: 5_000 })
  })

  test('right operator panel opens and closes', async ({ page }) => {
    await page.goto('/')
    const rightAside = page.locator('aside').last()
    await expect(rightAside).toBeHidden()

    await tap(page, page.getByTitle('Metis Assistant'))
    await expect(rightAside).toBeVisible({ timeout: 5_000 })

    // Right aside is w-80 (320px) from right edge; on 390px screen it spans x=70–390.
    // x=30 is in backdrop-only territory.
    await page.mouse.click(30, 400)
    await expect(rightAside).toBeHidden({ timeout: 5_000 })
  })

  test('opening left panel closes right panel', async ({ page }) => {
    await page.goto('/')
    const leftAside = page.locator('aside').first()
    const rightAside = page.locator('aside').last()

    await tap(page, page.getByTitle('Metis Assistant'))
    await expect(rightAside).toBeVisible({ timeout: 5_000 })

    // Header has relative z-50 so toggle buttons sit above the z-40 backdrop.
    await tap(page, page.getByTitle('Workspaces & files'))
    await expect(leftAside).toBeVisible({ timeout: 5_000 })
    await expect(rightAside).toBeHidden()
  })
})

// ── spawn + terminal ──────────────────────────────────────────────────────────

test.describe('spawn and terminal', () => {
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chrome', 'mobile-only assertions run only under the mobile project')
  })

  test.afterEach(async ({ page }) => {
    await cleanupAgents(page)
  })

  test('spawn menu opens on click', async ({ page }) => {
    await page.goto('/')
    const spawnBtn = page.getByRole('button', { name: /^spawn$/i }).first()
    await tap(page, spawnBtn)

    // SpawnMenu appears — verify by its unique heading
    await expect(page.getByText('Spawn lane')).toBeVisible({ timeout: 8_000 })
  })

  test('spawning a shell agent creates a tab', async ({ page }) => {
    await page.goto('/')
    await cleanupAgents(page)

    // Open spawn menu
    await tap(page, page.getByRole('button', { name: /^spawn$/i }).first())

    // Wait for menu to appear
    await page.getByText('Spawn lane').waitFor({ state: 'visible', timeout: 8_000 })

    // The spawn menu portal has backdrop-blur + "Spawn lane" heading — scope to it
    const spawnMenu = page.locator('.backdrop-blur').filter({ hasText: 'Spawn lane' })

    // Select shell kind
    await tap(page, spawnMenu.getByRole('button', { name: /^shell$/ }))

    // Click the confirm spawn button
    await tap(page, spawnMenu.getByRole('button', { name: /spawn shell/i }))

    // Empty state hint should disappear
    await expect(page.getByText('tap spawn to start an agent')).toBeHidden({ timeout: 10_000 })

    // An agent tab should now exist in the tab bar. Filter to visible instances —
    // with live agents present, .first() can match a card in the hidden desktop
    // rail (same trap as the nav helper; see control-center.spec.ts nav()).
    const agentTab = page.locator('[class*="rounded-lg"][class*="border"]').filter({
      hasText: /shell|zsh/i,
    }).locator('visible=true').first()
    await expect(agentTab).toBeVisible({ timeout: 10_000 })
  })

  test('terminal renders after spawning shell', async ({ page }) => {
    await page.goto('/')
    await cleanupAgents(page)

    // Spawn shell
    await tap(page, page.getByRole('button', { name: /^spawn$/i }).first())
    await page.getByText('Spawn lane').waitFor({ state: 'visible', timeout: 8_000 })
    const spawnMenu = page.locator('.backdrop-blur').filter({ hasText: 'Spawn lane' })
    await tap(page, spawnMenu.getByRole('button', { name: /^shell$/ }))
    await tap(page, spawnMenu.getByRole('button', { name: /spawn shell/i }))

    // xterm.js renders into a .xterm container
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 })

    // Terminal canvas should have non-zero dimensions.
    // Wait for .xterm-screen to be visible (not just present) before reading bbox.
    await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 10_000 })
    const termBox = await page.locator('.xterm-screen').first().boundingBox()
    expect(termBox).not.toBeNull()
    expect(termBox!.width).toBeGreaterThan(50)
    expect(termBox!.height).toBeGreaterThan(20)
  })

  test('terminal accepts input and echoes it back', async ({ page }) => {
    await page.goto('/')
    await cleanupAgents(page)

    // Spawn shell
    await tap(page, page.getByRole('button', { name: /^spawn$/i }).first())
    await page.getByText('Spawn lane').waitFor({ state: 'visible', timeout: 8_000 })
    const spawnMenu = page.locator('.backdrop-blur').filter({ hasText: 'Spawn lane' })
    await tap(page, spawnMenu.getByRole('button', { name: /^shell$/ }))
    await tap(page, spawnMenu.getByRole('button', { name: /spawn shell/i }))

    // Wait for terminal
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 20_000 })

    // Click terminal to focus
    await page.locator('.xterm-screen').first().click()

    // Send a distinctive echo command
    await page.keyboard.type('echo metis-e2e-ok\r')

    // Shell should echo it back in the terminal rows.
    // Use .first() because both the typed command and the output contain the string.
    await expect(
      page.locator('.xterm-rows').getByText('metis-e2e-ok').first(),
    ).toBeVisible({ timeout: 10_000 })
  })
})

// ── desktop layout (sanity) ───────────────────────────────────────────────────

test.describe('desktop layout', () => {
  // Override viewport for this group — runs correctly in both mobile and desktop projects
  test.use({ viewport: { width: 1440, height: 900 } })

  test('three-column layout renders on desktop', async ({ page }) => {
    await page.goto('/')
    // Both asides visible on desktop
    await expect(page.locator('aside').first()).toBeVisible()
    await expect(page.locator('aside').last()).toBeVisible()
    // Mobile toggles should be hidden on desktop
    await expect(page.getByTitle('Workspaces & files')).toBeHidden()
    await expect(page.getByTitle('Metis Assistant')).toBeHidden()
  })
})
