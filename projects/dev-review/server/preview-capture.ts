/**
 * Headless capture/verify for the review console (#256, + the headless verify
 * endpoint deferred out of #258).
 *
 * Uses playwright-core (no bundled browser): launches system Chrome
 * (`channel: 'chrome'`) and falls back to the newest python-playwright-managed
 * Chromium in ~/Library/Caches/ms-playwright. Loads the TARGET url directly —
 * headless capture needs no same-origin proxy. Localhost dev targets only
 * (project scope); no auth/cookie replication.
 *
 * Browser is a lazy singleton with an idle close (a launch costs ~1s; pin
 * bursts shouldn't pay it per crop, an idle console shouldn't hold Chrome).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright-core'

const DATA_DIR = process.env.AW_DATA_DIR ?? path.join(os.homedir(), '.openclaw', 'dev-review')
const CROPS_DIR = path.join(DATA_DIR, 'crops')
const IDLE_CLOSE_MS = 30_000
const GOTO_TIMEOUT_MS = 15_000
const SELECTOR_TIMEOUT_MS = 5_000

/** Same slug scheme as the session files (app/api/reviews) — crops sit beside them. */
export function slugFor(url: string): string | null {
  try {
    const u = new URL(url)
    const raw = `${u.hostname}-${u.port || 'default'}${u.pathname}`
    return raw.replace(/\/+$/, '').replace(/[^a-zA-Z0-9.-]+/g, '_') || null
  } catch {
    return null
  }
}

function newestManagedChromium(): string | null {
  const root = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
  try {
    const dirs = fs.readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    for (const d of dirs) {
      for (const rel of [
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
      ]) {
        const exe = path.join(root, d, rel)
        if (fs.existsSync(exe)) return exe
      }
    }
  } catch {}
  return null
}

let browser: Browser | null = null
let idleTimer: NodeJS.Timeout | null = null

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  } catch {
    const exe = newestManagedChromium()
    if (!exe) {
      throw new Error('no usable Chromium: install Google Chrome or run `python3 -m playwright install chromium`')
    }
    browser = await chromium.launch({ executablePath: exe, headless: true })
  }
  return browser
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    const b = browser
    browser = null
    b?.close().catch(() => {})
  }, IDLE_CLOSE_MS)
  idleTimer.unref?.()
}

/** Element screenshot for one annotation → PNG beside the session artifact. */
export async function captureCrop(input: { url: string; selector: string; annotationId: string }): Promise<{ path: string }> {
  const slug = slugFor(input.url)
  if (!slug) throw new Error(`bad url: ${input.url}`)
  if (!/^[\w-]+$/.test(input.annotationId)) throw new Error('bad annotationId')
  const b = await getBrowser()
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } })
  try {
    const page = await ctx.newPage()
    await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
    const loc = page.locator(input.selector).first()
    await loc.waitFor({ state: 'visible', timeout: SELECTOR_TIMEOUT_MS })
    const dir = path.join(CROPS_DIR, slug)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${input.annotationId}.png`)
    await loc.screenshot({ path: file, timeout: SELECTOR_TIMEOUT_MS })
    return { path: file }
  } finally {
    await ctx.close().catch(() => {})
    scheduleIdleClose()
  }
}

/** Headless selector verification (#258 follow-up): match counts per check. */
export async function verifySelectors(input: { url: string; checks: { id: string; selector: string }[] }):
  Promise<{ id: string; matches: number }[]> {
  const b = await getBrowser()
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } })
  try {
    const page = await ctx.newPage()
    await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: GOTO_TIMEOUT_MS })
    const results: { id: string; matches: number }[] = []
    for (const c of input.checks) {
      let matches = 0
      try { matches = await page.locator(c.selector).count() } catch { matches = 0 }
      results.push({ id: c.id, matches })
    }
    return results
  } finally {
    await ctx.close().catch(() => {})
    scheduleIdleClose()
  }
}

/** Resolve a served crop path safely (GET /preview/crops/<slug>/<file>). */
export function cropFileFor(slug: string, file: string): string | null {
  if (!/^[\w.-]+$/.test(slug) || !/^[\w-]+\.png$/.test(file)) return null
  const full = path.join(CROPS_DIR, slug, file)
  return full.startsWith(CROPS_DIR) && fs.existsSync(full) ? full : null
}
