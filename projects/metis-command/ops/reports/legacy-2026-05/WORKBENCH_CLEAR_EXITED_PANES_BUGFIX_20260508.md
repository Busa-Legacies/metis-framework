# Workbench Clear Exited Panes Bugfix - 2026-05-08

## Summary

Fixed stale exited panes remaining visible after clearing exited agents. The root cause was that `clearExitedAgents` only deleted persisted `outputTails` records whose ids were not present in the in-memory `agents` map. Runtime agents that had already exited stayed in `agents`, so they were treated as live ids and remained visible.

## Changes

- Updated `server/pty-server.ts` `clearExitedAgents` to:
  - Reconcile process health before clearing.
  - Remove runtime agents only when `agent.meta.status === 'exited'`.
  - Respect the optional `workspaceId` filter for runtime and persisted records.
  - Delete matching persisted `outputTails`.
  - Never signal or kill running agents.
- Updated `killAgent` so `DELETE /agents/:id` removes already-exited runtime agents immediately, including their `outputTails`, without sending process signals.
- Moved the `DELETE /agents/:id` route before the generic missing-runtime 404 so persisted-only exited output tails can be deleted through the existing `killAgent` path.

## Tests

- Added `PTY server clear exited removes runtime panes without killing running agents`.
  - Spawns one short-lived exited agent and one long-running agent in the same workspace.
  - Calls `DELETE /agents/exited?workspaceId=...`.
  - Verifies the exited agent disappears and the running agent remains alive.
- Added `PTY server DELETE removes an already-exited runtime agent`.
  - Spawns a short-lived agent.
  - Waits until it is visible as `exited`.
  - Calls `DELETE /agents/:id`.
  - Verifies it disappears from agent listing and scrollback is removed.

## Verification

- `npm run typecheck` passed.
- `node --import tsx --test tests/tool-routing.test.ts` passed: 14 tests.
- `node --import tsx --test tests/pty-server-lifecycle.test.ts` was attempted but blocked by the sandbox before application code ran:
  - `listen EPERM: operation not permitted 127.0.0.1`
  - This matches the known PTY/local networking sandbox limitation for this repo.

No GitHub push was performed.
