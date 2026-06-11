---
name: QA UI
slug: qa-ui
version: 1.0.0
description: "Automated frontend QA — score a UI against docs/design-guidelines.md and report design-system violations. Tiered: static scan always runs; headless render escalates only when runtime rules are in question. Target (path or URL, optional): $ARGUMENTS"
---

TRIGGER when: you've built or changed any HTML/CSS/dashboard UI, before shipping a frontend change, or reviewing a page against the design system.
DO NOT trigger for: pure backend/logic changes, or a one-line copy edit with no style impact.

## Pre-flight
Resolve the target from `$ARGUMENTS`:
- **file path** → read it (and any linked CSS) directly. Default when empty: `projects/dashboard/index.html` + its `static/` CSS.
- **URL** → the live page for Tier 2 render. Dashboard runs on **Jay**: `http://<<MACHINE_1_TAILSCALE_IP>>:8080`.

Then read the rubric source of truth: `docs/design-guidelines.md` §11 (Implementation Checklist) and §10 (What to Avoid). Those sections are authoritative — if they change, this skill follows them.

## Step 1 — Tier 1 static scan (category A — always runs, zero-dep)
Grep/Read the source; record PASS / FAIL (+ `file:line`) per rule. See `design-rules-checklist.md` in this skill directory for the full rule table.

Core rules to check from source:
- Monospace fonts only (no Inter/Roboto/Arial/system-ui)
- No box-shadow for elevation on dark bg (top-border highlight is the correct method)
- Near-black bg `#0b0d14`, not pure black `#000000`
- 4px spacing grid (all padding/margin/gap px values divisible by 4)
- ≤4 semantic accent colors
- Cards have `id` attributes (breaks nav anchors if absent)
- T1 section labels are 9px / 700 weight / uppercase / muted color

## Step 2 — Tier 2 decide (category B — runtime-only, opt-in)
These require computed style / animation — they can't be confirmed from source alone:
- Gradient primary buttons render correctly; secondary uses ghost/border
- Live indicators carry a pulse animation
- Cards show the top-edge `border-hi` highlight + staggered entry animation
- Computed color contrast is adequate

If a render target exists AND a category-B rule is in question:
```bash
python3 -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('playwright') else 1)" 2>/dev/null \
  && echo "playwright available → render" \
  || echo "playwright absent → emit visual-confirm checklist"
```
- **Available** → render; read `getComputedStyle`; assert animation presence; record PASS/FAIL.
- **Absent** → emit a numbered visual-confirm checklist of category-B items for the human to eyeball. Mark them `DEFERRED (human)` in the scorecard — not silently skipped.

## Step 3 — Scorecard
```
QA-UI — <target>

A (static, auto)     <pass>/<total>
  ✓ monospace fonts
  ✗ near-black bg        index.html:12  (background:#000000 → use #0b0d14)
B (runtime)
  ✓ gradient buttons     (rendered)
  ⊘ stagger animation    DEFERRED (human) — confirm on <<MACHINE_1_TAILSCALE_IP>>:8080

Verdict: <N> violations · <D> deferred
```
Verdict is `clean` only when Tier 1 is fully PASS and no category-B item is FAIL (deferrals are allowed but noted).

## Step 4 — Hand off, don't commit
Surface violations; offer to fix the static ones if clear. Leave any commit to `/checkpoint`. Re-run `/qa-ui` after fixes to confirm a clean scorecard.
