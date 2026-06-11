# Workbench Swarm Ops Improvement - 2026-05-10

## Goal

Improve Agent Workbench as Jarvis's internal swarm-ops control plane, with the smallest useful local changes and without broad rewrites.

## Current UI/API Audit

- The PTY sidecar already exposes the core control-plane primitives: workspace CRUD, agent spawn/kill/rename, scrollback, persisted exited output, broadcast, layout persistence, task lanes, resume specs, and per-workspace git status.
- The renderer already had a three-rail shape: workspace/files/tasks on the left, panes/tabs in the middle, and assistant/notes/MCP on the right.
- Running/exited state and git status were already present, but the workspace rail did not surface the top "what next?" lane from cockpit summary.
- `ptyApi.spawnAgent` and `/agents` already accepted `initialPrompt`, and the server already uses it for Claude append-system-prompt and Codex `exec`; the visible spawn UI did not expose that directive path.
- Some visible copy still framed the app as a product/dev environment or assistant, rather than an internal operator surface.

## Changes Made

- Added a directive field to the spawn menu for Claude and Codex lanes.
  - Claude receives the directive through the existing appended system prompt path.
  - Codex receives the directive through the existing `codex exec --sandbox workspace-write <prompt>` path.
  - Shell/Gemini/Python/custom panes keep manual behavior and show that directives are ignored.
- Updated Workbench spawn plumbing so `initialPrompt` flows from the spawn menu to `ptyApi.spawnAgent`.
- Added next-lane visibility to workspace cards in the left rail using `cockpitSummary.nextActions`.
  - Each workspace can now show the top action kind and reason, next to existing agents/tasks/git/evidence cues.
- Tightened visible swarm-ops language:
  - Header label: `Swarm Ops`.
  - Right rail tab: `operator`.
  - Empty pane/tab copy points to `spawn` and `operator`.
  - Metadata/package/README now describe an internal swarm-ops control plane.
  - Notes placeholder/template changed from mission/product language to an ops brief.
  - Operator system prompt now calls the app Jarvis's internal swarm-ops workbench.

## Remaining Gaps

- Directive spawn is intentionally minimal: it does not yet include reusable directive templates, lane presets, or a task-to-directive handoff.
- Codex role prompts are not composed server-side; role chips remain Claude-only. Codex gets the freeform directive exactly as entered.
- The workspace rail shows only the first cockpit next action per workspace. A richer lane queue would need a compact drilldown or filter.
- The API still uses `/api/assistant` and `AssistantPanel` naming internally for compatibility; only user-visible copy was adjusted.
- Test execution is blocked in this sandbox because `tsx --test` cannot open its IPC pipe under `/var/folders/.../tsx-501/...pipe`.

## Verification

- `npm run typecheck` passed.
- `npm run build` passed.
  - Build emitted an existing Turbopack warning about `next.config.ts` appearing in the NFT trace through `app/api/assistant/route.ts` and `lib/dispatch-runs.ts`.
- `npm run lint` completed with warnings only; no lint errors.
  - Warnings are existing cleanup categories such as unused imports/vars and React hook dependency warnings.
- `npm test` did not run to completion in this environment.
  - Failure: `Error: listen EPERM: operation not permitted /var/folders/3y/v47pm3c521x0_6f0c7hm04gr0000gn/T/tsx-501/11331.pipe`.
