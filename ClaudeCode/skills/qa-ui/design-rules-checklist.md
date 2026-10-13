# Design Rules Checklist — /qa-ui

Authoritative source: `docs/design-guidelines.md` §10 (What to Avoid) and §11 (Implementation Checklist). This file is a quick-reference extract — always reconcile against the source if they diverge.

## Category A — Static scan (checkable from source text)

| Rule | How to grep/check | FAIL signal |
|---|---|---|
| Monospace fonts only | `font-family` declarations | Any `Inter`, `Roboto`, `Arial`, `system-ui`; missing SF Mono/Fira Code/JetBrains Mono |
| No shadow-for-elevation | `box-shadow` | `box-shadow` used to lift a surface on dark bg (top-border highlight is the correct method) |
| Near-black bg, not pure black | `#000000` / `#000\b` / `rgb(0,0,0)` | Pure black background instead of `#0b0d14` |
| 4px spacing grid | `padding`/`margin`/`gap` px values | A value not divisible by 4 |
| ≤4 semantic accent colors | Distinct accent/semantic hex values | More than 4 (green/red/yellow/blue is the budget) |
| Cards have `id` | Card/panel class blocks | A card element with no `id` (breaks nav anchors) |
| T1 section labels | Section-label styles | Label not 9px / 700 weight / uppercase / muted color |

## Category B — Runtime-only (need computed style or animation observation)

| Rule | Check method | Notes |
|---|---|---|
| Gradient primary buttons render | `getComputedStyle` on `.btn-primary` | Should show a gradient background, not flat |
| Ghost/border secondary buttons | `getComputedStyle` on `.btn-secondary` | Should be transparent bg with border |
| Live indicators pulse | Animation presence check | `.indicator-live` or similar should have a CSS animation |
| Top-edge card highlight | Computed `border-top` | Cards should show `border-top: 1px solid var(--border-hi)` |
| Staggered card entry | Animation check | Cards should animate in with staggered delay on page load |
| Adequate color contrast | Contrast ratio calculation | Text on surfaces should meet WCAG AA (4.5:1) |

## Surface elevation system (reference)
```
--bg        #0b0d14   page background
--surface   #12151f   card / panel level 1
--surface2  #1a1e2e   nested / active state
--surface3  #222842   tooltip / overlay
```
Cards must use `border-top: 1px solid var(--border-hi)` for elevation — not `box-shadow`.

## Typography tiers (reference)
- T1 (section labels): 9px / 700 / uppercase / `var(--text-muted)` / 1.5px letter-spacing
- T2 (primary content): 14px / 400–500 / `var(--text-primary)`
- T3 (meta/secondary): 12px / 400 / `var(--text-secondary)`

## Color budget (reference)
- Accent/indigo: `#6366f1` (primary interactive)
- Success/green: `#22c55e`
- Warning/yellow: `#eab308`
- Error/red: `#ef4444`
- No additional semantic colors beyond these four.

## Font stack (reference)
```css
font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace;
```
Never: `Inter`, `Roboto`, `Arial`, `Helvetica`, `system-ui`, `-apple-system`.

## Category C — AI-slop anti-pattern rules (#979, from Impeccable CLI v3.3.0)
Source: `github.com/pbakaus/impeccable`, diffed `cli-v3.2.0` → `cli-v3.3.0`
(`cli/engine/registry/antipatterns.mjs`). These are general AI-generated-UI tells,
not metis-specific — they apply on top of Category A/B above, on any target.

### C1 — static-checkable (fold into Step 1 grep pass)
| Rule | How to grep/check | FAIL signal |
|---|---|---|
| Decorative blinking cursor | `@keyframes` named blink/caret/cursor + hero/landing markup | Animated fake text-cursor outside a real input field (advisory) |
| Off-ramp font size | Literal `font-size` values vs documented type ramp | A size not in the T1(9px)/T2(14px)/T3(12px) ramp (§ Typography tiers above) |
| Auto-scrolling marquee | `<marquee>`, `animation: scroll`/`marquee`, infinite-loop keyframes on a logo/text strip | Continuously auto-scrolling content with no user control |
| Decorative pulsing status dot | `@keyframes pulse` on a small dot element | Pulse animation on an indicator not wired to genuinely live/changing data |
| Radial-gradient background halo | `radial-gradient(` in a background on a dark surface | Saturated-center-to-transparent chromatic wash used as ambient glow |
| Repeated container text | Same literal string 3+ times inside one card/panel block | Redundant label/status baked into every slot of a template |
| Shape-assembled illustration | Large inline `<svg>` with many `<circle>/<rect>/<path>` primitives in a hero | Hero-scale "illustration" built from primitive shapes instead of real artwork |
| Heading rhythm | Compare heading `margin-top` vs `margin-bottom` in CSS | Space above a heading ≤ space below it — section reads as captioning the block above |

### C2 — render-confirm (Step 2 category B, opt-in)
| Rule | Check method | FAIL signal |
|---|---|---|
| Content invisible at rest | Compute visibility after reveal handlers settle | Text stuck at `opacity:0`/`visibility:hidden` — failed-reveal signature |
| Cards flush against scroller edge | Rendered inset on both sides of a horizontal scroller | Cards flush on one edge, gutter on the other — panel wider than its clip box |
| First-viewport column overflow | Rendered height of sibling columns in the opening section | One column runs far past the fold while its sibling fits in one viewport |
| Uncaught script error on load | Console/page-error listener during render | Any uncaught JS exception — fix before judging anything else, can hide most of the page |
| Text occluded by overlap | Rendered bounding-box overlap between text and an opaque layer | Text partially painted under a box/second text run |

### Diversity check — adapted from Impeccable v4's direction-by-dice (not installed as a tool)
Impeccable v4 (`skill-v4.0.2`) forces design-space diversity for *generation* by rolling a
seed against 188 reviewed "worlds" and dealing 6 challengers, so a single model pass can't
converge on the same three fonts and a cream background. We don't run the actual seed+roll
CLI here (`/qa-ui` is a scorer, not a generator) — the transferable principle is: **a Tier 2
subjective/taste call from a single pass is a converged opinion, not a verdict.** When a
category-B item is genuinely a judgment call (not a hard rule), note in the scorecard that it
reflects one read and, where feasible, sanity-check it against at least one alternative
treatment before marking `DEFERRED (human)` or PASS — don't let a single-pass read stand in
for taste-diversity the way a seeded challenger set would.
