# Workbench Jarvis Isolation + CEO Control Spec — 2026-05-08 CT

## Problem
Nick wants to command Jarvis from inside Agent Workbench with the same effectiveness as Telegram/OpenClaw UI, while Workbench remains a controlled multi-agent cockpit. Prior issues:

- Workbench directives and Telegram context can bleed together.
- Stale malformed `aw_action` blocks can replay/noise later turns.
- Workspace assistant lacks a fully durable Workbench-scoped session identity.
- Project/product panes need stronger boundaries so REOS/Sitework/Workbench agents do not interfere.

## Desired behavior
Inside Workbench, Nick can say:

> Spawn 3 Claude agents in Sitework: one for scrolling/3D animation, one for copy/content flow, one for dead links/clickability.

Jarvis should:
1. Identify active workspace or requested workspace.
2. Spawn panes in that workspace only.
3. Give each pane a scoped directive with owned files/modules and acceptance tests.
4. Track lane reports/completion.
5. Later answer: “these agents are done; here is what they did; this one should be closed; these two get next directives.”
6. Package commits/save-points without making Nick handle branch mechanics.

## Requirements

### R1 — Persistent Workbench session
- Workbench Jarvis uses a stable session key such as `workbench:<workspaceId>` or `workbench:global`.
- It must not reuse Telegram direct-chat session context.
- Gateway chat requests include active workspace ID/name/cwd and visible pane summary.

### R2 — Channel/context isolation
- Telegram inbound metadata must never appear in Workbench assistant responses.
- Workbench action blocks/directives must not be routed to Telegram.
- Workbench should talk to the same main Jarvis/OpenClaw brain, but with a Workbench-scoped session and metadata.

### R3 — Action replay hygiene
- Do not replay historical malformed `aw_action` blocks.
- Only execute action blocks emitted in the current assistant turn.
- Keep a per-turn action ledger: action id, tool, args hash, result, timestamp.
- Ignore duplicate action ids / same-turn replay.

### R4 — Workspace-scoped tools
- `spawn_agents`, `broadcast`, `send_to_agent`, and `read_agent_output` default to active workspace.
- Cross-workspace actions require explicit workspace id/name in the request or Jarvis confirmation.
- Spawned agent cwd defaults to the workspace canonical root.
- Workspace notes are injected into new Claude panes.

### R5 — Product boundaries
- Each workspace has canonical root, GitHub remote, notes, pinned roots, and lane report path.
- Agent Workbench UI should expose these boundaries visibly.
- Future spawning should reject a cwd outside workspace root unless the path is in pinned roots.

### R6 — Fast manager UX
- Quick Workbench requests should not require Telegram:
  - list agents
  - read completed outputs
  - close done panes
  - spawn lane agents
  - broadcast next directive
  - summarize dirty Git state
- Slow/deep reasoning can route to OpenClaw Jarvis, but tool actions should execute in Workbench.

### R7 — Tests
Add/maintain tests for:
- action block validation rejects malformed JSON and unknown tools;
- `send_to_agent` requires known agent id;
- broadcasts stay isolated to workspace;
- Workbench session key generation does not equal Telegram/session-default;
- stale action blocks in previous messages are not re-executed;
- workspace cwd/root validation for spawned panes.

## Acceptance gates
- `npm test -- --watch=false` passes.
- `npm run build` passes if available.
- Manual smoke: Workbench assistant can list agents, spawn two panes in selected workspace, send different directives, and report outputs without Telegram bleed.

## Implementation lanes

### Lane A — Session/runtime isolation
Owner: Codex preferred.
Files likely: `lib/openclaw-gateway.ts`, `lib/openclaw-runtime.ts`, `app/api/assistant/route.ts`, tests.
Deliverable: persistent Workbench session key + metadata isolation.

### Lane B — Action replay / dispatch ledger
Owner: Claude or Codex.
Files likely: `app/api/assistant/route.ts`, `lib/tool-routing.ts`, tests.
Deliverable: only current-turn action blocks execute; duplicates/stale malformed blocks ignored.

### Lane C — Workspace boundary UX/API
Owner: Claude for design, Codex for API.
Files likely: `server/pty-server.ts`, `lib/pty-client.ts`, Workbench UI components.
Deliverable: visible canonical root/notes/pinned roots and spawn cwd validation.

## GitHub policy
Commit internally after tests. Do not push without Nick approval.
