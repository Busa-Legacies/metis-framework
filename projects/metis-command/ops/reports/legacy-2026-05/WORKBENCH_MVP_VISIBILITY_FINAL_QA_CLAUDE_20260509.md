# Workbench MVP Visibility — Final QA — Claude — 2026-05-09

## Scope

Final reviewer pass to answer one question for Nick: **is Agent Workbench
MVP-complete for the requirement "I can see all workspaces and open
agents at a glance, without losing what I had"?**

This QA was scoped to wait for / inspect the two coordination-named
Codex builder reports before scoring:

- `WORKBENCH_MVP_VISIBILITY_FIX_CODEX_20260509.md` (canonical lane name
  per `ops/reports/workbench_next_high_roi_wave_20260509_0120.md` —
  Codex agent `ag_gqr7zci5a4`, kicked at 01:22 CT).
- `WORKBENCH_OPEN_PANE_FOCUS_FIX_CODEX_20260509.md` and/or the
  `HIGHROI_…` variant referenced in this QA's coordination update.

QA executed at 01:30 CT.

No code edits, no test edits, no push, no deploy.

## TL;DR Verdict

**FAIL — MVP NOT COMPLETE.** Both builder lanes were still in flight at
QA time. Neither builder report exists, and the code state of
`components/Workbench.tsx` and `components/PaneGrid.tsx` is byte-identical
to the 01:04 productization-QA snapshot. The two intra-workspace
visibility blockers Claude flagged this morning (B1 and B2) have NOT
landed; B3 is no longer a hard sandbox blocker but the harness needs a
narrow hardening before the smoke result is trustworthy. MVP closure
pending B1 + B2 + a clean B3.

| MVP requirement | Status | Evidence |
| --- | --- | --- |
| See every workspace at a glance, even idle | DONE | `lib/cockpit-ui-state.ts:getCockpitWorkspaceMatrix`, drawer matrix in `components/AssistantPanel.tsx`. Carries from 2026-05-09 morning slice. |
| Per-bucket agent state (running / review-ready / blocked / stale / unknown-exit / ack'd) | DONE | `lib/cockpit-summary.ts:269-278`; `tests/cockpit-continuity.test.ts` and the cockpit suite in `tests/tool-routing.test.ts` (43 tests, 42 pass, 1 pre-existing skip). |
| Open all agents in one workspace without evicting existing panes (B1) | NOT DONE | `components/Workbench.tsx:272-281` still calls `assignAgent(rootForWs, leaf.id, agentId)` against `leaves(rootForWs)[0]`. Builder lane `ag_gqr7zci5a4` has produced no diff. |
| Per-pane "ack'd" / "stale" pill in the pane title bar (B2) | NOT DONE | `components/PaneGrid.tsx` — `grep -nE "ackn|acknowledged|staleRunning"` returns zero matches. |
| Reports survive an exited pane being cleared | DONE | `lib/cockpit-continuity.ts:85`; verified by `tests/cockpit-continuity.test.ts`. |
| No silent clearing from cockpit code paths | DONE | All cockpit tools carved out of dispatch-run wrapper at `app/api/assistant/route.ts:287`; drawer renders no close/clear button. |
| Real browser smoke executes the visibility surfaces (B3) | PARTIAL | `npm run smoke:browser` now exits 0 in this shell, but only because the live Electron app is already bound to `127.0.0.1:3747` and the harness fetches from it before its own spawned `next dev` settles. The harness is a false-positive vector while the app is running, and a true-positive once it isn't — see "B3" below. |

## What I expected to see and didn't

The expected builder artifacts were not on disk at QA time:

```bash
$ find . -maxdepth 3 \
    -name "*MVP_VISIBILITY*" -o \
    -name "*OPEN_PANE_FOCUS*" -o \
    -name "*HIGHROI*VISIBILITY*" 2>/dev/null
(no output)
```

Neither was anywhere else under the workspace tree. Spawn record
(`ops/reports/workbench_next_high_roi_wave_20260509_0120.md`) confirms
the canonical Codex agent is `ag_gqr7zci5a4 — HIGHROI-workbench-mvp-
visibility-fix — expected report
WORKBENCH_MVP_VISIBILITY_FIX_CODEX_20260509.md`. ~8 minutes elapsed
between spawn (01:22) and this QA (01:30); typical Codex builder lanes
take longer. **Score this final QA as a sequencing miss, not a Codex
miss** — the QA agent fired before its builder dependency.

I also re-ran the diff against `Workbench.tsx` and `PaneGrid.tsx` to
make sure I was not missing in-flight uncommitted edits:

```bash
$ git diff components/Workbench.tsx components/PaneGrid.tsx
(no output)
```

The tree matches the byte state Claude reviewed in
`WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md`. Conclusion: no QA
re-baseline needed — the productization QA's blocker analysis is the
current truth.

## Residual blockers — exact list

### B1. `openAgentPane` is destructive — `components/Workbench.tsx:272-281`

**Severity: HIGH. Single biggest gate on Nick's complaint.**

Today (verified 2026-05-09 01:30 CT):

```ts
function openAgentPane(workspaceId: string, agentId: string) {
  setActiveWsId(workspaceId)
  setLayoutByWs((cur) => {
    const rootForWs = cur[workspaceId] ?? singleLeafLayout()
    const leaf = leaves(rootForWs)[0]               // ALWAYS first leaf
    if (!leaf) return cur
    setActiveLeafId(leaf.id)
    return { ...cur, [workspaceId]: assignAgent(rootForWs, leaf.id, agentId) }
  })
}
```

`assignAgent` is a destructive set, not a focus. Every "Open pane" click
in the cockpit drawer overwrites whatever was in leaf 0 of the target
workspace. If the agent is already in another leaf, the layout ends up
with the same agent in two places and a different agent evicted from
leaf 0. If a leaf is empty, the drawer ignores it and overwrites a
populated leaf instead.

The correct helper already exists at `lib/layout.ts:59` —
`placeAgent(root, agentId, preferredLeafId?)` honours an empty preferred
leaf, fills any empty leaf, and only as a last resort overwrites. The
~15-line patch sketched in `WORKBENCH_VISIBILITY_QA_CLAUDE_20260509.md`
section (1) and `WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md` B1 is
the canonical fix:

```ts
function openAgentPane(workspaceId: string, agentId: string) {
  setActiveWsId(workspaceId)
  setLayoutByWs((cur) => {
    const rootForWs = cur[workspaceId] ?? singleLeafLayout()
    const existing = leaves(rootForWs).find((l) => l.agentId === agentId)
    if (existing) {                          // already shown — focus it
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

Required test (no existing coverage for `placeAgent` from
`tests/tool-routing.test.ts` or any sibling — `grep -rnE
"placeAgent|openAgentPane" tests/` returns zero matches). Add a
`tests/workbench-layout.test.ts` (or a new suite in
`tool-routing.test.ts`) driving `placeAgent` directly:

1. seed a 2-leaf layout, leaf 0 holds `agent_a`; call placement against
   `agent_a`; assert leaf 0 unchanged.
2. seed a 2-leaf layout with leaf 1 empty; call placement against
   `agent_b`; assert leaf 1 fills, leaf 0 untouched.

### B2. Per-pane "ack'd" / "stale" pill missing — `components/PaneGrid.tsx`

**Severity: MEDIUM. Highest UX-per-LoC win in this slice.**

Verified 2026-05-09 01:30 CT:

```bash
$ grep -nE "ackn|acknowledged|staleRunning" components/PaneGrid.tsx
(no output)
```

Drawer header shows ack state; the pane title bar — the surface Nick
spends his time on — does not. Wire data is already on the cockpit
GET (`acknowledgedAgentIds[]`, `staleRunningAgentIds[]`); this is a
purely presentational add (small pills next to the existing pane status
indicator, colour-coded with the existing tone palette). No backend
work, no new tests required beyond a snapshot-style render check if the
team wants one.

### B3. Browser-smoke harness is now executable but reports a false positive

**Severity: LOW-MEDIUM. Sandbox blocker is gone; harness needs a small fix.**

This is the change vs. the productization QA at 01:04 CT.

```bash
$ AW_SMOKE_TIMEOUT_MS=8000 npm run smoke:browser
> agent-workbench@0.1.0 smoke:browser
> node scripts/browser-smoke.mjs
browser smoke passed: http://127.0.0.1:3747
```

But:

```bash
$ lsof -nP -iTCP:3747
COMMAND    PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
Agent\x20 5808 jarvis   15u  IPv6 0x8c1ed5958feead7  0t0      TCP *:3747 (LISTEN)
```

The Electron app is already bound to 3747. `scripts/browser-smoke.mjs`
spawns its own `next dev -H 127.0.0.1 -p 3747`, which would race against
that bind. The probe loop fetches `/` every 500 ms; the Electron app's
already-rendered page satisfies the
`/Agent Workbench|__next/i.test(html)` check before the spawned child
writes `EADDRINUSE` to its captured stdout. So the harness exits 0 even
though its own renderer never came up.

Two narrow fixes (no net-new architecture):

1. After `spawn(...)`, before the probe loop, assert the spawned child
   is the listener. Easiest: have the harness pin to a random free port
   (or one different from the Electron app's), set the env, and probe
   that. Or:
2. Fail fast if `lsof -iTCP:${port}` shows a foreign listener at
   harness start.

Status assessment with the harness as-is:

- **The renderer can serve the cockpit surfaces in a real browser** —
  evidence is the live Electron app at `http://127.0.0.1:3747` returning
  HTTP 200 with a Next-shaped HTML payload right now.
- **The smoke harness cannot tell** whether the rendered page came from
  the harness's own renderer or an unrelated listener. So claiming
  "browser smoke green" from CI today on a developer box that happens
  to have the app open is a false-positive vector.

Net: B3 is no longer a hard "we cannot bind anything" sandbox blocker.
The five visual checks listed in
`WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md` B3 still need to be
walked through manually after B1+B2 land — those check the matrix
table render, drawer scroll, optimistic-ack flicker, the non-evicting
"Open pane", and the "ack'd"/`stale` pills.

## What I verified this pass (read-only)

- Read the three predecessor reports:
  `WORKBENCH_VISIBILITY_QA_CLAUDE_20260509.md`,
  `WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md`,
  `WORKBENCH_BROWSER_SMOKE_RELEASE_BOUNDARY_CODEX_20260509.md`.
- Inspected current code state of the two blocker files
  (`components/Workbench.tsx`, `components/PaneGrid.tsx`) and the helper
  the fix depends on (`lib/layout.ts:59`).
- Confirmed neither builder report file exists on disk under the
  workspace tree.
- `git diff components/Workbench.tsx components/PaneGrid.tsx` — empty.
- `npm run typecheck` — clean.
- `node --import tsx --test tests/tool-routing.test.ts
  tests/cockpit-continuity.test.ts` — 43 tests, 42 pass, 1 skipped
  (the existing `originWorkspaceId` placeholder), 0 fail.
- `AW_SMOKE_TIMEOUT_MS=8000 npm run smoke:browser` — exit 0, but as
  documented in B3 the result is contaminated by the live app on 3747.
- `curl -sI http://127.0.0.1:3747/` — HTTP 200 from the live Electron
  app, confirming a real browser CAN render the cockpit surfaces today.

## Score after B1/B2

If/when the Codex builder lane lands its B1 fix and a small B2 patch,
plus the placeAgent render test described above, MVP scores **PASS**
on the two intra-workspace gates that are red today.

| Gate | Pre-B1/B2 | Post-B1/B2 (expected) |
| --- | --- | --- |
| Multi-pane visibility intra-workspace | FAIL | PASS once `openAgentPane` uses `placeAgent` and existing-leaf focus, with at least one render-style test driving the helper. |
| Per-pane state visibility | FAIL | PASS once `PaneGrid.tsx` renders `ack'd`/`stale` pills sourced from the cockpit GET wire data. |
| Cross-workspace visibility | PASS | PASS (no change). |
| Cockpit invariants (purity, ack-not-deletion, reports outlive agents) | PASS | PASS (no change). |
| Tests / typecheck / build | PASS | PASS provided the new placeAgent test lands and the existing 42-pass / 1-skip cockpit suite stays green. |

## Score on B3 — separately

B3 is a productization gate, not an MVP gate. With the new
`scripts/browser-smoke.mjs` and the documented `npm run smoke:browser`
contract, the question is no longer "can we bind?" — it's "can the
harness tell its own bind from someone else's?". Until that is fixed:

- Treat green smoke output as **inadmissible evidence on any developer
  box that has the Electron app running**.
- Treat a manual five-step walkthrough (matrix, drawer scroll, open
  pane, ack flicker, clear-exited preserves report) as the acceptance
  signal, exactly as listed in `WORKBENCH_PRODUCTIZATION_QA_CLAUDE_
  20260509.md` B3.
- File a small follow-up ticket for the harness pin/conflict-detect
  hardening.

## Recommended sequencing (unchanged from productization QA)

One Codex lane closes MVP:

1. `openAgentPane` swap — `assignAgent` → `placeAgent` + existing-leaf
   focus (B1).
2. Pane-title `ack'd`/`stale` pills (B2).
3. One render-style test on `placeAgent` covering the empty-leaf and
   already-shown cases.
4. Manual five-step browser walkthrough on a real renderer.

A separate productization lane (P1–P5 from
`WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md`) does NOT block MVP
and should NOT be batched with the above.

## Verdict (one line)

**FAIL on MVP at 01:30 CT** — builder lanes still in flight, B1 and B2
not on disk, B3 harness needs a 5-line conflict-detect hardening before
its green output can be trusted; re-score immediately when
`WORKBENCH_MVP_VISIBILITY_FIX_CODEX_20260509.md` lands.
