/**
 * Mobile-friendliness benchmark for the Control Center (phone viewport).
 * Measures: load timing, per-mode switch latency, tap-target compliance
 * (44px iOS guideline), and an effective-text-size audit. Run:
 *   node scripts/mobile-bench.mjs [url]
 */
import { chromium } from 'playwright'

const URL = process.argv[2] ?? 'http://localhost:3747'
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

const t0 = Date.now()
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
const dcl = Date.now() - t0
await p.waitForTimeout(2500)

// per-mode switch latency (tap → mode testid visible)
const MODES = [['Overview', 'overview-mode'], ['Work', 'work-mode'], ['Usage', 'usage-mode'], ['Ops', 'ops-mode'], ['Personal', 'personal-mode'], ['Settings', 'settings-mode']]
const switches = {}
for (const [name, tid] of MODES) {
  const s = Date.now()
  await p.getByRole('button', { name, exact: true }).locator('visible=true').first().tap({ timeout: 15000 })
  await p.getByTestId(tid).waitFor({ state: 'visible', timeout: 15000 })
  switches[name] = Date.now() - s
}

// audits run against the Personal mode (dense data surface) + bottom nav
const audit = await p.evaluate(() => {
  const interactive = [...document.querySelectorAll('button, a, [role="button"]')].filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight
  })
  const small = interactive.filter((el) => { const r = el.getBoundingClientRect(); return r.height < 44 || r.width < 44 })
  const texts = [...document.querySelectorAll('span, p, div, td, li, h1, h2, h3')].filter((el) => {
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.bottom > 0 && r.top < innerHeight
  })
  const sizes = texts.map((el) => parseFloat(getComputedStyle(el).fontSize))
  const tiny = sizes.filter((s) => s < 12).length
  const nav = document.querySelector('nav.md\\:hidden, nav[class*="md:hidden"]')
  const navRect = nav ? nav.getBoundingClientRect() : null
  const navBtn = nav ? nav.querySelector('button')?.getBoundingClientRect() : null
  return {
    interactiveCount: interactive.length,
    smallTargets: small.length,
    smallPct: Math.round((small.length / Math.max(1, interactive.length)) * 100),
    textNodes: sizes.length,
    tinyText: tiny,
    tinyPct: Math.round((tiny / Math.max(1, sizes.length)) * 100),
    medianFont: sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] ?? 0,
    navHeight: navRect ? Math.round(navRect.height) : null,
    navBtnH: navBtn ? Math.round(navBtn.height) : null,
    navGapToBottom: navRect ? Math.round(innerHeight - navRect.bottom) : null,
  }
})

console.log(JSON.stringify({ dclMs: dcl, switchesMs: switches, ...audit }, null, 1))
await b.close()
