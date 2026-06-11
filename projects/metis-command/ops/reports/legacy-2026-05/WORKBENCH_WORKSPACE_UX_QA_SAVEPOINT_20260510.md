# Workbench Workspace UX QA Savepoint - 2026-05-10

## Verdict

PASS for the completed workspace close/add UX lane.

The reviewed UX is safe for a local savepoint: workspace close uses the existing `DELETE /workspaces/:id` API, last-workspace deletion is guarded in both UI and server, the server delete handler does not remove workspace files from disk, and blank workspace creation matches the intended temporary/cwd-derived naming behavior.

## Exact Commit Group Reviewed

Base commit: `c97ff8a docs(workbench): report overnight agent state slice`

Reviewed lane files:

- `components/Workbench.tsx`
- `lib/pty-client.ts`
- `server/pty-server.ts`
- `tests/pty-server-lifecycle.test.ts`
- `WORKBENCH_WORKSPACE_UX_CLOSE_ADD_20260510.md`

Recommended savepoint contents:

```bash
git add components/Workbench.tsx lib/pty-client.ts server/pty-server.ts tests/pty-server-lifecycle.test.ts WORKBENCH_WORKSPACE_UX_CLOSE_ADD_20260510.md WORKBENCH_WORKSPACE_UX_QA_SAVEPOINT_20260510.md
git commit -m "QA workspace close and unnamed add UX"
```

Important staging note: `server/pty-server.ts` contains additional pre-existing uncommitted changes outside this UX lane, including effort/runtime guardrail wiring. A path-based commit will include those hunks unless Jarvis interactively stages only the workspace create/delete hunks.

## Safety Findings

- X close calls `ptyApi.deleteWorkspace(id)`, which sends `DELETE /workspaces/:id`.
- UI prevents closing the last workspace and shows `Cannot close the last workspace.`
- Server also rejects deleting the last workspace with HTTP 400 `cannot delete last workspace`.
- Server delete removes the workspace record, kills in-memory agents for that workspace, and saves state. It does not call `rm`, `rmSync`, `unlink`, `rmdir`, or otherwise delete the workspace cwd.
- Confirmation copy explicitly says files on disk are not deleted.
- Blank name plus no cwd creates a persisted blank-name workspace at `os.homedir()`, rendered as `temporary workspace`.
- Blank name plus explicit cwd derives the name from the cwd basename.
- Explicit names are trimmed and preserved.

## Verification Run

- `git diff --check -- components/Workbench.tsx lib/pty-client.ts server/pty-server.ts tests/pty-server-lifecycle.test.ts`: PASS
- `npm run lint`: PASS with 28 warnings, no errors.
- `node --import tsx --test tests/tool-routing.test.ts tests/workbench-layout.test.ts tests/effort-level.test.ts tests/runtime-guardrails.test.ts`: PASS, 66 passing, 1 skipped.
- `npm run typecheck`: FAIL due to unrelated `tests/runtime-guardrails.test.ts` `ProcessEnv.NODE_ENV` typing errors.

## Risks

- PTY lifecycle tests were reviewed in source but not run here because the requested check scope was non-PTY; these tests require a local PTY HTTP server.
- The savepoint is not perfectly lane-isolated at file granularity because `server/pty-server.ts` has unrelated dirty hunks.
- Existing lint warnings remain in the repo, including warnings in `components/Workbench.tsx`, but no lint errors were introduced.

## Savepoint Recommendation

Jarvis should create a local savepoint commit after deliberate staging. If the goal is a broad "current workspace UX lane plus already-present server context" savepoint, use the path group above. If the goal is a lane-pure commit, stage hunks in `server/pty-server.ts` selectively before committing.
