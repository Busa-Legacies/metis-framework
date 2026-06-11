# Workbench Regression Gap Tests - 2026-05-08

## Scope

Shield QA follow-up for the two non-blocking test gaps from `WORKBENCH_CLAUDE_CONTROL_PLANE_QA_20260508.md`:

1. `POST /workspaces/:id/resume` still works after `DELETE /agents/exited?workspaceId=...`.
2. Clearing exited agents in one workspace does not clear exited agents in another workspace.

No push or deploy performed.

## Changes

- Updated `tests/pty-server-lifecycle.test.ts`.
- Added `PTY server resume still works after clearing exited agents in a workspace`.
  - Spawns a short-lived custom agent.
  - Waits for it to enter `exited`.
  - Confirms the workspace resume spec exists.
  - Calls `DELETE /agents/exited?workspaceId=<workspace>`.
  - Confirms the tombstone is gone but the resume spec remains.
  - Calls `POST /workspaces/<workspace>/resume` and asserts the saved agent spec spawns again.
- Added `PTY server clear exited is scoped to the requested workspace`.
  - Creates two workspaces with separate cwd roots.
  - Spawns one short-lived custom agent in each workspace.
  - Waits for both to enter `exited`.
  - Calls `DELETE /agents/exited?workspaceId=<ws1>`.
  - Confirms ws1's exited agent is removed and ws2's exited agent plus scrollback remain.

No server code changes were needed.

## Verification

- `npm run typecheck` - pass.
- `node --import tsx --test tests/tool-routing.test.ts` - pass, 14 / 14.
- `node --import tsx --test tests/pty-server-lifecycle.test.ts` - blocked by sandbox before application code ran.
  - Failure: `listen EPERM: operation not permitted 127.0.0.1`.
  - All 7 lifecycle tests failed at the `freePort()` local socket bind step, including pre-existing tests, so this does not indicate an application regression.

## Result

Both QA gap tests have been added and are targeted to the PTY lifecycle test suite. The only incomplete verification is the known local socket bind restriction in this sandbox environment.
