# Workbench MVP Acceptance Review — Claude — 2026-05-09

## Scope

Reviewer pass for the **VISIBLE LANE** acceptance call: is Agent Workbench
MVP-complete for Nick's central requirement —
**"I can see all active agents and all workspaces clearly, at a glance,
without losing what I had"**?

If not, what are the exact remaining blockers after B1 (open-pane focus
fix), B2 (per-pane ack pill), and B3 (real-browser smoke)?

This is a read-only acceptance call — no code edits, no push, no deploy.
The other Claude productization QA
(`WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md`, 01:04 CT) is used as
a cross-check, not as the final verdict.

## Inputs read this pass

- `WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md` (01:04 — sibling
  Claude pass; cross-checked).
- `WORKBENCH_BROWSER_SMOKE_RELEASE_BOUNDARY_CODEX_20260509.md` (01:03 —
  Codex packaged smoke harness + release-boundary proposal).
- `WORKBENCH_VISIBILITY_QA_CLAUDE_20260509.md` (00:55 — earlier Claude
  visibility QA).
- `WORKBENCH_VISIBLE_COCKPIT_NEXT_CODEX_20260509.md` (00:53 — Codex
  cross-workspace matrix landing).
- `WORKBENCH_COCKPIT_UI_CONTINUITY_FINAL_GATE_CODEX_20260509.md`,
  `WORKBENCH_COCKPIT_UI_CONTINUITY_IMPL_CODEX_20260509.md`,
  `WORKBENCH_COCKPIT_UI_CONTINUITY_CLAUDE_20260509.md` (cockpit-continuity
  three-step landing).
- Source verified diff-side: `components/Workbench.tsx`,
  `components/PaneGrid.tsx`, `components/AssistantPanel.tsx`,
  `lib/layout.ts`, `lib/cockpit-summary.ts`, `lib/cockpit-ui-state.ts`,
  `lib/cockpit-continuity.ts`, `scripts/browser-smoke.mjs`,
  `package.json`.

## Verdict — one line

**NOT MVP-complete.** B1, B2, and B3 are all still **NOT landed** as of
this pass. The cross-workspace half of the visibility requirement is
done; the intra-workspace half — and the human-render confirmation — is
not. No new code was committed since the prior productization QA, so the
blocker list is unchanged in source, only re-confirmed.

## Pass / fail by Nick-visible behavior

| Nick-visible behavior | Pass | Source / evidence |
| --- | --- | --- |
| Sees a workspace strip showing every workspace, idle ones included | PASS | `lib/cockpit-ui-state.ts:getCockpitWorkspaceMatrix`, rendered in `components/AssistantPanel.tsx:179-273` (matrix block) |
| Sees compact aggregate counts under dispatch strip (`N ws · running · stale · review · blocked · reports`) | PASS | `components/AssistantPanel.tsx:99-138` (`cockpitCountButton` strip) |
| Sees per-bucket health chips per workspace (running/review-ready/blocked/stale/unknown-exit/acked) | PASS | `lib/cockpit-summary.ts:269-278`; verified by `tests/cockpit-continuity.test.ts` and `tests/tool-routing.test.ts` |
| Acknowledging a row removes it from the drawer immediately | PASS | `lib/cockpit-ui-state.ts:applyCockpitAgentAcknowledgement` (optimistic UI) |
| Reports survive an exited pane being cleared | PASS | `lib/cockpit-continuity.ts:85`; verified `tests/cockpit-continuity.test.ts` |
| Cockpit code paths never silently clear panes | PASS | `acknowledge_agent`, `list_workspace_reports`, and `cockpit` GET all carved out of dispatch-run wrapper at `app/api/assistant/route.ts:287` |
| Click "Open pane" in the drawer keeps existing panes intact | **FAIL — B1** | `components/Workbench.tsx:272-281` still calls `assignAgent(rootForWs, leaves(rootForWs)[0].id, agentId)` — overwrites leaf 0 unconditionally |
| Pane title bar shows "ack'd" / "stale" pill so Nick can see review state at the pane | **FAIL — B2** | `components/PaneGrid.tsx` — confirmed zero references to `ack`, `acknowledge`, or `stale` (word-boundary grep). Only the drawer carries that state |
| The cockpit / matrix / drawer has been seen rendered in a real browser | **FAIL — B3** | `npm run smoke:browser` exists (`scripts/browser-smoke.mjs`) but every run is blocked by sandbox `listen EPERM 127.0.0.1:3747`. No human eyes-on. |

## Detailed re-verification of each blocker

### B1 — `openAgentPane` is still destructive (HIGH)

`components/Workbench.tsx:272-281` (verified this pass, byte-for-byte
identical to what the prior QA flagged):

```ts
function openAgentPane(workspaceId: string, agentId: string) {
  setActiveWsId(workspaceId)
  setLayoutByWs((cur) => {
    const rootForWs = cur[workspaceId] ?? singleLeafLayout()
    const leaf = leaves(rootForWs)[0]
    if (!leaf) return cur
    setActiveLeafId(leaf.id)
    return { ...cur, [workspaceId]: assignAgent(rootForWs, leaf.id, agentId) }
  })
}
```

Concrete Nick-visible failure mode: with a 4-pane layout active, click
"Open pane" in the drawer → leaf 0's agent is silently replaced; the
displaced agent loses its layout slot. If the requested agent is already
in another leaf, it appears in *two* leaves and a different agent gets
evicted.

The fix path (`lib/layout.ts:59 placeAgent`) already exists in the code
and has the correct semantic — preferred-leaf-then-empty-then-overwrite
— and is unused by `openAgentPane`. No new infrastructure required.

This is the single change that materially closes the central complaint.
Until it lands, "see all agents at a glance" actively gets *worse* the
moment Nick uses the drawer's primary action.

### B2 — Pane-title ack/stale pill is missing (MEDIUM)

`components/PaneGrid.tsx` re-grepped this pass with word boundaries
(`\back|\bstale|acknowledge`) → zero hits. The matches the previous QA
report cited as "ack" hits were class-name fragments (`blAck`, `trACKing`)
and are not relevant.

The wire data is already on the cockpit summary
(`acknowledgedAgentIds[]`, `staleRunningAgentIds[]` from
`lib/cockpit-summary.ts`), and the optimistic-ack helper already exists
in `lib/cockpit-ui-state.ts`. So this is a pure presentational add to
`PaneGrid.tsx` header (around lines 161-169 next to the existing
maximize / split / close button cluster). Estimated <30 LoC.

Why this is MVP-blocker, not nice-to-have: Nick spends most of his time
looking at the panes themselves, not the cockpit drawer. Without the
pill, "this one was reviewed" / "this one has gone silent" lives in a
drawer he has to open every time. That defeats "at a glance".

### B3 — Real-browser smoke still blocked (MEDIUM)

Codex's 01:03 pass packaged the smoke harness:

- `npm run smoke:browser` script in `package.json:21` (verified).
- `scripts/browser-smoke.mjs` (verified): boots `next dev` on
  127.0.0.1:3747, fetches `/`, asserts the response contains
  `Agent Workbench` or `__next`, fails clearly on `EPERM`/`EADDRINUSE`.
- README.md and `docs/release-boundary-proposal-20260509.md` document
  the procedure and the standalone-repo recommendation.

But every smoke attempt — Codex this pass and Claude QA twice today —
fails before app code runs:

```text
Error: listen EPERM: operation not permitted 127.0.0.1:3747
```

So **the matrix table, the chip layout, the drawer scroll behavior, the
optimistic-ack flicker, and the open-pane affordance have never been
seen rendered**. The MVP claim is currently code-side only.

The unblock path is environmental, not code: Nick (or Jarvis on Nick's
box, outside this sandbox) runs `npm run dev:web` and walks through:
1. New cockpit aggregate strip renders under the dispatch strip with
   non-zero counts on a multi-workspace setup.
2. Drawer matrix shows every workspace, idle ones included, with the
   `empty` health pill on truly-empty workspaces.
3. Click "Open pane" on an agent NOT already in the layout — pane
   appears without evicting anything (depends on B1).
4. Click "Acknowledge" on a review-ready row — row disappears from the
   drawer, and the pane title pill shows "ack'd" (depends on B2).
5. Click the manual "clear exited" header button — exited pane goes
   away but its row in the cockpit `reports[]` survives.

## Cross-check against the sibling Claude QA

The 01:04 productization QA reaches the same verdict: NOT MVP-complete,
same three blockers, same fix paths. This acceptance review confirms
their findings against the live source. I diff-walked the cited file
ranges and re-grepped `PaneGrid.tsx` to make sure no work landed
between the two passes — none did. The two reports agree.

Two additions this pass over the 01:04 QA:
- Re-graded the table from "MVP requirement" framing to a
  Nick-visible-behavior framing, since that is what the task asked for.
- Re-confirmed the smoke harness and release-boundary proposal already
  shipped, so the **B3 unblocker is environmental**, not engineering
  work — that has implications for sequencing (see below).

## Remaining MVP blockers — minimum to call "done"

1. **B1.** Replace `openAgentPane` body with `placeAgent`-based
   placement that focuses an existing leaf if the agent is already
   shown. ~15 LoC in `components/Workbench.tsx:272-281`. One render
   test in `tests/tool-routing.test.ts` (or new
   `tests/workbench-layout.test.ts`) driving `placeAgent` directly:
   - existing-agent: re-focus same leaf, no overwrite;
   - new agent + empty leaf: fills empty leaf, leaf 0 untouched.
2. **B2.** Add per-pane `ack'd` and `stale` pills to `PaneGrid.tsx`
   header next to the maximize/split/close cluster. Use existing
   `acknowledgedAgentIds[]` / `staleRunningAgentIds[]` from the cockpit
   summary. Pure presentational; no new state; <30 LoC.
3. **B3.** Run the now-packaged `npm run smoke:browser` outside the
   sandbox (or `npm run dev:web` + manual eyes-on) and walk the five
   render checks listed above. Report pass/fail per step in a
   short-form follow-up. Not engineering work; environmental unblock.

That is the entire MVP exit list. After B1 + B2 + B3, the
"see all agents/workspaces at a glance" complaint is closed.

## Out of scope for MVP — productization, not visibility

Carry-forward from the 01:04 QA, **none of these block MVP**:

- **P1** — `closePane` deletes exited agent's scrollback
  (`components/Workbench.tsx:269` → `kill(id)` →
  `server/pty-server.ts:542-557` `killAgent` drops `outputTails`).
  Reports survive but live terminal history does not. Needs a
  one-paragraph spec slice on hide-vs-delete semantics.
- **P2** — Lint debt in `components/AssistantPanel.tsx` and
  `lib/cockpit-ui-state.ts` (no-explicit-any, hook-deps, unescaped
  quotes). Pre-existing; release-readiness blocker, not MVP.
- **P3** — `data/dispatch-runs/<id>.json` is a non-atomic write; the
  newer cockpit files use temp+rename
  (`lib/cockpit-continuity.ts:37-42`). Apply the same helper.
- **P4** — Auth-parity test for `GET /api/assistant?scope=cockpit`
  identical to the POST path (carry-over from cockpit-endpoint review).
- **P5** — Cockpit poll has no `document.visibilityState` gate; fires
  every 5s regardless of foreground state.
- **P6** — `originWorkspaceId` propagation for cross-workspace
  attribution (the existing `it.skip` placeholder in
  `tests/tool-routing.test.ts`).
- **P7** — Drawer-driven bulk ack/clear is explicitly out of scope per
  the continuity spec; flag for the next product wave only.
- **Release boundary** — Standalone private repo vs monorepo package
  decision is open; until owner decides, Workbench is local-only and
  cannot be described as release-controlled
  (`docs/release-boundary-proposal-20260509.md`).

These should land in a separate hygiene lane after MVP closes.

## Sequencing recommendation

**One small Codex lane closes MVP**:

- B1: replace `openAgentPane` with `placeAgent` + existing-leaf focus.
- B2: add ack'd / stale pills in `PaneGrid.tsx` header.
- One layout-helper render test for the B1 invariants.
- Claude review pass on the diff.
- Hand off to Nick for B3 real-browser smoke (already packaged as
  `npm run smoke:browser` — needs to run outside this sandbox).

After Nick reports the five render checks pass, the MVP gate is
closed. P1–P7 then form the next "ready to put in front of anyone
outside Nick" lane.

## Verification this pass

Read-only review. No code/test edits, no push, no deploy.

- `components/Workbench.tsx:272-281` — re-read; confirmed identical to
  the diff the prior QA flagged. B1 not landed.
- `components/PaneGrid.tsx` — re-grepped `\back|\bstale|acknowledge`
  with word boundaries; zero matches. B2 not landed.
- `package.json:21` and `scripts/browser-smoke.mjs` — confirmed smoke
  harness exists and exits cleanly on bind failure. B3 unblocker is
  environmental, not engineering.
- `components/AssistantPanel.tsx:179-273` — confirmed cockpit drawer
  matrix block, count strip, and `onOpenAgent` callback wired through
  to `Workbench.openAgentPane`. The destructive path Nick will hit on
  primary use is confirmed.
- Cross-checked verdict and blocker list against
  `WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md`. Same conclusion;
  no drift between sibling Claude passes.
- Test counts not re-run this pass; the prior Codex final-gate report
  (43 total, 42 pass, 1 pre-existing skip) is consistent with the
  sandbox state and the source did not change since.

## Verdict (final, one line)

Cross-workspace visibility ships. Intra-workspace visibility (B1) and
per-pane review state (B2) are still missing in source, and no human
has rendered the cockpit yet (B3). MVP is one ~50-LoC Codex lane plus
one off-sandbox smoke run away — but until that lands, **Workbench is
not MVP-complete for Nick's "see all agents/workspaces" requirement**.
