# Workbench Session Target Metadata P2 - Codex - 2026-05-08

## Scope

Implemented the minimal session/target metadata propagation needed after P1 target guardrails.

Objective:

- Preserve the active Workbench session that initiated a dispatch.
- Preserve the resolved target workspace for each dispatch run/action.
- Let active-session dispatch summaries include cross-workspace target runs, so Jarvis does not need to infer target state from panes.
- Keep UI scope minimal.

No push or deploy performed.

## Files Changed

- `lib/workspace-selector.ts`
  - Extracted `resolveWorkspaceSelector()` from the assistant route.
  - Keeps exact id match first, then unique case-insensitive workspace name match.
  - Returns candidate ids for ambiguous names instead of guessing.

- `lib/dispatch-runs.ts`
  - Added `sessionWorkspaceId` to dispatch runs and actions.
  - Continued storing runs under the resolved execution workspace.
  - Added `dispatchRunStatusForSession(sessionWorkspaceId, runId?)`, which scans persisted dispatch files and returns runs where either:
    - `run.workspaceId === sessionWorkspaceId`, or
    - `run.sessionWorkspaceId === sessionWorkspaceId`.
  - This lets an active Workbench workspace see dispatches it initiated into another workspace.

- `app/api/assistant/route.ts`
  - Uses extracted workspace selector.
  - Records `sessionWorkspaceId` from the active Workbench session and `targetWorkspaceId` from the resolved execution workspace.
  - Sets `targetWorkspaceId` for all dispatch actions, not only explicit cross-workspace actions.
  - `get_dispatch_status()` uses session-aware status when no explicit `workspace_id` is supplied, and target-workspace status when `workspace_id` is explicit.
  - `GET /api/assistant?workspaceId=<active>` now returns session-aware dispatch status, so the existing dispatch strip can see cross-workspace target runs.
  - Adds a compact `Recent dispatch summary` line to Jarvis/assistant prompt context.

- `components/AssistantPanel.tsx`
  - Added optional dispatch target/session fields to local status types.
  - Shows `target:<workspaceId>` in the dispatch strip only when the latest run targets a workspace other than the active one.

- `tests/tool-routing.test.ts`
  - Added workspace selector tests for exact id resolution and ambiguous name rejection.
  - Added dispatch metadata assertions for `sessionWorkspaceId`.
  - Added coverage that active-session status includes a cross-workspace target run stored under the target workspace.

- `memory/working-context.md`
  - Checkpointed the lane context before code edits.

## Behavior

- A cross-workspace dispatch from Workbench active workspace `ws1` into target workspace `ws2` is still persisted under `ws2`, but now records `sessionWorkspaceId: "ws1"`.
- The active session status call for `ws1` can return that `ws2` run through `dispatchRunStatusForSession()`.
- Jarvis prompt context now includes the most recent dispatch run summaries for the active session, including cross-workspace target ids, spawned ids, and failed spec counts.
- The existing dispatch UI strip remains compact and only adds a target label when it matters.

## Tests

Passed:

- `npm run typecheck`
- `node --import tsx --test tests/tool-routing.test.ts`
  - 25 tests passed.

Not run:

- Broad lint was not requested.
- PTY lifecycle/browser tests were not run for this metadata-only lane.

## Remaining Blockers / Follow-Up

- `dispatchRunStatusForSession()` scans persisted dispatch JSON files. This is acceptable for the current small file-backed store, but should move to an indexed store if dispatch volume grows.
- The status summary reports target workspace ids, not display names. A later cockpit-status lane can enrich summaries with workspace names from the workspace registry.
- Assistant chat persistence still stores chat messages separately from dispatch run state. This lane makes dispatch state visible to session summaries, but does not redesign chat history storage.
