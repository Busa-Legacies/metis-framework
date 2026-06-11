# Claude Desktop Handoff — Agent Workbench / BridgeMind-Style UX
Created: 2026-04-30 CT

Read first:
- `ops/product-specs/agent-workbench-bridgemind-reference-20260430.md`
- `ops/build-protocols/desktop-build-role-map-20260430.md`
- `voice/README.md` section “Jarvis Voice HUD Overlay”

Mission: build the frontend/UX of our agent workbench. This should feel like a Jarvis command room, not generic Trello or generic SaaS.

Build targets:
1. Workbench shell with task board + active workspace room.
2. Agent lanes for Claude Desktop, Codex Desktop, Jarvis/OpenClaw, Terminal/Logs.
3. Voice HUD integration/status strip: Idle, Listening, Transcribing, Targeting Claude/Codex, Dispatching, Thinking, Review Ready.
4. Review gate panel: changed files, tests, screenshots/logs, QA notes, ship/fix decision.
5. Dark high-contrast command-center visual system: stable layout, low clutter, OBS-friendly.

Do not:
- rename the product BridgeMind;
- build a generic SaaS dashboard;
- fake live data without marking fallback/demo state;
- bypass review/QA evidence.

Deliverable:
- code changes;
- screenshots if UI changes;
- concise changed-files report;
- verification command/result.
