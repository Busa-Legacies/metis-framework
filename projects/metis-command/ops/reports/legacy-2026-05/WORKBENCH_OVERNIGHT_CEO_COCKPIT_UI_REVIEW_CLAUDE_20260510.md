# Workbench Overnight CEO Cockpit UI Review - Claude - 2026-05-10 CT

## Rescue Note

- Rescued by Codex from preserved Claude scrollback at 2026-05-10 05:00 CDT.
- This is not a fresh browser review. It is a cleaned extraction of Claude lane `ag_u3oqjh7dst` from:
  `/Users/jarvis/.openclaw/workspace/ops/reports/overnight_agent_scrollbacks_20260510/OVN-WORKBENCH-ceo-cockpit-claude-ui-review_ag_u3oqjh7dst_tick0459_full.txt`
- Original Claude-written timestamp in scrollback: 2026-05-10 04:51 CDT.
- Source wire report read for context: `WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_WIRE_CODEX_20260510.md`.

## Scope

Reviewer-only, design-lens read of the overnight CEO cockpit UI wiring. No source was modified by the Claude review lane. Browser smoke was not attempted: per the prior wire report, the UI server at `127.0.0.1:3747` and PTY at `127.0.0.1:3748` were not running, and the review lane was forbidden from touching server or PTY lifecycle.

Static review only: visual rendering, hover tooltips, scroll behavior, and in-page color contrast were not verified end to end.

## Files Reviewed By Claude

- `WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_WIRE_CODEX_20260510.md`
- `components/AssistantPanel.tsx`
  - CEO block around lines 251-292.
  - Helpers around lines 160-196.
  - Drawer wrapper around lines 198-397.
- `lib/ceo-cockpit-view.ts`
- `tests/ceo-cockpit-view.test.ts`

## Verdict

Ship-with-polish. The wiring is correct, additive, and safe: pure derivation from already-loaded `cockpitSummary`, no new endpoints, no PTY changes, and no extra fetches. The helper contract is faithfully reflected in the chips. Bucket separation, including `starting` distinct from `inFlight` and intentionally merged in the UI rollup, is sound and well tested. As a v0 overnight digest it is usable.

Three issues keep it from being the "glance and go" surface a tired CEO/PMA needs at 03:00 CT:

1. It duplicates the existing workspace-state matrix about 50 px below it without clear differentiation.
2. Typography is below useful sizes for an overnight glance.
3. The branch column is deadweight until `gitByWorkspace` is plumbed through; every workspace currently reads `no repo`.

None of these are blockers. They are precise next-polish items.

## Issues

### Hierarchy And Duplication

1. CEO section and workspace-state section overlap. Both render per-workspace cards with stuck/review/blocked/unread chips, with the CEO block around lines 251-292 and workspace state around lines 294-343. For a single workspace, the user sees the same numbers twice within the same scroll viewport. The CEO section claims to be the headline digest, but its header uses the same visual weight as the workspace-state header. Nothing visually says "read this first."

2. There is no collapse or hide affordance. Both sections are always-open siblings, with no way to keep one and dismiss the other.

### Typography And Readability

3. Chip text is `text-[9px]`, roughly 7.5 pt at default zoom. That is below comfortable glance-read size and below what tired eyes track at distance. The CEO digest should be the largest, most glanceable thing in the drawer; today it is among the smallest.

4. The branch label combines `shrink-0` and `truncate`. These conflict: `shrink-0` blocks the flex child from shrinking, so `truncate` cannot engage. A long branch name such as `slice/summarize-portfolio-tool` can push the workspace name into the only thing that can shrink. Recommended shape: `min-w-0 max-w-[45%] truncate`.

5. `{n} test ev` reads like a typo at a glance. Use `{n} tests` or `{n} evidence`.

### Information Loss Versus Helper

6. `lastShippedAt` is computed but not surfaced. This is the highest-signal overnight field: did anything ship while I slept, and when? The helper sets it, but the UI ignores it.

7. Acknowledged data is dropped. The helper carries acknowledged counts per row, and the workspace-state section below shows an acknowledged chip. The CEO row does not, which is inconsistent and hides a real overnight state: items already triaged can be ignored.

8. `nextAction.severity` is computed but rendered as flat muted text. The next-actions section uses severity dots. The CEO row's `next:` line should use the same color cue; right now a severity-3 blocker reads the same as a severity-1 report-ready note.

9. Branch is always `no repo` in production today. `buildCeoCockpitView` is called with `{ summary }` only, so `gitByWorkspace` is never passed. Either suppress the label until git data is wired, or wire it.

### Interaction

10. Per-workspace bucket chips are non-interactive spans with hover-only titles. Agent names hide behind hover-only tooltips, which are invisible on touch, invisible to keyboard, and easy to miss. For a CEO drawer where the next move is "open the stuck one," chips should be focusable buttons that either inline-list names or open the matching agent pane via `onOpenAgent`.

11. There is no cwd peek beyond title hover. The workspace name has a title containing name and cwd, but the CEO card has no other path anchor such as open-folder or copy-path. The only path to "where on disk is this?" is hover.

### Empty And Degenerate States

12. Zero-state is unhandled. When all totals are zero, the totals row still renders four hard-coded zero chips: `0 approval`, `0 stuck`, `0 in flight`, `0 done`. For overnight use, this should collapse to a single all-clear row.

13. Workspace total is duplicated. The header already shows workspace and action counts; the CEO section repeats workspace count again. Drop the second count.

### Drawer Width

14. `max-w-[340px]` is tight for three stacked sections. On a 13-inch portrait dock or split screen, chips will wrap to two or three rows per card. Consider `max-w-[400px]` or making the CEO section a horizontal scroll strip rather than a card stack.

## Fit For Purpose: Nick / PMA Overnight Supervision

Strong fits:

- Read-only digest.
- No extra fetch.
- Totals-then-detail layout.
- Severity-aware next-action surfacing per workspace.
- `starting` versus `in_flight` separation, so a slow spawn does not masquerade as in-flight work.

Weak fits:

- Branch/git is the single fastest "did the agent actually push code?" signal at 03:00 CT, and it is currently `no repo` everywhere.
- Last-shipped time, the second-fastest signal, is computed and dropped.
- Rendered chips are too small and read-only; there is no one-click "ack the done one and go back to bed" flow.

## Precise Next Polish, Priority Order

1. Wire `gitByWorkspace` into `buildCeoCockpitView({ summary })` at `components/AssistantPanel.tsx:208`. Without this, the branch column remains visually broken.
2. Surface `lastShippedAt` as a small `shipped HH:MM CT` chip on each workspace card next to the branch label.
3. Bump typography one notch in the CEO section only: `text-[9px]` to `text-[10px]` for chips, `text-[10px]` to `text-[11px]` for body, and section header to `text-xs text-cyan-100/85` to match the drawer header. Leave the workspace-state section alone.
4. Apply `severityTone(ws.nextAction.severity)` to the `next:` line.
5. Add an acknowledged chip mirroring the workspace-state section, only when count is greater than zero.
6. Fix the `shrink-0 truncate` conflict on the branch label to `min-w-0 max-w-[45%] truncate`.
7. Make per-workspace bucket chips focusable buttons. Click should call `onOpenAgent(ws.workspaceId, firstAgentIdInBucket)`, with tab order following card order.
8. Replace `test ev` with `tests`.
9. Add a zero-state rollup: when `needsApproval + stuck + inFlight + starting + reportsUnread === 0`, render a single all-clear row.
10. Drop the duplicate `{ceoView.totals.workspaces} ws`.
11. Decide the CEO-to-workspace-state relationship. Either collapse workspace-state behind a default-closed disclosure when CEO is present, or drop the per-workspace card list from the CEO section and keep only totals, pushing detail to the existing matrix. Today they fight for the same real estate.

## Blocked Items

- Browser smoke remains blocked. UI on `127.0.0.1:3747` and PTY on `127.0.0.1:3748` were not running per the prior wire report, and the Claude lane was reviewer-only and forbidden from changing server/PTY lifecycle.
- Visual rendering of chips, hover tooltips, scroll behavior, and in-page color contrast remains unverified.
- Recommended follow-up: a lane allowed to start the dev server should capture a screenshot of the cockpit drawer with at least one workspace in each bucket: done, needs approval, stuck, and in flight, plus populated `gitByWorkspace`.

## Test Sanity

The 9-test suite in `tests/ceo-cockpit-view.test.ts` covers the helper contract: bucketing, totals, branch fallback, severity selection, last-output join, evidence and reports counts, and ASCII Telegram-safe one-liner. Helper coverage is good. There is no UI test for `AssistantPanel.tsx`'s CEO block, which is where most of the issues above sit. This is not a blocker for the slice.

## One-Line Verdict

Ship-with-polish: wiring is correct and safe, but typography is too small, the branch column is deadweight until `gitByWorkspace` is wired, and the CEO digest duplicates the workspace-state matrix below it without enough visual hierarchy. Browser smoke remains blocked because the servers were down and the lane forbade starting them.
