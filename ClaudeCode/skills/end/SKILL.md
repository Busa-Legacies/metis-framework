---
name: End Session
slug: end
version: 1.0.0
description: "Run the full session close protocol — commit, push, update state, compose daily log, sweep tasks, send handoff, integrity check."
argument-hint: "[session name]"
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

## Step 0b — Credential-touch check (#767)
Before committing, sweep the local working set for credential exposure:
```bash
bash scripts/security-review.sh --nudge
```
Exit 2 → the session touched credentials: run the full **`/security-review`** and act on its verdict
*before* committing/pushing. FAIL is a hard stop (remove/rotate/scrub per its recovery block — never
push a secret); WARN → eyeball the listed files; PASS/exit 0 → proceed. Cheap; never skip on exit 2.

## Step 0c — Desktop-control hygiene restore (#654)
If this session drove <<MACHINE_1_ID>>'s GUI (desktop control / vision loop / `desktop_action`), return the
desktop to its pre-session state so Ant doesn't come back to stray windows:
```bash
python3 scripts/computer_use/desktop_hygiene.py restore   # on <<MACHINE_1_ID>>, where the desktop lives
```
No-op (`no_snapshot`) if the session opened nothing — safe to always run. Quits session-opened
apps + closes session-opened windows; never touches pre-existing, dirty (unsaved), or PROTECTED/
DENIED surfaces. Report the result line (`quit` / `closed_windows` / `skipped_dirty`). If the open
windows were *intentional* for Ant, run `desktop_hygiene.py clear` instead. Remote (Air/<<MACHINE_2_ID>>)
session that couldn't restore <<MACHINE_1_ID>> remotely → leave it; <<MACHINE_1_ID>>'s next `/start` sweeps it.
Standard: `docs/process/desktop-control-hygiene.md`.

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
Thread KEY is the `[...]` label. If exit 2 (over budget without dropping a concurrent session's thread): STOP, surface it, resolve by `--remove`-ing genuinely-done threads. Add/clear blockers with `--upsert-blocker 'KEY::text'` / `--remove-blocker KEY` (KEY = the blocker's `#id`, else its first 24 chars; a `--remove`/`--remove-blocker` that matches nothing also exits 2, so fix the key, never ignore it). `--upsert` refuses (exit 2) a thread another session owns: that session updates it; `--take-over` only when deliberately adopting an abandoned thread. Preview with `--show`.

**Format contract (enforce strictly):**
- Max 35 lines total
- Allowed sections: `## Active focus` (1 line) · `## Open threads` (bullets) · `## Blockers` (bullets) · `## Next action` (1 line)
- **No session narrative** — no "Session A/B/C did X". That belongs in the Scribe daily log.
- **No completed work** — if it's done, it's gone. Only forward-looking state.
- Deploy commands and keys are allowed inline if still pending; remove when resolved.

## Step 4.5 — Reconcile progress ledgers → durable digest (never-lose)
Every turn's sign-off was banked live by `hook-progress-ledger.sh` to
`~/.openclaw/session-ledgers/`. Promote it — and sweep any **orphaned** ledgers from
sessions that died without closing (the exact loss Ant flagged 2026-07-27):
```bash
python3 scripts/ledger-reconcile.py --all-orphans
```
It updates `workspace/state/session-digests/<session>.md` for each session with un-promoted turns
and syncs each named active task's `nextAction`. Its printed **untracked Next: candidates** feed
Step 5/7 below (mint the real ones, deduped) — this is the source, alongside the git roll-up, that
makes reflection complete. Commit the digests (they ride the Step 1/2 commit or auto-sync).

## Step 5 — Reflect & extract
Three outputs (read this session's `workspace/state/session-digests/<session>.md` as the running
record of decisions/ideas/next-steps, alongside the git roll-up — nothing that hit a sign-off is lost):
- **Lessons learned** → route via `docs/process/correction-protocol.md`: if the lesson should change *behavior* → delta-edit the governing skill/CLAUDE.md and make the memory entry a ≤3-line breadcrumb. Durable non-behavioral lessons → `feedback_*` memory file (step 10); session-specific → Scribe summary (step 6)
- **Suggested next steps / new to-dos** → mint each as a **governed task** via the mutator — never hand-edit `task-queue.md` or `workspace/state/OPEN_TASKS.md` (both are projections that `scripts/render-tier1-state.py` regenerates from `tasks.json`; #350 auto-render overwrites hand edits). `python3 scripts/update-tier1-state.py create-task --actor claude --patch '{...}'` (run `update-tier1-state.py schema` for the required-field contract; carry Why/How per [task-writing-protocol.md](../../docs/process/task-writing-protocol.md)). The highest-priority one also lands in `## Next action`. Dedup first — see Step 7.

Also: **backstop sweep for bugs fixed before committing** — these leave no git trace and the roll-up can't surface them. Recall by hand and route: reusable gotcha → `feedback_*`; design-level → DR; one-off → commit/Scribe log; trivial → nothing.

Also: **comprehension-debt check** (`loop-engineering-review.md` #1) — if this session merged loop/lane/subagent-generated code that shipped without a human reading it end-to-end, that gap is real debt. Name it and route a read-through task (`task-queue.md`) rather than letting the delta between what exists and what we understand compound. Stay the engineer, not just the one who pressed go.

## Step 5b — Pre-close suggestions
Note 2–3 concrete improvement ideas (friction points, missing automation) that surfaced this session. **Don't pause the close to pitch them** — a mid-protocol stop-and-ask contradicts stop discipline (a turn ends only for input-needed / banked / blocked). Mint the actionable ones as governed tasks (create-task, per Step 5, deduped in Step 7); the close continues without interruption.

## Step 5c — Spec reconcile (durable intended-state)
*(Skip if no `planRef`-linked task reached `done` this session, or there's no spec for its area yet.)*
For each task that reached **done** this session and carries a `planRef`, check whether the change moved the **intended end-state** of its area. If so, **reconcile** `docs/specs/<area>.md` — rewrite the affected lines to current truth (spec = "is"), bump `updated`, add the task to `sources`. Don't append a changelog; the spec stays ≤80 lines. If no spec exists for that area yet, only create one when the subsystem is load-bearing and worth the upkeep (see `docs/specs/README.md`). This is the Tier-1 manual reconcile from `PLAN-spec-base.md` §3.

## Step 5d — Writing freshness sweep
*(Only if this session touched writing — edited a `projects/writing/` draft or an external writing clone. Skip otherwise.)*
The Writing Studio reads drafts + the portfolio/dataviz sources **live from disk**, so a session that edits writing must leave the most up-to-date version + an accurate status showing (Ant's rule, 2026-07-10). Run:
```bash
bash scripts/writing-freshness-check.sh --force --deep
```
Surface any `WARN(writing):` lines in the sign-off — advisory, not a hard gate. Resolve what you can: commit uncommitted draft edits (durable against auto-sync reset), stamp a `status:` on any statusless draft (`scripts/writing-status.py <slug> <status>`), and refresh any external clone that's behind origin (`git -C <clone> reset --hard origin/<branch>`, preserving local wip on a branch first) so the Studio stops rendering stale *published* content.

## Step 5e — Cross-fleet infra propagation
*(Only if this session fixed or hardened infrastructure. Skip otherwise.)*
Before sign-off, classify each infra fix by propagation class and route it so it does not
strand on this machine (`docs/process/cross-fleet-infra-learning.md`): **fleet-wide** → declare
into `fleet-manifest.txt` / the machine's `launchAgents` roster / `mirror-manifest.json`;
**machine-aware-auto** → ensure the shared script self-adapts per host (git-sync carries it);
**needs-eval-per-machine** → `python3 scripts/fleet-lesson.py --propagation needs-eval-per-machine --summary "..." --detail "why + what changed"` to fan it to the other nodes (each self-triages); **local-only** → capture the why in memory. Surface what you routed in the sign-off.

## Step 6 — Daily log
See `daily-log-protocol.md` in this skill directory for the full Scribe compose + CC write + boundary advance procedure.

Short form: roll up git commits → route Scribe to compose → CC writes file → run boundary advance script → assert file exists with today's date.

**Group the sibling-session rollup by theme, not a raw dump (#699).** Sibling-session commits are often the majority of the week's real activity — group them by task id / theme with 2-3 sentence prose bullets *above* the raw `git log` list, so the daily log stays a readable record of what happened rather than an unparseable commit dump.

## Step 7 — Task dedup gate
Hard gate: never log a followup already owned or finished. Run `python3 scripts/free-work.py`. For each next-step from Step 5, mint it ONLY if not already: (a) CLAIMED/WIP under an active lease, (b) an existing `queued` task in `tasks.json`, or (c) completed per the step-6 git roll-up. Skip any match and state why. Mint via the **create-task mutator** (never hand-edit `task-queue.md`/`OPEN_TASKS.md` — they re-render from `tasks.json`); `update-tier1-state.py schema` prints the required-field contract (`taskId, title, priority, state, owner, summary, why, how, project`). Update `docs/process/live-status.md` only if a multi-session workstream changed.

## Step 7b — Leave the project + refresh the projection (only if you joined one)
If this session joined a project (`agent-work.py join <slug>`), drop your presence and re-render the per-project live-status so siblings stop seeing you as live:
```bash
python3 scripts/agent-work.py leave <slug>
python3 scripts/project-workspace.py render-projection
```
`leave` removes your presence record (any live task lease is finished separately via the mutator / `unclaim` in Phase 4 of the pickup standard); `render-projection` rewrites `docs/process/state/project-live-status.json` + `docs/process/project-live-status.md` idempotently so the departure shows. Skip for non-project (`--flat`/ad-hoc) sessions.

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

**Draft-then-keep (curation assist — don't rely on recall):** before deciding what to write, *draft* the candidates first — scan THIS session and list the durable lessons as short candidate entries (draft inline, or have the `echo` lane draft them from the session). Then apply the filter test to each and keep only those that pass. Drafting first closes the "forgot to write the memory at /end" gap; the filter test + the `correction-protocol.md` graduation table are still the gate — a *behavioral* lesson graduates to a skill/CLAUDE.md (with a ≤3-line breadcrumb), never a standalone memory file. **Auto-*draft*, human-*approve*; never auto-store.**

**Index maintenance (run each /end):** first run `scripts/git-lock.sh run python3 ClaudeCode/scripts/memory-maintain.py --apply --commit`. The `--commit` flag (#4716) commits the rewritten `MEMORY.md` + `MEMORY-archive.md` AND any untracked node files `--apply` staged, together, with an explicit pathspec — so the #4608 close-gate can never fire on a strand `--apply` itself created (prevent, not just catch); the `git-lock.sh` wrapper serializes it against the auto-sync daemon. It deterministically byte-budgets the HOT index (importance-weighted, recency-decayed) and moves the overflow to the recall-reachable COLD catalog, so the whole-file load never breaches its cap — this is event-driven headroom on top of the daily `ant.memory-maintain` job (a busy session can add more than the daily run's margin, so trimming at close keeps it safe). The maintainer rebalances hot/cold but never deletes or merges, so ALSO scan for ~5 genuinely DEAD entries and:
- Delete the memory file if the fact is already captured in code, docs, or commit history.
- Merge into a related file if it's a near-duplicate.
- Retag `active→resolved` if the project shipped or the lesson no longer applies.
Remove the corresponding line from MEMORY.md after each deletion/merge; the maintainer keeps everything else under cap automatically (continuous maintenance, not crisis cleanup).

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

## Step 12.5 — Mark this session finished (terminal-app archive)
Tell the terminal surfaces this session ran its close protocol, so it shows **archived/finished**
instead of lingering as an idle tmux shell in the Metis Command Terminal room + the native MetisTerm app:
```bash
python3 scripts/session-finished-mark.py --reason ended
```
Appends one row to `docs/process/state/session-finished.jsonl` (git-synced, union-merged); the fleet
publisher stamps the matching session `status: finished` (revive-guarded — a reused tmux name with a
fresh session is NOT marked). Clean no-op outside tmux. Run it LAST among the command steps (after the
lock release) so the marker sits at the true session end. The row rides the Step 1/2 commit or auto-sync.

## Step 13 — Session sign-off (project-organized close brief, Ant 2026-08-22)
Keep the required header — `**<area> › <#id slug>** — <done|banked|blocked|in-progress>` (hook-enforced) —
but the `/end` close body is NOT the per-turn Done/Verified/Check (every turn already banked that; repeating
it by close is noise). Instead write a **brief, organized progress update grouped by project/milestone**, so
Ant can see effort-per-assigned-project and the in-/out-of-scope tangents at a glance:

```
**session › /end close** — <status>

## Projects / milestones worked
- **<Project or milestone>** — <rough effort: light/moderate/heavy> — <1-line of what moved>
  (one bullet per project touched; effort is the point — it exposes where the session actually went)

## Tasks this session
- In-scope (assigned/requested): <task named + (#id)> — <done|handed-off|blocked>
- Out-of-scope / tangents: <bug-fix, incident, overlap> — <what forced it + outcome>
  (name tangents explicitly — unplanned bug-fixing / incidents / rabbit-holes are the effort leak Ant wants visible)

## Follow-ups (next session)
- <named task (#id)> — <the one next action> ; note any handoffs/owners
```

Rules: every task NAMED with `(#id)` (never bare #NNN); effort labels are rough, not precise; a tangent that
ate real time gets its own line even if tiny in output. This is the last thing Ant reads — it must let him
reconstruct *where the session's effort went, per project,* not just what shipped.

## Run-all gate
Run all steps 6–11 whenever: files were edited, OR tasks were discussed, OR the session was 3+ turns. Skip only when ALL three are false. Step 10 may additionally be skipped if nothing durable and non-obvious surfaced.
