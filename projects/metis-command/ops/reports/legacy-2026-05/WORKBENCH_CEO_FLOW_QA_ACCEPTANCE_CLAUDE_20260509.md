# Workbench CEO Flow — Shield QA Acceptance Tests — 2026-05-09 CT

## 1. Purpose

Shield QA acceptance harness for the CEO/PMA flow defined in
`WORKBENCH_CEO_PRODUCT_MANAGEMENT_FLOW_SPEC_CLAUDE_20260509.md` and the
ten-item product backlog in
`WORKBENCH_NEXT_IMPROVEMENTS_FROM_VIBE_PROCESS_CODEX_20260509.md`. This
doc enumerates the test cases a Shield reviewer must run before any
slice of the CEO flow is declared "ready to commit" by the Workbench
itself.

Read-only QA pass. No source edits, no push, no deploy, no install, no
messages. The only file written by this pass is this report.

## 2. Source-of-truth chain (for this acceptance set)

Read in order; later supersedes earlier.

1. `WORKBENCH_CEO_FLOW_NEXT_GAPS_20260508.md` — durable dispatch runs,
   target guardrails, replay hygiene, done/review gates baseline.
2. `WORKBENCH_CEO_COCKPIT_NEXT_SPEC_CLAUDE_20260508.md` — cockpit
   fan-out + per-agent close-recommendation read endpoint.
3. `WORKBENCH_VISIBILITY_QA_CLAUDE_20260509.md` — visibility verdict
   (multi-pane, no-premature-clear, accurate done/idle).
4. `WORKBENCH_PRODUCT_WAVE_QA_CLAUDE_20260509.md` — current
   in-source-vs-open productization status.
5. `WORKBENCH_NEXT_IMPROVEMENTS_FROM_VIBE_PROCESS_CODEX_20260509.md`
   — ten-item backlog (mission packet, evidence ledger, checkpoint
   scheduler, budget/5h visibility, watchdog actions, sync truth,
   lane advisor, safe launch, done gates, mission resume).
6. `WORKBENCH_CEO_PRODUCT_MANAGEMENT_FLOW_SPEC_CLAUDE_20260509.md` —
   binding CEO product spec; §5–§7 are the contract this doc tests.

## 3. Test taxonomy

Each test below has a stable id of the form `T-<area>-<n>`. Areas:

- `VPANE` — visible multi-agent panes
- `NOCLR` — no premature clearing of agent state / scrollback
- `TGCKPT` — Telegram-rendered checkpoint proof
- `MPKT` — mission packet contract
- `EVID` — evidence ledger
- `BUDG` — budget / 5h visibility
- `GATE` — approval gates (review / commit / push)

Test types:

- **U** — unit / route-level test (`tests/*.test.ts`,
  `tests/*.test.mjs`).
- **R** — render / component test (`tests/*.test.tsx` or test
  renderer).
- **F** — fixture-driven integration test (seeded `data/*.json`,
  simulated restart, mocked git/PTY).
- **M** — manual host walkthrough (sandbox cannot bind
  127.0.0.1:3747/3748 — must run on Nick's box).

Each test states: **Pre**conditions, **Steps**, **Pass**, **Fail**,
**Evidence to record**.

Severity:

- **P0** — gate; lane cannot ship without this passing.
- **P1** — required for the slice to be "feature complete".
- **P2** — hardening; can ride along the next QA pass.

## 4. Visible multi-agent panes (VPANE) — covers S3, §6.3

Anchors: `WORKBENCH_VISIBILITY_QA_CLAUDE_20260509.md` §1,
`WORKBENCH_PRODUCT_WAVE_QA_CLAUDE_20260509.md` B1 (`placeAgent` +
existing-leaf focus, `Workbench.tsx:304-318`).

### T-VPANE-1 — Multi-pane survives spawn (P0, type U+F)

Pre: workspace W has a 4-leaf layout with agents A, B, C, D placed in
leaves L0..L3; mission packet M with one new lane "Forge-1".

Steps: assistant calls `spawn_agents` with one spec for Forge-1;
inspect `layoutByWs[W]` after one render tick.

Pass: Forge-1 is placed via `placeAgent` into the empty preferred
leaf if any, else last-resort overwrite. Agents A..D remain in their
original leaves except in the last-resort case, in which the
overwritten leaf id is recorded in evidence as `manual_override`.

Fail: any agent A..D loses its leaf binding without a
`manual_override` evidence row, OR the new agent fails to render any
leaf in the active layout.

Evidence: snapshot of `layoutByWs[W]` before and after; the spawned
agent id and lane id; the path of the placed leaf.

### T-VPANE-2 — Open-existing focuses, never duplicates (P0, type U)

Pre: workspace W has agent X already bound to leaf L1.

Steps: cockpit drawer "open pane" action invokes
`openAgentPane(W, X)` (`Workbench.tsx:304-318`).

Pass: `activeLeafId` becomes L1; `layoutByWs[W]` is byte-equal to
its pre-call value; `leaves(root).filter(l => l.agentId === X).length === 1`.

Fail: any leaf other than L1 is mutated, OR X appears in two leaves
after the call.

Evidence: pre/post layout JSON; selected `activeLeafId`.

### T-VPANE-3 — Pane title shows lane / role / kind (P0, type R)

Pre: spec describes pane title format
`<laneName> · <role> · <kind>` (§6.3).

Steps: render `<PaneGrid>` against a mocked agent with
`{ kind: 'codex', role: 'forge', laneName: 'Forge-1' }`.

Pass: pane title text-content contains exactly
`Forge-1 · forge · codex`.

Fail: any of the three fields is missing or in a different order.

Evidence: rendered title string.

### T-VPANE-4 — Initial-prompt header echoed to pane (P1, type U)

Pre: mission packet M with lane L1 having scope, evidence path,
budget, stop conditions; spawn_agents called against M+L1.

Steps: read first N output lines from PTY tail for the new agent.

Pass: the four header fields (scope, evidence path, budget, stop
conditions) appear in the first 20 lines of the agent's output, in
prose form (no fenced code block, no markdown table — Telegram-safe).

Fail: any of the four fields missing, OR a fenced/tabular block is
rendered.

Evidence: first 20 lines of agent output.

### T-VPANE-5 — No hidden-spawn route (P0, type U)

Pre: routing layer per `lib/tool-routing.ts`.

Steps: invoke each spawn-capable tool path (`spawn_agents`,
`resume_workspace`, layout reconciler) with a synthetic spec missing
a `paneId` / `leafId` / placement directive.

Pass: every path either creates a leaf (visible spawn) OR rejects
with `requires_pane`. No code path produces a runtime agent without a
corresponding leaf in the active workspace layout.

Fail: any path returns `{ id }` without a leaf join in the same
render loop.

Evidence: route response and pre/post `state.json` agent vs leaf
diff.

### T-VPANE-6 — 4-pane host walkthrough (P1, type M)

Pre: Nick's box; `npm run dev:web` running.

Steps: open Workbench; spawn a mission with 4 lanes; verify all 4
panes appear simultaneously; click "open pane" on each from the
cockpit drawer; assert no eviction (carries forward
`WORKBENCH_VISIBILITY_QA_CLAUDE_20260509.md` recommendation #1).

Pass: 4 panes visible; no eviction across 4 click cycles; pane
titles match T-VPANE-3.

Fail: any pane evicted, or fewer than 4 visible after spawn.

Evidence: screen recording or screenshot grid.

## 5. No premature clearing (NOCLR) — covers §3, §6.5, §6.8

Anchors: `WORKBENCH_VISIBILITY_QA_CLAUDE_20260509.md` (2),
`WORKBENCH_PRODUCT_WAVE_QA_CLAUDE_20260509.md` P1#3,
`server/pty-server.ts:542-557 killAgent`,
`components/Workbench.tsx:295-302 closePane`.

### T-NOCLR-1 — Pane survives agent exit (P0, type U+F)

Pre: agent G running in leaf L; G exits cleanly.

Steps: observe `layoutByWs` after exit event.

Pass: leaf L still references G's agent id; pane stays visible until
explicit user action.

Fail: leaf L is removed or its agentId is cleared automatically.

Evidence: pre/post layout JSON; PTY agent state.

### T-NOCLR-2 — Cockpit ack does not delete (P0, type U)

Pre: agent G in `cockpit-acks.json` is unacknowledged.

Steps: invoke `acknowledge_agent` (the cockpit-only tool).

Pass: `data/dispatch-runs/<id>.json` byte-equal pre/post; G's PTY
row + `outputTails` unchanged; only `data/cockpit-acks.json` written
(matches `tests/tool-routing.test.ts:577` snapshot pattern).

Fail: any other file written; any PTY-side mutation.

Evidence: file diff list before/after.

### T-NOCLR-3 — Reports outlive their agent (P0, type F)

Pre: `cockpit-reports.json` has a row whose `agentId` is no longer
present in `state.json` (e.g. cleared via header "clear exited").

Steps: call `get_cockpit_summary` and `list_workspace_reports`.

Pass: report still surfaces with its agentId echoed; corresponds to
`tests/tool-routing.test.ts:549`.

Fail: report dropped, or agentId stripped.

Evidence: tool response payload.

### T-NOCLR-4 — Pane "X" guarded by close-pane policy (P0, type U+R)

Pre: workspace W with agent G exited cleanly, with at least one
unread report row in `cockpit-reports.json`.

Steps: invoke `closePane` against G's leaf.

Pass: per the chosen P1#3 option, EITHER the user is prompted before
deletion (Option A confirm gate) OR the leaf is removed but G's
`outputTails` and runtime row are preserved (Option B hide
semantics). In both cases, the report row in
`data/cockpit-reports.json` survives.

Fail: report row deleted, OR scrollback dropped without explicit
user action, OR no guard at all (current pre-P1#3 behavior).

Evidence: file diff; layout diff; PTY runtime diff.

### T-NOCLR-5 — Force-close requires reason (P1, type U)

Pre: workspace W with pane P holding agent G in any non-`done`
state.

Steps: invoke "Force Close" with empty reason; then again with text.

Pass: empty-reason call rejects with `requires_reason`; non-empty
call succeeds AND writes a `manual_override` row to
`data/evidence-ledger/<W>.json` with the reason text and a
timestamp.

Fail: empty reason accepted, OR no evidence row appended.

Evidence: rejection payload + appended evidence row.

### T-NOCLR-6 — Watchdog blocks Close-Pane on obligations (P1, type U)

Pre: lane L1 in workspace W is `checkpoint_due` per §6.8 watchdog
state machine; pane P holds L1's agent.

Steps: render the cockpit pane control; attempt Close-Pane.

Pass: Close-Pane affordance is greyed out / disabled; tooltip cites
the unmet obligation (`checkpoint_due`,
`needs_stop_decision`, `over_soft_budget`, `over_hard_budget`,
`needs_read`, or `needs_wake`); only "Force Close" remains active
(and routes through T-NOCLR-5).

Fail: Close-Pane stays enabled, OR no tooltip explanation.

Evidence: rendered button state + tooltip text.

### T-NOCLR-7 — Restart preserves panes (P0, type F)

Pre: seeded `~/.openclaw/agent-workbench/state.json` and `data/`
with one workspace, two leaves, two exited agents, two unread
reports, one mission packet, one ready-to-commit packet.

Steps: kill Workbench process; start it; observe rehydrated state
before any user action.

Pass: workspace strip, panes, mission packets, evidence ledger,
pending commit packet all visible; no `spawn_agents` action issued
during rehydrate; previously running agents marked `exited (restart)`
(per §6.9 + AC8.1–AC8.3).

Fail: any auto-respawn, OR any item missing, OR ghost spawn
generated by a cached chat send (action-ledger replay protection
miss).

Evidence: rehydrate log; pre/post state.json diff; tool-call audit
showing zero spawn actions.

## 6. Telegram-rendered checkpoint proof (TGCKPT) — covers S2, S4, §3 backlog #3

Anchors: `feedback_telegram_plain_text.md` (plain text only — no
markdown tables, no fenced code blocks, no headers in messages),
backlog #3 Checkpoint Scheduler, §6.4 evidence kind `report` /
`test` / `manual_override`.

### T-TGCKPT-1 — Checkpoint evidence is durable (P0, type U)

Pre: lane L1 in workspace W; assistant tool
`attach_task_evidence` invoked with kind=`checkpoint` carrying
`reportPath`, `summary`, `recordedAt`.

Steps: read `data/evidence-ledger/<W>.json` after the call; restart;
re-read.

Pass: row survives both reads byte-for-byte (atomic same-dir rename
discipline matches `lib/dispatch-runs.ts:104-119`).

Fail: row missing post-restart, OR partial write detected, OR not
written via temp+rename.

Evidence: evidence ledger contents; rename trace from a wrapped
`fs.renameSync` mock.

### T-TGCKPT-2 — Checkpoint state clears on evidence (P0, type U)

Pre: lane L1 stale-but-outputting, watchdog state
`checkpoint_due`.

Steps: post a checkpoint evidence row for L1 via
`attach_task_evidence`; re-run cockpit summary.

Pass: L1's watchdog state transitions out of `checkpoint_due`;
`lastCheckpointAt` updated; `checkpointCount` incremented (backlog
#3 acceptance).

Fail: state stays `checkpoint_due` after a valid checkpoint
artifact.

Evidence: pre/post cockpit-summary payload for L1.

### T-TGCKPT-3 — Telegram-safe rendering (P0, type U)

Pre: synthetic checkpoint evidence rollup for one mission, three
lanes, mixed pass/fail.

Steps: invoke `summarize_portfolio` (and any
`render_checkpoint_for_telegram` helper in `lib/jarvis-persona.ts`)
against the rollup.

Pass: rendered string contains zero markdown tables (no `|---|`,
no `|` column rows), zero fenced code blocks (no ` ``` `), zero ATX
or Setext headers (no leading `#`/`##`, no `===`/`---` underlines),
and uses plain prose with line breaks. AC2.3 + Nick's preference
(`feedback_telegram_plain_text.md`).

Fail: any of the above markers present.

Evidence: rendered string + regex assertion log.

### T-TGCKPT-4 — Checkpoint summary is reproducible (P1, type U)

Pre: same input as T-TGCKPT-3.

Steps: render twice in the same process; render once, restart,
render again from disk.

Pass: byte-equal output across all three renders (deterministic
ordering on lane id asc → recordedAt asc; AC2.2 snapshot pattern).

Fail: any divergence between renders.

Evidence: hash of each render.

### T-TGCKPT-5 — No outbound message side effects (P0, type U)

Pre: any test that exercises the rendering path.

Steps: assert at the routing boundary that no Telegram / Discord /
HTTP-out call is made during render; rendering must be local-only.

Pass: zero outbound network calls; the rendered string is returned
as a tool result and never auto-sent. Matches §9 non-goal "no
external send".

Fail: any outbound call observed.

Evidence: network mock log.

## 7. Mission packet (MPKT) — covers S10, §6.2, backlog #1

Anchors: §6.2, AC10.1–AC10.4.

### T-MPKT-1 — Atomic packet persistence (P0, type U)

Pre: assistant tool `create_mission` invoked with a packet payload
(goal, target workspace, lanes[], budget, review owner, acceptance
bundle).

Steps: observe writes to `data/mission-packets/<id>.json`.

Pass: write performed via same-dir temp + `renameSync`, with
`finally` cleanup of the temp file (matches dispatch-runs discipline
at `lib/dispatch-runs.ts:104-119`); single rename observed in the
fs mock.

Fail: direct `writeFileSync` to the destination, OR cross-directory
rename, OR orphan temp left after a forced failure.

Evidence: rename trace; final file contents.

### T-MPKT-2 — Spawn binds to mission (P0, type U)

Pre: an open mission M exists in workspace W.

Steps: call `spawn_agents` against W with a spec missing
`mission_id`.

Pass: call rejects with `requires_mission_id` UNLESS the spec carries
the explicit `ad_hoc: true` override flag (AC10.2).

Fail: hidden default-on ad-hoc spawn.

Evidence: tool response.

### T-MPKT-3 — Lane → agent mapping (P0, type U)

Pre: mission M with three lanes L1/L2/L3.

Steps: spawn against M; inspect dispatch run + mission packet after
all spawns complete.

Pass: every spawned agent carries (`mission_id`, `lane_id`); each
lane in M has exactly one agent id (or zero if spawn failed); no
orphan agent without a lane (AC10.3).

Fail: any agent has no lane id, OR a lane has multiple agents, OR
agent ids don't appear in the mission packet's lane list.

Evidence: dispatch-run + mission-packet JSON snapshot.

### T-MPKT-4 — Initial prompt derived from packet (P0, type U)

Pre: lane L1 has scope S, evidence path E, budget B, stop conditions
C.

Steps: spawn L1; capture initial prompt sent to the PTY.

Pass: prompt contains S, E, B, C in prose form (Telegram-safe per
T-TGCKPT-3); echoed to pane on first attach (T-VPANE-4).

Fail: any field missing, OR markdown table / fenced block in the
prompt.

Evidence: captured initial prompt text.

### T-MPKT-5 — Closing requires lane finality (P0, type U)

Pre: mission M with lanes in mixed states.

Steps: invoke `close_mission` while at least one lane is in
`building` / `review` / `ready_to_commit` (i.e., not `done` or
`blocked`).

Pass: rejects with `requires_lane_finality`. When every lane is
`done` or `blocked`, accept and persist a final evidence rollup at
the mission's report path (AC10.4).

Fail: close accepted with non-final lanes, OR no final rollup
written.

Evidence: rejection payload; final rollup file.

### T-MPKT-6 — Restart rehydrates packets (P1, type F)

Pre: seeded `data/mission-packets/<id>.json` with two open
missions.

Steps: simulate restart; query `list_missions` (or equivalent).

Pass: both packets present; assistant prompt includes summary of
each (matches §6.9 + AC8.1).

Fail: missing packets after restart, OR auto-spawn on rehydrate.

Evidence: rehydrate log; tool response.

## 8. Evidence ledger (EVID) — covers S4, §6.4, backlog #2

Anchors: AC4.1–AC4.4, atomic-rename discipline.

### T-EVID-1 — Atomic write per row (P0, type U)

Pre: any of the recording tools (`attach_task_evidence`,
`record_review_verdict`, `record_test_run`, `record_diff_snapshot`,
`record_manual_override`) invoked.

Steps: observe writes to `data/evidence-ledger/<workspaceId>.json`.

Pass: same-dir temp + rename; single rename per call; `finally`
cleanup; orphan-temp count after the test is zero.

Fail: any direct write, cross-dir rename, or leftover temp.

Evidence: fs-mock rename trace.

### T-EVID-2 — Schema enforced (P0, type U)

Pre: row payloads with malformed shapes (missing `kind`,
unknown `kind`, missing `recordedAt`, non-string `reportPath`).

Steps: call each recording tool with each malformed payload.

Pass: rejection with a typed error code per case; no partial write
observed in `data/evidence-ledger/<workspaceId>.json`.

Fail: malformed row written, OR write occurs before validation.

Evidence: tool response per case + post-call file contents.

### T-EVID-3 — Restart survival (P0, type F)

Pre: `data/evidence-ledger/<W>.json` seeded with rows of every
kind (`report`, `test`, `diff`, `review`, `manual_override`).

Steps: restart Workbench; query
`get_cockpit_summary({ workspaceId: W })` and `list_workspace_reports`.

Pass: all rows still surfaced; counts and unread flags reproduce
pre-restart values (AC4.2).

Fail: any row missing or duplicated.

Evidence: pre/post ledger byte hashes.

### T-EVID-4 — Cockpit summary join (P0, type U)

Pre: workspace W has 5 evidence rows: 2 report (1 unread), 1 test
(exit 0), 1 review (verdict ok), 1 manual_override.

Steps: call `get_cockpit_summary({ workspaceId: W })`.

Pass: returned payload includes evidence counts per lane; reports
unread count == 1; review verdict surfaced; matrix tile in §6.1
shows correct chip values.

Fail: counts mismatch, OR rows surfaced from another workspace.

Evidence: tool response payload.

### T-EVID-5 — Done requires evidence (P0, type U)

Pre: lane L1 in `ready_to_commit` with NO `report` and NO `review`
or `manual_override` rows.

Steps: invoke `mark_task_done` against L1.

Pass: rejected with `requires_evidence` (AC4.4).

Fail: lane transitions to `done`.

Evidence: tool response.

### T-EVID-6 — Manual override path (P1, type U)

Pre: lane L1 in `ready_to_commit` with one `report` row but NO
`review` row.

Steps: invoke `mark_task_done` after first writing a
`manual_override` row with reason text.

Pass: lane transitions to `done`; the override row is referenced in
the dispatch-run completion log; reason text preserved.

Fail: transition rejected, OR override row not referenced.

Evidence: ledger contents + dispatch-run completion entry.

## 9. Budget visibility (BUDG) — covers backlog #4, §6.7 hardLimit gate

Anchors: backlog #4 acceptance (synthetic 5h mission, 50/80/100
percent warnings, hard-limit blocks auto-spawn).

### T-BUDG-1 — Mission budget fields persist (P0, type U)

Pre: `create_mission` invoked with
`budget: { startedAt, softLimitMinutes, hardLimitMinutes,
fiveHourDeadlineAt, costBudget }`.

Steps: read packet from disk after the call.

Pass: all fields present and serialized exactly as written.

Fail: any field truncated or coerced.

Evidence: packet JSON.

### T-BUDG-2 — Time-remaining surfaces in cockpit (P0, type U)

Pre: synthetic mission M with `softLimitMinutes=120`,
`hardLimitMinutes=300`, `startedAt` 60 minutes ago.

Steps: call `get_cockpit_summary` and inspect M's tile.

Pass: tile reports `timeRemainingSoftMin=60`,
`timeRemainingHardMin=240`, `softPctConsumed=50`,
`hardPctConsumed≈20`; budget chip rendered in §6.1 strip.

Fail: any value missing, OR off by more than 1 minute, OR no chip.

Evidence: cockpit-summary payload + rendered chip.

### T-BUDG-3 — Soft limit fires next-action (P0, type U)

Pre: same mission as T-BUDG-2 but `startedAt` 144 minutes ago
(120 % of soft, 48 % of hard).

Steps: call `get_cockpit_summary`.

Pass: `nextActions[]` contains a row of kind `budget_warning` for
M with severity per spec; copy is plain prose, no table/fence.

Fail: no warning, OR auto-kill / auto-stop side effect observed.

Evidence: cockpit-summary payload; PTY-state diff (must be empty).

### T-BUDG-4 — Hard limit blocks spawn without override (P0, type U)

Pre: mission M past `hardLimitMinutes`.

Steps: call `spawn_agents` against M with no override flag, then
again with `override: true` and a reason.

Pass: first call rejects with `over_hard_budget`; second call
accepts AND writes a `manual_override` evidence row capturing the
reason (AC9.3).

Fail: first call accepted, OR second call accepted without writing
the override row.

Evidence: tool responses + ledger row.

### T-BUDG-5 — 5h work-window deadline visible (P1, type U)

Pre: mission M with `fiveHourDeadlineAt` set 30 minutes in the
future.

Steps: render workspace tile.

Pass: tile shows "five-hour window: 30m left" or equivalent prose;
no fenced/tabular rendering.

Fail: deadline missing or off, OR rendered as a table.

Evidence: rendered tile string.

### T-BUDG-6 — Cost budget surfaces but never auto-stops (P1, type U)

Pre: mission M with `costBudget` set; synthetic spend at 110 % of
budget.

Steps: cockpit summary call.

Pass: tile shows `over_cost_budget` chip; `nextActions[]` includes a
manual review action; PTY agents continue running (no auto-kill,
matches §9 non-goal).

Fail: any auto-kill / auto-stop, OR no chip.

Evidence: cockpit payload + PTY agent statuses pre/post.

## 10. Approval gates (GATE) — covers S6/S7, §6.5, §6.7

Anchors: AC6.1–AC6.4, AC7.1–AC7.4, §6.5 state machine.

### T-GATE-1 — Lane state transitions are typed (P0, type U)

Pre: task T with `state: 'todo'`.

Steps: call each transition tool in legal order
(`claim_task` → `request_review` → `record_review_verdict(ok)`
→ `mark_task_ready_to_commit` → commit-packet approve →
`mark_task_done`); then attempt illegal transitions
(`todo` → `done`, `building` → `done`, etc.).

Pass: legal sequence accepted; every illegal call rejected with
`illegal_transition`; final state is `done`. State persists across
restart (AC for §6.5).

Fail: any illegal transition accepted.

Evidence: per-call response; final task state.

### T-GATE-2 — Ready-to-commit requires evidence (P0, type U)

Pre: task T in `review` with no evidence rows.

Steps: call `mark_task_ready_to_commit`.

Pass: rejected with `requires_evidence` (AC for §6.5; ≥1 `report`
AND ≥1 `review` OR `manual_override`).

Fail: transition accepted.

Evidence: tool response.

### T-GATE-3 — Commit packet card preconditions (P0, type U)

Pre: workspace W has (a) ≥1 task in `ready_to_commit` AND
(b) `dirty>0 OR untracked>0 OR ahead>0` per the sync endpoint.

Steps: call `propose_commit_packet`.

Pass: card payload returned (workspace, branch, upstream, files,
suggested commit message, suggested push target, review chain).
File list = union of evidence diffs ∪ current dirty/untracked,
deduped (AC6.1, AC6.2).

Fail: card returned when preconditions absent, OR file list
mismatched.

Evidence: tool response.

### T-GATE-4 — Commit message is deterministic (P0, type U)

Pre: same packet inputs as T-GATE-3.

Steps: call `propose_commit_packet` twice.

Pass: byte-equal `commitMessage` field across both calls
(AC6.3 snapshot).

Fail: any divergence.

Evidence: hash of message.

### T-GATE-5 — Push target gating (P0, type U)

Pre: workspace W with no upstream set.

Steps: render the commit-packet card.

Pass: Push button disabled with hint "set upstream first" (AC6.4);
`pushAllowed` false in sync payload.

Fail: Push enabled, OR auto-set-upstream side effect.

Evidence: rendered card state + sync payload.

### T-GATE-6 — Approve commits in visible pane (P0, type U+M)

Pre: ready commit packet for workspace W; no shell pane currently
in W.

Steps: invoke `apply_commit_packet({ approve: true })` without a
target pane id; then again with one.

Pass: first call either (a) opens a fresh pane in W and runs
`git add` / `git commit` visibly inside it, OR (b) rejects with
`requires_pane_id`. Either path makes the commit observable to Nick
in the layout. No hidden child process. Matches AC7.1.

Fail: hidden child process spawned, OR commit completed without a
visible pane association.

Evidence: PTY agent registry diff; pane layout diff; agent output
contains `git commit` line.

### T-GATE-7 — Push runs only after commit success (P0, type U)

Pre: simulated `git commit` failure (e.g., empty index).

Steps: invoke `apply_commit_packet({ approve: true, push: true })`.

Pass: `git push` does NOT run (AC7.2); both attempts recorded as
evidence rows of kind `commit_approval` and (negative)
`push_attempt` regardless of outcome.

Fail: push runs after commit failure, OR no evidence row recorded.

Evidence: command sequence captured from PTY tail; ledger rows.

### T-GATE-8 — Approve is idempotent (P0, type U)

Pre: packet successfully approved once with resulting sha S.

Steps: re-invoke `apply_commit_packet({ approve: true })` with the
same packet id.

Pass: returns `commit_already_applied: <S>` (AC7.4); no second
commit; no second evidence row.

Fail: a second commit observed, OR duplicate evidence row.

Evidence: git log; ledger row count.

### T-GATE-9 — Reject path resets task and records reason (P0, type U)

Pre: ready commit packet; reviewer text reason supplied.

Steps: invoke `apply_commit_packet({ reject: true, reason })`.

Pass: associated task moves back to `building`; a `manual_override`
evidence row is appended carrying the reason and a timestamp; no
git command runs (AC7.3).

Fail: task state unchanged, OR no override row, OR any git
operation observed.

Evidence: task state + ledger row + git log diff (must be empty).

### T-GATE-10 — `main` / `master` push requires explicit confirm (P1, type U)

Pre: branch is `main` and upstream is `origin/main`.

Steps: invoke `apply_commit_packet({ approve: true, push: true })`
without a typed-confirmation field; then with the literal string
`confirm push to main`.

Pass: first call rejects with `requires_protected_branch_confirm`;
second call proceeds. Default-off behavior matches §9 + open
question #4.

Fail: first call pushes.

Evidence: tool responses; git log diff.

### T-GATE-11 — Reviewer block surfaces required fixes (P1, type U)

Pre: task T in `review`.

Steps: call `record_review_verdict({ verdict: 'block', reasons:
['fix X', 'add test Y'] })`.

Pass: T state moves back to `building`; `reasons[]` are surfaced
in cockpit-summary `nextActions` for that lane; no auto-spawn
follow-up.

Fail: T moves to `done`/`ready_to_commit`, OR reasons not
surfaced.

Evidence: tool response + cockpit payload.

### T-GATE-12 — Sync-status read-only and accurate (P0, type U)

Pre: mocked `git` shell responses for cases:
in-repo / not-in-repo / ignored-by-parent / dirty / untracked /
ahead / behind / no-upstream.

Steps: call `GET /api/workspace/<id>/sync` for each fixture.

Pass: response shape matches §6.6 `WorkspaceSyncStatus` interface;
values match fixture; `pushAllowed` is `false` until a packet is
approved (AC5.4); `ignoredByParent` true for `Projects/agent-workbench/`
(AC5.3); `inRepo:false` for non-repo workspaces (AC5.2); response
is read-only (no shell side effects beyond `git` queries).

Fail: any field missing, off, or `pushAllowed:true` without prior
approval.

Evidence: per-fixture response payload.

### T-GATE-13 — Host walkthrough: end-to-end approval (P1, type M)

Pre: Nick's box; workspace W in dirty state with one
ready-to-commit task; mission packet present.

Steps: open Workbench; review the commit-packet card; click
"Approve & Commit" (no push); verify the commit lands in a visible
pane and the workspace tile updates.

Pass: commit visible inline; tile shows `dirty=0` (or reduced),
`ahead=ahead+1`; evidence ledger has `commit_approval` row.

Fail: any of the above invisible or incorrect.

Evidence: screen capture + post-state cockpit payload.

## 11. Sequencing & coverage map

This is the order Shield should run for the next CEO-flow lane.

1. P0 unit pass (no host needed): all `type U` and `type R` tests
   above. Run via `npm run typecheck` then
   `node --import tsx --test tests/...`.
2. P0 fixture pass (`type F`): seed `data/`, simulate restart,
   assert rehydrate-without-spawn (T-NOCLR-7, T-MPKT-6, T-EVID-3).
3. P1 manual host walkthrough (`type M`): T-VPANE-6, T-GATE-6,
   T-GATE-13 — must run on Nick's box per
   `WORKBENCH_PRODUCT_WAVE_QA_CLAUDE_20260509.md` host blockers.
4. P2 hygiene (lint debt, visibility-gated cockpit poll,
   PaneGrid render-style test) folds in here per the existing
   product-wave plan.

Cross-spec coverage map (each spec AC has at least one acceptance
test below):

| Spec AC                  | Test ids                                  |
| ------------------------ | ----------------------------------------- |
| AC1.1–AC1.4 (S1 strip)   | T-EVID-4 (chips), T-VPANE-3, T-NOCLR-7    |
| AC2.1–AC2.3 (S2 plain)   | T-TGCKPT-3, T-TGCKPT-4, T-TGCKPT-5        |
| AC3.1–AC3.5 (S3 spawn)   | T-VPANE-1..5                              |
| AC4.1–AC4.4 (S4 evid)    | T-EVID-1..6, T-MPKT-3                     |
| AC5.1–AC5.4 (S5 sync)    | T-GATE-12                                 |
| AC6.1–AC6.4 (S6 packet)  | T-GATE-3, T-GATE-4, T-GATE-5              |
| AC7.1–AC7.4 (S7 approve) | T-GATE-6, T-GATE-7, T-GATE-8, T-GATE-9    |
| AC8.1–AC8.3 (S8 resume)  | T-NOCLR-7, T-MPKT-6, T-EVID-3             |
| AC9.1–AC9.4 (S9 watch)   | T-NOCLR-5, T-NOCLR-6, T-BUDG-3, T-BUDG-4  |
| AC10.1–AC10.4 (S10 mpkt) | T-MPKT-1, T-MPKT-2, T-MPKT-3, T-MPKT-5    |

Each test in this file traces to at least one of the spec ACs above
and at least one source file in §2's source-of-truth chain.

## 12. Definition of "Shield PASS" for a CEO-flow lane

A lane is Shield-PASS only when ALL of the following hold:

- `npm run typecheck` exits 0.
- The `tests/` suite runs all P0-tagged tests above for the touched
  area and reports zero failures.
- Every `type F` test for the touched area is run against a fresh
  fixture (not a leftover dev `data/`).
- Every `type M` test for the touched area is signed off by Nick
  (or Nick's delegate) on the host, with a screen capture or a
  written verdict attached as a `manual_override` evidence row in
  the relevant workspace's evidence ledger.
- No source file outside the touched area was modified (lane scope
  enforced).
- No outbound message, push, deploy, or external send occurred
  during the lane's spawn or QA run.

Anything less is FAIL or PARTIAL. PARTIAL lanes do not earn a
ready-to-commit transition; they go back to `building` with a
`manual_override` row recording what is missing.

## 13. Non-goals for this acceptance set

Carry-forward of `WORKBENCH_CEO_PRODUCT_MANAGEMENT_FLOW_SPEC_CLAUDE_20260509.md` §9:

- No auto-commit, auto-push, auto-merge, auto-deploy, auto-PR
  testing.
- No auto-kill / auto-respawn testing.
- No GitHub remote mutation. All push tests are local against a
  mocked / local-bare upstream.
- No outbound Telegram / Discord / Slack / email message sends. The
  Telegram tests assert rendering only.
- No cross-host telemetry. Everything runs against local
  `~/.openclaw/agent-workbench/state.json` and `data/`.
- No replacement of the dispatch-run model; tests extend it.

## 14. Verification notes

This is a doc-only QA pass.

- No code, tests, push, deploy, install, or messages were emitted by
  this pass.
- The only file written is this report at
  `WORKBENCH_CEO_FLOW_QA_ACCEPTANCE_CLAUDE_20260509.md`.
- All test IDs, anchors, and ACs trace back to the source-of-truth
  chain in §2 and to the source modules cited in
  `WORKBENCH_CEO_PRODUCT_MANAGEMENT_FLOW_SPEC_CLAUDE_20260509.md`
  §11 (`lib/dispatch-runs.ts`, `lib/cockpit-summary.ts`,
  `lib/cockpit-continuity.ts`, `lib/cockpit-ui-state.ts`,
  `lib/action-ledger.ts`, `lib/workspace-selector.ts`,
  `lib/tool-routing.ts`, `app/api/assistant/route.ts`,
  `server/pty-server.ts`, `components/Workbench.tsx`,
  `components/PaneGrid.tsx`, `components/AssistantPanel.tsx`,
  `components/TasksPanel.tsx`).
- No claim is made about runtime behavior beyond what those files
  and the prior reports already verify; new tests called for in
  this document are described as required-but-not-yet-implemented.
