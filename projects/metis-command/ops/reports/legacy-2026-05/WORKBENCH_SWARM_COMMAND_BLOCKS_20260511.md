# Swarm Mailbox And Command Blocks
Date: 2026-05-11
Worker: 4

## Delivered
- Added `lib/swarm-mailbox.ts`, a pure bounded mailbox helper for append/list/ack flows keyed by `workspaceId`, `missionId`, `laneId`, and `agentId`.
- Added `lib/terminal-command-blocks.ts`, a pure terminal parser that prefers OSC 133 shell integration markers and falls back to common shell prompt command heuristics.
- Added focused node tests for mailbox semantics, guardrails, OSC 133 parsing, fallback parsing, and output bounds.

## Integration Hooks Needed
- `server/pty-server.ts`: add `mailbox?: SwarmMailboxRow[]` to persisted state, then expose routes such as:
  - `GET /workspaces/:workspaceId/mailbox?missionId=&laneId=&agentId=&acked=&limit=`
  - `POST /workspaces/:workspaceId/mailbox`
  - `POST /workspaces/:workspaceId/mailbox/ack`
- `server/pty-server.ts`: call `extractTerminalCommandBlocks()` from the scrollback endpoint or while appending persisted output, then persist command block snapshots per agent if UI collapse/search needs to survive restarts.
- `components/AgentTerminal.tsx`: consume command block snapshots from an HTTP endpoint or a new WebSocket message type; keep raw terminal streaming unchanged until the block UI is ready.

Direct server/UI edits were intentionally avoided because those files already have concurrent modifications outside Worker 4 ownership.

