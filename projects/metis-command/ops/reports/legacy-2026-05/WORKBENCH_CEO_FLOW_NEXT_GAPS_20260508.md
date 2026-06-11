# Workbench CEO Flow Next Gaps - 2026-05-08

## Scope

Scout/architect review for Jarvis as the Agent Workbench project cockpit. Read-mostly inspection of:

- `WORKBENCH_ISOLATION_IMPLEMENTATION_REPORT_20260508.md`
- `WORKBENCH_CLAUDE_CONTROL_PLANE_QA_20260508.md`
- `WORKBENCH_JARVIS_ISOLATION_SPEC_20260508.md`
- `WORKBENCH_UX_CONTROL_POLISH_20260508.md`
- `WORKBENCH_CLEAR_EXITED_PANES_BUGFIX_20260508.md`
- `../../ops/reports/workbench_dispatch_20260508.md`
- `app/api/assistant/route.ts`
- `components/Workbench.tsx`
- `server/pty-server.ts`
- supporting task, layout, assistant, and routing modules

No push/deploy. No broad code edits.

## Current State

The recent lanes landed the right foundation:

- Workbench session keys are workspace-scoped (`workbench:<workspaceId>` / `workbench:global`).
- OpenClaw/Gateway calls receive Workbench metadata.
- `aw_action` execution only parses the current assistant turn.
- Same-turn duplicate action ids / same tool+args fingerprints are suppressed.
- Spawn cwd is constrained to workspace cwd or pinned roots.
- Broadcast selection is workspace-scoped and running-agent-only.
- Exited panes can now be cleared without killing running agents.
- The UI has task columns and a reviewer spawn path.

The remaining gaps are not another broad isolation rewrite. They are the cockpit control layer: durable dispatch runs, idempotency, target confirmation, pane lifecycle edges, and visible done/review gates that Jarvis can actually operate.

## Priority 0 - Dispatch Run Reliability

### Gap

Jarvis tool execution is still turn-local. `runOpenClawConversation()` accumulates `toolCalls` in memory and returns them to chat, but there is no persisted dispatch run object that records intent, target workspace, expected agents, per-action status, retry state, or completion state. Evidence:

- `execTool()` spawns specs in a loop and returns mixed `{ id }` / `{ error }` rows, but does not create a durable run or retry failed specs: `app/api/assistant/route.ts:101`.
- Tool results are fed back as synthetic `[SYSTEM]` chat text, then discarded except for chat `toolCalls`: `app/api/assistant/route.ts:523`.
- Assistant chat persistence stores messages/toolCalls, not dispatch state or expected lane outcomes: `components/AssistantPanel.tsx:93`.

This is why Jarvis can spawn many agents, but cannot reliably answer "which lanes are done, blocked, duplicated, or need retry?" after refresh/restart without re-reading scrollback manually.

### Next Lane

Add a durable `dispatchRuns` model scoped by workspace:

- `runId`, `workspaceId`, `createdBy`, `userPrompt`, `status`.
- Intended actions with stable ids and fingerprints.
- Execution results per action.
- Spawned agent ids mapped to lane names/roles.
- Expected deliverables and acceptance criteria.
- Retry/cancel/close timestamps.

### Acceptance Criteria

- Re-sending the same assistant request with the same run/action ids does not spawn duplicate agents.
- Partial spawn failure is visible as `partial_failed`, with failed specs retryable individually.
- UI shows a compact "last dispatch" strip: requested lanes, spawned ids, failed actions, next retry.
- A test simulates one successful spawn and one failed spawn and asserts persisted partial state survives a new request.
- Jarvis can call a status tool and summarize dispatch state without scraping terminal output.

## Priority 1 - Target Workspace and Agent Guardrails

### Gap

Workspace isolation exists for spawn cwd and broadcast, but direct agent tools still trust ids globally:

- `requireKnownAgent()` checks whether an id exists anywhere, not whether it belongs to the active/declared workspace: `app/api/assistant/route.ts:84`.
- `send_to_agent`, `kill_agent`, `rename_agent`, and `read_agent_output` call `requireKnownAgent()` with only the id: `app/api/assistant/route.ts:120`.
- Explicit cross-workspace spawn/broadcast can run while the session key remains the active workspace key because `sessionKey` is built once from `activeWorkspaceId`: `app/api/assistant/route.ts:466`.

This is safe enough for current UI use, but not for CEO cockpit use where Jarvis may manage Sitework, REOS, Market Alpha, and Workbench from one active pane. A stale agent id in chat can target the wrong workspace.

### Next Lane

Introduce explicit target resolution:

- Resolve workspace names/ids server-side before tool execution.
- For direct agent tools, verify `agent.workspaceId === activeWorkspaceId` unless a `workspace_id` is explicit.
- If a request names a different workspace than the active one, record that target in the dispatch run and session metadata.
- Return a confirmation-required error for ambiguous workspace names.

### Acceptance Criteria

- `send_to_agent` to an id in another workspace fails unless `workspace_id` matches that agent.
- `kill_agent` and `rename_agent` have the same workspace guard.
- "Spawn in Sitework" from another active workspace resolves to Sitework by name and records target workspace in the run.
- Ambiguous or missing workspace names return a user-visible choice instead of guessing.
- Tests cover cross-workspace direct-agent rejection and explicit workspace allow.

## Priority 2 - Durable Stale Replay Hygiene

### Gap

Current-turn parsing is correct, but replay protection is not durable:

- `prepareCurrentTurnActions()` suppresses duplicates only inside one assistant text: `lib/action-ledger.ts:43`.
- There is no persisted action ledger keyed by workspace/session/run.
- Browser retry, tab restore, or a second POST with the same chat payload can ask the brain to emit the same action again and spawn duplicate panes.
- Invalid action blocks are logged as toolCalls in the response, but there is no user-visible action audit or "ignored historical action" trail.

### Next Lane

Make action ids durable:

- Require or synthesize stable action ids from run id + action index + args hash.
- Persist action fingerprints per workspace session and dispatch run.
- Treat duplicate action ids across retries as `already_applied` and return the original result.
- Add an audit view for ignored/invalid/duplicate actions.

### Acceptance Criteria

- Duplicate POST of the same assistant action does not create a second agent.
- Duplicate `send_to_agent` with the same run/action id is not re-sent to the terminal.
- Different action id with same args can be allowed only when the user explicitly starts a new run.
- Tool-routing tests cover same-turn duplicate, cross-turn duplicate, retry after partial failure, and malformed historical block.

## Priority 3 - Pane Lifecycle and Resume Hygiene

### Gap

The exited-pane fix closed the obvious stale tab issue, but there are still lifecycle edges:

- Layout persistence can schedule a save using fallback `singleLeafLayout()` before the server layout is loaded: `components/Workbench.tsx:151` and `components/Workbench.tsx:159`.
- Layout load and live-agent reconciliation are split effects; active leaf selection uses the pre-merged root: `components/Workbench.tsx:116`.
- `resumeWorkspace()` ignores the returned `spawned` payload and runs a no-op `setRoot()` with stale `wsAgents`: `components/Workbench.tsx:241`.
- Server resume swallows per-spec spawn failures and returns only successes: `server/pty-server.ts:1029`.
- Runtime exited agents are kept for scrollback until manually cleared, which is fine, but there is no policy for auto-collapsing long-dead panes versus preserving evidence.

### Next Lane

Tighten pane/session lifecycle:

- Add a `layoutHydratedByWs` flag so fallback layouts are never persisted before load/merge completes.
- Return resume failures with `{ spec, error }` rows.
- Use the `spawned` resume response to immediately place panes and show partial failure.
- Add optional "archive exited after N hours" metadata, not automatic deletion.
- Remove debug console logging from normal pane reconciliation once covered by tests.

### Acceptance Criteria

- A slow `GET /layout` cannot overwrite a saved multi-pane layout with a fallback single leaf.
- Resume with one invalid cwd reports one failure and still places successful agents.
- Clear exited remains workspace-scoped and does not delete resume specs unless the user dismisses resume.
- Tests cover layout hydration race, resume partial failure, and cross-workspace clear isolation.

## Priority 4 - Done/Review Gates Jarvis Can Operate

### Gap

The task board exists, but completion gates are not enforceable:

- Task statuses are simple strings and API PATCH accepts any string cast as `TaskStatus`: `server/pty-server.ts:1088`.
- The assistant tool schema has no task tools, so Jarvis cannot create lanes, assign owners, request review, or mark done through the same controlled action path: `app/api/assistant/route.ts:56`.
- Review spawning exists, but approval/blocking is just terminal text; it does not update task evidence or block `done`: `server/pty-server.ts:1128`.
- The UI lets a user move any task to `done` manually, with no required report, tests, reviewer verdict, or diff summary: `components/TasksPanel.tsx:167`.

### Next Lane

Promote tasks into first-class control-plane tools:

- Add tools: `create_task`, `assign_task`, `claim_task_files`, `request_review`, `record_review_verdict`, `mark_task_done`, `list_tasks`.
- Add task evidence fields: `reportPath`, `testCommands`, `testResults`, `reviewerAgentId`, `reviewVerdict`, `blockedReason`, `completedAt`.
- Enforce transitions: `todo -> building -> review -> done`; direct `done` requires either reviewer approval or explicit human override.
- Make dispatch runs optionally create tasks for each spawned lane.

### Acceptance Criteria

- Jarvis can spawn three lane agents and create three linked tasks in one run.
- A task cannot be marked `done` via API without evidence and either review approval or explicit override.
- Reviewer block sets task to `review`/blocked and surfaces required fixes.
- UI shows "Done", "Needs Review", "Blocked", and "Ready to Close Pane" as separate states.
- Tests cover invalid task status rejection and done-gate enforcement.

## Priority 5 - Manager Status Surface

### Gap

Jarvis currently has to infer status from visible pane summaries, chat, and scrollback:

- `visiblePaneSummary` is only `id:kind:name:status`, not lane/task/review/evidence aware: `app/api/assistant/route.ts:250`.
- Agent metadata includes `role` and `taskId`, but assistant summaries and tabs do not elevate gate state.
- The existing Workbench dispatch report had to be written manually as an ops report, outside the app state.

### Next Lane

Add a cockpit status endpoint and UI panel:

- Workspace summary: running/exited agents, active dispatch runs, tasks by status, blocked lanes, review-ready lanes, dirty git summary.
- Agent summary: role, task id, last output, exit code, report path, close recommendation.
- Jarvis status tool that returns this structured summary.

### Acceptance Criteria

- User can ask "what is done and what needs review?" and Jarvis answers from structured state, not raw scrollback alone.
- UI highlights panes ready to close only after done/review gates pass.
- Summary endpoint is workspace-scoped and excludes other workspaces unless explicitly requested.
- Tests assert summaries separate active, exited, blocked, review, and done lanes.

## Recommended Order

1. Durable dispatch runs + idempotent action ledger.
2. Workspace/agent guardrails for direct tools.
3. Task tools and done/review gates.
4. Pane hydration/resume lifecycle tests.
5. Cockpit status endpoint and UI surface.

That order gives Jarvis reliable memory of what it tried to do before making the UI more ambitious.

## Verification Notes

This was a read-mostly architecture review. No tests were run because no production code changed. The only file added by this pass is this report.
