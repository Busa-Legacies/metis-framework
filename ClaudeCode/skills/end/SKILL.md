---
name: End Session
slug: end
version: 1.0.0
description: "Run the full session close protocol — commit, push, update state, compose daily log, sweep tasks, send handoff, integrity check. Session name: $ARGUMENTS"
---

**Steps 1–3 are the minimum viable close** — do them first in case rate limits hit mid-protocol.

## Step 0 — Reap orphaned background tasks
```bash
scripts/reap-bg-tasks.sh --kill --quiet
```

## Step 0a — Concurrency check (acquire close lock)
```bash
scripts/close-lock.sh acquire
```
- **Exit 0 (acquired):** proceed with FULL close; run `scripts/close-lock.sh release` after step 12.
- **Exit 1 (another close in progress):** do a **SCOPED close** instead — steps 1–2 (commit + push your own work) + step 10 as a **new uniquely-named memory file only** (never rewrite MEMORY.md's existing lines; append your single index line last). SKIP steps 3–4 and 6 (working-context + daily-log rewrites) — the holding session owns those. Do not release a lock you didn't acquire.

## Step 1 — Commit uncommitted work
Commit with explicit pathspecs on `git commit` itself (never `git add -A`), under the sync lock:
```bash
scripts/git-lock.sh run sh -c "git commit -m '<desc>' -- <specific-paths> && scripts/close-push.sh"
```
`git commit -- <paths>` auto-stages and commits ONLY those paths; a separate `git add && git commit` commits the *entire index*, sweeping in whatever another session or the daemon pre-staged. Brand-new untracked files still need `git add <new-file>` first AND must be named in the commit pathspec. Don't leave work in the tree.

## Step 2 — Push to GitHub
`scripts/close-push.sh` (called above) handles the push. **Never `git pull --rebase`/`git stash` on a rejected push (#099)** — `close-push.sh` leaves the commit local+durable; the auto-sync daemon will merge and push it. Never stash or `git add -A` another session's tree.

## Step 3 — Audit open threads → produce ops list
Read current `## Open threads` in `workspace/memory/working-context.md`. For each item decide:
- **Done** → `--remove KEY` op
- **Still active/changed** → `--upsert 'KEY::new text'` op
- **Unchanged** → leave it (no op)

Never produce a full-file rewrite — the #124 model is ops-only so concurrent sessions' threads are preserved.

## Step 4 — Apply working-context ops under sync lock
```bash
scripts/git-lock.sh run python3 scripts/working-context-update.py \
  --focus '<1-line active focus>' \
  --next '<1-line next action>' \
  --remove '<done-KEY>' \
  --upsert '<KEY>::<changed thread text>' \
  --enforce-budget
```
Thread KEY is the `[...]` label. If exit 2 (over budget without dropping a concurrent session's thread): STOP, surface it, resolve by `--remove`-ing genuinely-done threads. Add/clear blockers with `--upsert-blocker 'KEY::text'` / `--remove-blocker KEY`. Preview with `--show`.

**Format contract (enforce strictly):**
- Max 35 lines total
- Allowed sections: `## Active focus` (1 line) · `## Open threads` (bullets) · `## Blockers` (bullets) · `## Next action` (1 line)
- **No session narrative** — no "Session A/B/C did X". That belongs in the Scribe daily log.
- **No completed work** — if it's done, it's gone. Only forward-looking state.
- Deploy commands and keys are allowed inline if still pending; remove when resolved.

## Step 5 — Reflect & extract
Three outputs:
- **Lessons learned** → route via `docs/process/correction-protocol.md`: if the lesson should change *behavior* → delta-edit the governing skill/CLAUDE.md and make the memory entry a ≤3-line breadcrumb. Durable non-behavioral lessons → `feedback_*` memory file (step 10); session-specific → Scribe summary (step 6)
- **Suggested next steps** → highest-priority one → `## Next action`; rest → `task-queue.md` entries with Why/Plan/Main files per [task-writing-protocol.md](../../docs/process/task-writing-protocol.md)
- **New to-dos** → `task-queue.md` + (if board-worthy) `workspace/state/OPEN_TASKS.md`: `- [P2] [ ] **#NNN slug** — note @agent:smith @machine:antfox`

Also: **backstop sweep for bugs fixed before committing** — these leave no git trace and the roll-up can't surface them. Recall by hand and route: reusable gotcha → `feedback_*`; design-level → DR; one-off → commit/Scribe log; trivial → nothing.

## Step 5b — Pre-close suggestions
Surface 2–3 concrete improvement ideas (friction points, missing automation). Present briefly and **pause** — ask Ant if any are worth acting on before continuing. If yes, handle inline; if no, log actionable ones to `task-queue.md`.

## Step 6 — Daily log
See `daily-log-protocol.md` in this skill directory for the full Scribe compose + CC write + boundary advance procedure.

Short form: roll up git commits → route Scribe to compose → CC writes file → run boundary advance script → assert file exists with today's date.

## Step 7 — Task dedup gate
Hard gate: never log a followup already owned or finished. Run `python3 scripts/free-work.py` and skim `task-queue.md` + `OPEN_TASKS.md`. For each next-step from step 5, write it ONLY if not already: (a) CLAIMED/WIP under an active lease, (b) an existing queued entry, or (c) completed per the step-6 git roll-up. Skip any match and state why. Prune completed entries from `task-queue.md`. Update `docs/process/live-status.md` if state changed. Each new entry must include: `Priority:` P1/P2/P3 · `Agent:` smith/scout/warden/scribe/claude · `Machine:` antfox/jarry/either · `Status:` queued/blocked/in-progress

## Step 8 — Cross-agent handoff
```bash
scripts/send-handoff.sh '{"done":[...],"next":[...],"blockers":[...],"summary":"..."}'
```
Fill `done`/`next`/`blockers` with **real content** — `[...]` is not acceptable. Script exits 0 even when <<MACHINE_1_ID>> is unreachable — **always run this step**.

## Step 9 — Rename the session
Run `/rename <short-descriptive-name>` matching the primary work done.

## Step 10 — Save to Claude Code memory
*(Skip only if nothing durable and non-obvious surfaced.)*

**Ownership:** Claude Code owns `ClaudeCode/memory/` writes, inline. Scribe owns only `workspace/memory/`, `working-context.md`, and daily logs — no overlap.

Write to `ClaudeCode/memory/` using the frontmatter standard in `~/.claude/CLAUDE.md`. Filter test: **durable + cross-session + non-obvious + not already in code/git/commit message**. Update/extend an existing file rather than creating a near-duplicate. Refresh its `MEMORY.md` line.

**Prune sweep (run each /end):** Scan MEMORY.md for ~5 entries that are `#resolved`, superseded, or stale. For each candidate:
- Delete the memory file if the fact is already captured in code, docs, or commit history.
- Merge into a related file if it's a near-duplicate.
- Retag `active→resolved` if the project shipped or the lesson no longer applies.
Remove the corresponding line from MEMORY.md after each deletion/merge. This keeps the index under its 200-line contract via continuous pruning, not crisis cleanup.

## Step 11 — Integrity check
```bash
bash scripts/close-integrity-check.sh
```
Fix any FAILs before declaring close complete. Also verify `~/.claude/projects/<cwd>/memory` is still a **symlink** (not a real dir). If hook symlinks are missing: `bash scripts/bootstrap-claude-memory.sh`.

## Step 12 — Release close lock
Only if you acquired it in step 0a:
```bash
scripts/close-lock.sh release
```

## Step 13 — Session sign-off
Close the turn with the final-output block per [session-output-standard.md](../../docs/process/session-output-standard.md): `**<area> › <#id slug>** — <status>` header, then `Done` / `Verify` / `Next` / `Asks`. This is the last thing Ant reads — it must carry project + task context so the hand-back is self-explanatory.

## Run-all gate
Run all steps 6–11 whenever: files were edited, OR tasks were discussed, OR the session was 3+ turns. Skip only when ALL three are false. Step 10 may additionally be skipped if nothing durable and non-obvious surfaced.
