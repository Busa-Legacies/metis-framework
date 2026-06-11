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
