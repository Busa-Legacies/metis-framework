# Workbench Visible Cockpit Next - Codex - 2026-05-09

## Scope

Implemented the next visible cockpit/control-plane slice on top of the existing cockpit summary and next-action drawer.

Goal: Nick can open one cockpit drawer and see every workspace's agent state immediately, not only the subset with queued actions.

No push or deploy performed.

## What Changed

- `lib/cockpit-ui-state.ts`
  - Added `CockpitWorkspaceHealth` buckets: `blocked`, `attention`, `active`, `clean`, `empty`.
  - Added `getCockpitWorkspaceMatrix(summary)` to produce one deterministic row per workspace.
  - Matrix rows include action count, unread report count, total attention count, kind summary, health, and latest unread report path.

- `components/AssistantPanel.tsx`
  - Added a "workspace state" matrix at the top of the cockpit drawer.
  - Every workspace now appears, including idle/empty workspaces with no queued action.
  - Each row shows:
    - health badge
    - workspace name and cwd tooltip
    - running/exited counts
    - agent-kind mix
    - latest run status
    - blocked/stale/review/unknown/retryable/report/acked chips
    - latest unread report open action
  - Preserved the existing next-action queue below the matrix.
  - Kept cockpit actions non-destructive: no clear/delete path was added.

- `tests/tool-routing.test.ts`
  - Added coverage that the matrix includes all workspaces, including idle ones.
  - Verifies blocked/attention/empty health classification, kind summary, unread report count, and latest unread report path.

- `memory/working-context.md`
  - Checkpointed the lane state for compaction continuity.

## Verification

Passed:

- `npm run typecheck`
- `node --import tsx --test tests/tool-routing.test.ts`
  - 38 tests total: 37 passed, 1 existing skipped placeholder.

Blocked / Not Fully Available:

- `npm run dev:web`
  - Blocked before app code by sandbox bind denial:
  - `listen EPERM: operation not permitted 0.0.0.0:3747`

Known Existing Lint Debt:

- `npx eslint components/AssistantPanel.tsx lib/cockpit-ui-state.ts tests/tool-routing.test.ts`
  - Still fails on pre-existing `AssistantPanel.tsx` issues:
    - `no-explicit-any`
    - existing hook dependency warnings
    - existing placeholder quote escaping
  - New cockpit matrix code typechecks and the added focused tests pass.

## Operator Notes

- The compact cockpit disclosure still gives top-level counts.
- Opening the drawer now shows a true multi-workspace control-plane view first, then the actionable queue.
- The visible invariant remains intact: cockpit read/ack/wake/report-open affordances do not silently clear panes.
