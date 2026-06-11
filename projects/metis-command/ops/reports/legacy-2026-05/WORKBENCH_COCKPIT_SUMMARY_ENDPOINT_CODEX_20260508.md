# Workbench Cockpit Summary Endpoint - Codex - 2026-05-08

## Scope

Implemented the smallest read-only cockpit summary API/data helper for all workspaces.

No push or deploy performed. No broad UI changes.

## Files Changed

- `lib/cockpit-summary.ts`
  - Added `buildCockpitSummary()`.
  - Fans out over workspace dispatch files via `listDispatchRuns()`.
  - Buckets agents by workspace, status, and kind.
  - Emits per-workspace latest run, recent runs, retryable failed spec counts, and close-recommendation primitives:
    - `reviewReadyAgentIds`: exited agents with `exitCode === 0` or no exit code.
    - `blockedAgentIds`: exited agents with non-zero exit code.
  - Reduces deterministic cockpit totals server-side.
  - Supports optional workspace selector filtering using `resolveWorkspaceSelector()`.

- `app/api/assistant/route.ts`
  - Added `GET /api/assistant?scope=cockpit`.
  - Added optional `workspace_ids=<csv>` and `runs_limit=<1..50>` handling.
  - Calls `ptyApi.listWorkspaces()` and `ptyApi.listAgents({ includeExited: true })` once, then delegates shaping to `buildCockpitSummary()`.
  - Added read-only assistant tool `get_cockpit_summary({ workspace_ids?: string[], runs_limit?: number })`.
  - Exempted `get_cockpit_summary` from dispatch-run mutation wrapping, like `get_dispatch_status`.

- `lib/tool-routing.ts`
  - Added `get_cockpit_summary` to the allowed tool names.
  - Added validation for optional `workspace_ids` string arrays and `runs_limit` integer range `1..50`.

- `tests/tool-routing.test.ts`
  - Added cockpit summary coverage for:
    - aggregate fan-out across workspaces,
    - mixed run-status totals,
    - retryable failed spec totals,
    - workspace selector filtering and error propagation,
    - close-recommendation buckets,
    - read-only invariance of dispatch-run files,
    - tool validation.

- `memory/working-context.md`
  - Checkpointed lane context and final verification.

## Verification

Passed:

- `npm run typecheck`
- `node --import tsx --test tests/tool-routing.test.ts`
  - 30 tests passed.

Not run:

- Broad lint was not requested and remains outside this lane.
- PTY lifecycle tests were not run; the cockpit tests use pure helpers and seeded dispatch files to avoid the known sandbox socket-bind blocker.
- Browser/UI smoke was not run because no UI surface was added.

## Blockers / Notes

- No hard blocker.
- `originWorkspaceId` is supported in the summary mapper when a run's stored `workspaceId` differs from the workspace block. With the current P2 storage model, cross-workspace dispatch runs are stored under the resolved target workspace, so this field is normally undefined.
- The endpoint returns selector errors with the same strings as `resolveWorkspaceSelector()`.
