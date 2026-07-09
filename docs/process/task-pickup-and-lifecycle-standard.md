# Task Pickup & Lifecycle Standard

The **concrete, tool-grounded** standard for how an agent session (primarily Claude
Code on <<MACHINE_1_ID>>, but any peer) assesses the queue, picks up a task, works it, closes it
out, and chooses the next one — without colliding with another active session.

This is the operational layer. It *implements* the abstract loop in
[`agent-operating-loop.md`](agent-operating-loop.md) and carries the durable fields
defined in [`task-state-contract.md`](task-state-contract.md). Where those docs say
*what* and *why*, this doc says *which command, in what order, with which guard*.

> One-line contract: **assess the project board → join a project → claim before
> touching → work behind a fence → close with evidence → re-assess.** Never skip the
> claim, never write shared state without the fence, never close without evidence.

**Pickup is project-oriented (#181).** A *project* (registry:
`docs/process/state/projects.json`) is a shared workspace sessions **join** — joining
writes an informational presence record (roster, 4h TTL, session-keyed), never a
lock. Multiple sessions collaborating inside one project is the intended state. A
*task* is the claimable unit; the lease + fence machinery below is unchanged and is
what prevents two sessions doing the same task. Every task carries a required
`project` slug (write-gated; `ops` is the catch-all).

## Canonical vs projection (read this first)

Every phase below depends on knowing which sources you can trust:

| Source | Role | Trust |
|---|---|---|
| `docs/process/state/active-checkouts.json` (leases) | who holds what, fence tokens | **CANONICAL** |
| `docs/process/state/tasks.json` (state/owner) | task lifecycle state | **CANONICAL** |
| `workspace/state/OPEN_TASKS.md` | dashboard board | projection |
| `gh issue list` | cross-device task record | projection (when reachable) |

If a projection disagrees with canonical, **canonical wins** — that disagreement is
`DRIFT`, and `free-work.py` surfaces it. Reconcile drift *before* acting on a "free"
item; a projection that says "free" over a canonical `in_progress(other)` is a
collision waiting to happen.

## Phase 1 — Assess the project board

**Command:** `python3 scripts/free-work.py` (or the `/free-work` skill).

Default output is the **PROJECT BOARD**: active projects ranked by
status > priority > free-count > blocked-ratio, each row carrying
`free / blocked / claimed` counts and the live presence roster. The pickup question
is "**which project needs hands**", then "which task inside it". Drill in with
`--project <slug>`; `--flat` keeps the legacy global task list.

Within a project (and in `--flat`), tasks bucket for *this machine* as before:

- **CLAIMED** — live leases (lease wins over lagging tasks.json state) +
  `in_progress` tasks owned by someone else → skip the *task*; the *project* stays
  joinable.
- **BLOCKED** — has an unresolved blocker → skip unless you're clearing the blocker.
- **FREE FOR `<machine>`** — `queued` tasks machine-matched
  (`@machine` == me / `either` / absent), minus CLAIMED/BLOCKED → eligible.
- **DRIFT** — projection/canonical mismatch → **reconcile before recommending**.
- **WIP** — warns if this machine already holds a live lease.

**Rules:**
1. A lease is *live* only if `status != done/released/...` **and**
   `leaseExpiresAt > now(UTC)`. Expired ≠ held.
2. If `DRIFT` is non-empty, fix it first (update the projection to match canonical,
   or correct canonical if the projection is right) — do not pick from a drifted list.
3. Rank projects by the board order, then `FREE` within them by leverage, not list
   order: P1 before P2; unblocks-others before standalone; finishable-this-session
   before open-ended. Surface the top 2–3 to Ant as a readable chat list (not
   AskUserQuestion chips) and let him choose, unless he's already delegated the choice.
4. Sibling presence in a project is an invitation, not a conflict — join and split
   its task list; the task-level lease keeps you off each other's work.

## Phase 2 — Join the project, then claim the task

**Join first:** `python3 scripts/agent-work.py join <slug>` — writes the presence
record (informational; auto-reaped at TTL; refresh rides on claim/renew). With live
presence, `claim-next` scopes to your project automatically. `leave` when switching
projects or wrapping up.

**Claiming is mandatory and comes before the first edit.** An unclaimed task can be
taken by another session mid-flight — exactly the collision this system exists to
prevent.

- **Preferred (collision-free):**
  `python3 scripts/agent-work.py claim-next --agent claude` (scoped by presence, or
  `--project <slug>`) — selects + claims inside one lock.
- **Task with a GitHub issue:**
  `scripts/agent-checkout <issue> --agent claude --auto-worktree` (or
  `--in-place` for state-only work on a clean tree). Worktree isolation physically
  prevents the auto-sync force-push collision.
- **Specific task by label:**
  `python3 scripts/agent-work.py claim "<task label>" --agent claude`.

Both mint a **fence token** (printed at claim). **Record it** — every later write to
shared state should present it (see Phase 3). See
[`agent-checkout-protocol.md`](agent-checkout-protocol.md) §Fencing tokens.

**Take-over rule:** only `--steal` a live lease when the holder is verifiably
unreachable/capped *or* Ant explicitly says take it over. A task that is merely
`queued` (no live lease) is not a steal — just claim it. After claiming, set
`tasks.json` `state: in_progress`, `owner: claude`, and a real `currentStep`.

## Phase 3 — Work the task

Execution discipline, from [`task-state-contract.md`](task-state-contract.md) and
this session's hard-won rules:

1. **Keep durable state honest as you go.** The task must always carry a resumable
   `currentStep` and `nextAction`. If you'd lose context to a crash, it belongs in
   `tasks.json`, not just the transcript.
2. **Present the fence on every shared-state write.** Pass `--fence-token N` to
   `renew`/`block`/`release`/`finish`. A long-running session should also
   `agent-work.py fence --issue N --token <mine>` (exit 1 = fenced out) *before*
   writing after any long pause — this catches the stale-writer case where you were
   reaped/stolen while asleep.
3. **Renew before the lease expires** (`agent-work.py renew ... --fence-token N`) for
   multi-hour work; default lease is 4h.
4. **Route generation to <<MACHINE_1_ID>>'s lanes when it qualifies** (see `~/.claude/CLAUDE.md`
   routing): scout for research-first, smith for code/draft, warden for review.
   Apply their output inline. Keep runtime/git/security work inline.
5. **Verify is a phase, not an afterthought.** Before claiming done, actually run the
   `verificationMethod`. Capture concrete `evidence_refs` (command output, commit sha,
   passing test) — a done claim without evidence is unauditable.
6. **Checkpoint discrete sub-results** with `/checkpoint`: atomic commit of only that
   sub-task's files **+ `working-context.md`, under the sync lock**
   (`scripts/git-lock.sh run ...`) so the auto-sync daemon can't front-run your
   labeled commit. The commit message IS the session record `/end` rolls up.

## Phase 4 — Close out the task

A task is done only when the artifact exists, the verification method passed, and the
evidence is recorded. Then, in order:

1. **Finish the lease with evidence:**
   `scripts/agent-finish <issue> --fence-token N --push --pr` (issue-backed), or
   `python3 scripts/agent-work.py unclaim <claim-id>` (claim-backed). Finishing a
   stolen/terminal lease is rejected by design — if it fences you out, your work was
   superseded; reconcile, don't force.
2. **Advance canonical state via the mutator** — never hand-edit `tasks.json` or the
   projections (`scripts/render-tier1-state.py` regenerates `OPEN_TASKS.md`; #350
   auto-render overwrites hand edits). The forward-only graph is
   `in_progress → execution_finished → needs_verification → done` (there is **no**
   `in_progress → done` — the mutator rejects it). Use
   `python3 scripts/update-tier1-state.py task-update --task-id <id> --expected-revision N
   --actor <you> --commit --patch '{"state": "execution_finished", ...}'`, then advance to
   `needs_verification`, then to `done` once the verification method passed. The **verifier**
   moves the `needs_verification → done` gate; a self-verified task may walk all three steps.
   Fill `evidence_refs` on the way. (`correct-state` is only for audited data fixes, not the
   normal path.)
3. **Commit + push under the lock** with a descriptive message (this is the record).
   Tag a milestone (`git tag -a <name>-v1`) when the work is a coherent shippable unit.
4. **Memory only if durable + cross-session + non-obvious + not-already-in-git** —
   write/extend one `ClaudeCode/memory/` file, refresh its `MEMORY.md` line. Usually
   skip for mechanical work.
5. **Handoff cleanly if ownership changes** — fill `handoff_context` and the handoff
   minimum from the state contract so the next owner resumes without transcript
   archaeology.

Closing a *session* (not a task) is the heavier `/end` ceremony — that adds rename,
Scribe daily-log, self-review, full reflection, and the task-queue sweep on top of the
above. `/checkpoint` accumulates; `/end` synthesizes + terminates.

## Phase 5 — Choose the next task

Re-run **Phase 1** (`free-work.py`). Do not pick from stale in-context memory of what
was free — state moved while you worked (the doctrine session landing commits during
this very session is the proof). Confirm `WIP` is clear (no dangling lease you forgot
to release) before claiming the next one.

Selection order, all else equal:
1. Anything you just *unblocked* for another session (clear it so they can move).
2. Highest priority `FREE FOR <this-machine>`.
3. Finishable-this-session over open-ended, when priority ties.
4. Defer paused-project work (e.g. trading bot is P3/paused) unless Ant re-prioritizes.

## Quick reference

```bash
# 1. Assess
python3 scripts/free-work.py

# 2. Pick up (claim BEFORE working)
scripts/agent-checkout <issue> --agent claude --auto-worktree   # issue-backed
python3 scripts/agent-work.py claim "<label>" --agent claude    # claim-backed
#   -> record the printed fence token

# 3. Work — present the fence on shared-state writes; verify; checkpoint under lock
python3 scripts/agent-work.py fence --issue <n> --token <N>      # pre-write staleness check
scripts/git-lock.sh run sh -c "git add <paths> workspace/memory/working-context.md \
  && git commit -m 'checkpoint: <desc>' && git push"

# 4. Close out (with evidence)
scripts/agent-finish <issue> --fence-token <N> --push --pr       # issue-backed
python3 scripts/agent-work.py unclaim <claim-id>                 # claim-backed
#   -> advance state via the mutator (task-update), never hand-edit tasks.json/projections:
#      in_progress -> execution_finished -> needs_verification -> done (+ evidence_refs).
#      OPEN_TASKS.md re-renders from tasks.json (render-tier1-state.py) — don't touch it.

# 5. Choose next
python3 scripts/free-work.py                                     # re-assess, never trust stale view
```

## Relationship to other docs

- [`agent-operating-loop.md`](agent-operating-loop.md) — the abstract loop this implements.
- [`task-state-contract.md`](task-state-contract.md) — the durable fields/states referenced throughout.
- [`agent-checkout-protocol.md`](agent-checkout-protocol.md) — claim/checkout/fence mechanics.
- [`<<MACHINE_2_ID>>-task-lifecycle-protocol.md`](<<MACHINE_2_ID>>-task-lifecycle-protocol.md) — the <<MACHINE_2_ID>>-side counterpart.
- `~/.claude/CLAUDE.md` — Session Start (free-work + claim), `/checkpoint`, `/end`, and lane routing.

## Success criteria

This standard is working when:
- two sessions never silently work the same task (claim + fence + free-work hold the line);
- every "free" pick comes from reconciled canonical state, not a drifted projection;
- done claims carry evidence and survive interruption;
- the next task is always chosen from a fresh assessment, not a stale mental model.

## Human-gated board fallback (standing directive, Ant 2026-06-06)

When the project board offers no agent-runnable free work (everything blocked on
Ant's OAuth/logins/presence/decisions), do **not** idle and do not ask "what next".
Default to, in order:

1. **Bot algorithms + accuracy** — trading-backend alpha/sizing/regime work and
   walk-forward/OOS accuracy testing; build and validate up to (never through) the
   money-safety gates (`math_review_attested`, fund deposits, live flip = Ant-only).
2. **Framework/backend buildouts** — infrastructure and backend work needing no
   external credential.
3. **Certifications/validation** — promotion-gate hardening (DSR/PSR, PBO), test
   coverage, validation harnesses.

Claim through the normal flow (join + claim-next/claim). Park the human gates in
working-context `## Blockers`; surface to Ant as explicit asks (R8) only when he can
act on them.
