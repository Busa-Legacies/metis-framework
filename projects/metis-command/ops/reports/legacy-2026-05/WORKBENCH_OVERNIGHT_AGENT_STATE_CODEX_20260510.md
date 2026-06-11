# Workbench Overnight Agent-State Slice — Codex — 2026-05-10 CT

## Timestamp

- Started from overnight supervision lane, verified at 2026-05-10 03:46:28 CDT.

## Branch and commit

- Branch: `slice/summarize-portfolio-tool`
- Implementation commit: `70fcef5` (`feat(cockpit): add deterministic agent state rows`)
- Push status at report creation: pending report commit/push.

## Scope shipped

- Added an additive `workspace.readiness.agentStates[]` row set to `lib/cockpit-summary.ts`.
- Added explicit deterministic state labels for supervisor reads:
  - `starting`
  - `running`
  - `stale`
  - `done`
  - `blocked`
  - `unknown_exit`
- Each row carries the agent id/name/kind plus useful supervision metadata:
  - `acknowledged`
  - `hasReport`
  - `lastOutputAt`, `idleMs`, `outputBytes` for running/stale agents
  - `exitCode` for done/blocked agents
- Kept legacy ID buckets unchanged for compatibility:
  - `reviewReadyAgentIds`
  - `blockedAgentIds`
  - `unknownExitAgentIds`
  - `staleRunningAgentIds`
  - `staleRunningAgents`
  - `acknowledgedAgentIds`

## Why this helps overnight supervision

Jarvis can now read one deterministic per-agent state array instead of reconstructing done/blocked/stale state from several bucket lists. The sort order prioritizes supervisor attention: blocked, stale, done, unknown exit, starting, running; then name and id.

This is read-only summary metadata. It does not kill, restart, wake, clear, or dispatch agents.

## Tests

- `npm run typecheck`
  - PASS
- Focused reliability suite:
  - `node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts tests/summarize-portfolio-tool.test.ts tests/cockpit-to-rollup.test.ts`
  - PASS: 65 pass, 1 pre-existing skip, 0 fail
- Non-PTY full suite:
  - `node --import tsx --test tests/browser-smoke.test.mjs tests/cockpit-continuity.test.ts tests/cockpit-to-rollup.test.ts tests/effort-level.test.ts tests/evidence-ledger.test.ts tests/portfolio-render.test.ts tests/summarize-portfolio-tool.test.ts tests/tool-routing.test.ts tests/workbench-layout.test.ts`
  - PASS: 112 pass, 1 pre-existing skip, 0 fail
- `npm test`
  - BLOCKED before test execution by sandbox IPC denial: `listen EPERM .../tsx-501/*.pipe`
- Full Node glob:
  - `node --import tsx --test tests/*.test.ts`
  - PARTIAL: 108 pass, 1 pre-existing skip; 7 PTY lifecycle tests blocked by sandbox loopback denial: `listen EPERM 127.0.0.1`

## Dirty-worktree notes

Pre-existing uncommitted files were preserved and not included in the implementation commit:

- `server/pty-server.ts`
- `.claude/`
- `PM_HANDOFF_20260509.md`
- `PM_NEXT_SLICE_REPORT_20260509.md`
- `WB_EFFORT_SELECTOR_REPORT_20260509.md`
- `WB_RISK_TIER_SLICE_REPORT_20260509.md`
- `WB_SUMMARIZE_PORTFOLIO_REPORT_20260509.md`
- `lib/effort-level.ts`
- `tests/effort-level.test.ts`

## Next reliability slices

1. Surface `agentStates[]` in the cockpit drawer as a compact progress digest with state, idle age, output bytes, report flag, and ack flag.
2. Add a read-only assistant tool option for `get_cockpit_summary` that returns only stale/blocked/done agent state rows for low-token overnight checks.
3. Add an evidence-gated done transition helper for task state: done requires evidence plus review or explicit manual override.
4. Harden the `npm test` path for sandboxed execution by adding a package script that uses `node --import tsx --test` and excludes PTY loopback tests when loopback bind is denied.
