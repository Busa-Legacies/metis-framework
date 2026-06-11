# Workbench Release-Boundary Final QA — Claude — 2026-05-09

## TL;DR

| Gate | Verdict |
| --- | --- |
| **MVP visibility** | **PASS** |
| **Productization (browser-smoke harness)** | **PASS** |
| **Remaining release blockers** | **None in code.** One non-code item: real-browser five-step manual walkthrough. |

Both intra-workspace visibility gates (B1, B2) and the browser-smoke
false-positive gate (B3) are landed in source on disk under
`Projects/agent-workbench/`. Focused tests are green. The previous
01:31 CT FAIL verdict was a sequencing miss; this report supersedes
it and `WORKBENCH_SOURCE_TRUTH_QA_CLAUDE_20260509.md`.

No push, no deploy, no external writes performed.

## Inputs

- `WORKBENCH_SOURCE_TRUTH_QA_CLAUDE_20260509.md` — post-Codex source-truth
  reconciliation (verdict: MVP PASS, productization PARTIAL on B3).
- `WORKBENCH_BROWSER_SMOKE_HARNESS_HARDENING_CODEX_20260509.md` — Codex
  hardening lane closing the B3 false-positive vector.

Both reports independently verified at byte level below.

## Source-truth evidence

`Projects/agent-workbench/` is excluded from the parent workspace git
tree (`/Projects/` in workspace `.gitignore`), so `git status` is blind
here. Verification is by file content and mtimes.

```
-rw-r--r--@ 13069 May  9 01:31  components/PaneGrid.tsx
-rw-r--r--@ 46920 May  9 01:31  components/Workbench.tsx
-rw-r--r--@  4854 May  9 01:30  lib/cockpit-ui-state.ts
-rw-r--r--@ 10536 May  9 01:29  lib/layout.ts
-rw-r--r--@  4862 May  9 02:12  scripts/browser-smoke.mjs       # hardened
-rw-r--r--@  1793 May  9 02:12  tests/browser-smoke.test.mjs    # new
-rw-r--r--@ 34263 May  9 01:31  tests/tool-routing.test.ts
```

`scripts/browser-smoke.mjs` and `tests/browser-smoke.test.mjs` mtimes
(02:12 CT) are post the Codex hardening report, confirming the
hardening landed.

### B1 — `openAgentPane` is non-destructive (PASS)

`components/Workbench.tsx:304-318`:

```ts
function openAgentPane(workspaceId: string, agentId: string) {
  setActiveWsId(workspaceId)
  setLayoutByWs((cur) => {
    const rootForWs = cur[workspaceId] ?? singleLeafLayout()
    const existing = leaves(rootForWs).find((l) => l.agentId === agentId)
    if (existing) {
      setActiveLeafId(existing.id)
      return cur
    }
    const placed = placeAgent(rootForWs, agentId, activeLeafId ?? undefined)
    const target = leaves(placed).find((l) => l.agentId === agentId)
    if (target) setActiveLeafId(target.id)
    return { ...cur, [workspaceId]: placed }
  })
}
```

`grep` confirms `assignAgent` no longer appears inside `openAgentPane`;
the two remaining call-sites (lines 483, 574) are intentional drag/drop
and `PaneGrid onAssignAgent` paths. `placeAgent` (lib/layout.ts) is
itself non-destructive: already-visible → focus; preferred empty leaf →
fill; any empty leaf → fill; overwrite only as last resort.

### B2 — Per-pane `ack'd` / `stale` / `report ready` pills (PASS)

Wiring chain end-to-end:

- `lib/cockpit-ui-state.ts:76-89` — `cockpitPaneStates(workspace, agentId)`
  pure helper derives the three states from cockpit wire data; labels
  match the user-facing requirement: `stale`, `report ready`, `ack'd`.
- `components/Workbench.tsx:71-95` — `refreshCockpitSummary` 5-second
  poll against `/api/assistant?scope=cockpit`; read-only, no mutation.
- `components/Workbench.tsx:186` — derives `activeCockpitWorkspace` via
  `useMemo`; line 567 passes it into `<PaneGrid>`.
- `components/PaneGrid.tsx:9` — imports helper.
- `components/PaneGrid.tsx:109` — `paneStates = cockpitPaneStates(...)`.
- `components/PaneGrid.tsx:166-170` — renders pills inside pane-control
  bar with `paneStateTone(state.kind)` styling.
- `components/PaneGrid.tsx:229-232` — tone helper covers stale (amber),
  report-ready (sky), acked (emerald, default branch).

Pills render once on mount and update every 5s as cockpit summary
refreshes — not just static markup.

### B3 — Browser-smoke harness false-positive vector closed (PASS)

`scripts/browser-smoke.mjs` (mtime 02:12 CT) now reserves a real TCP
port via `net.createServer().listen({ host, port, exclusive: true })`
**before** spawn:

- Default run: reserves an ephemeral free port (`port: 0`), releases it,
  then targets that port deterministically (`buildSmokeConfig` at lines
  58-70). Probe URL is the freshly reserved port — cannot be the live
  Electron app's 3747.
- Deterministic override: `AW_NEXT_PORT` (precedence) or `AW_SMOKE_PORT`
  goes through the same `reserveTcpPort` call; if a foreign listener
  already owns the port, `listen` errors with `EADDRINUSE` and the
  harness fails before spawn — no probe issued.
- Race tail: `runBrowserSmoke` retains the regex-grep at line 109
  (`/listen EPERM|EADDRINUSE|Error: listen/i`) on child output, so a
  process that grabs the port between release and spawn still fails
  the run.
- Input validation: `parsePort` and `parseTimeoutMs` reject bad
  `AW_NEXT_PORT` / `AW_SMOKE_PORT` / `AW_SMOKE_TIMEOUT_MS` values with
  explicit messages before spawn.

This closes the precise scenario flagged in the prior source-truth QA:
"developer box has Electron app open, harness sees foreign Next page,
exits 0 with inadmissible green." The default no longer touches 3747
at all.

## Tests — focused suites green

```bash
$ node --test tests/browser-smoke.test.mjs
ℹ tests 4  ℹ pass 4  ℹ fail 0  ℹ skipped 0

$ node --import tsx --test \
    tests/tool-routing.test.ts \
    tests/cockpit-continuity.test.ts \
    tests/workbench-layout.test.ts
ℹ tests 48  ℹ pass 47  ℹ fail 0  ℹ skipped 1
```

Combined: 52/52 active tests pass, 1 pre-existing
`originWorkspaceId` placeholder skip (not a regression).

Coverage relevant to the three gates:

- B1 → `tests/workbench-layout.test.ts` "workbench agent pane placement"
  suite (does not duplicate visible agent; fills empty leaf before
  replacing occupied pane).
- B2 → `tests/tool-routing.test.ts` "workbench pane placement and state
  helpers" suite added by Codex (covers `cockpitPaneStates` outputs).
- B3 → `tests/browser-smoke.test.mjs` (port override precedence; port
  and timeout validation; default loopback host; occupied-port
  rejection before probe).

## Reconciling with prior reports

| Claim | Source-truth QA (01:31) | Browser-smoke hardening (02:12) | This report (02:1x) |
| --- | --- | --- | --- |
| B1 fixed | YES | n/a | YES |
| B2 fixed | YES | n/a | YES |
| B3 false-positive closed | NO — race remains | YES — pre-bind reservation | YES — verified |
| Tests | 45 pass / 1 skip | +4 browser-smoke pass | 47 + 4 pass / 1 skip |

The source-truth QA correctly identified the B3 race; Codex's
hardening lane (02:12 CT) closes it. Both code-level MVP gates and
the productization gate are now in source.

## Sandbox observation (not a blocker)

Inside the sandbox, `npm run smoke:browser` exits with:

```
browser smoke cannot reserve 127.0.0.1:0: listen EPERM: operation not permitted 127.0.0.1
```

This is the **correct fail-safe direction**: the sandbox cannot bind
loopback at all, so the harness fails before any probe runs. End-to-end
real-browser execution requires a developer or CI host with bind
permission — environmental, not a code defect.

## Exact remaining release blockers

**Code:** none.

**Out-of-band, non-blocking but recommended before user-visible
"ship-ready" call:**

1. Real-browser five-step manual walkthrough on a developer box with
   bind permission: matrix table render, drawer scroll, optimistic-ack
   flicker, non-evicting open-pane on existing-leaf focus, and visible
   `ack'd`/`stale`/`report ready` pills updating across the 5s poll.
   This is acceptance-walk-through scope, not a code blocker.

## Productization follow-ups (non-MVP, non-release-blocking)

These are tracked but explicitly NOT gates:

1. Cockpit-poll back-off / SSE migration off the 5s `/api/assistant?scope=cockpit`
   poll once the endpoint stabilises.
2. Pane pill snapshot/render test on `<PaneGrid>` with a mocked
   `cockpitWorkspace` to cement the B2 contract beyond the helper-only
   coverage.
3. Remaining P1-P5 items from `WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md`
   (`AssistantPanel` polish etc.) — separately tracked.

## Verdict (one line)

**Release boundary: PASS.** MVP visibility (B1, B2) and browser-smoke
harness hardening (B3) are all landed in source as of 2026-05-09 02:12
CT; focused test suites are green; only a real-browser manual
acceptance walkthrough remains, and it is non-code.
