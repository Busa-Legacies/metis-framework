---
name: Checkpoint
slug: checkpoint
version: 1.0.0
description: "Bank a completed task mid-session — commit with intent, refresh forward state, keep working. Non-terminating; a strict subset of /end."
argument-hint: "[label (optional)]"
---

This is a light, NON-TERMINATING close. Its job is **banking a finished task** — commit verified work with intent so the next step continues cleanly and the meaningful commit lands ahead of the auto-sync timer.

**Surviving context compaction is NOT this skill's job** — that floor is automatic and hook-backed, so a compaction (or crash) between checkpoints never loses your place. On every compaction the `SessionStart` hook (matcher `compact`, `claude-post-compact.sh`) re-injects the authoritative forward-state into the resumed window: `working-context.md` (shared board) **plus this session's last few sign-offs from the Stop-hook ledger** (its freshest Done/Next/Asks). (It emits plain stdout, not a JSON envelope — `PreCompact`/`PostCompact` events exist but do NOT accept context injection, so the envelope path is a dead end.) You do not need to `/checkpoint` "to save context" before a compaction. What `/checkpoint` *does* contribute here is **freshness of the shared board** — Steps 1 & 1.5 refresh `working-context.md` threads + promote the ledger to the digest, so the state the hook re-injects reflects real progress rather than a stale snapshot.

**Commit-history contract:** the descriptive commit here IS the session record. `/end` rolls work up by reading `git log` (filtering `[auto-sync]` snapshots) — a good commit message at each checkpoint is what makes `/end` accurate.

**Cadence (#524):** bank at every milestone — don't wait for `/end`. Refreshing the board at high context (~70%) is good hygiene (it improves what the compaction hook re-injects), but it is *hygiene, not a safety net* — the hook is the net. If the same error-class recurs **>5×**, stop retrying and root-cause it; marathon sessions otherwise pile up dozens of errors with no circuit-breaker.

## Step 0 — Verify the task is complete
```bash
bash scripts/task-verify.sh "<current-task-label>"
```
- Exit 0 (PASS) → proceed.
- Exit 1 (FAIL) → STOP. Surface the failure to Ant. Do not commit until fixed.
- Exit 2 (manual) → the script prints the "Done when:" criterion. Confirm with Ant, then re-run with `VERIFY_SKIP=1 bash scripts/task-verify.sh ...` to acknowledge and proceed.
- No task-queue.md entry (ad-hoc work) → skip this step; note it in the commit message.

## Step 0.5 — Runtime verification gate
Before committing, ask: does the work have a runtime surface reachable right now?

- **Reachable** (server startable, CLI runnable, UI drivable) → exercise the changed code path, capture evidence (pane output, response body, screenshot), and cite it in the checkpoint commit message body. This is MY job — never write "smoke test X" as a next action when the tools are available.
- **No surface** (docs-only, types-only, build config with no behavioral diff) → skip; note "no runtime surface" in the commit message.
- **Genuine blocker** (requires other hardware, Ant's credentials, destructive live target, network-gated service) → skip; **name the blocker explicitly** in the checkpoint output — a bare "couldn't test" is not acceptable.

**UI-fix freshness gate (#520 — the one Ant keeps catching):** a visual/layout change may be
reported done ONLY with a render captured *after* the edit (screenshot mtime **>** the changed
file's mtime) **at the viewport the bug was reported at** (phone width ~390 when Ant flagged it on
mobile; else the reported width). A plan-phase mock, a pre-change screenshot, a render at the
wrong viewport, or "evidence" that itself still shows the broken state does **NOT** pass — that's a
fail, not a done. The `Verified:` line must name the viewport and that the shot post-dates the edit.
Live app token-gated? That's a *genuine blocker* — say so; a faithful post-change mock at the
reported width is the fallback, never a stale/pre-change image. Full runbook: `/qa-ui` +
`reference_metis_command_ui_verify` memory.

## Step 0.6 — Credential-touch check (#767)
Before committing, sweep the local working set for credential exposure:
```bash
bash scripts/security-review.sh --nudge
```
- Exit 0 (silent) → no credential signal; proceed.
- Exit 2 → this session touched credentials. Run the full **`/security-review`** and act on its
  verdict *before* committing. A **FAIL** is a hard stop — remove/rotate/scrub per its recovery
  block; do not checkpoint a secret onto a branch (the autosync daemon will push it). WARN → eyeball
  the listed files; PASS → proceed. Cheap (~1s); nudge-only, never silently skip on exit 2.

## Step 1 — Decide working-context ops
Produce your deltas only (the op-based helper re-reads the live file under the lock — it can't clobber a concurrent session's threads):
- `--remove '<finished-KEY>'` for the task you just banked
- `--upsert '<KEY>::text'` for changed/new threads
- `--next '<1-line>'`
- `--upsert-blocker 'KEY::text'` / `--remove-blocker KEY` as needed

**Do NOT pass `--enforce-budget` here** — that's `/end`'s job. A checkpoint only adds/updates its own threads.

## Step 1.5 — Reconcile the progress ledger → board (never-lose)
The Stop hook (`hook-progress-ledger.sh`) has already banked every turn's sign-off to
`~/.openclaw/session-ledgers/<session>.jsonl` as work happened. Promote that into durable,
git-backed state so nothing dies if this session later closes uncleanly:
```bash
python3 scripts/ledger-reconcile.py     # defaults to the current (most-recent) session's ledger
```
It appends new turns to `workspace/state/session-digests/<session>.md` (the running decision/idea/
next-step log) and sets each named **active** task's `nextAction` to its latest ledger `Next:`
(governed, idempotent). It prints any **untracked Next: candidates** — glance at them; if one is
real new work, mint it via the create-task mutator (deduped) rather than letting it live only in
chat (feedback_log_suggestions_always). Include the digest file in the Step 2 commit pathspec.

## Step 2 — Atomic op-apply + commit + push under the sync lock
```bash
scripts/git-lock.sh run sh -c "python3 scripts/working-context-update.py \
  --remove '<finished-KEY>' --next '<1-line>' \
  && git commit -m 'checkpoint: <desc>' -- <task-paths> workspace/memory/working-context.md \
  && scripts/close-push.sh"
```
Commit with **explicit pathspecs on `git commit` itself** (`git commit -- <paths>` auto-stages and commits ONLY those paths) — a separate `git add <paths> && git commit` commits the *entire index*, which sweeps in whatever another session or the daemon had pre-staged (this exact failure put 40 of a sibling's staged file-moves under an unrelated commit message on 2026-06-06). Never `git add -A`. Leave unrelated working-tree changes untouched. Note: `git commit -- <paths>` does not include brand-new untracked files — `git add <new-file>` those first; they ride along only if also named in the commit pathspec.

**Never `git pull --rebase`/`git stash` on a rejected push (#099)** — `close-push.sh` leaves the commit local+durable for the auto-sync daemon. Nothing is lost.

After a successful push, update the checkpoint SHA marker:
```bash
git -C ~/metis-os rev-parse HEAD > ~/.claude/last-checkpoint-sha
```

## Step 2b — Writing freshness (only if you touched writing)
If this checkpoint banked a writing edit (a `projects/writing/` draft or an external writing clone), run the sweep so the Studio keeps showing the up-to-date version + an accurate status:
```bash
bash scripts/writing-freshness-check.sh --force
```
Surface any `WARN(writing):` lines and resolve the easy ones inline: stamp a `status:` on a statusless draft (`scripts/writing-status.py <slug> <status>`) or note a stale external clone. Advisory — don't block the checkpoint over it. (Runs the shallow clone check; `/end` runs `--deep` with a fetch.)

**If auto-sync already captured the task files** (clean working tree for those paths): stage only `working-context.md` but still write a full commit message body describing the work. The roll-up reads message bodies, not file diffs — skip the body and the work silently drops from `/end`.

## Step 2c — Project presence refresh (only if working in a project)
If this session joined a project (`agent-work.py join <slug>`), keep the sibling roster honest at each checkpoint — refresh your advisory presence with what you just banked and what's next, then re-render the per-project live-status projection:
```bash
python3 scripts/agent-work.py join <slug> --current-task '<#id>' --current-step '<just-banked / next step>'
python3 scripts/project-workspace.py render-projection
```
Re-joining upserts your presence record (it's a roster, not a lock); `render-projection` rewrites `docs/process/state/project-live-status.json` + `docs/process/project-live-status.md` idempotently so any sibling — Claude, Codex, or a lane — sees your live state. Skip entirely for non-project (`--flat`/ad-hoc) work. Advisory; don't block the checkpoint over it.

## Step 2d — Progress event (only for a meaningful project slice)
Discord is the comms surface where progress shows up as events (`docs/process/discord-comms-architecture.md`). Task-finish and milestone-completion already emit automatically — so **only** emit here when this checkpoint banked a *substantive, project-scoped* slice that a reader of the project channel would want to see (a shipped sub-feature, a working integration, a landed refactor), NOT a routine mid-task save. When in doubt, skip — an empty channel is honest; a noisy one isn't.
```bash
python3 scripts/metis-progress.py emit <project-slug> "checkpoint: <what landed>"
```
`<project-slug>` is a tasks.json project (collapses to the coarse project channel + a #status pulse). Best-effort; never block the checkpoint over it.

## Step 3 — Memory (usually skip)
Only write a `ClaudeCode/memory/` file if a durable, cross-session, non-obvious lesson surfaced.

## Step 3.5 — Desktop-control hygiene restore (#654)
If this session drove <<MACHINE_1_ID>>'s GUI this cycle, close what it opened so the desktop doesn't
accrete stray windows across a long session:
```bash
python3 scripts/computer_use/desktop_hygiene.py restore   # on <<MACHINE_1_ID>>; no-op if nothing was opened
```
Never touches pre-existing / dirty / PROTECTED-DENIED surfaces. Use `desktop_hygiene.py clear` if
the windows are intentionally left for Ant. Skip if the session never touched desktop control.
Standard: `docs/process/desktop-control-hygiene.md`.

## Step 4 — Pivot check
```bash
python3 scripts/task-domain.py "<current-task-label>"
python3 scripts/task-domain.py "<next-task-label>"
```
- Domains **match** → continue here; rename the session (`/rename <slug>`) and proceed.
- Domains **differ** → surface: `↪ pivot? next task is "<label>" (<domain>) — different domain. Continue here (c) or open new session (p)?`
- Ant confirms pivot → run `scripts/session-pivot.sh "<next-task-label>"`, then escalate to full `/end`. Do NOT continue working in this session after a confirmed pivot.

## Step 5 — Confirm and surface the next move
At minimum:
- `✓ checkpoint: <area> › <label> (<short-sha>) — banked` (or `→ pivoting`)
- `→ next: <single highest-value next action>` from `## Next action` + open threads just refreshed
- If anything needs Ant to verify or decide: add a `Check:` (direct question with an easy y/n answer) / `Asks:` line — don't bury it. `Verified:` is for evidence you already ran, never a chore for Ant.

Do NOT run any `/end` terminal ceremony during a normal (non-pivot) checkpoint: no Scribe daily-log, no self-review, no task-queue sweep.

**When to run:** the instant you finish a discrete task — committing promptly keeps the meaningful commit ahead of the auto-sync timer. Skip for trivial one-line edits.
