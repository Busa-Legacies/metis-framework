# Workbench Isolation Implementation Report - 2026-05-08

## Scope
Implemented persistent Workbench-scoped Jarvis session/context isolation, current-turn `aw_action` replay hygiene, and workspace cwd boundary enforcement for spawned panes.

## Changes
- Added `lib/workbench-session.ts`
  - Stable session keys: `workbench:<workspaceId>` and `workbench:global`.
  - Reserved non-Workbench key checks for Telegram/default separation tests.
- Added `lib/action-ledger.ts`
  - Extracts action blocks only from the current assistant turn text.
  - Creates per-turn ledger entries with `actionId`, `tool`, `argsHash`, `result/error`, and timestamp.
  - Suppresses duplicate explicit action ids and same-turn tool/args replays.
- Added `lib/workspace-boundary.ts`
  - Validates spawn cwd against the workspace canonical root plus pinned roots.
  - Rejects unrelated cwd escapes before PTY launch.
- Updated `app/api/assistant/route.ts`
  - Resolves active workspace name/cwd and visible pane summary from the PTY sidecar when available.
  - Injects Workbench context into Jarvis/OpenAI prompts.
  - Uses `buildWorkbenchSessionKey()` for OpenClaw gateway and runtime fallback.
  - Replaces ad hoc action-block loops with current-turn ledger execution.
- Updated `lib/openclaw-gateway.ts`
  - Accepts Workbench metadata and includes it in `chat.send`.
- Updated `lib/openclaw-runtime.ts`
  - Accepts per-turn `sessionKey`; fallback default is now `workbench:global`.
- Updated `server/pty-server.ts`
  - Enforces cwd boundary validation for spawn and resume paths.
  - Rejects inaccessible cwd instead of silently falling back outside the workspace.
- Updated tests
  - Action validation: malformed JSON, unknown tools, optional action ids.
  - Replay hygiene: current-turn extraction, duplicate id suppression, same-turn replay suppression.
  - Session isolation: Workbench keys differ from Telegram/default.
  - Broadcast isolation: workspace-scoped broadcast stays in workspace.
  - Unknown agent input: `/agents/:id/input` rejects missing agent.
  - Spawn cwd validation: workspace child allowed, pinned root allowed, unrelated cwd rejected.

## Verification
- `npm run typecheck`: passed.
- `npm run build`: passed.
  - Build warning: Next/Turbopack reported an NFT trace warning from `next.config.ts -> lib/openclaw-runtime.ts -> app/api/assistant/route.ts`.
- `TMPDIR=/private/tmp node --import tsx --test tests/tool-routing.test.ts`: passed.
- `npm test -- --watch=false`: blocked by sandbox before test execution.
  - Failure: `tsx` cannot create its IPC pipe (`listen EPERM`).
- `TMPDIR=/private/tmp npm test -- --watch=false`: blocked the same way.
- `TMPDIR=/private/tmp node --import tsx --test tests/*.test.ts`: pure tests passed; PTY tests blocked by sandbox network restrictions.
  - Failure: `listen EPERM: operation not permitted 127.0.0.1`.

## Notes
- No GitHub push was performed.
- The requested PTY tests are present but require an environment that allows local socket binding.
