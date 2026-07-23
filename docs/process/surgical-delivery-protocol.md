# Surgical Delivery Protocol

Last updated: 2026-06-05 11:30 PDT

Purpose:
- lay specific canonical files onto a **busy or remote multi-session machine** without resetting it
- reconcile a diverged clone with origin without clobbering concurrent sessions' in-flight work
- make "deliver" and "reconcile" two deliberate steps, never one destructive `git reset`/`git pull`
- preserve the durable lessons from the #12 dispatch rollout and the #147 auto-sync recovery

This is the protocol for the kind of delivery done in #12 (laying the dispatch config onto <<MACHINE_1_ID>>)
and #147 (catching <<MACHINE_1_ID>>'s diverged clone back up to origin), both on a host running ~8 live
Claude sessions plus an auto-sync daemon, where a full pull/merge/reset would have destroyed work.

## Core rule

> On a busy host, never reset and never stash someone else's work. Assess in-memory first, deliver
> the smallest set of files from the canonical ref, then reconcile divergence as a separate, locked,
> deterministic step, and verify the result by direct observation, not assumption.

## When this protocol applies

Use it whenever you are writing git-tracked state onto a clone you do **not** have exclusive control of:
- a remote machine reached over SSH (e.g. <<MACHINE_1_ID>>/<<MACHINE_1_ID>>) that has live agent sessions
- any clone where the auto-sync daemon is running and committing `[auto-sync]` snapshots
- a clone that has diverged from origin and has **uncommitted local work** in the tree
- delivering a fix/config that must land without interrupting whatever is mid-flight

It is overkill for:
- your own single-session local clone where you hold all the work
- a clean clone (0 uncommitted, 0 divergence); there a normal pull is fine

## Phase 0: Assess before you touch anything

Never act on an assumption about a busy host's state. Establish ground truth first:

1. **Divergence count**: `git rev-list --left-right --count HEAD...origin/main` (ahead/behind).
2. **Uncommitted work**: `git status --short`. Treat every dirty file as *someone's in-flight work*
   until proven otherwise. A live session or the daemon owns it.
3. **Concurrent sessions**: count active sessions / stranded local commits before any destructive
   thought. (In #147, ~8 live sessions + 35 stranded commits is what ruled out `git reset --hard`.)
4. **In-memory conflict preview**: `git merge-tree --write-tree --name-only HEAD origin/main`
   computes the merge and lists conflicts **without touching the working tree**. This is how you
   decide whether a reconcile is clean or needs drivers, on a live host, with zero risk.
5. **Collision check for governed IDs**: before unioning task/lease state, confirm no ID was
   independently assigned on both sides (compare `lastAssigned` and the actual id sets).

If Phase 0 shows the host is busy, **a destructive op is off the table**; proceed by delivery, not reset.

## Phase 1: Deliver (path-scoped, non-destructive)

Lay only the canonical files you intend to deliver, from the canonical ref, leaving everything else
in the working tree untouched:

```sh
git fetch origin --quiet                 # refresh the ref; skip if fetch is blocked (see creds note)
git checkout origin/main -- <specific files>
```

- `git checkout <ref> -- <paths>` reads from the **already-cached** `origin/main`, so it works even
  when `git fetch` is failing on auth; you can deliver from a stale-but-valid ref.
- Name **specific paths**. Never `git checkout origin/main -- .` and never `git add -A`; that is how
  you swallow a concurrent session's edits.
- This is delivery, not reconciliation. Do **not** try to also catch the whole clone up here.

## Phase 2: Reconcile divergence (locked, deterministic, atomic)

Only after delivery, if the clone is behind and you must converge it:

1. **Hold the lock the whole time.** Wrap the entire reconcile in one `scripts/git-lock.sh run` so the
   auto-sync daemon cannot interleave a snapshot mid-merge.
2. **Persist live churn: never stash it.** Hot state files (e.g. `active-checkouts.json` lease state)
   are rewritten every few minutes by live sessions. A merge aborts ("local changes would be
   overwritten") if they're dirty. **Commit** them first (exactly what the daemon does), never
   `git stash` (a stash-pop after rebase conflicts in files you never touched; #099).
3. **Register deterministic merge drivers before merging.** For high-churn governed state, the
   `taskstate` (revision-wins, `scripts/merge-taskstate.py`) and `leasestate` (fenceCounter-wins,
   `scripts/merge-lease-state.sh`) drivers resolve conflicts without human intervention. They are
   self-registered by `scripts/openclaw-git-sync.sh`, but register them manually for an ad-hoc merge.
4. **Solve the bootstrap problem.** A merge that *delivers* a driver can't *use* that driver in the
   same merge: `.gitattributes` is read from the pre-merge tree. So **commit the driver + its
   `.gitattributes` mapping into the local HEAD first**, then merge.
5. **Merge, let drivers resolve, take canonical for text.** `git merge origin/main --no-edit`. For
   any remaining text conflict in forward-state docs (`working-context.md`,
   `task-naming-convention.md`), take origin (`git checkout --theirs`); origin is canonical forward
   state. Then **regenerate projections** from the merged canonical (`render-tier1-state.py write`)
   rather than hand-merging `OPEN_TASKS.md`/`task-queue.md`.
6. **Beat the live-churn race with one atomic loop, not round-trips.** If the host's lease file keeps
   going dirty between your separate SSH calls, the merge never starts. Put commit-dirty → merge →
   resolve → push in a **single locked script with an internal retry loop** (re-fetch each attempt).
   This eliminates the gap where churn re-dirties the tree. (#147 converged on loop attempt 1 once the
   per-call gap was removed.)
7. **Push via `close-push.sh`, never `pull --rebase`/`stash` on a rejected push.** If origin advanced,
   `close-push.sh` leaves the commit local+durable for the daemon; nothing is lost. Do not rebase
   across a shared tree.

## Phase 3: Verify by observation

Do not declare success from the fact that commands "ran". Confirm the end state directly
(see `feedback_verify_subagent_findings` / `feedback_no_bandaid_fixes`; keep signals honest):

- `git rev-list --left-right --count HEAD...origin/main` → expect `0  0`.
- For a daemon fix, force a fresh run and read the **exit code**, not the last scheduled status:
  `launchctl kickstart -k gui/$(id -u)/<label>` then check `launchctl list | grep <label>` (col 2 = last
  exit code; want `0`) and tail the daemon log for a "sync complete" line.
- Re-read the actual merged file content for the fields you cared about, on the target machine.

## Credentials on headless hosts

macOS `osxkeychain` is GUI-context-bound: **invisible to non-interactive SSH sessions and fragile for
launchd daemons** (symptom: `could not read Username for 'https://github.com': Device not configured`).
Use a file-based helper that works in both SSH and daemon contexts:

```sh
git config --global credential.helper store      # ~/.git-credentials, mode 0600
```

Move the token through the **encrypted SSH tunnel directly between credential helpers**; never print a
secret to the transcript/stdout, never paste it into a command line that gets logged.

## Anti-patterns (the things that lose work)

- `git reset --hard origin/main` on a busy host → destroys stranded commits AND live-session edits.
- `git pull --rebase` / `git stash` over a shared dirty tree → pop-conflicts in files you never touched (#099).
- `git add -A` / `git checkout origin/main -- .` → swallows concurrent sessions' uncommitted work.
- Separate SSH calls for commit-then-merge on a churning host → the lease file re-dirties in the gap.
- A merge that delivers a merge driver and expects it to apply in the same merge (bootstrap gap).
- Trusting `launchctl list` status alone for a daemon "fix" without a fresh kickstart + exit code.
- Declaring done from command exit, not from observed divergence/exit-code/file content.

## Decision summary

The default safe behavior on a busy/remote clone is:
- assess in-memory first (`merge-tree`, divergence, dirty files, live sessions)
- deliver with path-scoped `git checkout <ref> -- <files>`, never reset/pull
- reconcile under one lock: commit churn (don't stash), register drivers, bootstrap them into HEAD,
  merge, take-theirs for text, regenerate projections, push via `close-push.sh`
- collapse multi-step churning merges into one atomic retry loop, not SSH round-trips
- use file-based git creds on headless hosts; never print secrets
- verify the end state by direct observation before declaring success
