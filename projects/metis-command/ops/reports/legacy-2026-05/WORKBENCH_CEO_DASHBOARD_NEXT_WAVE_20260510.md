# Workbench CEO Dashboard Next Wave - 2026-05-10

## Scope

Built the next CEO dashboard slice in the existing pure cockpit view model instead of adding a second dashboard data path.

The slice summarizes agents by workspace with:

- Workspace agent counts: `running`, `exited`, and `completed`.
- Per-agent dashboard rows from existing cockpit state.
- Latest output and last output timestamp when agent metadata is provided.
- Current task title/status from `Agent.taskId` or `Task.ownerId`.
- Latest report path attributed to the agent.
- Close/recycle recommendation:
  - `close` for clean completed or unknown-exit agents.
  - `recycle` for blocked or stale agents.
  - `none` for running or starting agents.

## Code Changed

- `lib/ceo-cockpit-view.ts`
  - Added `CeoWorkspaceAgentCounts`.
  - Added `CeoCurrentTask`.
  - Added `CeoLifecycleAction`.
  - Extended `CeoAgentRow` with `currentTask`, `reportPath`, and `lifecycleAction`.
  - Added `agentCounts` and `agentRows` to each `CeoWorkspaceCockpit`.
  - Extended `buildCeoCockpitView()` input to accept optional `tasks`.

- `tests/ceo-cockpit-view.test.ts`
  - Added coverage for running/exited/completed counts.
  - Added coverage for latest output, task mapping, report path mapping, and close/recycle recommendations.

## Acceptance Notes

This is a small code/test slice. It does not yet wire the new `agentRows` into a larger visible table or API response beyond the existing CEO cockpit view model. That is the right next UI step.

Recommended next UI wave:

1. Pass live `agents` and workspace `tasks` into the cockpit drawer's `buildCeoCockpitView()` call.
2. Render a compact "agents by workspace" table inside the CEO overnight section:
   - agent name/kind
   - state
   - current task
   - latest output tail
   - report file button
   - close/recycle recommendation
3. Wire `close` to the existing acknowledge/clear-exited flow.
4. Keep `recycle` as a recommendation until a governed respawn action exists.

## Checks

- `npm run typecheck` passed.
- `TMPDIR=/private/tmp node --import tsx --test tests/ceo-cockpit-view.test.ts` passed: 13 tests.
- `TMPDIR=/private/tmp npm run lint` passed with warnings only. Warnings are pre-existing repo warnings outside this slice after removing the one touched-file warning.
- `TMPDIR=/private/tmp node --import tsx --test tests/*.test.ts` ran 136 tests: 126 passed, 1 skipped, 9 failed. All 9 failures are `tests/pty-server-lifecycle.test.ts` failures from sandbox rejection of `listen 127.0.0.1`, not assertion failures in this slice.
- `TMPDIR=/private/tmp npm test` could not start because the `tsx` CLI attempted to create an IPC listener and the sandbox returned `EPERM`.

## No Push/Deploy

No push or deploy was performed.
