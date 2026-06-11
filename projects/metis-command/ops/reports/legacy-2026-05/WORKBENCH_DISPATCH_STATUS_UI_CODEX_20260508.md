# Workbench Dispatch Status UI - Codex - 2026-05-08

## Scope

Implemented the compact last-dispatch UI strip for the Agent Workbench assistant panel.

Objective:

- Read `GET /api/assistant?workspaceId=<active>` for the active workspace.
- Show latest dispatch run status.
- Show spawned ids.
- Show failed specs.
- Show retryable failed rows.
- Keep scope tight and avoid broad lint debt.

No push or deploy performed.

## Files Changed

- `components/AssistantPanel.tsx`
  - Added local dispatch run response types matching `lib/dispatch-runs.ts`.
  - Added active-workspace dispatch status fetch via `GET /api/assistant?workspaceId=<active>`.
  - Polls dispatch status every 5 seconds while a workspace is active.
  - Refreshes dispatch status after assistant responses that include tool calls or a `dispatchRunId`.
  - Renders a compact dispatch strip under the assistant persona/auto controls.
  - Displays latest run status, compact run id, action count, spawned agent ids, failed spec count/details, and retryable failed `spawn_agents` rows.

- `memory/working-context.md`
  - Checkpointed this lane state and verification.

## Verification

Passed:

- `npm run typecheck`
- `node --import tsx --test tests/tool-routing.test.ts`
  - 22 tests passed in the current workspace state.

Attempted:

- `npm run dev:web`
  - Blocked before app code by sandbox networking: `listen EPERM: operation not permitted 0.0.0.0:3747`.

Not run:

- Broad lint intentionally skipped per lane instruction to avoid unrelated lint debt.
- No component/browser test exists for `AssistantPanel.tsx`; targeted verification used typecheck plus the existing dispatch/tool-routing regression tests for the consumed status shape.

## Blockers / Notes

- The parent git repository ignores `/Projects/`, so `git status` does not report these project file edits.
- Browser/runtime smoke verification was not possible because the sandbox prevented the local Next server from binding to port 3747.
- The strip is read-only. Retry remains model/API-driven: retry failed specs by issuing a new `spawn_agents` action with a new action id and only the failed specs, matching the P0 dispatch run note.
- The UI depends on the P0 endpoint and does not add a new server mutation.
