# Workbench Target Guardrails P1 - Codex - 2026-05-08

## Scope

Implemented Priority 1 target workspace guardrails for Agent Workbench assistant tool execution.

Objective:

- `send_to_agent`, `kill_agent`, `rename_agent`, and `read_agent_output` reject cross-workspace agent ids unless an explicit matching `workspace_id` is supplied.
- Explicit workspace selectors are resolved server-side before execution.
- Explicit target workspace resolution is recorded in durable dispatch runs.
- Add targeted tool-routing tests.

No push or deploy performed.

## Files Changed

- `lib/tool-routing.ts`
  - Added optional `workspace_id` validation for direct agent tools.
  - Added `resolveDirectAgentTarget()` for active-workspace and explicit-workspace ownership checks.
  - Cross-workspace direct ids now return a clear error asking for explicit `workspace_id`.
  - Mismatched explicit `workspace_id` returns a clear ownership error.

- `app/api/assistant/route.ts`
  - Updated assistant tool descriptions and OpenAI tool schemas to expose optional `workspace_id` for direct tools.
  - Added server-side workspace selector resolution by id or unique case-insensitive name.
  - Ambiguous workspace names return a confirmation-style error listing candidate ids instead of guessing.
  - Missing workspace names/ids return a user-visible error.
  - Direct agent tools now verify the resolved target against the agent's `workspaceId` before calling PTY endpoints.
  - `spawn_agents`, `broadcast`, and `get_dispatch_status` also use canonical resolved workspace ids for explicit `workspace_id`.

- `lib/dispatch-runs.ts`
  - Added `targetWorkspaceId` and `explicitTargetWorkspaceId` to dispatch runs and actions.
  - `beginDispatchAction()` records explicit target workspace metadata when provided.

- `tests/tool-routing.test.ts`
  - Added direct-agent workspace guardrail tests:
    - cross-workspace id rejection without `workspace_id`
    - explicit matching `workspace_id` allow
    - explicit mismatched `workspace_id` rejection
  - Added validation coverage for optional direct-tool `workspace_id`.
  - Added dispatch-run coverage for explicit target workspace recording.

- `memory/working-context.md`
  - Checkpointed this lane state and verification results.

## Behavior

- Direct agent tools without `workspace_id` can only target agents in the active workspace.
- Direct agent tools with `workspace_id` can target agents outside the active workspace only when the resolved workspace id matches the agent's own `workspaceId`.
- `workspace_id` may be a workspace id or a unique workspace name; ambiguous names are rejected with candidate ids.
- Explicit cross-workspace tool calls are written to the target workspace dispatch-run file with `targetWorkspaceId` and `explicitTargetWorkspaceId` set.

## Tests

Passed:

- `npm run typecheck`
- `node --import tsx --test tests/tool-routing.test.ts`
  - 22 tests passed.

Not run:

- Broad lint was not requested.
- PTY lifecycle tests were not requested for this routing lane.

## Notes

- The durable dispatch run id supplied by the assistant request is preserved, but explicit cross-workspace actions are stored under the resolved target workspace id so later status reads for that target workspace show the action evidence.
- Session metadata remains active-workspace scoped in the current conversation drivers; this lane records explicit target workspace at the dispatch-run/action layer and resolves tool execution target ids server-side.
