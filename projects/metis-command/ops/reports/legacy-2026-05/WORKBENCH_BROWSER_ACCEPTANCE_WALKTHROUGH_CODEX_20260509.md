# Workbench Browser Acceptance Walkthrough — Codex — 2026-05-09

## Verdict

| Gate | Verdict | Evidence |
| --- | --- | --- |
| Release-boundary context read | PASS | Read `WORKBENCH_RELEASE_BOUNDARY_FINAL_QA_CLAUDE_20260509.md`; it identifies the remaining non-code item as the real-browser five-step manual walkthrough. |
| Existing 127.0.0.1:3747/3748 reuse | BLOCKED | `lsof` showed listeners on 3747 and 3748, but HTTP checks from this sandbox could not connect to either port over IPv4 or IPv6. |
| Browser automation surface | BLOCKED | Browser skill was loaded, but `tool_search` exposed no `node_repl js` / `mcp__node_repl__js` callable tool for the in-app browser. |
| Matrix render walkthrough | BLOCKED | Could not open the Workbench in a real browser from this session. Source/test evidence for matrix helpers remains green. |
| Drawer scroll walkthrough | BLOCKED | Could not open and scroll the cockpit drawer in a real browser from this session. |
| Optimistic ack walkthrough | BLOCKED | Could not click an acknowledgement in-browser. Source/test evidence for ack state transitions remains green. |
| Non-evicting pane focus walkthrough | BLOCKED | Could not click an already-open agent in-browser. Source/test evidence for non-evicting focus remains green. |
| `ack'd` / `stale` / `report ready` pane pills | BLOCKED | Could not visually verify rendered pills in-browser. Source/test evidence for pill derivation remains green. |
| Push/deploy | PASS | No push or deploy performed. |

## Required Input

Read:

- `WORKBENCH_RELEASE_BOUNDARY_FINAL_QA_CLAUDE_20260509.md`

Relevant release-boundary instruction from that report:

- The only remaining non-code item is the real-browser five-step manual walkthrough: matrix table render, drawer scroll, optimistic ack flicker, non-evicting open-pane on existing-leaf focus, and visible `ack'd` / `stale` / `report ready` pills updating across the 5s poll.

## Browser Availability Evidence

Existing listener check:

```text
COMMAND    PID   USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
Agent      5807  jarvis 15u  IPv6 ...          TCP *:3748 (LISTEN)
Agent      5808  jarvis 15u  IPv6 ...          TCP *:3747 (LISTEN)
```

Connectivity checks:

```text
curl -I --max-time 3 http://127.0.0.1:3747/
curl: (7) Failed to connect to 127.0.0.1 port 3747 after 0 ms: Couldn't connect to server

curl -I --max-time 3 http://127.0.0.1:3748/
curl: (7) Failed to connect to 127.0.0.1 port 3748 after 0 ms: Couldn't connect to server

curl -g -I --max-time 3 'http://[::1]:3747/'
curl: (7) Failed to connect to ::1 port 3747 after 0 ms: Couldn't connect to server

curl -g -I --max-time 3 'http://[::1]:3748/'
curl: (7) Failed to connect to ::1 port 3748 after 0 ms: Couldn't connect to server
```

Browser-control check:

```text
tool_search query: node_repl js JavaScript execution
result: Found 0 tools.

tool_search query: mcp__node_repl__js
result: Found 0 tools.
```

Result: this session could not truthfully execute the real-browser walkthrough, despite the local machine having Agent Workbench listeners.

## Focused Verification Collected

Typecheck:

```text
npm run typecheck
> tsc --noEmit
exit code: 0
```

Focused tests:

```text
node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts tests/workbench-layout.test.ts

tests 48
pass 47
fail 0
skipped 1
```

Relevant passing coverage:

- Matrix render state: `getCockpitWorkspaceMatrix` coverage in `tests/tool-routing.test.ts` and `tests/cockpit-continuity.test.ts`.
- Optimistic ack state: `applyCockpitAgentAcknowledgement` and cockpit acknowledgement transition coverage in `tests/cockpit-continuity.test.ts`.
- Non-evicting pane focus: `tests/workbench-layout.test.ts` confirms an already-visible agent is not duplicated and empty leaves are filled before replacement.
- `ack'd` / `stale` / `report ready` pills: `tests/tool-routing.test.ts` confirms `cockpitPaneStates` derives the expected labels without mutating cockpit data.

Browser smoke:

```text
AW_SMOKE_TIMEOUT_MS=8000 npm run smoke:browser

browser smoke cannot reserve 127.0.0.1:0: listen EPERM: operation not permitted 127.0.0.1
exit code: 1
```

This is consistent with the prior sandbox observation: local bind/probe is denied before app code can be exercised.

## Walkthrough Matrix

| Step | Required Observation | Result | Notes |
| --- | --- | --- | --- |
| 1 | Cockpit matrix table renders in the Workbench UI. | BLOCKED | No browser page could be opened from this session. |
| 2 | Cockpit drawer scrolls and remains usable. | BLOCKED | No browser page could be opened from this session. |
| 3 | Acknowledge action shows optimistic UI transition/flicker and persists in next cockpit state. | BLOCKED | Browser click path unavailable; pure state transition tests pass. |
| 4 | Opening an already-visible agent focuses its existing leaf without evicting another pane. | BLOCKED | Browser click path unavailable; layout tests pass. |
| 5 | Pane-level `ack'd`, `stale`, and `report ready` pills are visible and update after polling. | BLOCKED | Visual browser check unavailable; helper tests pass. |

## Final Status

The requested real-browser acceptance walkthrough is **BLOCKED** in this session by unavailable browser control and unreachable local HTTP endpoints, even though Agent Workbench listener processes are present on 3747/3748.

Source-level and focused test evidence remains **PASS** for the same gates, but this report does **not** claim the manual browser walkthrough is complete.

No push or deploy was performed.
