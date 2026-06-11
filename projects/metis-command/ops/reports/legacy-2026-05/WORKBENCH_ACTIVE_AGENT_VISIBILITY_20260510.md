# Workbench Active Agent Visibility - 2026-05-10

## Scope

Audit why Nick cannot easily tell what agents are doing across workspaces, with focus on:

- Workbench UI state rendering.
- Agent status labels.
- Completed/exited visibility.
- Workspace badges for active/exited counts.

No push or deploy performed.

## Findings

1. The left workspace rail already showed per-workspace running/exited counts, but only when the rail was on the `ws` tab.
2. The header workspace selector, which remains visible while using files/tasks/main panes, did not show per-workspace activity on the collapsed selector or dropdown rows.
3. Agent tabs relied mostly on a small colored dot plus hover text. That made status hard to scan, especially for retained exited agents.
4. Exited agents are intentionally retained for review/scrollback and can be cleared workspace-by-workspace, but the UI language mixed `done`, `exited`, and dot-only status.

## Smallest Safe Fix Implemented

- Added `lib/workspace-activity.ts` as a small pure helper for workspace activity counts and agent status labels.
- Updated the left workspace rail to use the same helper and show `active` / `exited` labels.
- Updated the top workspace switcher:
  - Collapsed selected workspace now shows active/exited badges.
  - Dropdown rows now show active/exited badges for every workspace.
- Updated agent tabs to show an explicit status pill:
  - `starting`
  - `active`
  - `exited <code>` / `exited ?`

This keeps behavior unchanged: no lifecycle, spawn, kill, clear, or persistence semantics were changed.

## Files Changed

- `components/Workbench.tsx`
- `lib/workspace-activity.ts`
- `tests/workspace-activity.test.ts`

## Verification

- `npm run typecheck` passed.
- `npx eslint components/Workbench.tsx lib/workspace-activity.ts tests/workspace-activity.test.ts` passed with existing warnings in `components/Workbench.tsx`; no errors.
- Focused test added: `tests/workspace-activity.test.ts`.
- Attempted `npx tsx --test tests/workspace-activity.test.ts`, but this sandbox blocks `tsx` IPC pipe creation with `listen EPERM` on both the default temp path and `/private/tmp`.

## Residual Risk

- I did not run a browser smoke test in this pass.
- The helper test is committed in source form and covered by typecheck, but the local sandbox prevented executing the `tsx` test runner.
- The existing `components/Workbench.tsx` lint warnings remain unrelated to this visibility fix.
