# Workbench Dispatch Runs P0 - 2026-05-08

## Scope

Implemented the smallest durable dispatch run foundation for Agent Workbench assistant tool execution.

Objective from `WORKBENCH_CEO_FLOW_NEXT_GAPS_20260508.md`:

- Persist run intent, actions, results, and spawned agent ids per workspace.
- Prevent duplicate spawns for the same run/action id.
- Expose structured dispatch status so Jarvis can summarize without scraping terminal output.
- Keep UI scope tight; document the UI strip follow-up.

No push or deploy performed.

## Files Changed

- `lib/dispatch-runs.ts`
  - Added file-backed workspace-scoped dispatch run storage under `data/dispatch-runs`.
  - Stores `runId`, `workspaceId`, `createdBy`, `userPrompt`, run status, action ids, action fingerprints, args hashes, raw args, results, errors, spawned agent ids, and failed spawn specs.
  - Synthesizes stable run ids from `{ workspaceId, userPrompt }` unless the caller supplies `dispatchRunId`.
  - Treats duplicate action ids or same tool/args fingerprints in the same run as already applied and returns the persisted result instead of executing again.
  - Marks spawn actions with mixed success/failure rows as `partial_failed`.

- `app/api/assistant/route.ts`
  - Wrapped assistant tool execution with durable dispatch run begin/complete calls.
  - Wired the same dispatch run id through CLI, OpenAI, and OpenClaw/Jarvis paths.
  - Returned `dispatchRunId` in assistant POST responses.
  - Added `get_dispatch_status({ workspace_id?, run_id? })` as an assistant-visible tool.
  - Added `GET /api/assistant?workspaceId=<id>&runId=<optional>` for structured last/run-specific dispatch status.
  - Kept status reads out of the action ledger so polling does not mutate dispatch runs.
  - Applied the same local/bridge API-key guard pattern to the GET endpoint as POST.

- `lib/tool-routing.ts`
  - Added validation for `get_dispatch_status`.

- `tests/tool-routing.test.ts`
  - Added durable dispatch run tests for stable run ids, duplicate action id/fingerprint suppression, and persisted partial spawn state with spawned ids plus failed specs.

- `memory/working-context.md`
  - Checkpointed this lane state before code edits.

## Behavior

- A repeated request with the same `dispatchRunId` and action id returns the previously persisted action result and does not call the underlying tool again.
- A repeated request without explicit action ids is still protected inside a run by the same tool/args fingerprint.
- A duplicate `spawn_agents` action returns stored `spawnedAgents` and `failedSpecs`, so Jarvis can summarize state after refresh/retry without reading terminal scrollback.
- Partial spawn failure is represented at both run and action level as `partial_failed`.
- Failed spawn specs are persisted in a shape suitable for a later retry action with a new action id and narrowed `specs` array.

## Tests

Passed:

- `npm run typecheck`
- `node --import tsx --test tests/tool-routing.test.ts`
  - 17 tests passed.

Not run:

- Broad lint intentionally skipped per lane instruction to avoid existing lint debt.
- PTY lifecycle tests were not targeted for this storage/API lane.

## Blockers / Follow-Up

- UI strip not implemented in this P0 pass. The API now exposes enough for a compact "last dispatch" strip: latest run status, requested actions, spawned ids, failed specs, and retryable failed rows. Next UI lane should read `GET /api/assistant?workspaceId=<active>` and render that summary.
- Retry is model/API-driven rather than a one-click server mutation: Jarvis can retry failed specs by emitting a new `spawn_agents` action with a new action id and only the failed specs. A future control-plane lane can add a dedicated `retry_dispatch_action` tool.
- Expected deliverables and acceptance criteria fields exist in the model but are not yet populated from lane/task metadata. That belongs with the task/done-gate lane.

## Next Lane

Priority 1 from the gap report: target workspace and direct-agent guardrails.

Recommended work:

- Verify direct agent tools (`send_to_agent`, `kill_agent`, `rename_agent`, `read_agent_output`) against active workspace unless an explicit matching `workspace_id` is supplied.
- Resolve workspace names/ids server-side for cross-workspace dispatch.
- Record explicit target workspace resolution in the dispatch run.
- Add tests for cross-workspace direct-agent rejection and explicit workspace allow.
