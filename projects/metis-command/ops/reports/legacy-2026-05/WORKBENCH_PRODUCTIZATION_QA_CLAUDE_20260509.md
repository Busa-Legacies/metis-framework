# Workbench Productization QA — Claude — 2026-05-09

## Scope

Reviewer pass to answer one question for Nick: **is Agent Workbench
MVP-complete for the requirement "I can see all agents and all workspaces
at a glance"?** If not, list exact remaining blockers.

Inputs read this pass:

- `WORKBENCH_VISIBILITY_QA_CLAUDE_20260509.md` (Claude QA against the
  cockpit-continuity slice).
- `WORKBENCH_VISIBLE_COCKPIT_NEXT_CODEX_20260509.md` (Codex landing of the
  cross-workspace matrix in the drawer — the freshest Codex lane in the
  release boundary).
- `WORKBENCH_COCKPIT_UI_CONTINUITY_FINAL_GATE_CODEX_20260509.md`,
  `WORKBENCH_COCKPIT_UI_CONTINUITY_IMPL_CODEX_20260509.md`,
  `WORKBENCH_COCKPIT_UI_CONTINUITY_CLAUDE_20260509.md` (the three-step
  cockpit slice landing this morning).
- `WORKBENCH_CEO_COCKPIT_NEXT_SPEC_CLAUDE_20260508.md` and
  `WORKBENCH_CEO_FLOW_NEXT_GAPS_20260508.md` (the larger CEO roadmap so
  this MVP call is read against the right bar).
- `ops/reports/workbench_ceo_control_map_20260508.md`,
  `ops/reports/workbench_next_product_wave_20260508.md`.
- Implementation: `lib/cockpit-summary.ts`, `lib/cockpit-continuity.ts`,
  `lib/cockpit-ui-state.ts`, `lib/layout.ts`, `app/api/assistant/route.ts`,
  `components/AssistantPanel.tsx`, `components/Workbench.tsx`,
  `components/PaneGrid.tsx`, `server/pty-server.ts`.
- Tests: `tests/tool-routing.test.ts`, `tests/cockpit-continuity.test.ts`.

No code/test edits. No push, no deploy. This is an MVP-readiness call only.

## Verdict

**NOT MVP-complete.** Cross-workspace visibility (the "see all workspaces"
half) is in. Intra-workspace visibility (the "see all agents in a
workspace at the same time without losing what you had") is NOT, because
the drawer's "Open pane" affordance still rewrites leaf 0 of the target
workspace via `assignAgent`, hiding whatever was there. Add a small
ack'd-state pill on the pane title bar and verify in a real browser, and
the MVP bar is met. Productization (lint debt, dispatch-runs atomic
write, auth-parity test, scrollback-on-close policy) is bigger than this
slice and listed separately.

| MVP requirement | Status | Where |
| --- | --- | --- |
| See every workspace at a glance, even idle ones | DONE | `lib/cockpit-ui-state.ts:getCockpitWorkspaceMatrix`; rendered in `components/AssistantPanel.tsx` cockpit drawer |
| See agent state by bucket (running / review-ready / blocked / stale / unknown-exit / acked) | DONE | `lib/cockpit-summary.ts:269-278`; verified by `tests/cockpit-continuity.test.ts` and `tests/tool-routing.test.ts` |
| Hold all panes in view inside one workspace | NOT DONE | `components/Workbench.tsx:272-281` — `openAgentPane` overwrites leaf 0 |
| Per-pane state at the pane (ack'd / stale) | NOT DONE | `components/PaneGrid.tsx` — no `ack`/`stale` reference |
| Reports survive an exited pane being cleared | DONE | `lib/cockpit-continuity.ts:85`; verified `tests/cockpit-continuity.test.ts` |
| No silent clearing from cockpit code paths | DONE | every cockpit tool carved out of dispatch-run wrapper at `app/api/assistant/route.ts:287`; drawer renders no close/clear button |
| Real browser smoke shows the new matrix + drawer | NOT DONE | every Codex+Claude pass blocked by sandbox `listen EPERM 0.0.0.0:3747`; no human has eyes-on |

## What landed (what Nick already gets)

The 2026-05-09 morning lane stack ships the cross-workspace overview Nick
asked for last week:

- `GET /api/assistant?scope=cockpit` returns one fan-out payload covering
  every workspace: running/exited counts per kind, last-run status, six
  agent buckets, recent reports, deterministic `nextActions[]` queue
  (`lib/cockpit-summary.ts`).
- Drawer renders one **matrix row per workspace**, including idle and
  empty workspaces, with health badge (blocked / attention / active /
  clean / empty), running/exited count, kind mix, latest run status, and
  per-bucket chips (`lib/cockpit-ui-state.ts:getCockpitWorkspaceMatrix`,
  `components/AssistantPanel.tsx` matrix block).
- Compact aggregate strip under the dispatch strip:
  `N ws · running · stale · review-ready · blocked · reports`
  (`components/AssistantPanel.tsx:319-442` area).
- Continuity invariants enforced: the cockpit GET is pure read, ack is
  metadata-only, reports outlive their agents, stale ≠ exited,
  `reviewReadyAgentIds` is `exitCode === 0` only. All six invariants
  verified diff-side in `WORKBENCH_VISIBILITY_QA_CLAUDE_20260509.md`
  section (2). Tests in `tests/tool-routing.test.ts` and
  `tests/cockpit-continuity.test.ts` (43 total, 42 pass, 1 pre-existing
  skip).
- Two new persistence files (`data/cockpit-acks.json`,
  `data/cockpit-reports.json`) written via temp+rename atomic writer
  (`lib/cockpit-continuity.ts:37-42`).
- Two new assistant tools: `acknowledge_agent` (mutating, isolated) and
  `list_workspace_reports` (read), both carved out of the dispatch-run
  wrapper.
- Optimistic UI: ack'ing a row removes it from the drawer locally before
  the next refresh — no flash of the just-acked row
  (`lib/cockpit-ui-state.ts:applyCockpitAgentAcknowledgement`).

That payload is what Jarvis-the-assistant sees. So Jarvis can hold a
correct multi-workspace mental model across polls today.

## Blockers to MVP — exact list

These are the *minimum* fixes Nick needs before the "see all
agents/workspaces" complaint is closed. Listed smallest first.

### B1. `openAgentPane` is destructive — fix `Workbench.tsx:272-281`

**Severity: high. Blocks the central complaint.**

Today (`components/Workbench.tsx:272`):

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

Click "Open pane" in the cockpit drawer → top-left pane silently switches
to that agent. If Nick has a 4-pane layout, one of the other agents
loses its leaf assignment. If the agent is already in another leaf, it
appears in two panes and a different agent gets evicted.

The helper that does the right thing already exists:
`placeAgent(root, agentId, preferredLeafId?)` at `lib/layout.ts:59` —
honours an empty preferred leaf, fills any empty leaf, only as last
resort overwrites. The fix is ~15 LoC:

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

Add one render-style test in `tests/tool-routing.test.ts` (or a new
`tests/workbench-layout.test.ts`) driving `placeAgent` directly:
1. seed a 2-leaf layout, leaf 0 holds `agent_a`; call placement against
   `agent_a`; assert leaf 0 unchanged and the helper returns the same
   leaf id for focus.
2. seed a 2-leaf layout with leaf 1 empty; call placement against
   `agent_b`; assert leaf 1 fills and leaf 0 is untouched.

This is the single change that materially closes Nick's complaint.

### B2. Add the per-pane "ack'd" pill in `PaneGrid.tsx`

**Severity: medium. Highest UX-per-LoC fix in this slice.**

`components/PaneGrid.tsx` has zero references to `ack`, `acknowledge`,
or `stale` (verified). The drawer shows ack state inside the drawer
header only. The pane title bar is the surface Nick looks at most while
working — that is where "this one is reviewed" / "this one has gone
silent" needs to render. The wire data is already on
`acknowledgedAgentIds[]` and `staleRunningAgentIds[]` from the cockpit
GET. Pure presentational add: small pills next to the existing pane
status indicator, colour-coded with the existing tone palette.

### B3. Browser smoke — actually load it

**Severity: medium. We are claiming MVP without a single human render.**

Both the Codex impl pass and the Claude QA pass were blocked by the
sandbox bind denial:

```text
Error: listen EPERM: operation not permitted 0.0.0.0:3747
```

So the matrix table, the chip layout, the drawer scroll behavior, the
optimistic-ack flicker, and the open-pane affordance have **never been
seen rendered**. Productization gate: Nick (or Jarvis on Nick's box)
runs `npm run dev:web` outside this sandbox, opens the workbench, and
walks through:
1. New cockpit aggregate strip renders under the dispatch strip with
   non-zero counts on a multi-workspace setup.
2. Drawer matrix shows every workspace, including ones with no queued
   action. Idle/empty workspace renders with the `empty` health pill.
3. Click an "Open pane" row in the drawer for an agent that is NOT
   already in the layout — pane appears without evicting anything
   (this depends on B1 landing first).
4. Click "Acknowledge" on a review-ready row — row disappears from the
   drawer immediately, and the per-pane title pill shows "ack'd"
   (this depends on B2 landing).
5. Click the manual "clear exited" button on the header — exited pane
   disappears, but its row in the cockpit `reports[]` still surfaces
   (`tests/cockpit-continuity.test.ts` covers the data path; smoke
   verifies the UI path).

Until those five render-checks pass, MVP is a code-side claim only.

## Productization blockers — beyond MVP

These do not block "see all agents/workspaces", but they block calling
Workbench *productized*. They are the exit list for the next 1–2 lanes.

### P1. `closePane` deletes the exited agent's scrollback

`components/Workbench.tsx:269` — `closePane` calls `kill(id)` on an
already-exited agent. `killAgent` (`server/pty-server.ts:542-557`)
treats an exited agent as "fully delete: drop `outputTails`, drop the
runtime row." Cockpit reports survive (good — that's the artifact); the
runtime scrollback does not. Nick clicks a pane X to free space and his
exited agent's terminal history is gone. The continuity spec deferred
this as "auto-close exited panes / archive policy"; now is the right
time. Two mitigations:

- Gate `closePane` on an unack'd-reports confirmation when the agent has
  unread reports in `cockpit-reports.json`.
- OR change exited-pane removal to a "hide pane" semantic that preserves
  `outputTails` until the explicit `clear exited` header button is used.

### P2. Lint debt on `AssistantPanel.tsx`

`npx eslint components/AssistantPanel.tsx lib/cockpit-ui-state.ts
tests/tool-routing.test.ts` still fails on:
- `no-explicit-any` (multiple sites in `AssistantPanel.tsx`).
- React hook dependency warnings.
- Unescaped quotes in placeholder strings.

These are pre-existing but new code is being added on top of them. Lint
must be green before "release-ready" can be claimed; otherwise CI sets a
red baseline that future lanes can't pass cleanly.

### P3. `data/dispatch-runs/<id>.json` is a non-atomic write

The two new cockpit files use temp+rename
(`lib/cockpit-continuity.ts:37-42`). The older dispatch-runs writer
does not. This is a known carry-forward from the cockpit-endpoint
review. The window is small but writes happen every dispatch action; on
a crash mid-write the dispatch-runs file can be truncated. Apply the
same temp+rename helper.

### P4. Auth-parity test for cockpit GET

`GET /api/assistant?scope=cockpit` uses the existing bearer model
(`route.ts:788`). There is no test asserting that a non-localhost call
without the bearer is rejected and a non-localhost call with the bearer
is accepted, identical to the POST path. Carry-forward from
`WORKBENCH_COCKPIT_ENDPOINT_REVIEW_CLAUDE_20260508.md` acceptance #6.
One test, no production code change.

### P5. Cockpit poll has no tab-visibility gating

The cockpit fetch fires on the same 5s interval as the dispatch poll
(`components/AssistantPanel.tsx:417-425`) and dispatches unconditionally
regardless of whether the tab is in the foreground. At N=4 workspaces
and 50 reports each, every poll does N `fs.readdirSync(workspace.cwd)`
on top of the N dispatch-runs reads. Cheap individually, wasteful
hidden. Wire `document.visibilityState !== 'hidden'` into the poll
gate; `requestIdleCallback` for the matrix derivation.

### P6. `originWorkspaceId` propagation

The next-action `derivedFrom` enum was specified forward-compatible with
a future `origin` source (cockpit spec). The session-metadata
propagation that would populate `originWorkspaceId` has not landed
(`tests/tool-routing.test.ts` carries the existing `it.skip` placeholder
named "surfaces originWorkspaceId once session-metadata propagation
lands"). Not a visibility blocker; matters for cross-workspace
attribution on the cockpit row.

### P7. Drawer-driven bulk operations

The continuity spec is explicit: the manual `clear exited` header button
is the *only* deletion path. If the next product wave wants
drawer-driven bulk clear (e.g. "ack and clear all review-ready"), it
must be a separate spec with its own confirmation flow. Flag for
roadmap, do not assume it.

## Where this sits in the larger CEO roadmap

The CEO flow gap report (`WORKBENCH_CEO_FLOW_NEXT_GAPS_20260508.md`)
ranks five priorities for the cockpit:

1. P0 — Durable dispatch runs. **DONE** (landed 2026-05-08, cockpit
   reads from it).
2. P1 — Workspace/agent guardrails for direct tools. **DONE**.
3. P2 — Durable stale replay hygiene. Action ledger is per-turn only;
   no cross-turn idempotency yet. **NOT DONE.** Not a visibility
   blocker but a productization concern.
4. P3 — Pane lifecycle and resume hygiene. Partial: layout hydration
   race fixed, resume partial-failure plumbing not. **PARTIAL.**
5. P4 — Done/review gates Jarvis can operate. Task tools not yet wired
   to the assistant. **NOT DONE.** Out of scope for "see all
   agents/workspaces" MVP, but the next major lane.
6. P5 — Manager status surface. The cockpit endpoint and matrix
   landing this morning are the read-fan-out half of P5. **DONE for
   read; UI surface MVP-ready pending B1+B2+B3.**

So the productization order Nick asked about is:

1. Land B1 (openAgentPane fix) and B2 (per-pane ack'd pill) in one
   small Codex lane. Reviewed by Claude. Smoke in real browser.
2. Land P1 (`closePane` scrollback policy) — pick one of the two
   mitigations and write a one-paragraph spec slice.
3. Land P3 (atomic dispatch-runs write) and P4 (auth-parity test) as
   ride-along hygiene.
4. Then the next product wave is gap-report Priority 4 — task tools and
   done/review gates — which extends the cockpit `nextActions[]` queue
   with a real reviewer-verdict source. That is a multi-lane wave and
   should not be batched with B1–B3.

## Sequencing recommendation

One lane, two checkpoints, no push:

- **Lane A — visibility MVP close** (single Codex lane, Claude review):
  - Fix `openAgentPane` to use `placeAgent` + existing-leaf focus.
  - Add per-pane "ack'd" and "stale" pills in `PaneGrid.tsx`.
  - Add the layout-helper render test described in B1.
  - Run real browser smoke and report the five visual checks listed in
    B3.
- **Lane B — productization hygiene** (separate Codex lane, Claude review):
  - `closePane` scrollback policy (P1).
  - Atomic write for `data/dispatch-runs/<id>.json` (P3).
  - Auth-parity test for cockpit GET (P4).
  - Tab-visibility gating on cockpit poll (P5).

Lane A is the gate for "MVP done". Lane B is the gate for "ready to put
in front of anyone outside Nick".

## Verification this pass

Read-only review. No code/test changes. No push, no deploy. Cross-checked:

- `Workbench.tsx:272-281` — confirmed `openAgentPane` calls
  `assignAgent(rootForWs, leaf.id, agentId)` with `leaf = leaves(rootForWs)[0]`.
- `lib/layout.ts:59` — confirmed `placeAgent` exists with the
  preferred-leaf-then-empty-then-overwrite semantic the spec called for.
- `components/PaneGrid.tsx` — grepped for `ack`, `acknowledge`, `stale`
  → zero matches, confirming the per-pane pill is missing.
- `server/pty-server.ts:542-557` — confirmed `killAgent` on an exited
  agent deletes `outputTails[id]`, calls `removeRuntimeAgent`, and
  saves state. Re-verifies the closePane-deletes-scrollback edge.
- Test counts from the Codex final-gate report (43 total, 42 pass, 1
  skipped) match what the implementation note claims; not re-run this
  pass because the harness is the same sandbox that fails on
  `npm run dev:web`.

## Verdict (one line)

Cross-workspace visibility is in. Intra-workspace visibility is one
~15-line patch + one pane-title pill + one real-browser smoke pass away
from MVP. Productization (close-pane scrollback policy, dispatch-runs
atomic write, lint debt, auth-parity test) is a separate ride-along
lane and should not block calling MVP done once B1+B2+B3 land.
