# Workbench Product Visibility Build - 2026-05-10

## Scope

Inspected the active-agent/dashboard visibility changes already present in Workbench and added the smallest read-only UI/test improvement for per-workspace task visibility.

## Files Changed

- `components/Workbench.tsx`
  - Polls existing task data for each workspace during the normal refresh loop.
  - Shows selected-workspace open task count in the top workspace switcher.
  - Shows per-workspace task status chips in the left workspace rail.
  - Shows compact task status chips in the workspace switcher dropdown.
- `lib/workspace-activity.ts`
  - Added `workspaceTaskCounts()` for per-workspace task bucket counts.
  - Counts `todo`, `building`, `review`, `done`, `active`, and `total` without leaking tasks across workspaces.
- `tests/workspace-activity.test.ts`
  - Added coverage for per-workspace task bucket counting.

## Verification

- `npm run typecheck`
  - Passed.
- `npm run lint -- components/Workbench.tsx lib/workspace-activity.ts tests/workspace-activity.test.ts`
  - Passed with existing warnings in `components/Workbench.tsx`; no errors.
- `npx tsx --test tests/workspace-activity.test.ts`
  - Blocked by sandbox IPC permissions: `listen EPERM ... tsx-501/...pipe`.
- `TMPDIR=/private/tmp npx tsx --test tests/workspace-activity.test.ts`
  - Same `tsx` IPC permission failure.

## Notes

- No push or deploy performed.
- Existing worktree changes were preserved.
- The task dashboard addition is read-only and uses existing `ptyApi.listTasks()` endpoints; it does not add any new task mutation path.

## Next Steps

- Run `npx tsx --test tests/workspace-activity.test.ts` outside the current sandbox or with a runner configuration that does not require local IPC pipes.
- Browser-check the workspace switcher and left rail with a workspace containing all task buckets to confirm chip wrapping at narrow widths.
- Consider sharing task state updates from `TasksPanel` back to `Workbench` so the dashboard updates immediately after a task edit instead of waiting for the next refresh tick.
