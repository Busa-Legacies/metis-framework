#!/usr/bin/env bash
# Auto-sync Metis OS bidirectionally (commit+push local, pull remote).
#
# Safety contract:
#   - never commit/push from a non-main branch
#   - never commit a tree containing conflict markers
#   - never leave a conflicted/mid-merge tree behind for the next run to blindly
#     `git add -A && commit` (that pushed corruption to every machine 2026-05-30 — T-SYNC-04)
#   - never auto-commit a MASS DELETION from a partial/incomplete checkout. A sandbox
#     that only sees some of the tree (e.g. <<MACHINE_2_ID>>'s /workspace view) would make
#     `git add -A` stage deletions of every absent tracked file and push the wipe to
#     all machines. That wiped <<MACHINE_1_ID>>/{memory,state,lanes,.gitignore} on 2026-05-30 22:21
#     (commit 7b6511f) — see ClaudeCode/memory/project_git_autosync.md T-SYNC-05.
#
# Deploy: this is the canonical version. On each machine, copy into place:
#   cp scripts/openclaw-git-sync.sh ~/.local/bin/openclaw-git-sync.sh && chmod +x ~/.local/bin/openclaw-git-sync.sh

: "${METIS_HOME:=$HOME/metis-os}"
REPO="$METIS_HOME"
LOG="$HOME/.openclaw/logs/git-sync.log"
BRANCH="main"

# Abort an auto-commit if it would delete more than this many tracked files in one tick.
# A normal sync rarely deletes >a handful; a partial-tree wipe deletes dozens. Tune via env.
DELETE_LIMIT="${OPENCLAW_SYNC_DELETE_LIMIT:-5}"

# Paths that auto-sync must NEVER delete — if staging marks any of these deleted, it is a
# partial-tree fault, not an intentional removal. (Critical shared state + the guard config.)
PROTECTED=(
  "workspace/memory/working-context.md"
  "workspace/state/OPEN_TASKS.md"
  "workspace/.gitignore"
)

# --- #234 split-sync: source never auto-commits to main; state files still do ----
# STATE_PATHSPECS = the only paths auto-committed to `main` when OPENCLAW_SPLIT_LANES=1.
# Everything else is SOURCE, durably snapshotted to autosync/<machine> (see below) and
# left dirty in the working tree for a human to commit with intent (#311 close gate).
# Phased rollout: the autosync/<machine> source snapshot is ALWAYS-ON (additive, can't
# change `main`). OPENCLAW_SPLIT_LANES gates the actual `main` behavior flip and defaults
# to 0 (legacy blanket-add) so landing this script does NOT flip every machine on the next
# tick — flip to 1 deliberately once the durability branch is proven. Kill-switch = set 0.
OPENCLAW_SPLIT_LANES="${OPENCLAW_SPLIT_LANES:-0}"
STATE_PATHSPECS=(
  'docs/process/state'
  'docs/process/task-queue.md'
  'docs/process/live-status.md'
  'docs/process/projects.md'
  'docs/process/task-naming-convention.md'
  'docs/process/audits'
  'docs/process/lane-outputs'
  'docs/process/decisions'
  'docs/process/taxonomy.yaml'
  'workspace/state'
  'workspace/memory'
  'workspace/.gitignore'
  '<<MACHINE_2_ID>>/memory'
  'ClaudeCode/memory'
)
# Exclusion form of the allowlist (everything that is NOT state) — used to stage SOURCE
# into a scratch index for the autosync/<machine> snapshot. Kept in lockstep with the list.
SOURCE_EXCLUDES=( ':(exclude)workspace/lanes' )
for _sp in "${STATE_PATHSPECS[@]}"; do SOURCE_EXCLUDES+=( ":(exclude)$_sp" ); done

# Per-machine branch for the source durability snapshot. Override OPENCLAW_SYNC_MACHINE if
# detection is wrong; falls back to the unix username (always unique per machine).
SYNC_MACHINE="${OPENCLAW_SYNC_MACHINE:-}"
if [ -z "$SYNC_MACHINE" ]; then
  _sync_host=$(scutil --get LocalHostName 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  _sync_user=$(id -un 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  _sync_home=$(printf '%s' "${HOME:-}" | tr '[:upper:]' '[:lower:]')
  if printf '%s %s %s' "$_sync_host" "$_sync_user" "$_sync_home" | grep -q "abusa\|anthony"; then
    SYNC_MACHINE="abusa"
  elif printf '%s %s %s' "$_sync_host" "$_sync_user" "$_sync_home" | grep -q "antfox\|/users/ant"; then
    SYNC_MACHINE="antfox"
  else
    SYNC_MACHINE="${_sync_user:-unknown}"
  fi
fi
AUTOSYNC_BRANCH="autosync/$SYNC_MACHINE"

# Stage ONLY the state pathspecs that currently exist (working tree or tracked).
# Why: `git add -A -- <pathspec>` hard-errors (exit 128) the instant ANY positive
# pathspec matches nothing — and stages NOTHING when it does. Several STATE dirs
# legitimately don't exist on a given machine (<<MACHINE_2_ID>>/memory on <<MACHINE_1_ID>>, an as-yet-uncreated
# lane-outputs/audits dir). Without this filter one absent path would abort the whole
# add and silently drop real state changes off `main` (caught by the SPLIT-3 test). The
# exclude-form used for the source snapshot has no such trap, so it needs no filter.
git_add_state() {
  local p present=()
  for p in "${STATE_PATHSPECS[@]}"; do
    if [ -e "$p" ] || [ -n "$(git ls-files -- "$p" 2>/dev/null)" ]; then
      present+=( "$p" )
    fi
  done
  [ "${#present[@]}" -gt 0 ] && git add -A -- "${present[@]}"
  return 0
}

# --- self-redeploy: keep ~/.local/bin/ in sync with the canonical repo copy ------
# After a pull, the repo copy may be newer than the running deployed binary. Detect
# this BEFORE acquiring the lock (so re-exec is clean) and re-exec with the updated
# version. Prevents permanent drift between machines without manual redeploy steps.
DEPLOYED="$HOME/.local/bin/openclaw-git-sync.sh"
CANONICAL="$REPO/scripts/openclaw-git-sync.sh"
if [ -f "$CANONICAL" ] && [ -f "$DEPLOYED" ] && ! diff -q "$DEPLOYED" "$CANONICAL" > /dev/null 2>&1; then
  cp "$CANONICAL" "$DEPLOYED" && chmod +x "$DEPLOYED"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] self-redeploy: updated deployed binary from canonical; re-execing" >> "$LOG"
  exec "$DEPLOYED" "$@"
fi

LOCK_DIR="$HOME/.openclaw/locks"
LOCK="$LOCK_DIR/git-sync.lock.d"   # directory lock — portable; macOS ships no flock(1)
LOCK_TTL="${OPENCLAW_SYNC_LOCK_TTL:-120}"   # seconds; reclaim a pid-less lock older than this
mkdir -p "$LOCK_DIR"

# --- failure alerting (edge-triggered, one Discord ping per incident) ----------
# The whole point of this sync is keeping every machine on one HEAD. A silent run of
# failed ticks is exactly what let <<MACHINE_1_ID>> diverge 156/175 (T-SYNC-10) before anyone noticed.
# Alert the moment a tick fails — but only on the healthy->failing EDGE, tracked by a
# marker file, so a multi-tick outage pings Discord once, not every 5 minutes. A
# "recovered" ping after the next clean sync clears the marker.
FAIL_MARKER="$LOCK_DIR/git-sync.failing"

alert_discord() {
  # best-effort: a notify failure must never change the sync's own exit status
  python3 "$REPO/scripts/discord_notify.py" "$1" >/dev/null 2>&1 || true
}

on_fail_edge() {
  [ -f "$FAIL_MARKER" ] && return 0          # already alerted this incident — stay quiet
  date '+%Y-%m-%d %H:%M:%S' > "$FAIL_MARKER"
  alert_discord "🔴 git-sync FAILING on $(hostname -s) — $(tail -n1 "$LOG" 2>/dev/null). Repo may diverge; see $LOG"
}

# Atomic mkdir lock with stale-holder reclaim. Replaces the old flock(1) lock,
# which silently no-op'd on macOS (no flock binary under the LaunchAgent PATH) and
# made `! flock -n 9` true on every run — the sync skipped every tick (T-SYNC-06
# regression, 2026-05-31). `mkdir` is atomic on POSIX, so it is a correct mutex.
# Manual git surgery holds the SAME lock via scripts/git-lock.sh.
acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; return 0; fi
  local holder mtime now age
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$holder" ]; then
    kill -0 "$holder" 2>/dev/null && return 1   # live holder → genuinely locked
    rm -rf "$LOCK"                              # named but dead → stale, reclaim
  else
    # no pid yet: mid-creation race or a crashed acquire. Honor TTL before stealing.
    mtime=$(stat -f %m "$LOCK" 2>/dev/null || echo 0); now=$(date +%s); age=$(( now - mtime ))
    [ "$age" -lt "$LOCK_TTL" ] && return 1
    rm -rf "$LOCK"
  fi
  mkdir "$LOCK" 2>/dev/null && { echo $$ > "$LOCK/pid"; return 0; }
  return 1
}

if ! acquire_lock; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] lock held by another process — skip" >> "$LOG"
  exit 0
fi
# EXIT trap: clean the lock and, on a genuine failure (exit 1 from any guard/push
# path below), fire the edge-triggered alert. Benign skips (wrong branch, lock held,
# clean no-op) exit 0 -> no alert. INT/TERM (e.g. launchd shutdown) exit 130 -> no alert.
trap 'code=$?; rm -rf "$LOCK"; [ "$code" -eq 1 ] && on_fail_edge; exit $code' EXIT
trap 'rm -rf "$LOCK"; exit 130' INT TERM

cd "$REPO" || exit 1
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
log() { echo "[$TIMESTAMP] $1" >> "$LOG"; }

heal_index_lock() {
  local index_lock lock_owner
  index_lock=$(git rev-parse --git-path index.lock 2>/dev/null || true)
  [ -n "$index_lock" ] || return 0
  [ -f "$index_lock" ] || return 0

  lock_owner=$(lsof "$index_lock" 2>/dev/null | awk 'NR>1{print $2; exit}')
  if [ -n "$lock_owner" ]; then
    log "index.lock held by live pid $lock_owner at $index_lock — skip this cycle"
    return 1
  fi

  rm -f "$index_lock"
  log "removed stale index.lock at $index_lock before git operation"
  return 0
}

# --- self-register the lease-state merge driver (idempotent) -------------------
# active-checkouts.json is high-churn shared state; without a custom resolver, two
# machines bump fenceCounter/updatedAt concurrently and CONFLICT on every pull, and the
# abort-on-conflict policy then diverges the repo unboundedly (T-SYNC-07, 2026-06-04:
# <<MACHINE_1_ID>> hit 156-ahead/175-behind, dashboard stuck on stale code). .gitattributes maps the
# file to merge=leasestate; the driver COMMAND lives in per-repo git config (not
# version-controlled), so register it here so every machine running the daemon self-heals.
LEASE_DRIVER="$REPO/scripts/merge-lease-state.sh"
if [ -x "$LEASE_DRIVER" ]; then
  git config merge.leasestate.name "lease-state fenceCounter-wins merge" 2>/dev/null || true
  git config merge.leasestate.driver "$LEASE_DRIVER %O %A %B %P" 2>/dev/null || true
fi

# --- self-register the task-state merge driver (idempotent) -------------------
# tasks.json + task-counter.json are governed state both machines mutate every session;
# without a resolver they conflict on the same task objects / counter and stall the daemon
# (the #147 outage: <<MACHINE_1_ID>> sat 35-ahead/46-behind for hours). Maps to merge=taskstate in
# .gitattributes; resolves deterministically (union tasks by taskId keeping higher
# revision; counter = max lastAssigned) so an allocated id is never re-issued.
TASKSTATE_DRIVER="$REPO/scripts/merge-taskstate.py"
if [ -x "$TASKSTATE_DRIVER" ]; then
  git config merge.taskstate.name "governed task-state revision-wins merge" 2>/dev/null || true
  git config merge.taskstate.driver "python3 $TASKSTATE_DRIVER %O %A %B %P" 2>/dev/null || true
fi

# --- self-register: ignore dirty submodule content (idempotent) ----------------
# T-SYNC-15 (2026-06-13): workspace/lanes is an orphaned gitlink (committed submodule
# pointer, NO .gitmodules entry, no remote) holding ever-dirty lane working files.
# The daemon already EXCLUDES workspace/lanes from commits, but stash/pull still saw it as
# "modified content" → every post-pull `git stash pop` conflicted on the submodule and
# wedged the tick (.failing loop, ~10h outage). `submodule.<name>.ignore` is INEFFECTIVE
# without a .gitmodules entry (can't resolve name→path); `diff.ignoreSubmodules=dirty`
# is the reliable lever — ignores dirty submodule CONTENT but still tracks a real gitlink
# pointer change. Local config (not committed) so the daemon self-registers it per machine.
git config diff.ignoreSubmodules dirty 2>/dev/null || true

# --- self-enable rerere so the daemon can replay known conflict resolutions -----
# (#122) Without this, a RECURRING conflict on a high-churn shared file (the same
# hunk shape every tick) aborts the pull forever — exactly what stranded ~15 local
# commits on <<MACHINE_2_ID>> 2026-06-05 under churn from ~6 concurrent sessions. rerere records
# each resolution once and replays it automatically; autoupdate STAGES the replayed
# result so the merge has zero unmerged paths left and the daemon can complete it
# (see the rerere-assisted recovery in the pull-failure branch below) instead of
# discarding the work. Genuinely-novel conflicts have no recorded resolution → they
# still leave unmerged paths → fail-soft abort as before (no regression).
git config rerere.enabled true 2>/dev/null || true
git config rerere.autoupdate true 2>/dev/null || true

# --- guard 1: only ever sync 'main' (never force a feature branch onto main) ---
CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$CUR_BRANCH" != "$BRANCH" ]; then
  log "on '$CUR_BRANCH' not '$BRANCH' — skip"
  exit 0
fi

# --- guard 2: bail to a clean tree if a prior run left a merge/rebase open -----
if [ -f .git/MERGE_HEAD ] || [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  log "merge/rebase in progress from a prior run — aborting to clean tree, skip"
  git merge --abort >> "$LOG" 2>&1 || git rebase --abort >> "$LOG" 2>&1 || true
  exit 1
fi

# --- guard 3: refuse to touch a tree that already contains conflict markers ----
# Require BOTH the opening `<<<<<<< ` and closing `>>>>>>> ` markers to be present
# before treating the tree as conflicted. A bare `=======` line is also a legit
# markdown setext-heading underline / horizontal separator, so matching it alone
# (the old pattern) false-tripped on ordinary docs. Real git conflicts always
# carry the `<<<<<<< ` / `>>>>>>> ` pair — gate on those.
if git grep -lE '^<<<<<<< ' -- . > /dev/null 2>&1 && git grep -lE '^>>>>>>> ' -- . > /dev/null 2>&1; then
  git grep -lE '^(<<<<<<< |>>>>>>> )' -- . >> "$LOG" 2>&1
  log "conflict markers present in tree — refusing to auto-commit; manual fix needed"
  exit 1
fi

# Heal stale git index locks up front, and stay out of the way if a live git
# process is already mutating the index. This avoids misclassifying local index
# contention as a pull/merge conflict (#235).
if ! heal_index_lock; then
  exit 0
fi

# --- stage + commit local changes ---------------------------------------------
# Use `git status --porcelain` (not `git diff --quiet`) so a brand-new UNTRACKED
# file in an otherwise-clean tree still triggers a commit. `git diff` ignores
# untracked files, so a lone new file (e.g. a fresh memory/test script) would
# never sync until some coincident tracked change swept it up via `git add -A`.
if [ -n "$(git status --porcelain)" ]; then
  if [ "$OPENCLAW_SPLIT_LANES" = "1" ]; then
    # #234: stage ONLY state files for main; source stays dirty (→ autosync/<machine>).
    git_add_state
  else
    git add -A -- ':(exclude)workspace/lanes'   # legacy blanket-add (kill-switch path)
  fi

  # --- guard 4: partial-tree wipe protection (T-SYNC-05) ----------------------
  # Count staged deletions; refuse if a protected path is being deleted, or if the
  # total deletions exceed the limit (the signature of a partial/incomplete checkout).
  DELETED=$(git diff --cached --diff-filter=D --name-only)
  DELETED_COUNT=$(printf '%s\n' "$DELETED" | grep -c . )
  for p in "${PROTECTED[@]}"; do
    if printf '%s\n' "$DELETED" | grep -qxF "$p"; then
      log "REFUSING auto-commit: protected path staged for deletion ($p) — partial-tree fault. Unstaging, skip."
      git reset >> "$LOG" 2>&1 || true
      exit 1
    fi
  done
  if [ "$DELETED_COUNT" -gt "$DELETE_LIMIT" ]; then
    # Don't auto-commit a suspicious bulk deletion — but DON'T wedge the whole sync
    # either (T-SYNC-12 / #235). The old `exit 1` here also skipped the pull+push
    # below, so any already-committed local work stopped syncing for as long as the
    # uncommitted bulk deletion sat in the tree. Ephemeral test-results churn (19
    # tracked Playwright artifacts deleted on disk) tripped this every tick and
    # stranded ~42 local commits unpushed (local 42-ahead/32-behind, "sync dead").
    # Fix: unstage, skip ONLY the commit, fall through to pull+push so committed
    # work still reconciles. The deletions stay in the working tree (stashed across
    # the pull) for a human to commit deliberately.
    log "REFUSING auto-commit: $DELETED_COUNT files staged for deletion (> $DELETE_LIMIT) — looks like a partial-tree wipe. Unstaging; SKIPPING COMMIT ONLY (pull+push of committed work continues). Commit bulk deletes manually."
    git reset >> "$LOG" 2>&1 || true
    SKIP_COMMIT=1
  fi

  # belt-and-suspenders: catch leftover conflict markers in staged ADDED lines.
  # NOTE: do NOT use `git diff --cached --check` here — that is a *whitespace*
  # checker (trailing-space, blank-at-eol, etc.) that only incidentally also
  # flags conflict markers, all with the same non-zero exit. Agent-written
  # markdown/YAML routinely has trailing whitespace (e.g. `tags: ` in memory
  # frontmatter), so `--check` aborted the whole sync indefinitely and mislabeled
  # it "conflict markers" (T-SYNC saga). Grep the staged diff for added lines only.
  # Gate on the UNAMBIGUOUS angle-bracket markers (`<<<<<<< ` / `>>>>>>> `) — never
  # legit in markdown/YAML, and a real conflict always carries them. A bare added
  # `=======` is a markdown setext-heading underline / separator, so matching it
  # here (the old pattern) false-tripped on ordinary docs — same trap guard-3 fixed.
  if git diff --cached -U0 | grep -qE '^\+(<<<<<<< |>>>>>>> )'; then
    log "staged conflict markers — unstaging and aborting"
    git reset >> "$LOG" 2>&1 || true
    exit 1
  fi
  if [ -z "${SKIP_COMMIT:-}" ]; then
    if [ -n "$(git diff --cached --name-only)" ]; then
      git commit -m "[auto-sync] $TIMESTAMP" >> "$LOG" 2>&1
      log "committed local changes ($DELETED_COUNT deletions, within limit)"
    else
      # split-sync: only source changed this tick → nothing staged for main; source
      # goes to autosync/<machine> below. Avoid an empty-commit error.
      log "no state changes to commit (source-only tick → $AUTOSYNC_BRANCH)"
    fi
  fi
fi

# --- stash any files the commit step couldn't capture (e.g. workspace/lanes exclusion)
# The commit above uses :(exclude)workspace/lanes, so modifications there are never
# committed by the daemon.  A git pull on a dirty tree either fails ("would be
# overwritten") or silently clobbers those files — both revert live edits.
# Stashing before pull guarantees pull operates on a clean tree, and the pop
# restores the edits intact afterward.  On stash-pop conflict the daemon exits
# without pushing, leaving resolution to the human.
STASH_REF=""
DIRTY_AFTER_COMMIT=$(git status --porcelain)
if [ -n "$DIRTY_AFTER_COMMIT" ]; then
  STASH_MSG="auto-sync pre-pull stash $TIMESTAMP"
  if git stash push --include-untracked -m "$STASH_MSG" >> "$LOG" 2>&1; then
    STASH_REF=$(git stash list | head -1 | cut -d: -f1)   # e.g. stash@{0}
    DIRTY_COUNT=$(printf '%s\n' "$DIRTY_AFTER_COMMIT" | grep -c .)
    log "stashed $DIRTY_COUNT file(s) before pull (ref: $STASH_REF)"
  else
    log "WARNING: stash push failed — pulling with dirty tree"
  fi
fi

# --- pull remote (merge); CLASSIFY failures, don't treat every one as a conflict
# A blanket "pull failed == merge conflict, exit 1" mislabels the most common
# laptop failure — being offline (`Could not resolve host`) — as a divergence
# emergency: it fired the 🔴 Discord alert and set LastExitStatus=1 on every
# disconnected tick, and ran `git merge --abort` with no merge in progress, which
# spews `fatal: There is no merge to abort (MERGE_HEAD missing)` into the log.
# Classify instead:
#   - remote unreachable (offline) -> benign + transient: restore tree, exit 0, no alert.
#   - real conflict / dirty-tree   -> exit 1 (alert stays meaningful), and only
#                                     `git merge --abort` when a merge truly started.
# Capture HEAD immediately before the pull so T-SYNC-11 (below) can tell exactly
# what the INCOMING merge changed (vs. our own local commit, already in this sha).
PRE_PULL_HEAD=$(git rev-parse HEAD)
PULL_OUT="$LOCK_DIR/git-sync.pull-out"
if ! git pull --no-rebase origin "$BRANCH" > "$PULL_OUT" 2>&1; then
  cat "$PULL_OUT" >> "$LOG"
  if grep -q 'index.lock' "$PULL_OUT"; then
    if heal_index_lock; then
      log "pull hit stale index.lock — retrying once after cleanup"
      if git pull --no-rebase origin "$BRANCH" > "$PULL_OUT" 2>&1; then
        rm -f "$PULL_OUT"
      else
        cat "$PULL_OUT" >> "$LOG"
      fi
    else
      log "pull blocked by live index.lock holder — skipping this cycle, will retry next tick"
      if [ -n "$STASH_REF" ]; then
        git stash pop >> "$LOG" 2>&1 || log "WARNING: stash restore failed ($STASH_REF) — run 'git stash pop' manually"
      fi
      rm -f "$PULL_OUT"
      exit 0
    fi
  fi
  if [ -f "$PULL_OUT" ] && [ -s "$PULL_OUT" ]; then
    if grep -qiE 'could not resolve host|could not read from remote|unable to access|connection (refused|timed out)|operation timed out|network is (unreachable|down)|temporary failure in name resolution' "$PULL_OUT"; then
      log "remote unreachable (offline) — skipping this cycle, will retry next tick"
      if [ -n "$STASH_REF" ]; then
        git stash pop >> "$LOG" 2>&1 || log "WARNING: stash restore failed ($STASH_REF) — run 'git stash pop' manually"
      fi
      rm -f "$PULL_OUT"
      exit 0
    fi
    # --- (#122) rerere-assisted recovery BEFORE aborting -------------------------
    # rerere (self-enabled above) replays any previously-recorded resolution for this
    # conflict and, with autoupdate, STAGES it; the union/leasestate merge drivers
    # auto-resolve their files inline. `git merge` still exits non-zero and leaves
    # MERGE_HEAD even when fully pre-resolved (it wants a human to commit) — so the
    # real signal is whether any UNMERGED paths remain. Zero unmerged ⇒ everything was
    # auto-resolved ⇒ complete the merge and push instead of throwing the work away.
    # Any remaining unmerged path ⇒ a genuinely-novel conflict ⇒ fail-soft abort below.
    if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && [ -z "$(git diff --name-only --diff-filter=U)" ]; then
      if [ "$OPENCLAW_SPLIT_LANES" = "1" ]; then
        git_add_state   # #234: complete the merge with state only
      else
        git add -A -- ':(exclude)workspace/lanes'
      fi
      # Never let a botched replay commit conflict markers (same gate as the local path).
      if git diff --cached -U0 | grep -qE '^\+(<<<<<<< |>>>>>>> )'; then
        log "rerere recovery: replayed resolution still contains conflict markers — aborting merge, manual fix needed"
        git merge --abort >> "$LOG" 2>&1 || true
        [ -n "$STASH_REF" ] && { git stash pop >> "$LOG" 2>&1 || log "WARNING: stash restore failed ($STASH_REF) — run 'git stash pop' manually"; }
        rm -f "$PULL_OUT"
        exit 1
      fi
      if git commit --no-edit >> "$LOG" 2>&1; then
        log "pull conflict auto-resolved (rerere/merge-driver) — merge completed ($(git rev-parse --short HEAD))"
        # fall through to stash-restore + push below
      else
        log "rerere recovery: merge commit failed — aborting to clean tree"
        git merge --abort >> "$LOG" 2>&1 || true
        [ -n "$STASH_REF" ] && { git stash pop >> "$LOG" 2>&1 || log "WARNING: stash restore failed ($STASH_REF) — run 'git stash pop' manually"; }
        rm -f "$PULL_OUT"
        exit 1
      fi
    else
      # --- Tier 3: AI author-intent resolution BEFORE the fail-soft abort --------
      # Deterministic layers (merge drivers + rerere) couldn't resolve this; unmerged
      # CODE paths remain. ai-merge-resolver.py resolves honoring BOTH sides' intent
      # and stages ONLY a result that clears every gate (no-markers + blast-radius +
      # independent intent-review + compile/tests). It stages nothing otherwise, so a
      # decline/failure is byte-identical to the old abort below — never a corrupt
      # push. Kill-switch: METIS_AI_MERGE=0. Contract: docs/process/sync-merge-boundary.md
      AI_SUMMARY="$LOCK_DIR/ai-merge-summary.txt"
      if [ "${METIS_AI_MERGE:-1}" = "1" ] \
         && python3 "$REPO/scripts/ai-merge-resolver.py" --repo "$REPO" --summary-file "$AI_SUMMARY" >> "$LOG" 2>&1 \
         && git commit --no-edit >> "$LOG" 2>&1; then
        AI_SHA=$(git rev-parse --short HEAD)
        AI_MSG=$(cat "$AI_SUMMARY" 2>/dev/null || echo "auto-resolved code conflict")
        log "Tier-3 AI-resolved code conflict — merge completed ($AI_SHA)"
        alert_discord "🧩 git-sync auto-resolved a CODE conflict on $(hostname -s): $AI_MSG — pushed as $AI_SHA. Undo: git revert -m 1 $AI_SHA"
        rm -f "$AI_SUMMARY"
        # fall through to T-SYNC-11 deletion guard + stash-restore + push below
      else
        log "pull failed — unresolved conflict; Tier-3 resolver declined/failed/disabled — restoring clean tree, manual resolve may be needed"
        if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
          git merge --abort >> "$LOG" 2>&1 || true
        fi
        if [ -n "$STASH_REF" ]; then
          git stash pop >> "$LOG" 2>&1 || log "WARNING: stash restore failed ($STASH_REF) — run 'git stash pop' manually"
        fi
        rm -f "$PULL_OUT" "$AI_SUMMARY"
        exit 1
      fi
    fi
  fi
fi
rm -f "$PULL_OUT"

# --- guard T-SYNC-11: incoming-merge source-deletion protection ----------------
# Guard-4 (above) only inspects our LOCAL commit's staged deletions. A *pull* merge
# that drops one-side-only SOURCE files sails right past it — that is exactly how the
# M5/M6 metis-command convergence work was wiped on 2026-06-09 (a divergent chain on
# another machine merged in and deleted files it never had). Inspect what the pull
# brought in: if the incoming merge deleted more than DELETE_LIMIT tracked *source*
# files, treat it as a suspected cross-session clobber — reset to the pre-pull HEAD,
# do NOT push, and alert for human review. (Legit bulk source deletions are rare and
# SHOULD require a human ack; resolve by pulling manually or raising the limit once.)
MERGE_DELETED=$(git diff --diff-filter=D --name-only "$PRE_PULL_HEAD" HEAD -- \
  '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.py' '*.sh' '*.css' '*.html' '*.json' 2>/dev/null)
MERGE_DELETED_COUNT=$(printf '%s\n' "$MERGE_DELETED" | grep -c .)
if [ "$MERGE_DELETED_COUNT" -gt "$DELETE_LIMIT" ]; then
  log "REFUSING push: incoming pull-merge deleted $MERGE_DELETED_COUNT source files (> $DELETE_LIMIT) — suspected cross-session clobber (T-SYNC-11). Resetting to pre-pull $PRE_PULL_HEAD; manual review needed."
  printf '%s\n' "$MERGE_DELETED" >> "$LOG"
  git reset --hard "$PRE_PULL_HEAD" >> "$LOG" 2>&1 || true
  exit 1
fi

# --- restore stashed edits after a successful pull ----------------------------
if [ -n "$STASH_REF" ]; then
  if ! git stash pop >> "$LOG" 2>&1; then
    log "WARNING: stash pop conflict after pull — local edits preserved in stash ($STASH_REF); resolve with 'git stash pop' manually, then push"
    exit 1   # don't push — manual resolution needed
  fi
  log "restored stashed edits after pull"
fi

# --- #234 source durability snapshot → autosync/<machine> (never main) ---------
# Always-on + additive: snapshots the working tree's SOURCE changes (everything outside
# STATE_PATHSPECS) onto autosync/<machine> via plumbing — no checkout, no branch switch,
# working tree untouched (source stays dirty so a human can /checkpoint it with intent).
# This is the durability path that makes the OPENCLAW_SPLIT_LANES=1 flip safe (mobile WIP
# survives without riding main). Every step is non-fatal: a failure here must NEVER block
# the main state push below. Skipped only if there is no source to snapshot.
if [ "${OPENCLAW_SOURCE_SNAPSHOT:-1}" = "1" ]; then
  _src_idx="$LOCK_DIR/source-sync.idx.$$"
  if GIT_INDEX_FILE="$_src_idx" git read-tree HEAD 2>>"$LOG" \
     && GIT_INDEX_FILE="$_src_idx" git add -A -- "${SOURCE_EXCLUDES[@]}" 2>>"$LOG"; then
    _src_tree=$(GIT_INDEX_FILE="$_src_idx" git write-tree 2>>"$LOG" || true)
    rm -f "$_src_idx"
    if [ -n "$_src_tree" ]; then
      _autosync_parent=$(git rev-parse --verify "refs/heads/$AUTOSYNC_BRANCH" 2>/dev/null || git rev-parse HEAD)
      _autosync_tree=$(git rev-parse "${_autosync_parent}^{tree}" 2>/dev/null || echo "")
      if [ "$_src_tree" != "$_autosync_tree" ]; then
        _src_commit=$(git commit-tree -p "$_autosync_parent" -m "[auto-sync source] $TIMESTAMP" "$_src_tree" 2>>"$LOG" || true)
        if [ -n "$_src_commit" ]; then
          git update-ref "refs/heads/$AUTOSYNC_BRANCH" "$_src_commit" 2>>"$LOG" \
            || log "source-snap: update-ref failed (will retry next tick)"
          if git push origin "$AUTOSYNC_BRANCH" >>"$LOG" 2>&1; then
            log "source-snap: pushed $AUTOSYNC_BRANCH ($(git rev-parse --short "$_src_commit" 2>/dev/null || echo '?'))"
          else
            log "source-snap: push of $AUTOSYNC_BRANCH failed (non-fatal; local ref durable, retries next tick)"
          fi
        fi
      fi
    fi
  else
    rm -f "$_src_idx"
    log "source-snap: scratch-index staging failed — skipping source snapshot this tick"
  fi
fi

# --- push ---------------------------------------------------------------------
if git push origin "$BRANCH" >> "$LOG" 2>&1; then
  log "sync complete ($(git rev-parse --short HEAD))"
  if [ -f "$FAIL_MARKER" ]; then          # we were failing; this clean sync is the recovery edge
    rm -f "$FAIL_MARKER"
    alert_discord "🟢 git-sync RECOVERED on $(hostname -s) — back in sync at $(git rev-parse --short HEAD)"
  fi
else
  log "ERROR: push failed"
  exit 1
fi
