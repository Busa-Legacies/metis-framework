# Workbench Product-Wave QA Map — Claude — 2026-05-09 12:30 CT

## Purpose

Owner-grade map covering the productization wave that follows the closed
release boundary. Tells Nick (and the next spawner) what P1/P2 lanes are
**safe to spawn**, what is **already in source** (don't duplicate), what
is **blocked by host/browser** in this sandbox, and the **exact
acceptance criteria** for each remaining lane.

Read-only QA pass. No code edits, no push, no deploy. Only this report
file written.

## Source-of-truth chain (read in order, latest supersedes earlier)

1. `WORKBENCH_RELEASE_BOUNDARY_FINAL_QA_CLAUDE_20260509.md` — release-
   boundary canonical PASS verdict.
2. `WORKBENCH_BROWSER_SMOKE_HARNESS_HARDENING_CODEX_20260509.md` — B3
   close.
3. `WORKBENCH_NEXT_LANE_QA_CLAUDE_20260509.md` — P1/P2 productization
   plan I'm verifying against here.
4. `WORKBENCH_BROWSER_ACCEPTANCE_WALKTHROUGH_CODEX_20260509.md` — Codex
   confirmed BLOCKED on real-browser five-step walkthrough from
   sandbox; consistent with my own observation below.
5. **This report** — productization-wave QA map.

Earlier 01:31 CT reports (`*MVP_VISIBILITY_FINAL*`, `*MVP_ACCEPTANCE_REVIEW*`,
the original `*PRODUCTIZATION_QA*`) remain stale per supersede chain;
do not respawn against them.

## Source-truth re-verification (this pass)

`Projects/agent-workbench/` is `.gitignore`d in the parent workspace
tree (workspace `git status` is blind here). Verification by file
content + mtime.

### Release-boundary items (B1, B2, B3) — still PASS

| Item | Source evidence | Mtime |
| --- | --- | --- |
| B1 — `openAgentPane` non-destructive | `components/Workbench.tsx:304-318` (`placeAgent(rootForWs, agentId, activeLeafId ?? undefined)`; existing-leaf focus first) | 2026-05-09 01:31 |
| B2 — per-pane `ack'd` / `stale` / `report ready` pills | `components/PaneGrid.tsx:9, :109, :166-170, :229-232`; helper at `lib/cockpit-ui-state.ts:76-89`; 5 s poll at `components/Workbench.tsx:71-95` | 01:30–01:31 |
| B3 — browser-smoke pre-bind reservation | `scripts/browser-smoke.mjs:33 reserveTcpPort` + `:41 listen({host,port,exclusive:true})` | 02:12 |

### P1 productization wave — partial Codex landing in flight

| P1 | Status (source) | Evidence |
| --- | --- | --- |
| **P1 #1 — atomic write for `data/dispatch-runs/<id>.json`** | **LANDED in source, no companion Codex report yet** | `lib/dispatch-runs.ts:104-119` now uses same-directory `writeFileSync` → `renameSync` with hidden-dotfile `.<basename>.<pid>.<ts>.tmp` and a `finally` cleanup; **mtime 2026-05-09 12:29:50 CT**. Test added in `tests/tool-routing.test.ts:312-340` ("persists dispatch runs through a same-directory atomic rename") — asserts single rename, same-dir from→to, regex-matched temp basename, end-state `[ws1.json]` only. **mtime 12:29:32 CT.** |
| **P1 #2 — auth-parity test for `GET /api/assistant?scope=cockpit`** | **NOT IN SOURCE** | `grep -rn 'bridgeApiKey\|scope=cockpit' tests/` returns no matches. Production parity is in place at `app/api/assistant/route.ts:847-855` (mirrors POST `:774-785`); coverage is the gap. |
| **P1 #3 — `closePane` scrollback policy slice + minimal code** | **NOT IN SOURCE** | `components/Workbench.tsx:295-302` still calls `void kill(agent.id)` on `agent.status === 'exited'`; `server/pty-server.ts:542-557 killAgent` still deletes `state.outputTails[id]` for exited agents and removes the runtime row. No spec slice file present. |

P1 #1's source change is unsealed (no `WORKBENCH_*_CODEX_20260509.md`
artifact for it); call this out so the next Codex spawn does not
re-implement.

### Test baseline — green

```text
npm run typecheck                                    # exit 0 (tsc --noEmit clean)

node --import tsx --test tests/tool-routing.test.ts \
                            tests/cockpit-continuity.test.ts \
                            tests/workbench-layout.test.ts
ℹ tests 48  ℹ pass 47  ℹ fail 0  ℹ skipped 1
  (skip = pre-existing originWorkspaceId placeholder at tool-routing:736)

node --test tests/browser-smoke.test.mjs
ℹ tests 4   ℹ pass 4   ℹ fail 0   ℹ skipped 0
```

Combined: **52/52 active tests pass, 1 pre-existing skip**, baseline
unchanged from release-boundary report — meaning P1 #1's atomic-rename
test landed without breaking existing coverage.

### P2 productization wave — none landed

| P2 | Status (source) | Evidence |
| --- | --- | --- |
| Lint debt close on `AssistantPanel.tsx` / `cockpit-ui-state.ts` | NOT STARTED | `npx eslint components/AssistantPanel.tsx lib/cockpit-ui-state.ts` reports **8 errors + 2 warnings** today (`no-explicit-any` ×7 at lines 18, 73, 344, 427, 553, 562; `react-hooks/exhaustive-deps` ×2 at 329, 621; `react/no-unescaped-entities` ×1 at 732). Same shape as the release-boundary report. |
| Cockpit-poll back-off / SSE + `document.visibilityState` gating | NOT STARTED | `components/Workbench.tsx:71-95` 5 s `setInterval` is unconditional; no `visibilityState` guard in this file. |
| Pane-pill render-style test on `<PaneGrid>` | NOT STARTED | Coverage stays helper-only at `tests/tool-routing.test.ts:739` ("workbench pane placement and state helpers"); no render-style test for PaneGrid. |
| `originWorkspaceId` propagation on cockpit row | OUT OF NEAR-TERM | Skip placeholder at `tests/tool-routing.test.ts:736` blocked on session-metadata propagation — this is P6, not a near-term lane. |

## Host/browser blockers (acknowledge, do NOT chase from sandbox)

| Surface | Sandbox observation | Verdict |
| --- | --- | --- |
| `npm run smoke:browser` | `browser smoke cannot reserve 127.0.0.1:0: listen EPERM: operation not permitted 127.0.0.1` (exit 1) | Correct fail-safe; harness fails before any probe. Not a code defect. |
| `curl http://127.0.0.1:3747/`, `:3748/`, IPv6 `[::1]` equivalents | Connection refused on all four (despite `lsof` showing `Agent` pid 5807/5808 listening on `*:3748` and `*:3747`) | Sandbox cannot reach loopback even when listeners exist locally. Walkthrough must run on Nick's host. |
| In-app browser-control MCP for the five-step walkthrough | `tool_search` for `node_repl js` and `mcp__node_repl__js` returned 0 tools (Codex 11:09 CT) and unchanged in this session | No real-browser verification possible from any sandbox session today. |

The `WORKBENCH_BROWSER_ACCEPTANCE_WALKTHROUGH_CODEX_20260509.md`
matrix (steps 1–5 all BLOCKED) remains the authoritative status of
the manual walkthrough. Nothing here changes that.

## Productization-wave QA matrix

Legend: SAFE = lane can be spawned now without conflict; PARTIAL = a
Codex change has already landed without a companion report; BLOCKED =
host/browser only; SKIP = already in source or out of contract.

| Lane | Verdict | Reason |
| --- | --- | --- |
| P1 #1 atomic dispatch-runs write | **PARTIAL — landed 12:29 CT, needs Codex sealing report + Claude review** | Source + test in place; no `WORKBENCH_*_CODEX_*.md` describing scope and acceptance. |
| P1 #2 cockpit GET auth-parity test | **SAFE TO SPAWN** | One test file change, no production code change. |
| P1 #3 closePane scrollback policy slice + minimal code | **SAFE TO SPAWN AFTER SPEC SLICE** | Spec paragraph first (one of two mitigations), then minimal code. Touches `components/Workbench.tsx:295-302` and possibly `server/pty-server.ts:542-557`. |
| P2 lint debt close (AssistantPanel + cockpit-ui-state) | **SAFE TO SPAWN** | Independent of P1. Required before any "release-ready" CI gate. |
| P2 visibility-gated cockpit poll | **SAFE TO SPAWN, BUT WAIT FOR P1 SETTLEMENT** | Touches `components/Workbench.tsx:71-95` — would conflict with any concurrent closePane edit (P1 #3). Sequence after P1 #3. |
| P2 PaneGrid render-style test | **SAFE TO SPAWN** | Test-only addition. |
| P6 `originWorkspaceId` propagation | **OUT OF SCOPE for this wave** | Blocked on session-metadata propagation; not in this wave. |
| Real-browser five-step manual walkthrough | **BLOCKED — host only** | Must run on Nick's box or CI runner with bind permission. Acceptance criteria under "Manual acceptance criteria (host)" below. |
| Re-fire B1 / B2 / B3 builder lanes | **SKIP — already landed** | See release-boundary report. |
| `clear_exited_agents` tool / drawer bulk-clear | **SKIP — out of contract** | Continuity invariant non-goal #2/#10; manual `clear exited` header button stays the only deletion path. |
| `/recommendations/execute` endpoint | **SKIP — out of contract** | Continuity invariant #1 (cockpit recommends, never acts). |

## Exact acceptance criteria per safe lane

### P1 #1 — atomic dispatch-runs write (in-flight Codex sealing review)

Claude review pass once Codex publishes the companion report. Until
then, exact in-source acceptance:

- `lib/dispatch-runs.ts` `writeWorkspaceData` delegates to a same-
  directory `writeFileSync(tmp)` → `renameSync(tmp, file)` helper
  (matches `lib/cockpit-continuity.ts:37-42` shape).
- Temp file lives in the **same directory** as the destination so the
  rename is atomic on the same filesystem (`path.join(path.dirname(file), ...)`).
- Temp basename collision-resistant (PID + epoch ms).
- `finally` block removes the temp on failure.
- A test in `tests/tool-routing.test.ts` (or a sibling) intercepts
  `fs.renameSync`, asserts exactly one rename, asserts `path.dirname(from) === path.dirname(to)`, and asserts no orphan temp files
  in the directory after the write.
- Focused test suite stays at **47 pass / 1 pre-existing skip / 0 fail**
  or grows by exactly the new test count.
- `npm run typecheck` clean.

Already met by current source on disk; awaiting Codex report for the
sealing review.

### P1 #2 — cockpit GET auth-parity test

- New test (likely in `tests/tool-routing.test.ts` or a new
  `tests/route-auth.test.ts`) invokes the route's `GET` handler with:
  - bridgeApiKey configured + `host: example.com` + no bearer →
    expects HTTP 401, `{"error": "unauthorized"}`.
  - bridgeApiKey configured + `host: example.com` + matching bearer →
    expects 200 with cockpit payload.
  - bridgeApiKey configured + `host: 127.0.0.1` + no bearer → expects
    200 (loopback bypass).
  - bridgeApiKey not configured → expects 200 regardless.
- Mirrors POST acceptance from cockpit-endpoint review #6.
- **No production code change** — failure means the route already had
  a regression (current source at `app/api/assistant/route.ts:847-855`
  is correct).
- Focused suite still green; total count grows by 4 (or however many
  cases the test covers).

### P1 #3 — closePane scrollback policy

Spec slice first (one paragraph in the lane report), pick **one** of:

**Option A — confirm-on-unread-reports gate.** `closePane` checks
`activeCockpitWorkspace`/`getCockpitWorkspaceMatrix` for any unread
report row tied to the agent in the closing leaf; if unread, raise a
`window.confirm` (or the existing dialog primitive) before the
`kill()` call. Default action remains close.

**Option B — hide semantics for exited agents.** `closePane` removes
the leaf from layout but leaves the runtime row + `outputTails` entry
intact when the agent is `status === 'exited'`. Only the explicit
`clear exited` header button (already at `components/Workbench.tsx:361`)
performs `killAgent` for exited agents.

Acceptance under either option:

- Existing `tests/workbench-layout.test.ts` placement suite still
  passes unchanged.
- New focused test (in `tests/workbench-layout.test.ts` for option A,
  in `tests/pty-server-lifecycle.test.ts` for option B) asserts
  reports survive a `closePane` on an exited agent.
- `clear exited` header button retains current behavior — explicit
  bulk-delete path stays the only authoritative scrollback drop.
- No regression in `tests/cockpit-continuity.test.ts` (reports still
  survive pane clear).

### P2 — lint debt close

Run as a **post-P1 hygiene lane**, Codex implements + Claude reviews:

- `npx eslint components/AssistantPanel.tsx lib/cockpit-ui-state.ts`
  exits 0.
- All 8 errors fixed (typed-any → discriminated union or precise
  shape; quote escaping; deps fixed by either dependency adjustment or
  proper memoization, not by suppressing the rule).
- 2 warnings either fixed or, if intentional behavior, suppressed
  with a comment that names the constraint.
- `npm run typecheck` and focused tests stay green.
- No behavioral change observable from helper / hook contracts —
  diff is confined to types, escapes, and dep arrays.

### P2 — visibility-gated cockpit poll

Spawn **after** P1 #3 lands to avoid a `Workbench.tsx` conflict:

- `components/Workbench.tsx:71-95` poll body short-circuits when
  `document.visibilityState === 'hidden'`.
- A `visibilitychange` listener triggers a single immediate refresh
  on `visible` to avoid stale data after long backgrounding.
- Focused test (likely `tests/cockpit-continuity.test.ts` or a new
  `tests/cockpit-poll.test.ts` with mocked document) asserts no fetch
  while hidden, fetch on transition to visible.

### P2 — PaneGrid pill render-style test

- New test in `tests/` (likely `tests/pane-grid.test.tsx` if RTL is
  set up; otherwise pure-component snapshot via test renderer) that
  feeds a mocked `cockpitWorkspace` into `<PaneGrid>` and asserts the
  three pill labels (`stale`, `report ready`, `ack'd`) appear /
  disappear correctly per `cockpitPaneStates` outputs.
- No production code change.

## Manual acceptance criteria (host — non-sandbox)

These are the only items that close the user-visible "ship-ready"
call. Run on Nick's box (`npm run dev:web`) or a CI runner with bind
permission; **cannot** be run from any sandbox session per the
codified host/browser blocker above.

1. **Matrix render** — open the assistant drawer; verify the cross-
   workspace matrix renders rows for every workspace with active
   agents, and column counts match the aggregate strip ("N ws ·
   running · stale · review · blocked · reports").
2. **Drawer scroll** — drawer remains scrollable past the visible
   viewport; rows do not snap back; aggregate strip stays sticky if
   designed sticky.
3. **Optimistic ack** — clicking ack on a drawer row removes it
   immediately (before the next 5 s cockpit poll); next poll does not
   re-add the row.
4. **Non-evicting open-pane** — clicking an agent already visible in
   a leaf focuses that leaf and does **not** evict any other pane;
   clicking an agent not visible places it in the preferred-empty
   leaf, only overwriting an occupied leaf if no empty leaves exist.
5. **Per-pane pills** — `ack'd` (emerald), `stale` (amber), `report
   ready` (sky) pills appear in the pane control bar per
   `cockpitPaneStates`; pills update across the 5 s cockpit poll
   without a manual refresh.

A failure on any of these reverts the release-boundary verdict from
PASS to BLOCKED for that gate; rerun the Claude release-boundary QA
afterward, not the builder lanes.

## Recommended sequencing for the product wave

1. **Codex (next): seal P1 #1.** Publish a brief
   `WORKBENCH_DISPATCH_RUNS_ATOMIC_WRITE_CODEX_20260509.md` describing
   the diff and the new test; Claude reviews against the acceptance
   above.
2. **Codex lane "productization-hygiene-A".** P1 #2 (cockpit GET
   auth-parity test) + P1 #3 (closePane scrollback spec slice +
   minimal code). Claude reviews.
3. **Codex lane "productization-hygiene-B".** P2 lint debt + P2
   PaneGrid render test. (Visibility-gated cockpit poll bundles in
   here only if it does not conflict with the P1 #3 diff.)
4. **Nick / Jarvis on Nick's box.** Real-browser five-step manual
   walkthrough. This is the final ship gate.
5. **CEO-flow Priority 4 wave.** Out of scope for this product wave;
   keep separate per release-boundary recommended sequencing.

## Governance — productization-wave reminders

- All wave work stays inside `Projects/agent-workbench/` (workspace
  `git status` is blind to it; verify via mtime + grep, as this report
  does).
- Continue naming convention: `WORKBENCH_*_CLAUDE_*.md` for QA passes,
  `WORKBENCH_*_CODEX_*.md` for builder passes; supersede chain depends
  on it.
- No GitHub push without Nick approval, even for hygiene lanes.
- One ride-along Codex lane at a time per the flywheel rule (serial
  task execution); do not parallel-spawn on the same files.

## Verdict (one line)

**Productization wave — release boundary remains PASS; P1 #1 (atomic
dispatch-runs write) has landed in source unsealed (12:29 CT) and
needs a Codex sealing report; P1 #2, P1 #3, all P2 lanes are SAFE TO
SPAWN per the matrix above; the real-browser five-step walkthrough
remains BLOCKED in any sandbox and must run on Nick's host.**
