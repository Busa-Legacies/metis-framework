---
name: Checkpoint
slug: checkpoint
version: 1.0.0
description: "Bank a completed task mid-session — commit with intent, refresh forward state, keep working. Non-terminating; a strict subset of /end. Optional label: $ARGUMENTS"
---

This is a light, NON-TERMINATING close. It banks a finished task so the next step continues cleanly and the work is durable against context compaction or a crash.

**Commit-history contract:** the descriptive commit here IS the session record. `/end` rolls work up by reading `git log` (filtering `[auto-sync]` snapshots) — a good commit message at each checkpoint is what makes `/end` accurate.

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

## Step 1 — Decide working-context ops
Produce your deltas only (the op-based helper re-reads the live file under the lock — it can't clobber a concurrent session's threads):
- `--remove '<finished-KEY>'` for the task you just banked
- `--upsert '<KEY>::text'` for changed/new threads
- `--next '<1-line>'`
- `--upsert-blocker 'KEY::text'` / `--remove-blocker KEY` as needed

**Do NOT pass `--enforce-budget` here** — that's `/end`'s job. A checkpoint only adds/updates its own threads.

## Step 2 — Atomic op-apply + commit + push under the sync lock
```bash
scripts/git-lock.sh run sh -c "python3 scripts/working-context-update.py \
  --remove '<finished-KEY>' --next '<1-line>' \
  && git commit -m 'checkpoint: <desc>' -- <task-paths> Jay/memory/working-context.md \
  && scripts/close-push.sh"
```
Commit with **explicit pathspecs on `git commit` itself** (`git commit -- <paths>` auto-stages and commits ONLY those paths) — a separate `git add <paths> && git commit` commits the *entire index*, which sweeps in whatever another session or the daemon had pre-staged (this exact failure put 40 of a sibling's staged file-moves under an unrelated commit message on 2026-06-06). Never `git add -A`. Leave unrelated working-tree changes untouched. Note: `git commit -- <paths>` does not include brand-new untracked files — `git add <new-file>` those first; they ride along only if also named in the commit pathspec.

**Never `git pull --rebase`/`git stash` on a rejected push (#099)** — `close-push.sh` leaves the commit local+durable for the auto-sync daemon. Nothing is lost.

After a successful push, update the checkpoint SHA marker:
```bash
git -C ~/metis-os rev-parse HEAD > ~/.claude/last-checkpoint-sha
```

**If auto-sync already captured the task files** (clean working tree for those paths): stage only `working-context.md` but still write a full commit message body describing the work. The roll-up reads message bodies, not file diffs — skip the body and the work silently drops from `/end`.

## Step 3 — Memory (usually skip)
Only write a `ClaudeCode/memory/` file if a durable, cross-session, non-obvious lesson surfaced.

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
