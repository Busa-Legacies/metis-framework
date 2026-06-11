# Workbench MVP Source Reconcile - Codex - 2026-05-09

## Scope

- Work only in `Projects/agent-workbench`.
- Reconcile conflicting B1/B2 reports against actual source.
- Inspect `components/Workbench.tsx`, `lib/layout.ts`, and `components/PaneGrid.tsx`.
- Implement remaining B2 ack/stale/report-ready pane pill only if not already landed.
- Run focused tests and typecheck.
- No push or deploy.

## Milestones

1. Loaded required Jarvis operating context and current Workbench session memory.
2. Inspected actual source in `components/Workbench.tsx`, `lib/layout.ts`, `components/PaneGrid.tsx`, and `lib/cockpit-ui-state.ts`.
3. Compared source against stale Claude acceptance-review claims.
4. Ran focused verification.
5. Updated durable context in `memory/working-context.md`.

## Reconciliation Verdict

Claude acceptance review was stale relative to the current source.

### B1 - `openAgentPane` Destructive Placement

Status: **already fixed in source**.

Evidence:

- `components/Workbench.tsx:304` defines `openAgentPane`.
- `components/Workbench.tsx:308-311` checks whether the requested agent is already visible and focuses that existing leaf without changing layout.
- `components/Workbench.tsx:313-316` calls `placeAgent(rootForWs, agentId, activeLeafId ?? undefined)`, then focuses the placed leaf.
- `lib/layout.ts:59-72` has idempotent `placeAgent`: already-visible agents return the original root, empty leaves are filled before fallback replacement.

Result: the stale reported source path that unconditionally assigned leaf 0 is no longer present.

### B2 - Per-Pane Ack/Stale/Report-Ready Pill

Status: **already fixed in source**.

Evidence:

- `components/PaneGrid.tsx:109` derives `paneStates` from `cockpitPaneStates(cockpitWorkspace, agent?.id)`.
- `components/PaneGrid.tsx:166-170` renders pane-title pills for every returned state.
- `components/PaneGrid.tsx:229-232` styles stale/report-ready/acked tones.
- `lib/cockpit-ui-state.ts:76-88` returns:
  - `stale` for `readiness.staleRunningAgentIds`.
  - `report ready` for unread reports attributed to the agent.
  - `ack'd` for `readiness.acknowledgedAgentIds`.

Result: no remaining B2 implementation was needed.

## Code Changes

No application source changes were required. The current source already contains the B1 and B2 fixes.

Files changed in this reconciliation lane:

- `memory/working-context.md` - durable checkpoint.
- `WORKBENCH_MVP_SOURCE_RECONCILE_CODEX_20260509.md` - this report.

## Verification

Commands run:

```bash
npm run typecheck
node --import tsx --test tests/workbench-layout.test.ts tests/cockpit-continuity.test.ts tests/tool-routing.test.ts
```

Results:

- `npm run typecheck` passed.
- Focused tests passed: 47 passed, 1 skipped, 0 failed.

## Remaining Gate

B3 remains outside this lane: real-browser smoke still needs a non-sandbox environment where local port binding is allowed, or a human eyes-on pass using the packaged smoke harness. No push/deploy was performed.
