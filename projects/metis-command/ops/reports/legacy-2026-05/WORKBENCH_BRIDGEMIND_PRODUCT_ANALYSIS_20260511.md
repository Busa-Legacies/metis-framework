# BridgeMind Product Analysis For Agent Workbench
Date: 2026-05-11
Workspace: `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`

## Sources Reviewed
- BridgeMind homepage: https://www.bridgemind.ai/
- BridgeSpace product page: https://www.bridgemind.ai/products/bridgespace
- BridgeSpace docs: https://docs.bridgemind.ai/docs/bridgespace
- BridgeMCP product/docs: https://www.bridgemind.ai/bridgemcp and https://docs.bridgemind.ai/docs/mcp
- BridgeVoice product page: https://www.bridgemind.ai/products/bridgevoice
- Existing local brief: `docs/agent-workbench-bridgemind-reference-20260430.md`

Note: I could verify public product/docs pages and the existing local YouTube transcript-derived brief. I did not rely on uninspectable live-stream claims beyond those local notes.

## BridgeMind Product Model
BridgeMind is building an agentic coding suite around five primitives:

1. BridgeSpace: a local desktop workroom with terminal grids, task board, editor/file context, workspace tabs, and agent launch points.
2. BridgeSwarm: coordinated builder/reviewer/scout/coordinator agents, live status, shared mailbox, and up to 16 visible terminal lanes.
3. BridgeMemory: local-first `.bridgememory/` markdown knowledge graph, wikilinks/backlinks, graph view, and MCP tools for agents to read/write shared context.
4. BridgeMCP: shared protocol layer connecting Claude, Codex, Cursor, Windsurf, and BridgeSpace to projects, tasks, knowledge, and agent workflows.
5. BridgeVoice: global desktop dictation with local Whisper/cloud Whisper, hotkeys, custom replacement dictionary, history, stats, and universal text injection.

## Useful Gaps For Our Agent Workbench
Our app already has PTY-backed agents, workspaces, pane grids, task board, roles, notes, MCP config, dispatch runs, cockpit summary, and evidence ledger. The highest-return next build lanes are:

1. Mission/lane contract
   - Convert loose multi-agent fanout into a durable mission packet with lanes, owner roles, scope, evidence obligations, budget, and review gate.
   - This maps directly to BridgeSpace task -> workspace -> agents -> review.

2. Evidence-gated task lifecycle
   - Task status `done` should require evidence rows: implementation report plus review or explicit override.
   - The existing `lib/evidence-ledger.ts` already has `hasRequiredEvidenceForDone`; it needs endpoint/UI/tool enforcement.

3. Shared memory hub
   - Add `.workbenchmemory/` or `.bridgememory/` compatible markdown notes with search, backlinks, and create/read helpers.
   - Keep it local-first and agent-readable through future MCP/tool surfaces.

4. Command-block readability
   - BridgeSpace emphasizes Warp-style command blocks with timestamps, exit status, collapse, and search.
   - Our terminals persist scrollback but do not yet structure output into blocks.

5. Swarm mailbox/activity feed
   - BridgeSwarm’s strongest coordination idea is not just multiple panes; it is role handoffs and shared status.
   - Add a local mailbox/event feed keyed by workspace/mission/lane so agents can leave handoffs without burying them in terminal output.

6. Voice command targeting
   - Our voice flow exists, but BridgeVoice’s developer dictionary/history/targeting makes voice reliable.
   - Add transcript history, replacement rules, and visible target state before deeper OS-wide injection work.

## Agent Lanes Started
1. Mission contract and lane advisor: define mission/lane types, lane selection helper, tests, and integration notes.
2. Evidence-gated tasks: enforce done/review transitions against evidence, add evidence task endpoints/client helpers/tests.
3. Shared memory hub: implement local markdown memory module with search/backlinks and tests.
4. Command blocks and swarm mailbox design: implement bounded backend primitives or produce exact integration patch if existing terminal stream shape blocks direct implementation.

