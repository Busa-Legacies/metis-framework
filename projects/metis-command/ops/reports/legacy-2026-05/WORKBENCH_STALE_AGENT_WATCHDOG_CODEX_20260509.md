# Workbench Stale Agent Watchdog - Codex - 2026-05-09

## Scope

- Repo: `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`
- Lane: small, safe P1 productization improvement for stale/low-progress agent supervision
- Constraints honored: no commit, push, deploy, installs, external writes, or edits outside this repo

## Files Changed

- `lib/cockpit-summary.ts`
  - Added additive `CockpitStaleRunningAgent` detail rows under `workspace.readiness.staleRunningAgents`.
  - Existing `staleRunningAgentIds` remains unchanged for compatibility.
  - Stale wake actions now include idle age, output byte count, and report-artifact state in the reason text.

- `lib/cockpit-ui-state.ts`
  - Pane stale badges now display compact idle age from the cockpit summary, for example `stale 12m` or `stale 1h`.
  - Falls back to the previous `stale` label if older summary data is missing.

- `tests/tool-routing.test.ts`
  - Added focused assertions for stale-agent detail rows: `idleMs`, `lastOutputAt`, `outputBytes`, and `hasReport`.
  - Updated pane state helper coverage to assert the age-bearing stale badge.

- `memory/working-context.md`
  - Checkpointed the lane context and implementation plan per workspace operating law.

## Evidence

- Existing state model already tracks the needed watchdog inputs:
  - `server/pty-server.ts` records `status`, `lastOutputAt`, and `outputBytes`.
  - `lib/types.ts` exposes those fields on `Agent`.

- Existing cockpit path already had a stale signal:
  - `lib/cockpit-summary.ts` computed `staleRunningAgentIds` from `lastOutputAt` or `createdAt`.
  - `components/AssistantPanel.tsx` surfaced stale counts and wake actions.
  - `components/PaneGrid.tsx` surfaced stale pane badges.

- New behavior makes stuck panes more obvious without changing execution semantics:
  - Cockpit summary still returns the original stale ID list.
  - New detail rows add idle age and byte/report context.
  - Stale action reasons now distinguish “idle with no report artifact” from generic silence.
  - Pane headers show stale age directly.

## Tests

- `npm run typecheck`
  - PASS

- `node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts`
  - PASS: 46 passed, 1 existing skipped placeholder, 0 failed

## Remaining Blockers

- No runtime browser smoke was run for this lane. Prior Workbench lanes documented sandbox loopback bind denial for local server/browser smoke (`listen EPERM`), and this change is covered through pure summary/UI-state helper tests.
- This is an indicator-only watchdog. It does not kill, pause, restart, or auto-escalate stale agents.
- “Report artifact” is inferred from cockpit report metadata attributed to an agent. Agents that write reports under unexpected names/locations may still appear as `no report artifact` until report detection is broadened.

## Next Suggested Lane

Add a read-only “agent progress digest” to the cockpit drawer that lists stale agents with name, kind, idle age, output bytes, last output timestamp, and report state. Keep actions manual: open pane, send newline, read report. This would improve supervision density without introducing automatic process control risk.
