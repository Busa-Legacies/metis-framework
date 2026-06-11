# Workbench Cockpit UI Continuity Implementation - Codex - 2026-05-09

## Scope

Implemented the smallest continuity slice requested for Agent Workbench cockpit:

- Report-ready panes via persisted cockpit report rows and cockpit summary surfacing.
- Stale-running signal via `staleRunningAgentIds` and next-action rows.
- Deterministic next-action queue across workspaces.
- Close-recommendation primitives split into clean, blocked, and unknown exit buckets.
- Acknowledgement metadata that does not clear panes.
- Compact cockpit UI disclosure plus a non-modal next-action drawer.

No push or deploy performed.

## Files Changed

- `lib/cockpit-summary.ts`
  - Tightened `reviewReadyAgentIds` to `exitCode === 0` only.
  - Added `unknownExitAgentIds`, `staleRunningAgentIds`, `acknowledgedAgentIds`.
  - Added `reports[]`, `staleThresholdMs`, expanded totals, and `nextActions[]`.
  - Added deterministic queue ordering by severity, workspace name, and source id.

- `lib/cockpit-continuity.ts`
  - Added `data/cockpit-acks.json` read/write with atomic temp-file rename.
  - Added `data/cockpit-reports.json` read plus flat `*.md` report detection in workspace cwd.
  - Report rows are bounded per workspace and survive agent disappearance.

- `app/api/assistant/route.ts`
  - Extended `get_cockpit_summary` with `stale_threshold_ms`, `reports_limit`, and `include_acked`.
  - Added `active_workspace_id` query handling for `GET /api/assistant?scope=cockpit`.
  - Added `acknowledge_agent` assistant tool and direct `POST /api/assistant?scope=acknowledge_agent`.
  - Added `list_workspace_reports` assistant tool.
  - `acknowledge_agent` validates that the agent exists and is exited; it writes only ack metadata.

- `lib/tool-routing.ts`
  - Added validation for cockpit continuity tool arguments.

- `components/AssistantPanel.tsx`
  - Added a compact cockpit aggregate row under the dispatch strip.
  - Added a right-edge next-action drawer.
  - Drawer supports open pane, acknowledge, send newline for stale agents, and open report file.
  - Drawer exposes no clear/delete action.

- `components/Workbench.tsx`
  - Added an `onOpenAgent` bridge so cockpit drawer rows can focus/place a pane without clearing it.

- `tests/tool-routing.test.ts`
  - Added focused coverage for tightened buckets, stale detection, report persistence after agent removal, ack metadata behavior, active workspace ordering, deterministic next-action ordering, and tool validation.

- `memory/working-context.md`
  - Checkpointed lane context.

## Continuity Notes

- The existing manual `clear exited` button remains the only clear-exited UI path.
- No cockpit code calls `ptyApi.clearExitedAgents`.
- `acknowledge_agent` does not contact PTY delete/clear endpoints and does not mutate dispatch-run files.
- Cockpit GET may update `data/cockpit-reports.json` when it detects a new or changed workspace-level markdown report. It does not clear panes or mutate dispatch-run files.

## Verification

Passed:

- `npm run typecheck`
- `node --import tsx --test tests/tool-routing.test.ts`
  - 37 tests total: 36 passed, 1 skipped existing placeholder.

Blocked:

- `npm run dev:web` for browser smoke failed before app code with sandbox bind denial:
  - `listen EPERM: operation not permitted 0.0.0.0:3747`

## Notes

- Required root operating files `SOUL.md`, `USER.md`, `IDENTITY.md`, `SYSTEM_MAP.md`, and `eco/daily_state.md` were not present in this repo scan; local `memory/working-context.md` and the three requested cockpit briefs were read.
- Git root ignores `/Projects/`, so this project does not show tracked file diffs from the workspace-level git status.
