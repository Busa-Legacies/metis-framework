# Workbench Task Build Handoff - 2026-05-11

## Scope

Worked in the real Swarm Ops app:

`/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`

Do not confuse this with the separate Electron prototype at `/Users/jarvis/Documents/New project 5`.

## Delivered

- Added a task build handoff endpoint:
  - `POST /workspaces/:workspaceId/tasks/:taskId/build`
  - Spawns a Codex builder with a task-scoped initial directive.
  - Sets the task status to `building`.
  - Assigns the spawned builder as the task owner.
- Added `ptyApi.buildTask()`.
- Added a compact hammer action to task cards for `todo` and `building` tasks.
- Added evidence count visibility on task cards.
- Added UI handling for the existing done gate: moving a task to `done` without required evidence prompts for an explicit override reason, then records a manual override through the existing backend path.
- Added a BridgeMemory-style Knowledge surface:
  - `GET /workspaces/:workspaceId/memory` on the PTY sidecar.
  - Searches `.workbenchmemory` or `.bridgememory` in the active workspace using the existing markdown memory parser.
  - Also searches local knowledge roots: workspace cwd, pinned roots, detected Obsidian vaults, `~/.openclaw`, `~/.claude`, and `~/.codex`.
  - Adds a right-rail `knowledge` tab that shows note titles, tags, paths, previews, update dates, and wikilink counts.
  - Keeps the first UI slice read-only so shared project memory is visible without accidental writes.
- Injects local knowledge-root context into spawned Claude agents and task-scoped Codex build prompts so CLI agents know where to resolve references to Jarvis projects, Obsidian notes, OpenClaw memory, Claude memory, and Codex memory.

## Behavior

The generated Codex directive includes:

- task title and description
- workspace name and cwd
- declared files in scope, or a scoped-inspection fallback
- workbench protocol: inspect first, smallest viable change, preserve unrelated edits, run focused checks, finish with changed files/verification/risks

This is the first task-to-agent BridgeSpace-style handoff without changing the main Swarm Ops layout.

The task board now makes the BridgeSwarm lifecycle clearer:

`todo -> build with Codex -> review with Claude -> evidence/override -> done`

The right rail now maps closer to BridgeMind's operating model:

`operator -> workspace notes -> shared knowledge graph -> MCP`

## Verification

- `npm run typecheck` passed.
- `npm run build` passed.
  - Existing Turbopack NFT warning remains: `next.config.ts` appears in the trace through `lib/dispatch-runs.ts` and `app/api/assistant/route.ts`.
- `node --import tsx --test tests/workbench-memory.test.ts tests/workbench-layout.test.ts` passed.
- `node --import tsx --test tests/pty-server-lifecycle.test.ts tests/workbench-layout.test.ts`
  - `workbench-layout.test.ts` passed.
  - PTY lifecycle tests were blocked by sandbox networking: `listen EPERM: operation permitted 127.0.0.1`.

## Restart note

The running packaged Agent Workbench listeners were visible on ports `3747` and `3748`, but this Codex sandbox could not signal them (`kill ... operation not permitted`) and could not bind replacement dev listeners (`listen EPERM`). Quit/reopen the macOS Agent Workbench app to load the updated PTY route and right-rail UI.
