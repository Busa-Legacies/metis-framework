# Codex Desktop Handoff — Agent Workbench Backend / Session Host
Created: 2026-04-30 CT

Read first:
- `ops/product-specs/agent-workbench-bridgemind-reference-20260430.md`
- `ops/build-protocols/desktop-build-role-map-20260430.md`

Mission: build the backend/system substrate for our agent workbench.

Build targets:
1. Data model: Project, Task, Workspace, AgentLane, DispatchEvent, Artifact, QACheck.
2. Task lifecycle API: Inbox → Ready → Running → Review → Done/Blocked.
3. Knowledge/attachment metadata per task.
4. Session-host abstraction: process/session state persists independently of React rendering.
5. Prompt dispatch ledger: target app/session, prompt preview/hash, timestamp CT, status, approval requirement.
6. Review-gate enforcement: cannot mark Done without linked artifact/test/QA evidence.
7. Tests for task lifecycle, dispatch ledger, and done-gate blocking.

Critical architecture note from BridgeMind transcript:
- Do **not** preserve hidden terminals by rendering every workspace and hiding inactive ones with CSS.
- Keep processes/sessions alive in a separate host keyed by terminal/session id; render only active workspace UI.

Do not:
- touch live trading V1;
- add external SaaS dependency for core local workbench state;
- implement blind external sending;
- skip tests.

Deliverable:
- code changes;
- tests run/result;
- migration/data notes if applicable;
- concise implementation report.
