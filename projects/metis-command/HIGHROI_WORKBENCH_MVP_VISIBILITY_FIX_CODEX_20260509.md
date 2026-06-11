# High-ROI Workbench MVP Visibility Fix - Codex - 2026-05-09

## Scope

Coordination lane for Agent Workbench MVP visibility after the update to avoid duplicating `NOW-workbench-fix-open-pane-focus`.

Owned work:

- B2 pane-level cockpit state visibility.
- Adjacent B1 review/test coverage where the current tree already contained the non-destructive `openAgentPane` shape.
- Focused verification only.

No push or deploy performed.

## Inputs Read

- `WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md`
- `WORKBENCH_BROWSER_SMOKE_RELEASE_BOUNDARY_CODEX_20260509.md`
- Current implementation in `components/Workbench.tsx`, `components/PaneGrid.tsx`, `lib/layout.ts`, `lib/cockpit-ui-state.ts`, and focused tests.

## What Changed

- `components/Workbench.tsx`
  - Added a read-only cockpit summary poll using the existing `/api/assistant?scope=cockpit` endpoint.
  - Passes the active workspace cockpit block into `PaneGrid`.
  - Did not broaden task tools or clear-pane behavior.

- `components/PaneGrid.tsx`
  - Adds compact per-pane pills beside the pane controls when the visible agent is:
    - `stale`
    - `report ready`
    - `ack'd`
  - Uses existing cockpit readiness/report data and keeps the title bar compact.

- `lib/cockpit-ui-state.ts`
  - Added pure `cockpitPaneStates(...)` helper for deriving pane pill state from a cockpit workspace block plus agent id.

- `lib/layout.ts`
  - Added `placeOrFocusAgent(...)` helper for focused tests and future callers: existing visible agents return their current leaf id; new agents use normal placement.

- `tests/tool-routing.test.ts`
  - Added focused coverage for:
    - no layout mutation when opening an already-visible agent,
    - filling an empty pane without evicting an occupied pane,
    - stale/report-ready/ack'd pane state derivation.

## B1 Coordination Note

On inspection, `components/Workbench.tsx` already contained the non-destructive `openAgentPane` pattern:

- focuses an existing leaf when the agent is already visible,
- otherwise calls `placeAgent(...)`,
- uses an empty leaf before replacing anything.

This lane did not replace that implementation. It added adjacent helper/test coverage.

## Verification

Passed:

```bash
npm run typecheck
```

Passed:

```bash
node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts
```

Result:

- 46 tests total
- 45 passed
- 1 skipped existing placeholder
- 0 failed

Browser smoke remains blocked before app code:

```bash
AW_SMOKE_TIMEOUT_MS=8000 npm run smoke:browser
```

Exact blocker:

```text
Error: listen EPERM: operation not permitted 127.0.0.1:3747
browser smoke Next exited early: code=1 signal=null
```

## Status

B2 is closed code-side with focused tests. B1 was already present in the tree and now has adjacent helper coverage. B3 remains sandbox-blocked for real browser rendering because the environment denies local bind on `127.0.0.1:3747`.
