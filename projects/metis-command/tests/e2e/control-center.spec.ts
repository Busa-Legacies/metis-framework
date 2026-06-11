/**
 * Control Center shell smoke (PLAN M1-M3). Verifies the mode nav and the native
 * Overview surface render independent of dashboard-backend health (header
 * renders before data loads). The transitional Native/Legacy toggle was retired
 * once native Overview reached parity (PLAN §7.6).
 */
import { test, expect } from '@playwright/test'

/** Click a top-level mode nav button — whichever instance is visible on this
 * viewport (desktop rail vs mobile bottom bar; both carry the same aria-label). */
async function nav(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('button', { name, exact: true }).locator('visible=true').first().click()
}


test.describe('control center shell', () => {
  test('default mode is Agents (Workbench preserved)', async ({ page }) => {
    await page.goto('/')
    // Workbench owns the main landmark; Spawn proves the Agents surface controls are mounted.
    await expect(page.locator('main')).toBeVisible()
    await expect(page.getByRole('button', { name: /^spawn$/i }).first()).toBeVisible()
  })

  test('Overview mode shows the native summary (legacy iframe retired)', async ({ page }) => {
    await page.goto('/')
    await nav(page, 'Overview')

    // Native view renders its container regardless of backend reachability.
    const overview = page.getByTestId('overview-mode')
    await expect(overview).toBeVisible()
    await expect(overview.getByText('Overview', { exact: true })).toBeVisible()
    await expect(overview.getByText('native', { exact: true })).toBeVisible()

    // The retired strangler toggle: no Legacy embed remains.
    await expect(page.getByRole('button', { name: 'Legacy' })).toHaveCount(0)
  })

  test('Work mode renders the summary-first work surface', async ({ page }) => {
    await page.goto('/')
    await nav(page, 'Work')
    await expect(page.getByTestId('work-mode')).toBeVisible()
    await expect(page.getByRole('button', { name: /Needs You/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Plan$/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Tasks$/i })).toBeVisible()
  })

  test('Work Plan subview renders the task spine surface', async ({ page }) => {
    await page.goto('/')
    await nav(page, 'Work')
    await page.getByRole('button', { name: /^Plan$/i }).click()
    // Mode shell renders regardless of backend reachability (data fills in async).
    await expect(page.getByTestId('work-graph')).toBeVisible()
  })

  test('Work Tasks subview renders the governed task board', async ({ page }) => {
    await page.goto('/')
    await nav(page, 'Work')
    await page.getByRole('button', { name: /^Tasks$/i }).click()
    // Header and search bar render before data loads.
    const tasks = page.getByTestId('tasks-mode')
    await expect(tasks).toBeVisible()
    await expect(tasks.getByText('Tasks', { exact: true })).toBeVisible()
    await expect(tasks.getByPlaceholder(/search/i)).toBeVisible()
  })

  test('Work Review subview renders with Dev/Content tracks', async ({ page }) => {
    await page.goto('/')
    await nav(page, 'Work')
    await page.getByRole('button', { name: /^Review$/i }).click()
    await expect(page.getByTestId('review-mode')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Dev Review' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Content' })).toBeVisible()
  })

  test('Usage and Ops modes render (last placeholders retired)', async ({ page }) => {
    await page.goto('/')
    await nav(page, 'Usage')
    await expect(page.getByTestId('usage-mode')).toBeVisible()
    await nav(page, 'Ops')
    await expect(page.getByTestId('ops-mode')).toBeVisible()
  })

  test('Settings mode renders (last placeholder retired)', async ({ page }) => {
    await page.goto('/')
    await nav(page, 'Settings')
    await expect(page.getByTestId('settings-mode')).toBeVisible()
  })

  test('Personal mode renders (life-management surface, §7.6)', async ({ page }) => {
    await page.goto('/')
    await nav(page, 'Personal')
    // Shell renders before data; cards fill in async from /api/all.
    await expect(page.getByTestId('personal-mode')).toBeVisible()
  })

  test('Overview Native resolves out of its loading state (regression: stuck-on-loading)', async ({ page }) => {
    // The 2026-06-09 defect: per-mode pollers thundering-herded /api/all and the
    // aggregate rebuilt inline for 15-40s, so Native showed "loading overview…"
    // forever. Correct behavior is the loading state RESOLVING — into cards when
    // the backend is up, or the explicit CardError when it isn't. Stuck loading
    // is the only failure mode this guards against, so it runs backend-agnostic.
    await page.goto('/')
    await nav(page, 'Overview')
    await expect(page.getByText('loading overview…')).toBeHidden({ timeout: 30000 })
  })

  test('Annotate tool: entry on every mode except Agents, opens page-scoped chat', async ({ page }) => {
    await page.goto('/')
    await nav(page, 'Work')
    await page.getByRole('button', { name: /^Tasks$/i }).click()
    // One entry per viewport: mobile = FAB (thumb zone), desktop = header
    // trigger in the old refresh-button slot (refresh removed — pages poll).
    const entry = page.locator('[data-testid="annotate-fab"], [data-testid="annotate-trigger"]').locator('visible=true').first()
    await expect(entry).toBeVisible()

    await entry.click()
    const panel = page.getByTestId('annotate-panel')
    await expect(panel).toBeVisible()
    // Panel is scoped to the current page.
    await expect(panel.getByText(/about: Work/)).toBeVisible()
    await panel.getByLabel('close annotate').click()
    await expect(panel).toBeHidden()

    // Workbench has the full Assistant — no duplicate entry point there.
    await nav(page, 'Agents')
    await expect(page.getByTestId('annotate-fab')).toBeHidden()

    // The redundant per-page data-refresh buttons are gone (Review's iframe
    // reload is the deliberate exception).
    await nav(page, 'Ops')
    await expect(page.getByTestId('ops-mode').getByRole('button', { name: /refresh/i })).toHaveCount(0)
  })

  test('Work Needs You subview exposes sorting controls', async ({ page }) => {
    await page.goto('/')
    await nav(page, 'Work')
    await page.getByRole('button', { name: /Needs You/i }).click()
    await expect(page.getByTestId('inbox-mode')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Priority' })).toBeVisible()
    await page.getByRole('button', { name: 'Newest' }).click()
    await expect(page.getByRole('button', { name: 'Newest' })).toBeVisible()
  })
})
