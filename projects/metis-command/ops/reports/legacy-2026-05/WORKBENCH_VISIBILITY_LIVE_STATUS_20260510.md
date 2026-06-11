# Workbench Visibility Live Status - 2026-05-10

## Timestamp

- Updated: 2026-05-10 18:51:30 CDT.
- Repo: `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`.
- Branch: `slice/summarize-portfolio-tool`.
- Current HEAD observed: `c97ff8a docs(workbench): report overnight agent state slice`.
- Push/deploy: not performed.

## Current Active Panes

Source-observed Workbench panes in `components/Workbench.tsx`:

- Header control strip: workspace switcher, global agent counts, command palette, stop all, clear exited, refresh, settings.
- Left rail: `ws`, `files`, and `tasks` tabs. Default state is `ws`.
- Main pane grid: agent tab strip, spawn menu, layout presets, resume banner, broadcast bar, and `PaneGrid`.
- Right rail: `assistant`, `notes`, and `mcp` tabs. Default state is `assistant`.
- Assistant cockpit drawer: existing cockpit summary plus the new CEO overnight digest from `components/AssistantPanel.tsx`.

Persisted legacy workbench state in `data/workbench-state.json` still lists these lanes:

- `Claude Desktop`: running on `aw-001`.
- `Jarvis / OpenClaw`: running on `aw-001`.
- `Codex Desktop`: queued on `aw-002`.
- `Terminal / Logs`: idle.

No live PTY server query was performed in this pass, so runtime process counts are taken from source/state files rather than `GET /agents`.

## Completed Reports

Completed visibility and adjacent status reports present in this worktree:

- `WORKBENCH_ACTIVE_AGENT_VISIBILITY_20260510.md`: active/exited visibility fix implemented; typecheck passed; focused test source added; sandbox blocked the `tsx` test runner IPC path.
- `WORKBENCH_OVERNIGHT_AGENT_STATE_CODEX_20260510.md`: deterministic `readiness.agentStates[]` shipped in commit `70fcef5`; focused reliability suites passed; full PTY path blocked by sandbox loopback/IPC limits.
- `WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_WIRE_CODEX_20260510.md`: CEO cockpit helper wired into the assistant drawer as a read-only digest; typecheck and focused helper tests passed.
- `WORKBENCH_OVERNIGHT_CEO_COCKPIT_POLISH_CODEX_20260510.md`: CEO digest polish completed; typecheck and focused helper tests passed.
- `WORKBENCH_CEO_DASHBOARD_NEXT_WAVE_20260510.md`: next dashboard view-model slice completed; focused tests passed; broader PTY tests blocked by sandbox localhost bind.
- `WORKBENCH_WORKSPACE_UX_QA_SAVEPOINT_20260510.md`: workspace close/add UX reviewed as pass, with staging caution for mixed `server/pty-server.ts` hunks.
- `WORKBENCH_VISUAL_UX_QA_EXEC_20260510.md`: close/add UX implementation passed source/lint/build checks, but overall execution gate failed at that time due to an unrelated typecheck error and sandbox-blocked PTY tests.
- `WORKBENCH_NEXT_SAVEPOINT_PACKET_20260510.md`: savepoint grouping and safest commit order documented; later notes say typecheck was restored by narrowing the runtime guardrail env type.

Earlier completed visibility boundary reports still relevant:

- `HIGHROI_WORKBENCH_MVP_VISIBILITY_FIX_CODEX_20260509.md`: pane-level cockpit pills for `ack'd`, `stale`, and `report ready`.
- `WORKBENCH_MVP_SOURCE_RECONCILE_CODEX_20260509.md`: reconciled source evidence for B1/B2 visibility.
- `WORKBENCH_RELEASE_BOUNDARY_FINAL_QA_CLAUDE_20260509.md`: MVP visibility release boundary marked pass.
- `WORKBENCH_BROWSER_ACCEPTANCE_WALKTHROUGH_CODEX_20260509.md`: manual browser walkthrough remained blocked, but source/test evidence for non-evicting pane focus and pane pills was green.

## What Lets Nick See Agents Working

The immediate UI change is the active/exited/status pill pass:

- `components/Workbench.tsx` now imports `workspaceActivityCounts()` and `agentStatusLabel()` from `lib/workspace-activity.ts`.
- The top workspace switcher shows active/exited badges on the collapsed selected workspace and on each dropdown row.
- The left workspace rail uses the same helper and labels workspaces with `active` and `exited` counts.
- Each agent tab now shows an explicit status pill: `starting`, `active`, `exited <code>`, or `exited ?`.
- The header still shows global running/exited counts across all workspaces.

This is the change that closes Nick's immediate visibility gap: he no longer has to be on the left `ws` rail or infer state from a tiny dot; active and retained completed/exited agents are visible from the persistent workspace switcher and agent tabs.

Related cockpit visibility already in place:

- `lib/cockpit-summary.ts` has deterministic `readiness.agentStates[]` rows for `starting`, `running`, `stale`, `done`, `blocked`, and `unknown_exit`.
- `components/AssistantPanel.tsx` renders a CEO overnight digest with approval/stuck/in-flight/done/report totals from the cockpit summary.
- `components/PaneGrid.tsx` continues to render cockpit-derived pane pills such as `ack'd`, `stale`, and `report ready`.

## Next Two Implementation Lanes

1. Agent dashboard table lane:
   - Pass live `agents` and workspace `tasks` into `buildCeoCockpitView()`.
   - Render compact per-workspace agent rows in the assistant cockpit drawer: agent name/kind, state, current task, latest output tail, report file button, and close/recycle recommendation.
   - Keep `recycle` read-only until a governed respawn action exists.

2. Runtime savepoint and acceptance lane:
   - Commit the mixed worktree in the savepoint groups documented in `WORKBENCH_NEXT_SAVEPOINT_PACKET_20260510.md`, using hunk staging for `server/pty-server.ts`.
   - Run or manually verify browser acceptance for the workspace switcher badges, agent status pills, CEO digest, close workspace flow, and unnamed workspace UI.
   - Add a sandbox-safe test path for non-PTY suites and keep PTY lifecycle tests isolated behind a localhost-capable environment.

## Manager Notes

- Do not clear exited panes automatically; retained exited agents remain review evidence until Nick or Jarvis explicitly clears them.
- Do not merge the dashboard table lane with lifecycle mutation work. First make status legible, then govern close/recycle actions.
- Current worktree is dirty and mixed. Treat report commits, UI/helper commits, runtime guardrail commits, workspace UX commits, and Telegram bridge commits as separate lanes unless Nick asks for one broad checkpoint.
