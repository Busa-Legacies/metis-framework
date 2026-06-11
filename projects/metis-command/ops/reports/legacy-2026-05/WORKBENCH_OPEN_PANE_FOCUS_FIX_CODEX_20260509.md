# Workbench Open Pane Focus Fix — Codex — 2026-05-09

## Scope

Owned B1 only from `WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md`:
fix destructive cockpit drawer `Open pane` behavior in `Workbench.tsx`.
No B2 ack-pill work. No push/deploy.

Post-patch HIGHROI coordination scan inside this project found no matching
files or mentions.

## Files Changed

- `components/Workbench.tsx`
  - `openAgentPane(workspaceId, agentId)` now checks whether the target
    agent is already assigned to a leaf in that workspace.
  - If already visible, it focuses that leaf and returns the current layout
    unchanged.
  - If not visible, it calls the existing `placeAgent(root, agentId,
    activeLeafId)` layout API and focuses the leaf that receives the agent.
  - This preserves cockpit summary/drawer behavior; no cockpit data or
    AssistantPanel paths were changed.

- `lib/layout.ts`
  - `placeAgent` now no-ops when the agent is already visible in the layout.
  - This prevents future callers from duplicating one agent across two panes.
  - Existing empty-leaf-first behavior is preserved.

- `tests/workbench-layout.test.ts`
  - Added regression coverage that `placeAgent` does not duplicate an
    already-visible agent.
  - Added regression coverage that placement fills an empty leaf before
    replacing an occupied pane, even when the preferred leaf is occupied.

- `memory/working-context.md`
  - Checkpointed this lane and verification status.

- `tsconfig.tsbuildinfo`
  - Refreshed by `npm run typecheck` because this project has
    `compilerOptions.incremental: true`.

## Verification

- `npm run typecheck` — PASS
- `node --import tsx --test tests/workbench-layout.test.ts` — PASS, 2/2
- `node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts tests/workbench-layout.test.ts` — PASS, 44 passed / 1 existing skipped placeholder
- `npm test` — BLOCKED before test execution by sandbox `tsx` IPC bind denial:
  `listen EPERM` on a temp pipe under `/var/folders/.../tsx-501/...pipe`

## Result

B1 is fixed code-side: cockpit drawer `Open pane` no longer silently rewrites
leaf 0 when the target agent is already visible or when an empty pane exists.
