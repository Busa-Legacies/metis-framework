# Workbench Workspace UX Close/Add - 2026-05-10

## Files Changed

- `components/Workbench.tsx`
  - Added workspace display helpers so blank persisted names render as a muted/italic `temporary workspace` label.
  - Added confirmed workspace close flow using existing `ptyApi.deleteWorkspace()` / `DELETE /workspaces/:id`.
  - Added hover X close controls in the top workspace switcher menu and left workspace list.
  - Disabled close controls when only one workspace exists and surfaces a non-destructive error if invoked anyway.
  - Updated the new workspace dialog so name is optional and the create action no longer requires a non-empty name.

- `lib/pty-client.ts`
  - Relaxed `createWorkspace` input typing to allow omitted/null/blank names.

- `server/pty-server.ts`
  - Changed `POST /workspaces` name handling:
    - Explicit non-blank names are trimmed and preserved.
    - Blank/null names with an explicit cwd use the cwd basename.
    - Blank/null names without an explicit cwd persist as `''` for temporary/visually unnamed workspaces.
  - Existing `DELETE /workspaces/:id` last-workspace protection remains in place.

- `tests/pty-server-lifecycle.test.ts`
  - Added focused coverage for blank-name temporary workspaces, cwd basename auto-naming, explicit-name trimming, deleting a non-last workspace, and rejecting deletion of the last workspace.

## Evidence

- `npm run lint`
  - Passed with 28 warnings. Warnings are existing repo warnings; no new lint errors.

- `npm run build`
  - Passed. Next build completed with the existing Turbopack NFT tracing warning from `next.config.ts` / `app/api/assistant/route.ts`.

- `npm run typecheck`
  - Failed on pre-existing/unrelated untracked `tests/runtime-guardrails.test.ts` typing errors around `ProcessEnv.NODE_ENV`.
  - A filtered changed-file typecheck grep found no errors in `components/Workbench.tsx`, `lib/pty-client.ts`, `server/pty-server.ts`, or `tests/pty-server-lifecycle.test.ts`.

- `npm run test:pty`
  - Blocked by sandbox networking: every test failed at local `127.0.0.1` listen setup with `EPERM`.
  - The new focused test cases are present but could not execute in this environment.

## Residual Risks

- I could not run the PTY lifecycle tests locally because this sandbox forbids binding a local test server.
- The close action stops agents through the existing backend delete behavior; it does not delete user files on disk.
- `server/pty-server.ts` had pre-existing uncommitted edits before this slice. This change only adds the workspace name derivation behavior on top of the current file state.

## Commit Recommendation

Commit the workspace UX slice separately from the pre-existing dirty worktree changes:

```bash
git add components/Workbench.tsx lib/pty-client.ts server/pty-server.ts tests/pty-server-lifecycle.test.ts WORKBENCH_WORKSPACE_UX_CLOSE_ADD_20260510.md
git commit -m "Add workspace close controls and unnamed create flow"
```
