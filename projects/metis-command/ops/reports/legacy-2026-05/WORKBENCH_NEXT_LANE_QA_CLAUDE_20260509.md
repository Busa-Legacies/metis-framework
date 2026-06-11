# Workbench Next-Lane QA — Claude — 2026-05-09

## Purpose

Owner-grade map after the 2026-05-09 release-boundary lane closed. Tells
Nick (and the next spawner) exactly what is **done in source**, what is
**release-blocking**, what is **P1 / P2 productization**, and **what
NOT to spawn** because it is already landed or explicitly out of
contract.

Read-only pass. No code edits, no push, no deploy.

## Source-of-truth chain

The 2026-05-09 morning produced overlapping reports; resolution order
(latest supersedes earlier):

1. `WORKBENCH_RELEASE_BOUNDARY_FINAL_QA_CLAUDE_20260509.md` ← canonical PASS verdict
2. `WORKBENCH_BROWSER_SMOKE_HARNESS_HARDENING_CODEX_20260509.md` (B3 close)
3. `WORKBENCH_MVP_SOURCE_RECONCILE_CODEX_20260509.md` (B1, B2 already in source)
4. `WORKBENCH_SOURCE_TRUTH_QA_CLAUDE_20260509.md` (Claude post-Codex)

Earlier-in-morning Claude reports are explicitly stale and cite this
chain as their supersede:

- `WORKBENCH_MVP_VISIBILITY_FINAL_QA_CLAUDE_20260509.md` (01:31 FAIL — sequencing miss)
- `WORKBENCH_MVP_ACCEPTANCE_REVIEW_CLAUDE_20260509.md` (FAIL — same)
- `WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md` (the blocker list it cites is closed)

Do **not** re-fire builder lanes off the FAIL reports.

## What is truly DONE (source-verified, this pass)

| Capability | Source evidence | Test |
| --- | --- | --- |
| Cross-workspace matrix in drawer | `lib/cockpit-ui-state.ts:54 getCockpitWorkspaceMatrix`; `components/AssistantPanel.tsx:179` | `tests/cockpit-continuity.test.ts`, `tests/tool-routing.test.ts` |
| Aggregate strip (N ws · running · stale · review · blocked · reports) | `components/AssistantPanel.tsx:99-138` | covered |
| Per-bucket readiness (running / review-ready / blocked / stale / unknown-exit / acked) | `lib/cockpit-summary.ts:269-278` | covered |
| Optimistic ack removes drawer row | `lib/cockpit-ui-state.ts:95 applyCockpitAgentAcknowledgement`; wired at `components/AssistantPanel.tsx:723` | covered |
| Reports survive pane clear | `lib/cockpit-continuity.ts:85` (atomic temp+rename at :40-41) | covered |
| Cockpit GET / `acknowledge_agent` / `list_workspace_reports` carved out of dispatch-run wrapper | `app/api/assistant/route.ts:287` | covered |
| **B1 — `openAgentPane` non-destructive** | `components/Workbench.tsx:304-318` uses `placeAgent(rootForWs, agentId, activeLeafId ?? undefined)` with existing-leaf focus first; `lib/layout.ts:59 placeAgent` is non-destructive | `tests/workbench-layout.test.ts` (2 cases) + `tests/tool-routing.test.ts:739` placement helpers suite |
| **B2 — per-pane `ack'd` / `stale` / `report ready` pills** | `components/PaneGrid.tsx:9` import, `:109` `paneStates = cockpitPaneStates(...)`, `:166-170` render, `:229-232` tone helper; helper at `lib/cockpit-ui-state.ts:76-89`; 5 s poll at `components/Workbench.tsx:71-95` | helper covered |
| **B3 — browser-smoke false-positive vector closed** | `scripts/browser-smoke.mjs:33 reserveTcpPort` + `:41 listen({host,port,exclusive:true})`; default reserves ephemeral free port, deterministic overrides go through same pre-bind reservation | `tests/browser-smoke.test.mjs` 4/4 |

This pass: `npm run typecheck` clean, focused TS tests **47 pass / 1
pre-existing skip / 0 fail**, browser-smoke harness tests **4/4 pass**.

## What is RELEASE-BLOCKING (right now)

**Code: nothing.**

**Out-of-band: one item.**

- **Real-browser five-step manual walkthrough**, on a host with bind
  permission (developer box or CI runner — not this sandbox). Steps:
  matrix table render across multiple workspaces; drawer scroll;
  optimistic-ack flicker (row removed locally before refetch);
  non-evicting "Open pane" focus on existing-leaf; per-pane
  `ack'd` / `stale` / `report ready` pills updating across the 5 s
  cockpit poll. Acceptance walkthrough scope, not a code defect.
  This unblocks the "ship-ready" call but does not require any new lane.

The sandbox `listen EPERM 127.0.0.1` from `npm run smoke:browser` is the
correct fail-safe direction (harness fails before any probe), not a
code bug.

## P1 productization (next lane after MVP gate)

These should be one ride-along Codex lane, Claude review, no push.
They do **not** block declaring MVP done.

1. **Atomic write for `data/dispatch-runs/<id>.json`.**
   `lib/dispatch-runs.ts:107` is still `fs.writeFileSync(file, …)` —
   non-atomic. `lib/cockpit-continuity.ts:40-41` already uses
   temp+rename. Lift the same helper to dispatch-runs. Small window,
   but writes happen every dispatch action; on crash mid-write the
   file can be truncated.

2. **Auth-parity test for `GET /api/assistant?scope=cockpit`.**
   The bearer model is in place — `app/api/assistant/route.ts:778-781`
   (POST) and `:850-851` (GET) are parallel. There is no automated
   test asserting non-localhost-without-bearer is rejected and
   non-localhost-with-bearer accepted on the GET path. One test, no
   production code change. Carry-over from the 2026-05-08 cockpit-
   endpoint review acceptance #6.

3. **`closePane` scrollback policy (P1).** `components/Workbench.tsx`
   `closePane` calls `kill(id)` even on already-exited agents;
   `server/pty-server.ts:542-557 killAgent` deletes
   `outputTails[id]` and removes the runtime row. Reports survive
   (good); terminal scrollback does not. Pick **one** mitigation:
   - gate `closePane` on an unread-reports confirmation, OR
   - change exited-pane removal to "hide" semantics that keeps
     `outputTails` until the explicit `clear exited` header button.
   Spec slice first (one paragraph), then code.

## P2 productization (later, after P1)

- **Lint debt on `components/AssistantPanel.tsx`.** `npx eslint
  components/AssistantPanel.tsx lib/cockpit-ui-state.ts` reports **8
  errors + 2 warnings** today (`no-explicit-any` x7,
  `react-hooks/exhaustive-deps` x2, `react/no-unescaped-entities`
  x1). All pre-existing; new code keeps adding on top. Must be green
  before "release-ready" can be claimed; otherwise CI sets a red
  baseline that future lanes can't pass cleanly.

- **Cockpit-poll back-off / SSE.** 5 s `/api/assistant?scope=cockpit`
  poll is fine for Nick alone; once the endpoint stabilises, migrate
  to event-stream and add `document.visibilityState !== 'hidden'`
  gating so the fetch dies in a backgrounded tab.

- **Pane-pill snapshot/render test on `<PaneGrid>`.** Today the B2
  contract is helper-only (`cockpitPaneStates` covered in
  `tests/tool-routing.test.ts:739`). Add a render-style test with a
  mocked `cockpitWorkspace` to cement the contract.

- **`originWorkspaceId` propagation.** `tests/tool-routing.test.ts:736`
  has `it.skip('surfaces originWorkspaceId once session-metadata
  propagation lands', …)`. Cross-workspace attribution on the cockpit
  row depends on it. Out of scope for visibility MVP; matters for
  governance once dispatches start crossing workspaces routinely.

## What NOT to spawn (already landed or out of contract)

- **B1 openAgentPane fix** — landed (`components/Workbench.tsx:304-318`).
- **B2 per-pane pills** — landed (`components/PaneGrid.tsx:166-170`).
- **B3 browser-smoke harness hardening** — landed
  (`scripts/browser-smoke.mjs:33` + `tests/browser-smoke.test.mjs`).
- **Any cockpit-summary or readiness-bucket re-architecture.** Wire-
  compatible additive shape is final per the continuity spec.
- **Any `clear_exited_agents` assistant tool / drawer-driven bulk
  clear.** Explicitly out of contract per
  `WORKBENCH_COCKPIT_UI_CONTINUITY_CLAUDE_20260509.md` non-goal #2/#10
  and the no-auto-clear invariant. The manual `clear exited` header
  button stays the only deletion path.
- **Any `/recommendations/execute` endpoint.** Cockpit recommends, never
  acts (continuity invariant #1, non-goal #4).
- **A new browser-smoke run from inside this sandbox.** The harness
  cannot bind 127.0.0.1; failing fast is the correct fail-safe, not a
  defect to chase. Run on Nick's box or CI.
- **A re-write of the originWorkspaceId test placeholder** until
  session-metadata propagation actually lands in tool-routing — that is
  P6 from the productization QA, not a near-term lane.
- **Re-spawning against the stale FAIL reports** listed under
  "Source-of-truth chain". They are sequencing artifacts; their blockers
  are closed.

## Governance — Workbench-specific reminders

Per `ops/reports/workbench_project_governance_protocol_20260508.md`:

- Every productization lane stays inside `Projects/agent-workbench`.
  `Projects/agent-workbench` is `.gitignore`d in the parent workspace
  tree, so `git status`/`git diff` from the workspace root is **blind**
  to changes here. Source-truth is by mtime + grep, as both this report
  and the source-truth QA do.
- No GitHub push without Nick approval, even for hygiene lanes.
- Continue to write `WORKBENCH_*_CLAUDE_*` for QA passes and
  `WORKBENCH_*_CODEX_*` for builder passes; the supersede chain depends
  on consistent naming.

## Recommended sequencing

1. **Nick (or Jarvis on Nick's box): real-browser five-step
   walkthrough.** Run `npm run dev:web` (or `npm run smoke:browser`)
   outside the sandbox and report pass/fail per step. Closes the
   release boundary.
2. **One Codex lane "productization-hygiene-A"**, Claude review:
   - dispatch-runs atomic write (P1 #1)
   - cockpit GET auth-parity test (P1 #2)
   - closePane scrollback policy spec slice + minimal code (P1 #3)
3. **One Codex lane "productization-hygiene-B"**, Claude review:
   - lint debt close on `AssistantPanel.tsx` / `cockpit-ui-state.ts`
   - tab-visibility gate on cockpit poll
   - PaneGrid pill render-style test
4. Then the larger CEO-flow Priority 4 wave (task tools / done-review
   gates extending `nextActions[]` queue with reviewer verdicts) —
   separate multi-lane wave, not batched with hygiene.

## Verdict (one line)

**MVP visibility = PASS in source as of 2026-05-09 02:12 CT.** The only
remaining release item is a real-browser manual walkthrough on a host
with bind permission. After that, two small productization lanes
(atomic dispatch-runs write + auth-parity test + closePane policy;
then lint + visibility gating + pane-pill render test) are the next
work — not a re-fire of B1/B2/B3.
