# Workbench Task Evidence Gate - 2026-05-11

## Scope
- Worker 2 implemented evidence-gated task completion in `server/pty-server.ts`.
- Added typed PTY client helpers for task evidence in `lib/pty-client.ts` and shared evidence row types in `lib/types.ts`.
- Added focused lifecycle coverage in `tests/pty-server-lifecycle.test.ts`.

## Behavior
- `PATCH /workspaces/:workspaceId/tasks/:taskId` now rejects moving a task to `done` unless `hasRequiredEvidenceForDone(workspaceId, taskId)` passes.
- The required gate is a `report` row plus either a `review` or `manual_override` row for the task.
- A caller can bypass the gate with `overrideDoneGate: true` or `override: true`, but only when a non-empty `overrideReason` or `doneOverrideReason` is supplied.
- Accepted overrides append `manual_override` evidence with `payload.gate = "task_done"`.
- Invalid task statuses now return `400` instead of being cast into persisted task state.

## Evidence Endpoints
- `GET /workspaces/:workspaceId/tasks/:taskId/evidence`
- `GET /workspaces/:workspaceId/tasks/:taskId/evidence?kind=report`
- `POST /workspaces/:workspaceId/tasks/:taskId/evidence`

POST accepts:

```json
{
  "kind": "report",
  "summary": "implementation report",
  "payload": { "path": "WORKBENCH_TASK.md" },
  "missionId": "optional",
  "laneId": "optional",
  "agentId": "optional",
  "id": "optional"
}
```

## Verification
- `node --import tsx --test tests/evidence-ledger.test.ts` passed.
- `node --import tsx --test tests/pty-server-lifecycle.test.ts tests/evidence-ledger.test.ts` was blocked by this sandbox before server startup: `listen EPERM: operation not permitted 127.0.0.1`.
- Targeted TypeScript compile for touched files no longer reports errors from this slice; remaining failures are pre-existing in `lib/tool-routing.ts` and `server/pty-server.ts` around workspace boundary narrowing.

## UI Follow-Up
- `TasksPanel` will surface the backend rejection through its existing `onError` path.
- A richer UI should add task evidence display, append controls for report/review rows, and an explicit override confirmation dialog before sending `overrideDoneGate`.
