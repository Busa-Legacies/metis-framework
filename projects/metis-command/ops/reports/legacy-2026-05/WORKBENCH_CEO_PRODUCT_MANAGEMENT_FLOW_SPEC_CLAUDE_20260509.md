# Workbench CEO Product-Management Flow Spec — Claude — 2026-05-09 CT

## 1. Purpose

Define the Agent Workbench product surface that turns Jarvis into Nick's
CEO/Project-Manager: opens the app once, walks every workspace, knows what
shipped, what is in flight, what the git tree looks like, what the next
action is, spawns visible agents to do that next action, watches the panes
without hiding them, captures evidence of what each lane produced, and
finally recommends a commit/push packet that Nick approves with one click.

This is a product/spec doc only. Read-only pass. No code, tests, push,
deploy, install, or messages.

## 2. Source-of-truth chain

Read in order; later supersedes earlier.

1. `WORKBENCH_CEO_FLOW_NEXT_GAPS_20260508.md` — durable dispatch runs,
   target guardrails, replay hygiene, done/review gates baseline.
2. `WORKBENCH_CEO_COCKPIT_NEXT_SPEC_CLAUDE_20260508.md` — cockpit fan-out
   + per-agent close-recommendation read endpoint.
3. `WORKBENCH_PRODUCT_WAVE_QA_CLAUDE_20260509.md` — what is already in
   source vs. open lanes (atomic dispatch-run writes landed; auth-parity
   test, closePane scrollback policy, lint debt, visibility-gated polling
   still open).
4. `WORKBENCH_NEXT_IMPROVEMENTS_FROM_VIBE_PROCESS_CODEX_20260509.md` —
   ten-item product backlog (mission packet, evidence ledger, checkpoint
   scheduler, budget/5h visibility, stale-watchdog actions, GitHub sync,
   lane advisor, safe launch preflight, task/done gate tools, mission
   resume).
5. **This report** — CEO product-management flow that ties those threads
   into one user-facing spec.

Everything below assumes the foundations from #1–#4 are the substrate; this
doc adds the missing CEO-shaped seams on top.

## 3. Product Principles (carry-forward, restated for this flow)

- Cockpit recommends; Jarvis approves; agents execute.
- No automatic kill, push, deploy, purchase, or external send.
- Every multi-agent build starts with a mission packet and ends with
  evidence.
- Every lane has one owner, one scope, one budget, one report path, one
  review state.
- Agent panes stay visible until Nick (or Jarvis on Nick's behalf) closes
  them. Stale, dirty-git, missing-evidence, no-checkpoint, over-budget,
  and out-of-repo states must be visible before "done" is offered.

## 4. Glossary (data nouns this spec relies on)

- **Workspace** — a project room with a `cwd` (REOS, Sitework, Workbench,
  Market Alpha, etc.).
- **Mission Packet** — durable build contract: goal, target workspace,
  lanes, evidence paths, budget, review owner, acceptance tests.
- **Lane** — one named slice of a mission, owned by one agent kind/role
  (Forge/Shield/Scout/Echo).
- **Agent** — a real PTY-backed `claude` / `codex` / `gemini` / shell /
  python child process bound to a lane.
- **Pane** — the visible terminal tab/leaf for an agent. Panes do not
  vanish on agent exit.
- **Evidence** — typed artifact rows tying a lane to its proof
  (report path, test command + exit, diff summary, review verdict).
- **Sync Status** — read-only release-boundary truth per workspace
  (in-repo, branch, upstream, ahead/behind, dirty, untracked, remote,
  reachable, push-allowed flag).
- **Commit/Push Packet** — Jarvis-proposed bundle (workspace, branch,
  files, diff stats, suggested commit message, suggested push target)
  awaiting human approval.

## 5. User Stories (CEO-grade)

Every story is from Nick's seat. "I" = Nick. "Jarvis" = the in-app
assistant. "Agent" = a spawned CLI lane.

### S1 — Open the app, see the whole portfolio in one glance

> As CEO I want to open Workbench and within 3 seconds see, for every
> workspace I have spawned in the last 30 days: what shipped most
> recently, what is in flight, whether the git tree is clean, and what
> the recommended next action is — without typing a prompt.

### S2 — Ask Jarvis "where do I start?" and get a concrete answer

> As CEO I want Jarvis to read all workspaces and tell me, in plain
> English: "REOS has one stale Codex lane needing a checkpoint;
> Workbench has a dirty branch with three untracked reports awaiting a
> commit packet; Sitework has nothing pending; Market Alpha has one
> review-ready lane needing my verdict." Jarvis must speak from
> structured cockpit state, not by re-reading scrollback.

### S3 — Spawn visible agents, never hidden ones

> As CEO when I tell Jarvis "build X in Workbench", I want every spawned
> agent to land as a visible pane in the layout for that workspace. I
> want to see the prompt, the working directory, the lane name, and the
> first lines of output without leaving the cockpit.

### S4 — Track evidence per lane without re-reading scrollback

> As CEO I want each lane to write into one structured evidence ledger:
> which report file the lane produced, which tests it ran, the exit
> codes, the diff summary, the reviewer verdict. I want to ask "what
> proof does the Forge lane have for task T?" and Jarvis answers from
> persisted state.

### S5 — See dirty git and report deltas per workspace, on the cockpit

> As CEO I want every workspace tile to show: branch, ahead/behind
> upstream, dirty file count, untracked file count, new reports since
> last visit, and whether this workspace is in a git repo at all.
> Out-of-repo workspaces must be flagged loudly so I do not assume work
> is being persisted.

### S6 — Get a commit/push packet recommendation, not an auto-commit

> As CEO when a mission's evidence is complete and the tree is dirty,
> I want Jarvis to propose a commit packet: which files to stage, a
> suggested commit message, an optional push target, and the review
> chain that produced the evidence. Nothing is committed or pushed
> until I press Approve.

### S7 — Approve, edit, or reject a commit/push packet from one card

> As CEO I want to approve, edit the message, drop files, or reject
> the packet from one cockpit card. Approve runs `git commit` (and
> optionally `git push`) inside the workspace pane visibly. Reject
> returns the packet to the lane with my reason recorded as new
> evidence.

### S8 — Resume the cockpit cleanly after restart

> As CEO when I restart Workbench, I want every workspace to come back
> with the same panes visible, the same dispatch runs intact, the same
> evidence ledger, and the same pending commit packets. No agent is
> auto-respawned; no action is auto-replayed. Jarvis proposes the
> next safe action.

### S9 — Watch stale/blocked/over-budget lanes before I close anything

> As CEO before any "Close Pane" suggestion, I want to see if the lane
> is stale (idle past threshold), checkpoint-due, blocked on review,
> or over-budget. The cockpit must hold me back from closing a pane
> that has unresolved obligations.

### S10 — Hold one shared mission packet across spawned lanes

> As CEO when I say "ship feature F", I want Jarvis to write one
> mission packet (goal, lanes, budgets, evidence paths, review owner)
> before spawning anything. Every lane prompt I see in its pane
> derives from that packet. The packet is what I review at the end,
> not three disconnected reports.

## 6. UI / Agent-Flow Requirements

This section enumerates the surfaces that satisfy §5. Each surface is
small and additive on top of today's cockpit; nothing here requires a
full UI rewrite.

### 6.1 Workspace Review Strip (top of cockpit)

A horizontal rail listing every workspace, ordered by most-recent
activity. Each tile shows:

- **Workspace name + cwd** (truncated).
- **Last shipped** — most recent dispatch run with status `succeeded`
  in the last N days; falls back to "no completed runs".
- **In-flight** — count of running agents and active dispatch runs.
- **Sync chip** — `repo/branch · ↑a ↓b · dirty=N · untracked=N`, or
  `not in repo` (red), or `ignored by parent` (amber).
- **Reports unread** — count of new reports since last visit.
- **Next action** — top recommended next action ("checkpoint Forge",
  "review Shield verdict", "approve commit packet", "spawn lane Y").
- **Click** focuses that workspace and pulls its panes in front.

Data source: existing `cockpit-summary.ts` plus a new sync-status field
(see §6.6) and the evidence-ledger join (see §6.4). Strip refreshes on
the existing 5s poll.

### 6.2 Mission Packet drawer (Jarvis-side authoring)

When Nick says "build X in workspace W", Jarvis MUST author a mission
packet before spawning. The packet drawer is a slide-in panel showing
fields that derive from the assistant's `create_mission` tool call:

- Goal (one paragraph, plain English).
- Target workspace (`workspaceId` + name resolved via
  `lib/workspace-selector.ts`).
- Lanes — list of `{ name, kind (claude/codex/...), role
  (forge/shield/scout/echo), scope, evidence path, budget,
  acceptance test }`.
- Budget — `softLimitMinutes`, `hardLimitMinutes`, optional cost cap,
  five-hour-window deadline.
- Review owner (Shield by default; explicit override allowed).
- Acceptance bundle — the report files that must exist before "done"
  can fire.

The drawer is read-only from Nick's side except for an Approve / Edit /
Cancel triplet. Approve persists the mission packet (`data/mission-packets/<id>.json`,
atomic write same shape as dispatch runs) and unlocks the spawn step.

### 6.3 Visible-Pane Spawn

`spawn_agents` MUST keep behaving as today (real PTY, stable pane in
the workspace's layout). Additions:

- Each spec carries `mission_id` + `lane_id`. The pane title shows
  `lane name · role · kind`.
- The first lines of the lane's initial prompt (scope + evidence path +
  budget + stop conditions, derived from the packet) are echoed into
  the pane so Nick can read them inline.
- Pane reconciliation is the **only** path to placing agents; no
  background-only spawn.
- A pane stays in the layout after agent exit until Nick clicks
  "Close Pane" or the cockpit explicitly marks it ready-to-close
  (gated by §6.5).

### 6.4 Evidence Ledger surface

Add a tabbed strip inside the workspace view: **Lanes / Evidence /
Reports / Tasks**. Evidence rows are typed:

- `report` — markdown produced by the lane (auto-detected from
  `WORKBENCH_*_<ROLE>_<DATE>.md` naming); records `path`, `mtime`,
  `unread` flag.
- `test` — recorded via assistant tool `attach_task_evidence` when an
  agent runs `npm test`, `npm run typecheck`, etc. Stores command,
  exit code, captured tail.
- `diff` — `git diff --stat` snapshot at evidence time.
- `review` — Shield/reviewer verdict + reasons.
- `manual_override` — Nick-recorded text reason; used when Nick wants
  to mark "done" without a Shield review.

Evidence is stored under
`data/evidence-ledger/<workspaceId>.json` with same atomic-write
discipline as dispatch runs (`lib/dispatch-runs.ts:104-119`). Cockpit
joins this against dispatch runs and tasks.

### 6.5 Lane / Task gate states

Replace the loose `task.status` string with a typed state machine:
`todo → building → review → ready_to_commit → done | blocked`.

Transitions are tool-driven only:
- `claim_task` (building)
- `request_review` (review)
- `record_review_verdict` (back to building OR forward to
  ready_to_commit)
- `attach_task_evidence` (any state)
- `mark_task_ready_to_commit` (review → ready_to_commit; requires
  ≥1 evidence row of kind `report` AND ≥1 of kind `review` OR a
  `manual_override` row)
- `mark_task_done` (ready_to_commit → done; requires the commit
  packet from §6.6 to have been Approved)

`done` is **never** reachable without going through ready_to_commit.

### 6.6 Sync-Status read endpoint

Extend the workspace status endpoint (currently returns local git
status from `server/pty-server.ts`) into a richer
`GET /api/workspace/<id>/sync` returning:

```ts
interface WorkspaceSyncStatus {
  inRepo: boolean
  releaseBoundary: string | null   // path of repo root
  ignoredByParent: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  dirtyFiles: { path: string; status: string }[]
  untrackedFiles: string[]
  remoteUrl: string | null
  githubReachable: boolean | null  // null = not yet probed; cached
  pushAllowed: boolean             // never auto-true; toggled by §6.7
  lastSyncCheckAt: string
}
```

This endpoint is read-only. Cockpit summary calls it once per workspace
per poll and feeds the strip in §6.1.

### 6.7 Commit/Push Packet card

When a workspace has at least one task in `ready_to_commit` AND the
sync status shows dirty/untracked/ahead, Jarvis emits a Commit/Push
Packet card on the workspace view. Card fields:

- Workspace, branch, upstream.
- Files to stage — pre-checked from the union of evidence diffs and
  current dirty/untracked, with manual checkboxes per file.
- Suggested commit message (plain text, derived from mission packet
  goal + per-lane evidence; user-editable).
- Suggested push target (`origin/<branch>`); off by default.
- Review chain — "Shield verdict OK on T1, T2; manual override on
  untracked report R3".
- Buttons: **Approve & Commit**, **Approve, Commit & Push**, **Edit**,
  **Reject**.

Approve & Commit runs `git add <files>` and `git commit -m <msg>` inside
the **visible workspace pane** (a fresh shell pane is opened if none
exists, not a hidden child). Approve, Commit & Push additionally runs
`git push <upstream>`. Approve states are recorded as evidence rows of
kind `commit_approval` / `push_approval` in the evidence ledger.

Reject returns the packet to the originating lane with Nick's reason
attached as `manual_override` evidence; the lane state goes back to
`building`.

### 6.8 Stale / blocked / over-budget watchdogs

Reuse the existing stale watchdog (`cockpit-summary.ts`) and extend its
`status` enum with `idle`, `checkpoint_due`, `needs_wake`,
`needs_read`, `needs_stop_decision`, `over_soft_budget`,
`over_hard_budget`. The cockpit shows recommended manual actions per
state; **no auto-kill, no auto-message**. The "Close Pane" affordance
is greyed out unless the lane state machine is at `done` or the user
has explicitly clicked "Force Close" (which records a
`manual_override` evidence row and the reason).

### 6.9 Resume & restart safety

After Workbench restart:

- Workspace Review Strip rehydrates from disk before any spawn occurs.
- Mission packets, dispatch runs, evidence ledger, and pending commit
  packets are all reloaded from `data/`.
- No agent is auto-respawned; the cockpit shows
  `previously running, now exited (restart)` rows for each lane and
  proposes "Re-spawn lane" with the original prompt.
- Action ledger replay protection (`lib/action-ledger.ts`) prevents
  any cached chat resend from creating ghost spawns.

## 7. Acceptance Criteria (mapped to user stories)

Each AC is what a Shield reviewer must verify before declaring the
slice done. Tests can be unit (`tests/*.test.ts`) or scripted manual.

### S1 — Portfolio glance

- AC1.1 — On cold cockpit load, the Workspace Review Strip renders
  every workspace present in `state.json` within 3s on a synthetic
  fixture of 10 workspaces.
- AC1.2 — Each tile renders sync chip, last-shipped, in-flight count,
  next action, and reports-unread count without scrollback access.
- AC1.3 — A workspace with zero dispatch runs renders
  "no completed runs" and a non-blocking sync chip; no crash.
- AC1.4 — Tiles refresh on the existing 5s poll without re-rendering
  pane state.

### S2 — Plain-English status from Jarvis

- AC2.1 — A new assistant tool `summarize_portfolio` returns a
  structured rollup keyed by workspace: `{ workspaceId, sync,
  laneStates, nextAction }`. Jarvis MUST call this tool before
  answering "where do I start?"; it must NOT scrape scrollback.
- AC2.2 — The plain-English answer Jarvis emits is reproducible from
  the tool's structured payload (snapshot test on synthetic state).
- AC2.3 — Telegram-friendly: the rendered answer contains no
  markdown tables, no fenced code blocks, no headers (per
  `feedback_telegram_plain_text.md`).

### S3 — Visible-pane spawn

- AC3.1 — Every successful `spawn_agents` action with a `mission_id`
  results in a pane appearing in the active workspace's layout in the
  same render loop the dispatch run is recorded.
- AC3.2 — Each pane title shows `lane name · role · kind`.
- AC3.3 — The lane's initial prompt header (scope, evidence path,
  budget, stop conditions) is echoed to the pane on first attach.
- AC3.4 — Pane lifecycle test (extends
  `tests/workbench-layout.test.ts`): spawn → exit → pane remains;
  manual close removes it; restart preserves it.
- AC3.5 — No code path (assistant tool, resume, layout reconciler)
  may create an agent without a corresponding leaf in the workspace
  layout; covered by a routing test rejecting hidden-spawn specs.

### S4 — Evidence ledger

- AC4.1 — `attach_task_evidence`, `record_review_verdict`,
  `record_test_run`, `record_diff_snapshot`, and `record_manual_override`
  tools persist rows into
  `data/evidence-ledger/<workspaceId>.json` via the same atomic
  same-directory rename discipline as dispatch runs.
- AC4.2 — Evidence rows survive Workbench restart (test).
- AC4.3 — Evidence rows are joined into the cockpit summary so the
  Workspace Review Strip and Lane tab can show counts and unread
  reports without scrollback.
- AC4.4 — `mark_task_done` rejects with `requires_evidence` if no
  ≥1 `report` evidence and no `review` or `manual_override` row.

### S5 — Sync status surface

- AC5.1 — `GET /api/workspace/<id>/sync` returns the shape in §6.6
  for a real repo workspace; ahead/behind/dirty/untracked are accurate
  on a controlled fixture (mocked git commands).
- AC5.2 — A workspace whose cwd is not inside any git repo returns
  `inRepo:false` and the sync chip shows "not in repo" in red.
- AC5.3 — A workspace inside a parent repo whose cwd is `.gitignore`d
  by the parent (e.g. `Projects/agent-workbench/` itself) returns
  `ignoredByParent:true` and the chip shows "ignored by parent" in
  amber.
- AC5.4 — `pushAllowed` is `false` until a Commit/Push Packet has
  been Approved; it never flips on automatically.

### S6 — Commit packet recommendation

- AC6.1 — A Commit/Push Packet card appears for a workspace iff
  `≥1 task in ready_to_commit AND (dirty>0 OR untracked>0 OR ahead>0)`.
- AC6.2 — Suggested files default to the union of evidence diffs and
  current dirty/untracked, deduped.
- AC6.3 — Suggested commit message is derived deterministically from
  the mission packet goal + lane evidence; the same inputs always
  produce the same message (snapshot test).
- AC6.4 — Push target is `origin/<branch>` only if upstream is set;
  otherwise the Push button is disabled with a "set upstream first"
  hint.

### S7 — Approval gate behaviour

- AC7.1 — Approve & Commit MUST run inside a visible workspace pane;
  no hidden child process. Test: assistant tool
  `apply_commit_packet` rejects unless a target pane id is supplied
  (or one is freshly opened by the same call).
- AC7.2 — Approve & Commit & Push performs commit then push in that
  order; if commit fails, push does not run; both operations are
  recorded as evidence regardless of outcome.
- AC7.3 — Reject returns `task.state` to `building` and writes a
  `manual_override` row carrying Nick's reason; no commit/push runs.
- AC7.4 — A packet that was already Approved cannot be Approved
  again (idempotent — second call returns
  `commit_already_applied:<sha>`).

### S8 — Resume cleanly

- AC8.1 — After process restart with seeded `data/`, the Workspace
  Review Strip, mission packets, evidence ledger, and pending commit
  packets all rehydrate to the pre-restart state.
- AC8.2 — No `spawn_agents` action runs during rehydrate; previously
  running agents show as `exited (restart)`.
- AC8.3 — Action-ledger replay protection rejects any duplicate
  `action_id` from a cached chat send across the restart boundary.

### S9 — Watchdog gating

- AC9.1 — A lane with `idle_ms > stale_threshold` and no checkpoint
  evidence renders state `checkpoint_due`; "Close Pane" is disabled
  for it.
- AC9.2 — A lane with `elapsed_ms > softLimit` renders
  `over_soft_budget`; cockpit emits a next-action of "extend budget
  or stop"; no auto-kill.
- AC9.3 — A lane with `elapsed_ms > hardLimit` blocks any further
  `spawn_agents` against the same mission until Nick approves an
  override; tested by routing rejection.
- AC9.4 — "Force Close" requires a non-empty reason and writes a
  `manual_override` evidence row.

### S10 — Mission packet contract

- AC10.1 — `create_mission` tool persists a mission packet under
  `data/mission-packets/<id>.json` atomically.
- AC10.2 — `spawn_agents` rejects if any spec lacks `mission_id` and
  the active workspace has at least one open mission (configurable
  off only by an explicit "ad-hoc spawn" override flag).
- AC10.3 — Each lane in the packet has an `initial_prompt` derived
  from the packet (scope + evidence path + budget + stop conditions)
  and the spawn API echoes it to the pane.
- AC10.4 — Closing a mission requires every lane in `done` or
  `blocked`, and the closing tool snapshot serializes the final
  evidence rollup as the mission report path.

## 8. Implementation Sequence

Tracks the existing waves so this slots cleanly into the open
backlog. Each step is one Codex/Forge lane plus one Shield review.

### Wave A — Read foundations (P0)

1. **A1 — Sync-Status read endpoint (§6.6).** Pure read. Wraps
   existing git status server-side, adds repo-boundary detection,
   ignored-by-parent detection, upstream / ahead / behind, and
   `lastSyncCheckAt`. Caches per workspace; the cockpit poll uses it.
   _Tests:_ `tests/sync-status.test.ts` with mocked `git` shell
   responses for in-repo, not-in-repo, ignored, dirty, untracked,
   ahead/behind, no-upstream cases.
2. **A2 — Evidence Ledger persistence + tools (§6.4).** Add
   `lib/evidence-ledger.ts` with atomic same-dir rename writes;
   tools `attach_task_evidence`, `record_review_verdict`,
   `record_test_run`, `record_diff_snapshot`,
   `record_manual_override`. Cockpit summary joins evidence by
   workspace + agent + task.
   _Tests:_ persistence round-trip, restart survival, malformed
   evidence rejection.
3. **A3 — Workspace Review Strip (§6.1).** Renders a tile per
   workspace from cockpit summary + sync-status + evidence joins.
   Today's status strip becomes the per-workspace detail view, not
   the only surface.
   _Tests:_ render snapshot for 0, 1, 5, 20 workspaces; sync-chip
   states; reports-unread count.

### Wave B — Mission contract + visible spawn (P0/P1)

4. **B1 — Mission Packet model + builder drawer (§6.2, §6.3).** Adds
   `lib/mission-packets.ts`, `create_mission` and `update_mission`
   tools, `spawn_agents` carries `mission_id` + `lane_id`. Pane title
   format change. Initial-prompt echo to pane on first attach.
   _Tests:_ packet persistence, lane→agent mapping, prompt echo,
   reject on missing mission when ad-hoc flag is off.
5. **B2 — Lane / Task gate state machine (§6.5).** Promote task
   `status` to typed state. Add transition tools. Make
   `mark_task_done` evidence-gated.
   _Tests:_ illegal-transition rejection; done-gate enforcement;
   state survives restart.

### Wave C — CEO answer surfaces (P1)

6. **C1 — `summarize_portfolio` assistant tool (§5 S2).** Pure read,
   returns the structured payload Jarvis must use to answer
   "where do I start?". Telegram-friendly rendering helper in
   `lib/jarvis-persona.ts`.
   _Tests:_ snapshot of structured payload; Telegram-format unit
   test asserting no tables/headers/fences.
7. **C2 — Stale / blocked / over-budget watchdog states (§6.8).**
   Extend `cockpit-summary.ts` enum and emit recommended manual
   actions; gate "Close Pane" affordance.
   _Tests:_ each enum state from synthetic fixtures.

### Wave D — Commit/Push approval gate (P1)

8. **D1 — Commit Packet builder (§6.7 backend).** Pure read tool
   `propose_commit_packet` consumes ready_to_commit tasks +
   sync-status + evidence and emits the card payload. Deterministic
   message generation.
   _Tests:_ snapshot for two synthetic packets; deterministic message
   reproduction.
9. **D2 — Apply Commit Packet inside visible pane (§6.7 frontend +
   `apply_commit_packet`).** Approve runs `git add/commit` (and
   optionally `git push`) in a workspace pane; idempotent on second
   call. Reject path writes `manual_override` evidence.
   _Tests:_ idempotent re-approve; commit-fails-blocks-push;
   reject-records-evidence-and-resets-task.

### Wave E — Restart & polish (P2)

10. **E1 — Resume rehydration test surface (§6.9).** End-to-end test
    that seeds `data/`, simulates restart, and asserts strip + panes
    + packets + evidence rebuilt without spawn or replay.
11. **E2 — Visibility-gated cockpit polling + lint debt close.**
    Already on the open backlog (`WORKBENCH_PRODUCT_WAVE_QA_CLAUDE_20260509.md`
    P2); fold in here so the cockpit doesn't burn poll cycles when
    the window is hidden.

The waves are independent enough that A and C can ship before B and
D, but D **must not** ship before B (commit packets need mission +
gate state to be meaningful).

## 9. Non-Goals (explicitly out of this spec)

- Auto-commit, auto-push, auto-merge, auto-deploy, auto-PR-creation.
- Auto-kill of stale agents.
- Auto-respawn on restart.
- A new dashboard rewrite separate from the existing cockpit; this
  spec is additive.
- Mutating GitHub issues, PRs, or remotes from inside the cockpit.
  All write-to-remote actions go through the visible-pane shell with
  human approval.
- Replacing the existing dispatch-run model; this spec extends it.
- Cross-host telemetry. Everything runs against local
  `~/.openclaw/agent-workbench/state.json` and `data/`.
- Pushing on Nick's behalf to any branch named `main` or `master` — D2
  must require explicit branch confirmation (never default-on) before
  push.

## 10. Open Questions (for Nick before implementation)

1. **Evidence retention.** How long do evidence rows live before
   compaction? Default proposal: full retention for 30 days, then
   collapse to per-lane summary unless task is still open.
2. **Multiple missions per workspace.** Allowed concurrently, or
   one-at-a-time? Default proposal: allowed; cockpit groups panes by
   mission inside the workspace.
3. **Force-Close threshold.** Should "Force Close" require Shield
   confirmation as well, or is Nick's reason text enough? Default
   proposal: reason text alone, with Shield notified after the fact.
4. **Push policy on `main`.** Block by default, or warn-only? Default
   proposal: block by default; require typed `confirm push to main`
   string.
5. **Telegram-rendered portfolio summary scope.** All workspaces, or
   filter to those with pending actions? Default proposal: filter to
   `nextAction != null` to keep the message short.

## 11. Verification Notes

This is a doc-only pass.

- No code, tests, push, deploy, install, or messages.
- Only file written is this spec at
  `WORKBENCH_CEO_PRODUCT_MANAGEMENT_FLOW_SPEC_CLAUDE_20260509.md`.
- All architectural assumptions trace back to files cited in §2 and
  to source modules: `lib/dispatch-runs.ts`, `lib/cockpit-summary.ts`,
  `lib/action-ledger.ts`, `lib/workspace-selector.ts`,
  `app/api/assistant/route.ts`, `server/pty-server.ts`,
  `components/Workbench.tsx`, `components/PaneGrid.tsx`,
  `components/AssistantPanel.tsx`, `components/TasksPanel.tsx`.
- No claim is made about runtime behavior beyond what those files,
  the prior reports, and the existing test suite already verify.
