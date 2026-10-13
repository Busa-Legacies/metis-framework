---
name: QA UI
slug: qa-ui
version: 1.0.0
description: "Automated frontend QA — score a UI against docs/design-guidelines.md and report design-system violations. Tiered: static scan always runs; headless render escalates only when runtime rules are in question."
argument-hint: "[path or URL (optional)]"
---

TRIGGER when: you've built or changed any HTML/CSS/dashboard UI, before shipping a frontend change, or reviewing a page against the design system.
DO NOT trigger for: pure backend/logic changes, or a one-line copy edit with no style impact.

## Done-claim gate (#520 — freshness + viewport, read FIRST)
Ant repeatedly catches UI fixes reported done that are still broken on his device — including a
case where the "evidence" screenshot itself showed the unfixed bug. So a UI change may be reported
**done only** when ALL hold:
1. **Post-change render** — the screenshot's mtime is **after** the changed file's mtime (it shows
   the code as edited, not a stale/plan-phase render). Re-render after the *final* edit, not a
   mid-edit one.
2. **Reported viewport** — rendered at the width the bug was reported at: **~390px** when Ant
   flagged it on his phone; otherwise the width he named. A desktop render does not clear a mobile
   bug.
3. **Inspected, not assumed** — you actually looked at the render and the specific reported element
   is fixed; an "evidence" image that still shows the defect is a **FAIL**, not a pass.
4. **Ant's motion environment** — Ant runs OS **Reduce Motion ON**. Any animation/motion change must
   also be verified with `reducedMotion: 'reduce'` emulation (Playwright context option) — a
   motion-on-only render repeatedly passed "fixes" that were completely static on his device
   (2026-07-15 boot compass: three fix rounds burned). Policy: "calm workspace, lively moments" —
   ambient chrome honors the flag; intentional moments (boot, room transitions) play under it
   (design-guidelines §0.7).

State the viewport + "render post-dates the edit" in the `Verified:` line. If the live app is
token-gated (a genuine blocker), a **faithful post-change mock at the reported width** is the
fallback — never a pre-change or wrong-viewport image. This gate is the done-bar; the tiered scan
below is the design-system score.

## Behavior gate (ghost controls, Ant 2026-10-08)
A screenshot proves a control RENDERS, never that it WORKS. Any button, toggle, picker, form, or
tap target in scope must be exercised on the live path: click/tap it (Playwright, mobile emulation
for phone surfaces, through the same auth the real user hits) and assert its effect (request 2xx,
state changed, session spawned, view navigated). Record the action and observed effect in the
task's verificationMethod. The done gate (`ghost_control_violation` in scripts/lib/tier1_state_ops.py)
refuses UI-control tasks whose verificationMethod has no behavioral proof; deliberately visual-only
work states `[render-only: <why no behavior applies>]`. Origin: the mobile New Session button
closed on a screenshot and never started a session.

## Pre-flight
Resolve the target from `$ARGUMENTS`:
- **file path** → read it (and any linked CSS) directly. (No static-HTML default anymore: the dashboard is a served app, `projects/dashboard/index.html` was retired.)
- **URL** → the live page for Tier 2 render. Dashboard runs on **<<MACHINE_1_ID>>**: `http://<<MACHINE_1_ID>>.<<TAILNET_DOMAIN>>:8080` (this is the **default when empty** now that there is no static index.html).

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

Also run **Category C1** (AI-slop anti-patterns, static-checkable — see `design-rules-checklist.md`
§Category C): blinking cursors, off-ramp font sizes, marquees, decorative pulsing dots, radial
background halos, repeated container text, shape-assembled illustrations, heading rhythm.

## Step 2 — Tier 2 decide (category B — runtime-only, opt-in)
These require computed style / animation — they can't be confirmed from source alone:
- Gradient primary buttons render correctly; secondary uses ghost/border
- Live indicators carry a pulse animation
- Cards show the top-edge `border-hi` highlight + staggered entry animation
- Computed color contrast is adequate

Also run **Category C2** (AI-slop anti-patterns, render-confirm — see `design-rules-checklist.md`
§Category C): content invisible at rest, edge-flush scroller cards, first-viewport column
overflow, uncaught script errors on load, text occluded by an overlapping element.

For any category-B item that's a genuine taste call (not a hard pass/fail rule), apply the
**diversity check** in `design-rules-checklist.md` §Diversity check before recording a verdict —
a single-pass read is a converged opinion, not ground truth.

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
C1 (AI-slop, static)  <pass>/<total>
  ✗ radial background halo  index.html:40  (radial-gradient glow behind hero)
B (runtime)
  ✓ gradient buttons     (rendered)
  ⊘ stagger animation    DEFERRED (human) — confirm on <<MACHINE_1_ID>>.<<TAILNET_DOMAIN>>:8080
C2 (AI-slop, render-confirm)
  ✓ no content hidden at rest
  ⊘ text occlusion       DEFERRED (human) — confirm on render

Verdict: <N> violations · <D> deferred
```
Verdict is `clean` only when Tier 1 is fully PASS and no category-B item is FAIL (deferrals are allowed but noted).

## Step 4 — Hand off, don't commit
Surface violations; offer to fix the static ones if clear. Leave any commit to `/checkpoint`. Re-run `/qa-ui` after fixes to confirm a clean scorecard.
