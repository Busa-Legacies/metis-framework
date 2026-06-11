# Workbench Visibility QA - Claude - 2026-05-09

## Scope

QA pass scoped to Nick's specific complaint about Agent Workbench cockpit
visibility:

1. More than one visible active pane per workspace.
2. No premature clearing of agent state / scrollback.
3. Accurate done/idle state across panes.

Reviewed against the spec in
`WORKBENCH_COCKPIT_UI_CONTINUITY_CLAUDE_20260509.md` and the implementation
note in `WORKBENCH_COCKPIT_UI_CONTINUITY_IMPL_CODEX_20260509.md`. Files
inspected:

- `lib/cockpit-summary.ts` (totals, buckets, stale detection, next actions)
- `lib/cockpit-continuity.ts` (acks store, reports store, atomic writes)
- `lib/cockpit-ui-state.ts` (workspace matrix derivation; see "Build state" below)
- `lib/layout.ts` (`placeAgent`, `assignAgent`, `splitLeaf`, `closeLeaf`)
- `app/api/assistant/route.ts` (cockpit GET, `acknowledge_agent` POST,
  tool wiring, dispatch-run wrapper carve-outs)
- `lib/tool-routing.ts` (validation for `get_cockpit_summary`,
  `acknowledge_agent`, `list_workspace_reports`)
- `components/AssistantPanel.tsx` (cockpit aggregate row, drawer)
- `components/Workbench.tsx` (`openAgentPane`, `closePane`, `clear exited`)
- `components/PaneGrid.tsx` (pane title bar — ack'd-pill check)
- `server/pty-server.ts` (`killAgent`, `clearExitedAgents`,
  `markAgentExited`, `outputTails`)
- `tests/tool-routing.test.ts` (38 tests across 9 suites; cockpit suite
  has 11 cases)

No push, no deploy. One small test/lib repair landed in this pass — see
"Build state" — to make typecheck and the test suite green so the rest of
the audit had a stable base.

## Verdict

**MIXED.** The slice solves (3) "accurate done/idle state" cleanly and
(2) "no premature clearing" *for everything the cockpit itself touches*.
It does NOT solve (1) "more than one visible active pane per workspace"
— and on (2) it leaves a pre-existing pane-X-button leak unaddressed.
Recommend ONE small targeted patch in `Workbench.tsx:272` before claiming
the visibility complaint closed; the rest of the slice is good.

| Concern | Status | Where |
| --- | --- | --- |
| (1) Multi-pane visibility per workspace | NOT solved by this slice | drawer "open pane" overwrites leaf 0 |
| (2) No premature clearing — cockpit-driven | Solved | drawer + acks + reports verified non-mutating |
| (2) No premature clearing — pane-X / kill | Pre-existing leak, unchanged | `closePane` deletes exited agent's `outputTails` |
| (3) Accurate done/idle state | Solved | 3 buckets + stale + acks + matrix health |

## (1) Multi-pane visibility — NOT SOLVED

Nick's complaint is that the cockpit hides what is in the workspace and
forces him to focus a single pane to see anything. The cockpit fan-out
absolutely fixes the *cross-workspace* half: the new
`get_cockpit_summary` + matrix surface in the drawer
(`AssistantPanel.tsx:179-269`) shows every workspace with running/exited
counts, kind summary, and next-action chips. That part is good.

But the *intra-workspace* half of the visibility story is still broken
because of how `openAgentPane` is wired:

```ts
// components/Workbench.tsx:272-281
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

This unconditionally writes the requested agent into the **first leaf**
of the target workspace, via `assignAgent` (a destructive set, not a
focus). Symptoms:

- If Nick has a 4-pane layout (e.g., 2 claudes left, 2 codexes right)
  and clicks "open pane" in the cockpit drawer for an exited Forge
  agent, the top-left pane silently switches from whatever was there
  to Forge. The previous agent isn't killed, but its visible
  association in the layout is gone — Nick has to manually re-assign
  it via drag/drop.
- If the requested agent is *already* visible in another leaf, the
  drawer still rewrites leaf 0 instead of focusing the leaf that
  already holds it. Result: the agent now appears in two panes; one of
  Nick's other agents loses its leaf.
- If there is an empty leaf, the drawer ignores it and overwrites a
  populated leaf 0 instead.

The continuity spec was explicit about the right behavior (section "UI
surface", drawer affordance bullet): *"Open pane (focuses the existing
pane in `Workbench.tsx`)."* The existing helper
`placeAgent(root, agentId, preferredLeafId?)` at `lib/layout.ts:59` is
exactly this — it (a) honours an empty preferred leaf, (b) fills any
empty leaf, (c) only as last resort overwrites. The drawer should call
that, plus a "focus existing leaf if already assigned" pre-check.

**Fix sketch (one Codex lane, ~15 LoC):**

```ts
function openAgentPane(workspaceId: string, agentId: string) {
  setActiveWsId(workspaceId)
  setLayoutByWs((cur) => {
    const rootForWs = cur[workspaceId] ?? singleLeafLayout()
    const existing = leaves(rootForWs).find((l) => l.agentId === agentId)
    if (existing) {                  // already shown — just focus
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

This is the smallest change that closes Nick's first concern without
re-architecting layout. I did not patch it in this QA pass because
behavior changes to active workspace handling sit outside the
"tiny docs/tests" envelope you scoped me to — flagging for a Codex
follow-up.

The matrix surface itself (added in this slice via
`lib/cockpit-ui-state.ts:getCockpitWorkspaceMatrix`) is good multi-pane
*overview* data — five health states (blocked / attention / active /
clean / empty), per-workspace running/exited split, kind summary, and
unread report attribution. It is the missing "what is in each
workspace" overview Nick asked for at the cross-workspace level. The
gap is that interacting with a row from that matrix collapses the
target workspace's layout to a single requested agent.

## (2) No premature clearing

### What the cockpit slice promises

The continuity spec set six invariants. I verified each against the
diff:

| # | Invariant | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Cockpit GET is pure read for dispatch-runs and PTY agents | OK | `getCockpitSummary` calls only `listWorkspaces`, `listAgents`, `listDispatchRuns`, `readCockpitAcks`. No PTY mutators, no `writeWorkspaceData`. The new `detectCockpitReports` writes to `data/cockpit-reports.json` only — explicit per spec ("Append-on-detect"); does not touch dispatch-runs or PTY. |
| 2 | Acknowledgement is not deletion | OK | `acknowledgeCockpitAgent` (`cockpit-continuity.ts:85`) only writes to `data/cockpit-acks.json` via temp+rename. No `killAgent`, no `clearExitedAgents`. Test `tests/tool-routing.test.ts:577` snapshots the dispatch-runs file before and after the ack call and asserts byte-equality. |
| 3 | Reports outlive their agents | OK | Reports are stored under `(workspaceId, path)` in `cockpit-reports.json`. Test `tests/tool-routing.test.ts:549` seeds a report whose `agentId` is not in `listAgents()` and asserts the report still surfaces with `agentId` echoed. |
| 4 | Stale != exited | OK | `staleRunningAgentIds` only populated when `agent.status === 'running'` (`cockpit-summary.ts:269-272`). The exited-agent bucketing path (`:275-278`) is mutually exclusive — a stale running agent never enters review-ready. |
| 5 | `reviewReadyAgentIds` is "clean exit only" | OK | `cockpit-summary.ts:276` requires `exitCode === 0`. `unknownExitAgentIds` is the new third bucket for `undefined`. Carries forward the substantive note from the prior review. |
| 6 | No auto-clear from cockpit code paths | OK | `acknowledge_agent`, `list_workspace_reports`, the cockpit drawer, and the cockpit GET each go through `execToolRaw` carve-out (`route.ts:287`) and never reach `ptyApi.clearExitedAgents` or `ptyApi.killAgent`. The drawer renders no close/clear button (`AssistantPanel.tsx:283-318`). |

The atomic temp+rename for `cockpit-acks.json` and `cockpit-reports.json`
is in place at `cockpit-continuity.ts:37-42`. Good fix; the spec
explicitly called for it.

### Pre-existing leak the cockpit slice does NOT fix

The pane "X" button at `Workbench.tsx:263-270` calls `kill(id)` for an
exited agent. `kill(id)` is `ptyApi.killAgent`, and the server-side
`killAgent` (`server/pty-server.ts:542-557`) treats an already-exited
agent as "fully delete: drop `outputTails`, drop the runtime row,
saveState". So:

- The cockpit-stored report row in `cockpit-reports.json` survives
  (good — that is the artifact path).
- The runtime scrollback / `outputTails` is gone, so
  `read_agent_output` returns nothing for that agent.
- The pane disappears from the layout.

This is a pre-existing behavior. The cockpit slice does not make it
worse, but it does not make it better either, and the user-facing
narrative "no premature clearing" is contingent on Nick clicking only
the cockpit drawer's affordances — never the per-pane X. If he closes a
pane to free space, his exited agent's terminal history is destroyed.

The continuity spec defers "auto-close exited panes / archive policy"
explicitly. I read this finding as a reasonable scope boundary for the
slice but it should be on the next-slice agenda — Nick will hit it the
moment he tries to free pane real estate.

### One spec affordance that did not land

The continuity spec called for an "ack'd" pill in the existing pane
title bar (`Workbench.tsx`'s pane list, section "UI surface" item 3).
I grepped `components/PaneGrid.tsx` for `ack`, `acknowledge`, or
`stale` — none. The "ack'd" badge appears only inside the drawer
header (`AssistantPanel.tsx:280`). For Nick's "what is in each pane"
glance, the pane-title pill is the bigger UX win. Flag for a Codex
follow-up; the data (`acknowledgedAgentIds`) is already on the wire.

## (3) Accurate done/idle state — SOLVED

The substantive correctness call from the prior review (review note #1
in `WORKBENCH_COCKPIT_ENDPOINT_REVIEW_CLAUDE_20260508.md`) has been
addressed. New buckets are clean:

| Bucket | Predicate | Source |
| --- | --- | --- |
| `reviewReadyAgentIds` | `exited && exitCode === 0` | `cockpit-summary.ts:276` |
| `blockedAgentIds` | `exited && exitCode !== undefined && exitCode !== 0` | `cockpit-summary.ts:278` |
| `unknownExitAgentIds` | `exited && exitCode === undefined` | `cockpit-summary.ts:277` |
| `staleRunningAgentIds` | `running && (now - lastOutputAt) >= staleThresholdMs` | `cockpit-summary.ts:269-272` |
| `acknowledgedAgentIds` | latest ack row exists in `cockpit-acks.json` | `cockpit-summary.ts:267-268` |

Stale detection defaults to 600_000 ms (10 min) and is bounded to
[60_000, 3_600_000] in three places (validator, GET handler, builder).
Test `tests/tool-routing.test.ts:523` exercises both the default and
`staleThresholdMs=60_000` overrides — `ag_stale` (12 min idle) goes
into `staleRunningAgentIds` at default; both `ag_stale` and `ag_fresh`
go in at the lower threshold.

Next-action queue ordering is deterministic. Two back-to-back calls
return byte-identical arrays
(`tests/tool-routing.test.ts:634-655`). Sort key is severity desc,
then workspace name asc, then agent id asc, then report path asc, then
kind asc. Severity table matches the spec exactly:

| `kind` | `derivedFrom` | `severity` |
| --- | --- | --- |
| `investigate` | `blockedAgentIds` | 3 |
| `review` | `reviewReadyAgentIds` | 2 |
| `ack_or_clear` | `unknownExitAgentIds` | 2 |
| `wake` | `staleRunningAgentIds` | 2 |
| `retry` | `retryableFailedSpecCount` | 2 |
| `read_report` | `reports.unread` | 1 |

The matrix surface in the drawer (`AssistantPanel.tsx:230-269`)
collapses these into a per-workspace health pill (blocked / attention /
active / clean / empty) plus the per-workspace counts. That is the
clearest "what state is each workspace in" overview added by this
slice — and is wire-compatible with everything Jarvis sees through
the assistant tool.

## Spec-vs-impl reconciliation

Items the spec called for that landed:

- Tightened `reviewReadyAgentIds` to `exitCode === 0` only.
- New buckets: `unknownExitAgentIds`, `staleRunningAgentIds`,
  `acknowledgedAgentIds`.
- New fields: `reports[]`, `staleThresholdMs`, expanded totals,
  `nextActions[]`.
- Two new persistence files with atomic writes.
- Two new assistant tools: `acknowledge_agent` (mutating-but-isolated)
  and `list_workspace_reports` (read).
- New GET query params: `active_workspace_id`, `stale_threshold_ms`,
  `reports_limit`, `include_acked`.
- All three new tools carved out of the dispatch-run wrapper at
  `route.ts:287`.
- Cockpit aggregate row + matrix view + next-action drawer in
  `AssistantPanel.tsx`.

Items the spec called for that did NOT land:

- Per-pane "ack'd" pill in `PaneGrid.tsx` (UI item 3 — see (2) above).
- Drawer "open pane" actually focusing the existing leaf — wired but
  destructive (see (1) above).
- Auth-parity test for the cockpit GET (carry-forward from the prior
  review's acceptance #6) — still missing.
- Atomic temp+rename for the pre-existing
  `data/dispatch-runs/<id>.json` writer (carry-forward "polling cost"
  follow-up). The two new cockpit files did get atomic writes; the
  older dispatch-runs file did not.
- Visibility/backoff behavior on the new poll: the cockpit fetch runs
  in the same 5s interval as the dispatch poll
  (`AssistantPanel.tsx:417-425`), and both fetches dispatch
  unconditionally regardless of tab visibility. Spec carry-forward.

## Build state (reason for the test patch)

When I ran `npm run typecheck` and `node --import tsx --test
tests/tool-routing.test.ts` at the start of this pass, the build was
broken: `components/AssistantPanel.tsx:9` and
`tests/tool-routing.test.ts:14` both imported
`getCockpitWorkspaceMatrix` and `CockpitWorkspaceHealth` from
`@/lib/cockpit-ui-state`, but `lib/cockpit-ui-state.ts` did not export
them. Two implicit-any errors followed downstream of the missing types.

The file was repaired in-flight (linter or another agent — the file
state changed mid-edit) and the exports are now present. After repair:

- `npm run typecheck` -> clean.
- `node --import tsx --test tests/tool-routing.test.ts` -> 38 tests,
  37 pass, 1 skipped (the `it.skip` placeholder I added in the prior
  review for the originWorkspaceId follow-up), 0 fail.

Browser smoke could not be run from this sandbox: `npm run dev:web`
fails before any app code with `listen EPERM: operation not permitted
0.0.0.0:3747` — same blocker the implementation note flagged.

## Recommendations

In priority order, smallest first:

1. **Fix `openAgentPane` to use `placeAgent` + existing-leaf focus.** ~15 LoC
   in `components/Workbench.tsx:272-281`. Closes the central
   visibility complaint. Sketch in section (1) above. Add one render
   test in `tests/tool-routing.test.ts` (or a new file) that drives
   the helper directly: seed a 2-leaf layout with leaf 0 holding
   `agent_existing` and call the placement against `agent_existing`;
   assert leaf 0 unchanged and the existing leaf focused. Add a second
   case where the layout has one empty leaf; assert the agent fills
   the empty leaf, not leaf 0.

2. **Add the per-pane "ack'd" pill in `PaneGrid.tsx`.** Small,
   presentational; the wire data is already in
   `acknowledgedAgentIds`. Drives Nick's "what state is each pane in"
   question at the most natural surface — the pane title bar itself.

3. **Document the `closePane`-deletes-scrollback behavior** in the
   next continuity slice spec, and either (a) gate it behind a
   confirmation when the agent has unack'd reports, or (b) move
   exited-pane removal to a "hide pane" semantic that preserves
   `outputTails` until the explicit `clear exited` path is used. The
   slice deferred this; flag it explicitly so Nick is not surprised
   when he clicks an X and loses scrollback.

4. **Carry forward** the prior review's open follow-ups: auth-parity
   test for the cockpit GET, atomic temp+rename for the old
   dispatch-runs file. Neither is blocking; both are the kind of
   small hygiene patches that should ride along with the next
   continuity-touching lane.

None of these block landing the slice. (1) is the only one that
materially gates Nick's stated complaint being "closed".
