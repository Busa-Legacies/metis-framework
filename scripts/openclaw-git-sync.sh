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

# Emergency pause kill-switch (#1605, 2026-07-31): if this sentinel exists the daemon
# no-ops. Stops the auto-sync merge/commit loop WITHOUT unloading launchd, so it survives
# ensure-autosync-loaded.sh's reloader (session-init / self-heal / syscheck). Added after
# the sync-merge resolver silently dropped committed work across sessions. Resume: rm the
# sentinel (the daemon starts syncing again on its next 15-min tick / RunAtLoad).
if [ -f "$HOME/.openclaw/git-sync-paused" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] PAUSED via ~/.openclaw/git-sync-paused sentinel — no-op tick" >> "$LOG" 2>/dev/null || true
  exit 0
fi

# Resolve a yaml-capable python for state rendering (#437 sync-integrity, 2026-06-22).
# The daemon's PATH python (/opt/homebrew on <<MACHINE_2_ID>>) lacks PyYAML, so
# render-tier1-state.py threw ModuleNotFoundError every tick and the Tier-1 projections
# (task-queue.md / OPEN_TASKS.md / live-status / projects.md) never refreshed — leaving
# stale projections and spamming the log. Prefer $METIS_PYTHON, else the first candidate
# that can import yaml, else bare python3 (fail-soft — render step is already fail-soft).
_resolve_pybin() {
  # Homebrew python leads: it's the only interpreter that reliably carries BOTH
  # yaml (render step) and pytest (pre-push gate) on both machines. The system /
  # CommandLineTools pythons can import yaml yet lack pytest, which turned the
  # gate permanently RED on <<MACHINE_2_ID>> the first time a test-bearing push originated
  # there (2026-07-10). Same gotcha class as the launchd-plist python pins.
  # Anaconda sits right behind homebrew (2026-08-18): the M2 Air has NO homebrew python, so
  # every candidate failed the yaml probe and the loop fell through to bare `python3` —
  # /usr/local/bin/python3 under the daemon's PATH, which lacks yaml. Render-tier1-state then
  # threw ModuleNotFoundError on EVERY tick for hours and the Tier-1 projections went stale,
  # i.e. the exact #437 failure this resolver exists to prevent, just via the fall-through
  # instead of the PATH. Anaconda carries BOTH yaml and pytest, so it satisfies the gate
  # constraint above as well; homebrew still leads, so no other node's choice changes.
  local c
  for c in "${METIS_PYTHON:-}" /opt/homebrew/bin/python3 /opt/anaconda3/bin/python3 /usr/bin/python3 /Library/Developer/CommandLineTools/usr/bin/python3 python3; do
    [ -n "$c" ] || continue
    if command -v "$c" >/dev/null 2>&1 && "$c" -c "import yaml" >/dev/null 2>&1; then echo "$c"; return; fi
  done
  echo python3
}
PYBIN="$(_resolve_pybin)"

# Abort an auto-commit if it would delete more than this many tracked files in one tick.
# A normal sync rarely deletes >a handful; a partial-tree wipe deletes dozens. Tune via env.
DELETE_LIMIT="${OPENCLAW_SYNC_DELETE_LIMIT:-5}"

# Cap on the daemon's OWN pre-pull stashes (#354). A stranded auto-sync stash from a
# failed pop must not accumulate and re-wedge future ticks; keep only the newest few.
AUTOSYNC_STASH_KEEP="${OPENCLAW_SYNC_STASH_KEEP:-5}"

# Age (days) after which a NON-auto-sync stash ('WIP on main', 'restored edits', a hand
# `git stash`) is treated as abandoned and swept into the lossless archive pipeline. The #354
# cap only bounds the daemon's OWN stashes; foreign stashes were never pruned and accumulated
# indefinitely (<<MACHINE_2_ID>> carried July stragglers into an August 13-stash pileup). We do NOT
# time-delete them: below they are archived to stash-archive/<machine>/* (same update-ref->push
# ->drop path as the auto-sync cap), where the already-scheduled, CONTENT-AWARE
# prune-stash-archives.sh (#3621) applies real retention — churn-only expires fast, SOURCE-bearing
# is kept 90d. The age gate here only protects a RECENT foreign stash that may be live WIP
# awaiting a `git stash pop`; abandoned ones stop bloating `git stash list` and every fetch.
STALE_FOREIGN_STASH_DAYS="${OPENCLAW_SYNC_STALE_FOREIGN_STASH_DAYS:-14}"

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
# change `main`). OPENCLAW_SPLIT_LANES gates the actual `main` behavior flip. Defaulted to
# 1 (lane split ON) on 2026-06-14 after the durability branch (autosync/<machine>) was
# proven live on <<MACHINE_1_ID>> and SPLIT-1..4 + 66/66 guards passed — source no longer auto-commits
# to `main`, eliminating the phantom-conflict / silent-clobber class (#234, cloud-session
# PR fix). Machines self-redeploy this script, so each picks up the flip on its next sync.
# Kill-switch: set OPENCLAW_SPLIT_LANES=0 (env on the daemon) to revert to legacy blanket-add.
OPENCLAW_SPLIT_LANES="${OPENCLAW_SPLIT_LANES:-1}"
# This reconciler legitimately `git add -A`s mixed source+state and commits it. Mark ourselves
# so pre-commit-index-sweep-guard.sh exempts our commits (it blocks OTHER actors from sweeping
# our pre-staged state into a bare source commit — the 2026-08-23 pathspec-less-commit bug).
export OPENCLAW_GIT_SYNC=1
# Silence the macOS ObjC fork-safety crash noise: after fork(), git shells out to the keychain
# credential helper, and the Objective-C runtime aborts the child with "+[__NSCFConstantString
# initialize] may have been in progress in another thread when fork() was called" — every push/
# fetch/pull (esp. the backgrounded push in push_with_timeout) can spew this. It's benign here
# (we don't use ObjC between fork and exec) but pollutes logs and looks like a real crash. This
# process-wide export covers every child git on both macOS launchd and the Linux fleet node.
export OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES
# STATE_PATHSPECS + SOURCE_EXCLUDES (the exclusion form of the allowlist, used to stage
# SOURCE into a scratch index for the autosync/<machine> snapshot) are the canonical
# state-vs-source split. As of #234 Slice 3 they live in a SHARED lib so close-push.sh
# can reuse the identical list for its branch-discipline warning without duplicating it
# (the list drifting between the daemon and the close path would leak source onto main or
# wedge state off it). Sourced defensively, mirroring the git-sync-lock.sh pattern below:
# in prod $REPO/scripts/lib is always present (version-controlled, same tree the daemon
# already requires for its python helpers); if somehow absent the arrays stay unset, which
# is a benign no-op state tick (git_add_state stages nothing) — never a destructive push.
_PATHSPEC_LIB="$REPO/scripts/lib/source-pathspec.sh"
[ -f "$_PATHSPEC_LIB" ] && . "$_PATHSPEC_LIB"

# Per-machine branch for the source durability snapshot. Override OPENCLAW_SYNC_MACHINE if
# detection is wrong. Canonical machine ids come from the declared topology (#509):
# config/infrastructure.json via infra_config (<<MACHINE_1_ID>>/<<MACHINE_2_ID>>). Replaces the persona-grep
# that named the branch after a unix user (autosync/<<MACHINE_2_USER>>) — ids and users are different
# vocabularies.
SYNC_MACHINE="${OPENCLAW_SYNC_MACHINE:-}"
if [ -z "$SYNC_MACHINE" ]; then
  SYNC_MACHINE=$(python3 "$REPO/scripts/lib/infra_config.py" detect-machine 2>/dev/null || true)
fi
if [ -z "$SYNC_MACHINE" ]; then
  # Detector unavailable (python missing / repo half-cloned) — same host signals as
  # before, but emitting the CANONICAL ids so the branch name stays stable either way.
  _sync_host=$(scutil --get LocalHostName 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  _sync_user=$(id -un 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  _sync_home=$(printf '%s' "${HOME:-}" | tr '[:upper:]' '[:lower:]')
  if printf '%s %s %s' "$_sync_host" "$_sync_user" "$_sync_home" | grep -q "<<MACHINE_2_USER>>\|anthony"; then
    SYNC_MACHINE="<<MACHINE_2_ID>>"
  elif printf '%s %s %s' "$_sync_host" "$_sync_user" "$_sync_home" | grep -q "<<MACHINE_1_ID>>\|/users/ant"; then
    SYNC_MACHINE="<<MACHINE_1_ID>>"
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
# Audit 2026-10-01 (git-sync self-heal, findings 8/26): the copy used to come from the WORKING
# TREE with no validation, so a half-edited or conflict-markered script in the shared checkout
# became the running daemon on every node's next tick, died at the parse error (exit 2, which the
# trap does not page on), and the broken daemon was the one component that would have pulled the
# fix. Now: deploy only what is COMMITTED at HEAD, only if it parses, and keep the previous
# binary so a bad deploy is one `mv` from recovery. A working-tree-only edit is never deployed.
_redeploy_candidate="$DEPLOYED.candidate.$$"
if [ -f "$DEPLOYED" ] && git -C "$REPO" show "HEAD:scripts/openclaw-git-sync.sh" > "$_redeploy_candidate" 2>/dev/null \
   && [ -s "$_redeploy_candidate" ] && ! diff -q "$DEPLOYED" "$_redeploy_candidate" > /dev/null 2>&1; then
  if bash -n "$_redeploy_candidate" 2>>"$LOG"; then
    cp "$DEPLOYED" "$DEPLOYED.prev" 2>/dev/null || true
    mv "$_redeploy_candidate" "$DEPLOYED" && chmod +x "$DEPLOYED"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] self-redeploy: updated deployed binary from HEAD:scripts/openclaw-git-sync.sh ($(git -C "$REPO" rev-parse --short HEAD 2>/dev/null)); previous kept at $DEPLOYED.prev; re-execing" >> "$LOG"
    exec "$DEPLOYED" "$@"
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] self-redeploy REFUSED: HEAD:scripts/openclaw-git-sync.sh does not parse (bash -n failed) — keeping the running binary; fix the committed script" >> "$LOG"
    rm -f "$_redeploy_candidate"
  fi
else
  rm -f "$_redeploy_candidate"
fi

LOCK_DIR="${OPENCLAW_LOCK_DIR:-$HOME/.openclaw/locks}"   # override: isolate the lock for tests (#452)
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

# The #1605 drop refusal needs an edge of its OWN, keyed on the offending merge sha rather than a
# bare flag (#4621). FAIL_MARKER above already dedupes the generic "git-sync FAILING" ping, but the
# drop guard raised a SECOND alert unconditionally, on every tick. That was survivable while the
# guard only ever saw merges a node had built itself: the node reset, re-merged, landed somewhere
# else, and the incident ended. Since #4613 it also fires on a drop the node merely RECEIVED — and
# a received drop is already on main, so every node re-pulls the identical merge, refuses it again,
# and paged again, every tick, until a human intervened. A true positive read as an outage.
# Keying the marker on the sha keeps the page where it matters (a DIFFERENT drop still alerts
# immediately) and drops only the repetition of one incident.
DROP_MARKER="$LOCK_DIR/git-sync.dropguard"

# #3685 stranding gets the same treatment, keyed on the SET OF STRANDED PATHS. The obvious key —
# the stash sha — is useless here: a persistent stranding produces a brand-new stash every tick by
# construction, so keying on it would dedup nothing. One conflicted pop is a discrete incident and
# should page. A session actively editing a source file another machine is also changing reproduces
# the condition every tick, and that paged every tick.
STRAND_MARKER="$LOCK_DIR/git-sync.stranded"

alert_discord() {
  # best-effort: a notify failure must never change the sync's own exit status.
  # git-sync FAILING/RECOVERED is an alert, not conversation → #alerts, never #metis.
  python3 "$REPO/scripts/discord_notify.py" --channel alerts "$1" >/dev/null 2>&1 || true
}

on_fail_edge() {
  # Only page once the failure PERSISTS past the self-heal window — a transient wedge that
  # auto-recovers next tick must NOT notify Ant (Ant 2026-09-02: stop paging on things that
  # self-heal). Counter increments per failed tick and resets on any clean sync (recovery path
  # below); tune the grace with OPENCLAW_SYNC_ALERT_AFTER (consecutive failed ticks, default 3).
  local _cf="${FAIL_MARKER%.failing}.failcount"
  local _n=0; [ -f "$_cf" ] && _n=$(cat "$_cf" 2>/dev/null || echo 0)
  _n=$((_n + 1)); echo "$_n" > "$_cf"
  [ -f "$FAIL_MARKER" ] && return 0                              # already alerted this incident
  [ "$_n" -lt "${OPENCLAW_SYNC_ALERT_AFTER:-3}" ] && return 0    # within self-heal grace — quiet
  date '+%Y-%m-%d %H:%M:%S' > "$FAIL_MARKER"
  alert_discord "🔴 git-sync FAILING on $(hostname -s) for $_n ticks (self-heal did not clear it) — $(tail -n1 "$LOG" 2>/dev/null). See $LOG"
}

# Shared lock-holder helper (#452): recognize a leaked orphan (bare `sleep`
# reparented to PID 1 after a SIGKILLed holder) so an alive-but-leaked holder is
# reclaimed instead of wedging sync. Sourced via $REPO so the ~/.local/bin copy
# picks it up too; degrades to legacy behavior if the lib is somehow absent.
# Portable file mtime, epoch seconds. `stat -f %m` is BSD/macOS; on GNU coreutils -f means
# "filesystem status", so on the Linux fleet node the BSD form does NOT cleanly fail — it can
# succeed and emit a non-number for an mtime directive it does not know. That is why the two
# existing call sites guarded on EXIT STATUS and still broke: the question is not "did stat exit
# 0", it is "did we get a number". Every mtime-dependent guard in this daemon — the lock TTL, the
# HEAD.lock grace window (T-SYNC-13), the edit-marker defer and its #886b drift ceiling — silently
# took the wrong branch on Linux, which is exactly the set of assertions that failed there.
# Try GNU first (it fails cleanly on BSD: "illegal option -- c"), then BSD, and validate digits.
# ClaudeCode/bin/file-guard.sh carries the same helper for the same reason; the two trees do not
# share a lib.
portable_mtime() {  # <path> -> epoch seconds on stdout, or nothing
  _pm=$(stat -c %Y "$1" 2>/dev/null)
  case "$_pm" in ''|*[!0-9]*) _pm=$(stat -f %m "$1" 2>/dev/null) ;; esac
  case "$_pm" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s' "$_pm"
}

_LOCK_LIB="$REPO/scripts/lib/git-sync-lock.sh"
[ -f "$_LOCK_LIB" ] && . "$_LOCK_LIB"

# Silent-deletion tripwire (#1605): audit_silent_drops <pre> <head> flags files/blocks a
# merge removed with no explicit non-merge delete commit (delete-vs-unmodified data loss).
# Sourced like the other libs; if absent the guard call below degrades to a benign no-op.
_DROPAUDIT_LIB="$REPO/scripts/lib/sync-drop-audit.sh"
[ -f "$_DROPAUDIT_LIB" ] && . "$_DROPAUDIT_LIB"

# --- #4861 finding 6: gated heal-forward for a RECEIVED, PUBLISHED #1605 silent drop -----------
# A silent drop already published on origin cannot be cleared by a reset — origin still has it, so
# EVERY node that pulls it refuses+resets on every tick, a fleet-wide livelock until a human
# restores the dropped paths on top of the published merge and pushes. That heal is purely
# mechanical, so ONE designated always-on node (<<MACHINE_1_ID>> by default; OPENCLAW_HEAL_FORWARD_NODE
# overrides) does it automatically and the fix propagates via origin. Every other node keeps
# refusing+paging until the heal arrives — the heal is minted once, on one node, never raced.
is_heal_forward_node() {
  # `${VAR-<<MACHINE_1_ID>>}` — NO colon, deliberate: default ONLY when UNSET. `${VAR:-<<MACHINE_1_ID>>}` would also
  # default on an EXPLICIT empty export, silently opting a non-<<MACHINE_1_ID>> node into auto-mutating shared
  # main (the ambiguity that reddened the guard suite on the host named <<MACHINE_1_ID>>; see 44e2b2d5a7). An
  # explicit empty now means "no designated node" → want="" → the -n guard below returns false.
  local want; want=$(printf '%s' "${OPENCLAW_HEAL_FORWARD_NODE-<<MACHINE_1_ID>>}" | tr 'A-Z' 'a-z')
  [ -n "$want" ] && [ "$(hostname -s 2>/dev/null | tr 'A-Z' 'a-z')" = "$want" ]
}

# Restore each silently-dropped path from its pre-drop content ON TOP of the published merge (HEAD
# here — canonical, cannot be reset away) and commit. Returns 0 only if it actually committed a
# heal. The one unacceptable outcome is resurrecting a DELIBERATELY-deleted file, so each path is
# re-gated against an explicit non-merge delete commit in the incoming range (audit_silent_drops
# already excludes those; this is defense-in-depth) before restore.
heal_forward_drops() {  # <pre_ref> <merge> <paths-newline-separated>
  local pre="$1" merge="$2" paths="$3" restored=0 skipped=0 p
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    if git log --no-merges --diff-filter=D --format=%H "$pre..$merge" -- "$p" 2>/dev/null | grep -q .; then
      log "heal-forward SKIP $p — has an explicit non-merge delete commit in range; not resurrecting a deliberate delete"
      skipped=$((skipped+1)); continue
    fi
    if git cat-file -e "$pre:$p" 2>/dev/null && git checkout "$pre" -- "$p" >> "$LOG" 2>&1; then
      git add -- "$p" >> "$LOG" 2>&1 && restored=$((restored+1))
    else
      log "heal-forward SKIP $p — no pre-drop content at ${pre:0:8} to restore"
      skipped=$((skipped+1))
    fi
  done <<HEALEOF
$paths
HEALEOF
  [ "$restored" -gt 0 ] || return 1
  git commit -m "heal-forward (#4861): restore $restored path(s) silently dropped by merge ${merge:0:8} (#1605)" >> "$LOG" 2>&1 || return 1
  log "heal-forward: restored $restored path(s) on top of ${merge:0:8} (skipped $skipped)"
  return 0
}

# Atomic mkdir lock with stale-holder reclaim. Replaces the old flock(1) lock,
# which silently no-op'd on macOS (no flock binary under the LaunchAgent PATH) and
# made `! flock -n 9` true on every run — the sync skipped every tick (T-SYNC-06
# regression, 2026-05-31). `mkdir` is atomic on POSIX, so it is a correct mutex.
# Manual git surgery holds the SAME lock via scripts/git-lock.sh.
# Reclaim is an ATOMIC RENAME, not a check-then-rm (audit 2026-10-01 finding 27): two acquirers
# that both observe the same dead holder used to both `rm -rf` the directory, so the second one
# deleted the FIRST one's freshly created lock and both proceeded. `mv` of a directory is one
# rename(2); only one mover wins, the loser's mv fails and it falls through to a plain mkdir
# that now correctly sees the winner's lock. The same shape is in git-lock.sh and tier1_state_io.py.
reclaim_lock_dir() {  # <reason> -> 0 if THIS caller won the reclaim
  local _r="$LOCK.reclaim.$$"
  if mv "$LOCK" "$_r" 2>/dev/null; then
    rm -rf "$_r"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] reclaimed $1" >> "$LOG"
    return 0
  fi
  return 1   # another acquirer moved it first — they own the reclaim
}
acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; return 0; fi
  local holder mtime now age
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  if [ -n "$holder" ]; then
    if kill -0 "$holder" 2>/dev/null; then      # holder pid is alive...
      # ...but reclaim it if it's a leaked orphan (#452); else genuinely locked.
      if command -v holder_is_leaked >/dev/null 2>&1 && holder_is_leaked "$holder"; then
        reclaim_lock_dir "leaked orphan lock holder $holder (bare sleep, PPID=1)" || true
      else
        return 1                                 # live, legitimate holder → locked
      fi
    else
      reclaim_lock_dir "stale lock (holder pid $holder is dead)" || true
    fi
  else
    # no pid yet: mid-creation race or a crashed acquire. Honor TTL before stealing.
    mtime=$(portable_mtime "$LOCK" || echo 0); now=$(date +%s); age=$(( now - mtime ))
    [ "$age" -lt "$LOCK_TTL" ] && return 1
    reclaim_lock_dir "pid-less lock older than ${LOCK_TTL}s (age ${age}s)" || true
  fi
  mkdir "$LOCK" 2>/dev/null && { echo $$ > "$LOCK/pid"; return 0; }
  return 1
}

if ! acquire_lock; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] lock held by another process — skip" >> "$LOG"
  exit 0
fi
# --- fleet git-health self-report (#3505) — ON THE EXIT PATH, DELIBERATELY ----
# This publishes THIS node's ahead/behind/dirty state to refs/heads/fleet-health/<machine>, which
# is how a node with local-only commits becomes visible fleet-wide with no inbound ssh (<<MACHINE_2_ID>>
# refuses publickey from both the Air and <<MACHINE_1_ID>>, so it was a total blind spot — and unobservable
# is exactly how 60 commits died across 11 reset-to-origin events, #2900).
#
# It lives in the EXIT TRAP rather than inline before the push because the tick has ELEVEN
# `exit 1` guard paths (T-SYNC-11 bulk-delete refusal, #1605 silent-drop refusal, restore_stash
# pop-conflict, the #471 pre-push gate) and EVERY ONE of them is a state where this node is
# stranded and holding commits nobody else can see. An inline call sits after those exits, so it
# would report only on healthy ticks and go silent precisely when the report is the thing that
# matters — the blind spot rebuilt one layer in. That was the real bug: <<MACHINE_2_ID>> ticks every ~5min
# and never published once, because it exits at restore_stash before ever reaching the call.
# The trap runs on all of them, so "unsafe" and "quiet" can never look alike again.
#
# Reporting at exit is also the CORRECT measurement point: it records the state the tick is
# actually leaving the node in, after any guard reset. Telemetry, so never fatal and never
# allowed to alter the tick's exit code.
publish_git_health() {
  [ -x "$REPO/scripts/fleet/git-health-report.sh" ] || return 0
  git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || return 0
  GIT_HEALTH_BRANCH="$BRANCH" GIT_HEALTH_MACHINE="$SYNC_MACHINE" GIT_HEALTH_QUIET=1 \
    GITSYNC_ROOT="$REPO" bash "$REPO/scripts/fleet/git-health-report.sh" >> "$LOG" 2>&1 || true
  return 0
}

# EXIT trap: publish git health (every path), clean the lock and, on a genuine failure (exit 1
# from any guard/push path below), fire the edge-triggered alert. Benign skips (wrong branch, lock
# held, clean no-op) exit 0 -> no alert. INT/TERM (e.g. launchd shutdown) exit 130 -> no alert.
trap 'code=$?; publish_git_health; rm -rf "$LOCK"; [ "$code" -eq 1 ] && on_fail_edge; exit $code' EXIT

# --- tick watchdog: one wall-clock bound for the WHOLE tick (audit 2026-10-01, findings 4/13/25) --
# Only pushes were bounded (push_with_timeout). A hung fetch, pull, gate check (pytest on a stuck
# listener), memory-maintain or dashboard restart held the mkdir lock with a LIVE pid, which the
# reclaim never steals, and every later tick exited 0 with "lock held by another process" — not an
# alert path. That is the 2026-07-13 three-day silent wedge re-entered through any unbounded site.
# Bound the unit of work instead of each symptom: a backgrounded killer SIGTERMs this shell past
# OPENCLAW_SYNC_MAX_TICK seconds; the TERM handler logs, kills the tick's own subprocess tree and
# exits 1 so the EXIT trap releases the lock, publishes health, and counts the failure toward the
# edge-triggered page. The default (1500s) is deliberately longer than the 900s StartInterval: the
# goal is "never silent for days", not a tight bound; an overlapping tick just sees "lock held".
TICK_DEADLINE="${OPENCLAW_SYNC_MAX_TICK:-1500}"
_tick_watchdog_pid=""
if [ "${TICK_DEADLINE:-0}" -gt 0 ] 2>/dev/null; then
  ( sleep "$TICK_DEADLINE"; kill -0 $$ 2>/dev/null && kill -TERM $$ 2>/dev/null ) &
  _tick_watchdog_pid=$!
  trap 'log "ERROR: tick exceeded ${TICK_DEADLINE}s wall-clock — watchdog terminated it (hung fetch/pull/gate/heal?); lock released, counted as a failed tick"; for _c in $(pgrep -P $$ 2>/dev/null); do [ "$_c" = "$_tick_watchdog_pid" ] || _kill_tree "$_c"; done; exit 1' TERM
  # Disarm the watchdog on every exit so a finished tick never leaves a stray killer behind.
  trap 'code=$?; [ -n "$_tick_watchdog_pid" ] && kill "$_tick_watchdog_pid" 2>/dev/null; publish_git_health; rm -rf "$LOCK"; [ "$code" -eq 1 ] && on_fail_edge; exit $code' EXIT
fi

# --- autorescue-tag hygiene (throttled, once/day) -----------------------------
# Placed HERE (right after the lock + EXIT trap, BEFORE the sync body) on purpose: tag
# pruning is independent of the sync's success, and the sync body has eleven `exit 1` guard
# paths — a block at EOF would be skipped on every tick that fails to push. Running here,
# under the lock, it fires on every tick that holds the lock, throttled to once per 24h by a
# stamp (the daemon ticks every ~15min). Best-effort; never changes this tick's outcome.
# The reference-transaction auto-rescue hook (#3548) tags every commit a main/master rewind
# would orphan; those LOCAL tags accumulate fast on heavy-rebase nodes (<<MACHINE_2_ID>> ~109/hr) and
# tax every local ref walk. scripts/fleet/prune-autorescue-tags.sh drops a tag only when its
# commit is on origin/main (lossless) or aged past MAX_AGE_DAYS. The daemon runs on every node
# (macOS launchd + Linux systemd) and self-redeploys, so this is the fleet-wide per-node
# workhorse; jay-maintenance also sweeps <<MACHINE_1_ID>> weekly (#3688).
_ar_janitor="$REPO/scripts/fleet/prune-autorescue-tags.sh"
_ar_stamp="$HOME/.openclaw/state/autorescue-prune.stamp"
if [ -x "$_ar_janitor" ]; then
  _ar_now=$(date -u +%s)
  _ar_last=0; [ -f "$_ar_stamp" ] && _ar_last=$(cat "$_ar_stamp" 2>/dev/null || echo 0)
  case "$_ar_last" in ''|*[!0-9]*) _ar_last=0 ;; esac
  if [ $(( _ar_now - _ar_last )) -ge 86400 ]; then
    mkdir -p "$(dirname "$_ar_stamp")" && echo "$_ar_now" > "$_ar_stamp"
    _ar_out="$(bash "$_ar_janitor" --apply 2>&1 | tail -1)"
    # NB: log() is defined below this point, so write to $LOG directly.
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] autorescue-tag janitor (daily): $_ar_out" >> "$LOG"
  fi
fi
trap 'rm -rf "$LOCK"; exit 130' INT TERM

cd "$REPO" || exit 1
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
log() { echo "[$TIMESTAMP] $1" >> "$LOG"; }

# Local-commit-loss guard for destructive aborts/resets (#2900). Pins at-risk unpushed
# local commits under a durable ref before guard-2's abort and verifies HEAD didn't
# regress off them afterward — closing the 2026-08-15 silent-drop path. Sourced like the
# other libs; degrades to a benign no-op if somehow absent.
_COMMITGUARD_LIB="$REPO/scripts/lib/git-sync-commit-guard.sh"
if [ -f "$_COMMITGUARD_LIB" ]; then
  . "$_COMMITGUARD_LIB"
else
  preserve_local_commits_before_abort() { :; }
  verify_no_local_commit_loss_after_abort() { :; }
fi

# Tip-only source-file preservation for the durability snapshot (#3893 Part 2). Sourced like the
# other libs; degrades to a benign pass-through (echo src_tree) if somehow absent.
_SNAPPRESERVE_LIB="$REPO/scripts/lib/source-snapshot-preserve.sh"
if [ -f "$_SNAPPRESERVE_LIB" ]; then
  . "$_SNAPPRESERVE_LIB"
else
  preserve_tiponly_source_tree() { printf '%s' "$3"; }
fi

# --- push wall-clock guard (2026-07-13 recovery) ------------------------------
# A git push that HANGS (slow pre-push hook, stalled TLS/pack transfer, network
# black-hole) must never hold the sync lock indefinitely. On 2026-07-13 a push
# stuck in a fork-heavy pre-push hook wedged ALL sync for 3 days with NO alert —
# a hang never returns, so the exit-1 failure path (and its Discord edge in the
# EXIT trap) never fired. This bounds every push: run it backgrounded, hard-kill
# the whole process tree past PUSH_TIMEOUT, and return non-zero so the normal
# push-failure path runs (source-snap: non-fatal retry; main: exit 1 ->
# on_fail_edge alert). Kill-switch/tune: OPENCLAW_SYNC_PUSH_TIMEOUT (seconds).
PUSH_TIMEOUT="${OPENCLAW_SYNC_PUSH_TIMEOUT:-120}"
_kill_tree() {  # kill a pid and all descendants (bash 3.2: no process groups)
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do _kill_tree "$c"; done
  kill -9 "$p" 2>/dev/null
}
# Per-push output capture (#4861), mirroring $PULL_OUT: the push's stdout+stderr is
# captured to its own file so the main-push failure branch can CLASSIFY the failure
# (a benign peer-moved-the-branch race vs a genuine failure) instead of paging on every
# lost race. Still appended to the shared $LOG so every caller's output stays in the log.
PUSH_OUT="$LOCK_DIR/git-sync.push-out"
# Heartbeat marker for the commit batcher (#995 F1): written by the DAEMON after a successful
# `git commit`, so the marker records a commit that happened, not a decision that may have been
# overridden (audit 2026-10-01 findings 15 / 23). No-op when the decision script is absent.
mark_autosync_commit() {
  [ -f "$REPO/scripts/autosync-commit-decision.py" ] || return 0
  "$PYBIN" "$REPO/scripts/autosync-commit-decision.py" --mark-committed >> "$LOG" 2>&1 || true
  return 0
}

# The #471 pre-push gate, callable from EVERY site that pushes to $BRANCH (audit 2026-10-01
# findings 12 / 21: the #886c(A) state ff-push shipped ungated). Output lands in $_gate_out (so the
# memory-limits auto-heal can read WHICH check reddened) and is appended to $LOG. Returns the gate's
# rc: 0 clean, 1 RED, 2 the gate itself could not run (fails closed).
_gate_out="$LOCK_DIR/git-sync.gateout"
run_prepush_gate() {
  GATE_BRANCH="$BRANCH" PYBIN="$PYBIN" METIS_HOME="$REPO" \
    "$PYBIN" "$REPO/scripts/autosync_prepush_gate.py" > "$_gate_out" 2>&1
  local rc=$?
  cat "$_gate_out" >> "$LOG"
  return "$rc"
}

push_with_timeout() {  # args: the git subcommand+args, e.g. `push origin main`
  : > "$PUSH_OUT" 2>/dev/null || true
  git "$@" > "$PUSH_OUT" 2>&1 &
  local pid=$! rc
  ( sleep "$PUSH_TIMEOUT"; kill -0 "$pid" 2>/dev/null \
      && { log "ERROR: push exceeded ${PUSH_TIMEOUT}s wall-clock — killing (git $*)"; _kill_tree "$pid"; } ) &
  local watcher=$!
  wait "$pid" 2>/dev/null; rc=$?
  kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
  [ -s "$PUSH_OUT" ] && cat "$PUSH_OUT" >> "$LOG"   # keep the shared log complete for every caller
  return "$rc"
}

# --- robust pre-pull stash restore (#354) -------------------------------------
# The daemon stashes tree changes the commit step can't capture (workspace/lanes
# exclusions, skipped bulk deletes) before pulling, then restores them after.
# Two hard rules, learned from an ~8h wedge (2026-06-13, a stale stash that
# conflicted on every bare pop):
#   1. Restore ONLY the stash THIS tick created — never a bare `git stash pop`,
#      which pops stash@{0} and can clobber a foreign/older stash.
#   2. On a pop conflict, abort to a clean tree (no conflict markers reach the
#      working tree) and PRESERVE the stash, so the next tick's marker guard
#      doesn't wedge every cycle. Local edits stay safe in the stash.
# STASH_SHA (the stash commit's stable hash, captured at push) is the identity;
# stash@{N} positions shift as stashes are added/dropped and must not be trusted.
restore_stash() {
  [ -n "${STASH_SHA:-}" ] || return 0
  local ref
  ref=$(git stash list --format='%gd %H' 2>/dev/null | awk -v s="$STASH_SHA" '$2==s{print $1; exit}')
  if [ -z "$ref" ]; then
    log "stash restore: our stash (${STASH_SHA:0:8}) is no longer present — nothing to restore"
    STASH_SHA=""
    return 0
  fi
  if git stash pop "$ref" >> "$LOG" 2>&1; then
    log "restored stashed edits after pull ($ref)"
    STASH_SHA=""
    return 0
  fi
  # Pop conflicted: discard the half-applied result so NO markers reach the working
  # tree (the wedge), and keep the stash so the edits aren't lost. HEAD (incl. any
  # merge commit from the pull) is retained — only the stash application is undone.
  git reset --hard HEAD >> "$LOG" 2>&1 || true

  # "Preserved" is only true if somebody eventually LOOKS (#3685). Nobody did: a conflicted
  # pop leaves the stash in place, prune_autosync_stashes archives it to a branch once it ages
  # past the keep cap, and the source edits then sit on a ref no one reads. A triage of
  # m2air's 35 archives found 17 stranded blobs that way, including an audit doc that exists
  # nowhere else on main. The archive made it recoverable; the silence made it unnoticed, and
  # visibility you can ignore is not visibility.
  #
  # DROP vs KEEP is decided over the WHOLE stash, path by path (2026-10-01 git-sync audit;
  # 2026-10-05: 18 untracked drain audit reports were lost here). The old test diffed only the
  # TRACKED side (STASH^1..STASH) and only outside the state allowlist, so (a) untracked files,
  # which live in the stash's THIRD parent, were never inspected, and (b) authored state
  # (memory, decisions) inside the allowlist counted as "regenerable". A path is regenerable
  # ONLY when a merge driver owns it (the drivers rewrite it wholesale, which is the reason the
  # driver exists) AND it is not authored memory/decisions. Everything else is KEPT.
  #
  # Escalate (alert) only for content nobody regenerates: untracked files, authored memory/
  # decisions, and SOURCE (outside the state allowlist). Driverless state churn (e.g. a
  # tick-churned *.jsonl with no union attribute) is kept + parked locally but stays quiet, so
  # the alert keeps meaning "real work may be stranded" (no cry-wolf, #3459).
  local _drivers=" keepours union leasestate taskstate projectstate healthchecks frontierledger memindex workingcontext exampledelegations "
  local _tracked="" _untracked="" _source="" _kept="" _alert="" _p _drv
  _tracked=$(git diff --name-only "${STASH_SHA}^1" "$STASH_SHA" 2>/dev/null)
  if git rev-parse -q --verify "${STASH_SHA}^3" >/dev/null 2>&1; then
    _untracked=$(git ls-tree -r --name-only "${STASH_SHA}^3" 2>/dev/null)
  fi
  _source="__ALL__"   # classifier lib missing -> treat every kept tracked path as alert-worthy
  if [ -f "$REPO/scripts/lib/source-pathspec.sh" ]; then
    # shellcheck source=/dev/null
    . "$REPO/scripts/lib/source-pathspec.sh" 2>/dev/null || true
    if [ "${#SOURCE_EXCLUDES[@]}" -gt 0 ] 2>/dev/null; then
      _source=$(git diff --name-only "${STASH_SHA}^1" "$STASH_SHA" -- "${SOURCE_EXCLUDES[@]}" 2>/dev/null)
    fi
  fi
  while IFS= read -r _p; do
    [ -n "$_p" ] || continue
    if _stash_path_authored "$_p"; then
      _kept="${_kept}${_p}"$'\n'; _alert="${_alert}${_p}"$'\n'; continue
    fi
    _drv=$(git check-attr merge -- "$_p" 2>/dev/null | sed -n 's/.*: merge: //p')
    if [ -n "$_drv" ] && [ "${_drivers#* $_drv }" != "$_drivers" ]; then
      continue   # driver-owned regenerable state
    fi
    _kept="${_kept}${_p}"$'\n'
    if [ "$_source" = "__ALL__" ] || printf '%s\n' "$_source" | grep -qxF -- "$_p"; then
      _alert="${_alert}${_p}"$'\n'
    fi
  done <<< "$_tracked"
  while IFS= read -r _p; do
    [ -n "$_p" ] || continue
    _kept="${_kept}${_p}"$'\n'; _alert="${_alert}${_p}"$'\n'   # untracked = new content: always keep
  done <<< "$_untracked"

  if [ -z "$_kept" ]; then
    # Every path is driver-owned regenerable state; reset --hard above already restored the
    # correct merged tree, so DROP the stash (ROOT CAUSE of #3459: keeping these orphaned a
    # stash near-every dirty tick and tripped gitsync-drift daily).
    if git stash drop "$ref" >> "$LOG" 2>&1; then
      log "stash pop conflict after pull — restored clean tree; stash ($ref) held only regenerable driver-owned state (no source), dropped to prevent orphan accumulation (#3459)."
    else
      log "WARNING: stash pop conflict after pull — restored clean tree; churn-only stash ($ref) drop failed, left in place (prune/reconcile will retire it)."
    fi
    STASH_SHA=""
    return 1
  fi

  log "WARNING: stash pop conflict after pull — restored clean tree; local edits preserved in stash ($ref). Resolve with 'git stash pop $ref' then push."
  # Durable LOCAL park for every kept stash: the stash list is capped/pruned, a ref is not.
  # Named by content tree so re-parking the same content is an idempotent no-op.
  local _park_tree
  _park_tree=$(git rev-parse -q --verify "${STASH_SHA}^{tree}" 2>/dev/null)
  if git update-ref "refs/openclaw/parked-stash/${_park_tree:-$STASH_SHA}" "$STASH_SHA" 2>>"$LOG"; then
    log "kept stash parked locally at refs/openclaw/parked-stash/${_park_tree:-$STASH_SHA} ($(printf '%s' "$_kept" | grep -c .) kept path(s))"
  fi
  if [ -n "$_alert" ]; then
    local _n _list
    _n=$(printf '%s' "$_alert" | grep -c . || true)
    _list=$(printf '%s' "$_alert" | head -12 | tr '\n' ' ')
    log "STRANDED SOURCE (#3685): the conflicted stash holds $_n path(s) that are NOT in any commit (untracked, authored memory/decisions, or source): $_list — alerting, and preserving as a branch so the content outlives the stash cap."
    # Park on origin under recover/ too (survives this machine). #4861: named by content tree so
    # the same content re-parks to the same ref; push_with_timeout keeps the tick bounded.
    local _park_ref
    _park_ref="recover/stranded-$(hostname -s)-${_park_tree:-$STASH_SHA}"
    if push_with_timeout push origin "${STASH_SHA}:refs/heads/${_park_ref}"; then
      log "stranded stash parked on origin at ${_park_ref}"
    else
      log "NOTE: could not park the stranded stash on origin (it remains in the local stash list and the local parked-stash ref)"
    fi
    local _strand_key
    _strand_key=$(printf '%s' "$_alert" | sort | tr '\n' ' ')
    if [ "$(cat "$STRAND_MARKER" 2>/dev/null || true)" = "$_strand_key" ]; then
      log "stranding covers the same path(s) as the previous stranding — already alerted, staying quiet"
    else
      printf '%s\n' "$_strand_key" > "$STRAND_MARKER" 2>/dev/null || true
      alert_discord "git-sync on $(hostname -s): stash pop conflicted and stranded $_n file(s) not in any commit — $_list. Preserved under recover/*-${STASH_SHA:0:8} and refs/openclaw/parked-stash; reconcile with 'git stash pop $ref'."
    fi
  else
    log "kept stash holds only driverless state churn — preserved quietly (no alert)"
  fi
  return 1
}

# Authored content no driver regenerates: never droppable even when a merge driver merges it on
# pull (MEMORY.md carries memindex, daily logs carry union, but a dropped stash still loses the
# local un-merged entries).
_stash_path_authored() {
  case "$1" in
    ClaudeCode/memory/*|workspace/memory/*|docs/process/decisions/*) return 0 ;;
  esac
  return 1
}

# Cap the daemon's OWN pre-pull stashes (#354) so a stranded one (failed pop,
# interrupted tick) can't accumulate and re-wedge future ticks. Keeps the newest
# AUTOSYNC_STASH_KEEP auto-sync stashes and reconciles older ones. Foreign stashes
# (any without our message) are never touched. Drops by SHA, re-resolving the
# selector each time because stash@{N} positions shift as entries are dropped.
#
# LOSSLESS (2026-07-27, #354 follow-on): the old comment claimed over-cap stashes
# "hold only ephemeral, commit-excluded content" and blind `git stash drop`-ped them.
# That assumption is FALSE — a pop-conflict can strand REAL source in a pre-pull stash
# (observed the same day: metis-command WIP that reconcile-daemon-stashes.py had to
# archive). So before dropping, preserve each over-cap stash commit as a branch ref:
# `git update-ref` makes it reachable locally (so it survives the drop even if the
# bounded origin push fails or origin is unreachable — degrades to "kept locally, daily
# reconcile pushes it", never silent loss), and a best-effort bounded push mirrors it to
# origin for cross-machine recovery.
prune_autosync_stashes() {
  local shas=() drop_sha ref count i stamp branch
  while IFS= read -r line; do
    [ -n "$line" ] && shas+=( "${line%% *}" )
  done < <(git stash list --format='%H %gs' 2>/dev/null | grep -F 'auto-sync pre-pull stash')
  count=${#shas[@]}
  [ "$count" -gt "$AUTOSYNC_STASH_KEEP" ] || return 0
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  for (( i=AUTOSYNC_STASH_KEEP; i<count; i++ )); do
    drop_sha="${shas[$i]}"
    ref=$(git stash list --format='%gd %H' 2>/dev/null | awk -v s="$drop_sha" '$2==s{print $1; exit}')
    [ -n "$ref" ] || continue
    branch="stash-archive/${SYNC_MACHINE:-unknown}/${stamp}-prune-${drop_sha:0:12}"
    git update-ref "refs/heads/${branch}" "$drop_sha" 2>>"$LOG" || true
    if push_with_timeout push origin "refs/heads/${branch}:refs/heads/${branch}"; then
      log "archived over-cap stash ${drop_sha:0:8} -> ${branch} (pushed)"
    else
      log "archived over-cap stash ${drop_sha:0:8} -> ${branch} (push failed/timed out — kept locally, content safe)"
    fi
    git stash drop "$ref" >> "$LOG" 2>&1 || true
  done
  log "pruned $(( count - AUTOSYNC_STASH_KEEP )) over-cap auto-sync stash(es) — archived to stash-archive/${SYNC_MACHINE:-unknown}/* (kept newest $AUTOSYNC_STASH_KEEP)"
}

# Companion to prune_autosync_stashes: that one caps the daemon's OWN stashes; this ages out
# NON-auto-sync stashes ('WIP on main', 'restored edits', hand-run `git stash`) that nothing else
# ever pruned, so they piled up in `git stash list` (and every fetch's ref advert) forever.
#
# LOSSLESS + CONTENT-SAFE BY DELEGATION. It does NOT decide retention. A foreign stash older than
# STALE_FOREIGN_STASH_DAYS is preserved as a branch (`git update-ref` first, so it survives the
# drop even if the bounded push fails or origin is unreachable), best-effort mirrored to origin,
# then dropped from the working stash list. Retention is then the job of the already-scheduled,
# content-aware prune-stash-archives.sh (#3621): churn-only archives expire fast, any archive
# touching SOURCE is held 90d and named loudly. That split is deliberate — a time-only delete here
# would destroy unrestored WIP (measured: 22/35 m2air archives held live SOURCE), which is exactly
# the trap test-stash-archive-sweep.sh pins. The age gate below only spares a RECENT foreign stash
# that may be live WIP awaiting a `git stash pop`.
prune_stale_foreign_stashes() {
  local now cutoff sha ts subj ref stamp branch swept=0
  now=$(date -u +%s 2>/dev/null) || return 0
  cutoff=$(( now - STALE_FOREIGN_STASH_DAYS * 86400 ))
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  # Snapshot the list up front (SHAs are stable identifiers); re-resolve stash@{N} by SHA each
  # iteration because positions shift as entries are dropped — same pattern as the auto-sync cap.
  while IFS='|' read -r sha ts subj; do
    [ -n "$sha" ] || continue
    case "$subj" in *"auto-sync pre-pull stash"*) continue ;; esac   # daemon's own — capped elsewhere
    [ -n "$ts" ] && [ "$ts" -lt "$cutoff" ] 2>/dev/null || continue  # keep recent — may be live WIP
    ref=$(git stash list --format='%gd %H' 2>/dev/null | awk -v s="$sha" '$2==s{print $1; exit}')
    [ -n "$ref" ] || continue
    branch="stash-archive/${SYNC_MACHINE:-unknown}/${stamp}-foreign-${sha:0:12}"
    git update-ref "refs/heads/${branch}" "$sha" 2>>"$LOG" || true
    if push_with_timeout push origin "refs/heads/${branch}:refs/heads/${branch}"; then
      log "archived stale foreign stash ${sha:0:8} ($subj) -> ${branch} (pushed; retention via prune-stash-archives.sh)"
    else
      log "archived stale foreign stash ${sha:0:8} ($subj) -> ${branch} (push failed/timed out — kept locally, content safe)"
    fi
    git stash drop "$ref" >> "$LOG" 2>&1 || true
    swept=$(( swept + 1 ))
  done < <(git stash list --format='%H|%ct|%gs' 2>/dev/null)
  [ "$swept" -gt 0 ] && log "aged out $swept non-auto-sync stash(es) older than ${STALE_FOREIGN_STASH_DAYS}d — archived to stash-archive/${SYNC_MACHINE:-unknown}/* for content-aware retention"
  return 0
}

# Audit 2026-10-01 (findings 14 / 24): this used to read "lsof printed nothing" as "no holder" and
# delete immediately. lsof exits 1 BOTH when nothing holds the file and when it fails, and it is
# absent from some PATHs (the plist once omitted /usr/sbin) and slow under the load this runs in —
# so an interactive `git commit` mid pre-commit-hook-chain could lose its index.lock to the daemon
# and both processes then wrote the index. Same shape as heal_head_lock, same cure: a live holder
# wins, a FRESH lock (younger than INDEXLOCK_GRACE) is left for the in-flight op, and when lsof is
# not available at all the grace is widened (INDEXLOCK_GRACE_NOLSOF) because mtime is then the
# ONLY evidence — a git index op never legitimately holds the lock for ten minutes.
heal_index_lock() {
  local index_lock lock_owner now mtime age grace="${INDEXLOCK_GRACE:-60}"
  index_lock=$(git rev-parse --git-path index.lock 2>/dev/null || true)
  [ -n "$index_lock" ] || return 0
  [ -f "$index_lock" ] || return 0

  if command -v lsof >/dev/null 2>&1; then
    lock_owner=$(lsof "$index_lock" 2>/dev/null | awk 'NR>1{print $2; exit}')
    if [ -n "$lock_owner" ]; then
      log "index.lock held by live pid $lock_owner at $index_lock — skip this cycle"
      return 1
    fi
  else
    grace="${INDEXLOCK_GRACE_NOLSOF:-600}"
    log "lsof unavailable on PATH — cannot prove index.lock is ownerless; using the ${grace}s mtime grace alone"
  fi

  now=$(date +%s)
  mtime=$(portable_mtime "$index_lock" || echo "$now")
  age=$(( now - mtime ))
  if [ "$age" -lt "$grace" ]; then
    log "index.lock at $index_lock is fresh (${age}s < ${grace}s) — leaving for in-flight op, skip this cycle"
    return 1
  fi

  rm -f "$index_lock"
  log "removed stale index.lock at $index_lock (age ${age}s, no live holder) before git operation"
  return 0
}

# This clone is shared by MANY writers — the daemon, the queue-runner, and every
# interactive session — all contending on one .git/index.lock. heal_index_lock only
# clears a STALE (ownerless) lock; a lock held by a LIVE interactive git op (a session
# mid `git add`/`git commit`) instead made the daemon give up and degrade to
# "stash push failed -> dirty-tree pull" (observed 325 lock hits / 111 dirty-tree
# degradations on 2026-07-28 under load 300+, which is how mobile-session work synced
# slowly and flakily). But interactive index ops finish in well under a second, so a few
# short backoff polls almost always win the lock. WAIT briefly for a live lock to clear
# before a lock-taking op; on timeout return 1 so the caller falls through to its existing
# degradation (no behaviour regression). Budget ~1.8s — far inside a sync tick.
wait_for_index_lock() {
  local index_lock owner deadline budget="${INDEXLOCK_WAIT_SECS:-2}"
  index_lock=$(git rev-parse --git-path index.lock 2>/dev/null || true)
  [ -n "$index_lock" ] || return 0
  [ -f "$index_lock" ] || return 0
  # One lsof only — it is the expensive call and is itself slow under the very load this
  # guards against, so confirm a LIVE owner ONCE, then cheaply poll for the file to clear.
  owner=$(lsof "$index_lock" 2>/dev/null | awk 'NR>1{print $2; exit}')
  [ -n "$owner" ] || return 0            # ownerless => stale; heal_index_lock's job, not ours
  deadline=$(( $(date +%s) + budget ))
  while [ -f "$index_lock" ] && [ "$(date +%s)" -lt "$deadline" ]; do
    sleep 0.2
  done
  if [ -f "$index_lock" ]; then
    log "index.lock still held (was live pid $owner) after ${budget}s wait — proceeding (may degrade this tick)"
    return 1
  fi
  return 0
}

# T-SYNC-13: a stale orphaned .git/HEAD.lock (left by a killed `git commit`/`git merge`
# or a wedged ai-merge) blocks EVERY commit and merge, so the daemon trips on it silently
# each cycle without ever advancing. Reclaim it — but only when provably orphaned:
#   - the file exists,
#   - NO live process holds it (lsof on the specific file — more precise than `pgrep git`,
#     which false-matches unrelated git processes in other repos), AND
#   - it is older than the grace window (a fresh lock likely belongs to an in-flight op
#     that lsof can miss between fd operations — so never yank a young one).
# Otherwise stay out of the way this cycle (return 1) exactly like heal_index_lock.
heal_head_lock() {
  local head_lock lock_owner now mtime age grace="${HEADLOCK_GRACE:-60}"
  head_lock=$(git rev-parse --git-path HEAD.lock 2>/dev/null || true)
  [ -n "$head_lock" ] || return 0
  [ -f "$head_lock" ] || return 0

  lock_owner=$(lsof "$head_lock" 2>/dev/null | awk 'NR>1{print $2; exit}')
  if [ -n "$lock_owner" ]; then
    log "HEAD.lock held by live pid $lock_owner at $head_lock — skip this cycle"
    return 1
  fi

  now=$(date +%s)
  mtime=$(portable_mtime "$head_lock" || echo "$now")
  age=$(( now - mtime ))
  if [ "$age" -lt "$grace" ]; then
    log "HEAD.lock at $head_lock is fresh (${age}s < ${grace}s) — leaving for in-flight op, skip this cycle"
    return 1
  fi

  rm -f "$head_lock"
  log "reclaimed stale orphaned HEAD.lock at $head_lock (age ${age}s, no live holder) before git operation"
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

# --- self-register the health-checks merge driver (idempotent) -----------------
# health-checks.json is high-churn self-heal state both machines rewrite (per-check
# `added` stamps, top-level updatedAt, ordering). It was the one governed-state file
# with NO merge driver, so every cross-machine pull aborted on it and local main
# diverged unboundedly (#437 sync-integrity, 2026-06-22: <<MACHINE_2_ID>> hit 16-ahead/34-behind;
# the Tier-3 AI resolver excludes governed .json by design, expecting this driver).
# Maps to merge=healthchecks in .gitattributes; resolves deterministically (union
# checks[] by name keeping newer `added`; gaps unioned; updatedAt = newer).
HEALTHCHECKS_DRIVER="$REPO/scripts/merge-healthchecks.py"
if [ -x "$HEALTHCHECKS_DRIVER" ]; then
  git config merge.healthchecks.name "self-heal health-checks newer-wins merge" 2>/dev/null || true
  git config merge.healthchecks.driver "python3 $HEALTHCHECKS_DRIVER %O %A %B %P" 2>/dev/null || true
fi

# --- self-register the frontier-scan ledger merge driver (idempotent) ----------
# workspace/state/frontier-scan/ledger.json is a {"seen": {hash: date}} append/update map
# rewritten by every frontier-scan run (nightly, both machines) -- structurally identical
# to health-checks.json but had NO merge driver (flagged by the 2026-07-24 system audit,
# never landed). Every cross-machine pull that touched it hit a raw conflict the Tier-3 AI
# resolver excludes by design; 2026-07-23 09:31 through 2026-07-25 13:44 that produced an
# unbroken ~15-min retry storm (~278 failed pull/conflict/restore cycles) that coincided
# with frontier-scan's 09:00 run every one of those mornings and starved its scout-lane MLX
# call into timing out (#475 regression root cause). Maps to merge=frontierledger in
# .gitattributes; unions seen/candidates/runs, updatedAt = newer.
FRONTIERLEDGER_DRIVER="$REPO/scripts/merge-frontier-ledger.py"
if [ -x "$FRONTIERLEDGER_DRIVER" ]; then
  git config merge.frontierledger.name "frontier-scan ledger seen/candidates/runs union merge" 2>/dev/null || true
  git config merge.frontierledger.driver "python3 $FRONTIERLEDGER_DRIVER %O %A %B %P" 2>/dev/null || true
fi

# --- self-register the memory-index merge driver (idempotent) ------------------
# MEMORY.md + MEMORY-archive.md are edited from many sessions/machines (entries added,
# demoted hot<->cold, reordered). Without a resolver a plain 3-way merge conflicts and the
# daemon dies mid-merge, wedging the whole clone (2026-07-09: wedged twice, blocking 6 live
# sessions). Maps to merge=memindex in .gitattributes; unions entries + dedupes by filename.
MEMINDEX_DRIVER="$REPO/scripts/merge-memindex.py"
if [ -x "$MEMINDEX_DRIVER" ]; then
  git config merge.memindex.name "memory-index union+dedupe merge" 2>/dev/null || true
  git config merge.memindex.driver "python3 $MEMINDEX_DRIVER %O %A %B %P" 2>/dev/null || true
fi

# --- self-register the working-context merge driver (idempotent) ---------------
# working-context.md is the session scratchpad every session appends keyed threads to;
# overlapping edits from two machines conflicted and wedged the daemon (same 2026-07-09
# outage). Maps to merge=workingcontext; unions threads by [KEY] (newer provenance ts wins)
# via the canonical Doc parser.
WORKINGCTX_DRIVER="$REPO/scripts/merge-workingcontext.py"
if [ -x "$WORKINGCTX_DRIVER" ]; then
  git config merge.workingcontext.name "working-context thread-union merge" 2>/dev/null || true
  git config merge.workingcontext.driver "python3 $WORKINGCTX_DRIVER %O %A %B %P" 2>/dev/null || true
fi

# --- never let config shadow a git BUILT-IN merge driver (2026-10-05) -----------
# A stray `merge.union.driver=true` in <<MACHINE_1_ID>>'s .git/config replaced git's built-in union with
# a no-op "keep ours" driver, so every merge=union ledger (fleet-inbox, fleet-sessions,
# uptime probes, ...) silently dropped the OTHER machine's appended lines on each auto-sync
# merge; the #1605 drop guard then refused the push, wedging main for hours. Nothing in the
# repo set it. Built-ins (union/text/binary) need no registration, so any config entry for
# them is drift: remove it every tick.
for _bi in union text binary; do
  if git config --get "merge.$_bi.driver" >/dev/null 2>&1; then
    log "removed stray merge.$_bi.driver ($(git config --get "merge.$_bi.driver")) shadowing git's built-in $_bi merge"
    git config --unset-all "merge.$_bi.driver" 2>/dev/null || true
  fi
done

# --- self-register the example-delegations merge driver (idempotent) ------------
# docs/process/state/example-delegations.json is an append-mostly {version, delegations:[...]}
# ledger read-modify-written from multiple machines (delegate-to-example.py / example-return-
# writeback.py). A plain 3-way merge conflicts on overlapping appends, ai-merge classifies the
# 1.3MB JSON as an unresolvable file type and defers to human, and the daemon restore-looped —
# behind-98, ~21h relay-poller stall (2026-09-29, #7278). Maps to merge=exampledelegations;
# loss-proof union by exact record (never by taskId → re-delegations preserved), version=max.
EXAMPLEDELEG_DRIVER="$REPO/scripts/merge-example-delegations.py"
if [ -x "$EXAMPLEDELEG_DRIVER" ]; then
  git config merge.exampledelegations.name "example-delegations loss-proof record-union merge" 2>/dev/null || true
  git config merge.exampledelegations.driver "python3 $EXAMPLEDELEG_DRIVER %O %A %B %P" 2>/dev/null || true
fi

# --- self-register the keep-ours driver for generated report artifacts (idempotent) ---
# docs/process/audits/** (self-heal.sh + system-audit.sh reports) are regenerated wholesale
# each run on BOTH machines under the SAME date-keyed filename, so a plain 3-way merge
# conflicts every tick. Because .md is AI-resolvable, each conflict re-dispatched a full
# smith-resolve + warden-review — ~20 lane dispatches in 2h on one file (#526). Maps to
# merge=keepours in .gitattributes; the `true` built-in exits 0 leaving OUR side, so the
# merge resolves deterministically with no conflict and the next generation reconciles the
# file. No script needed — `true` is always present.
git config merge.keepours.name "keep-ours for regenerated report artifacts (#526)" 2>/dev/null || true
git config merge.keepours.driver "true" 2>/dev/null || true

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
# #4197: an in-place clone left OFF `main` — e.g. a headless dispatch that branched here and was
# interrupted before returning — makes this guard skip EVERY tick, silently, forever. That is the
# T-SYNC-10 divergence class turned inward: the local checkout stops syncing and nobody notices.
# Count consecutive off-main skips and fire the standard fleet alert ONCE past a threshold so a
# stranded clone surfaces instead of rotting. ALERT-ONLY — never auto-return-to-main under load
# (proven racy: a live session may be mid-operation on this branch). Env: OPENCLAW_SYNC_OFFMAIN_ALERT_TICKS.
OFFMAIN_COUNT_FILE="$LOCK_DIR/git-sync-offmain.count"
OFFMAIN_ALERT_THRESHOLD="${OPENCLAW_SYNC_OFFMAIN_ALERT_TICKS:-20}"
CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$CUR_BRANCH" != "$BRANCH" ]; then
  _off_n=$(cat "$OFFMAIN_COUNT_FILE" 2>/dev/null); case "$_off_n" in ''|*[!0-9]*) _off_n=0;; esac
  _off_n=$((_off_n + 1)); echo "$_off_n" > "$OFFMAIN_COUNT_FILE" 2>/dev/null || true
  log "on '$CUR_BRANCH' not '$BRANCH' — skip (off-main tick $_off_n)"
  # Edge-fire exactly at the threshold so a persistent strand pings once, not every 5 min.
  if [ "$_off_n" -eq "$OFFMAIN_ALERT_THRESHOLD" ]; then
    log "off-main skip streak hit alert threshold ($_off_n ticks on '$CUR_BRANCH') — firing fleet alert"
    alert_discord "🟠 git-sync on $(hostname -s): local clone stuck OFF '$BRANCH' (on '$CUR_BRANCH') for $_off_n consecutive ticks — auto-sync is skipping and the checkout may be stranded (e.g. a headless dispatch that branched and never returned). Return it to '$BRANCH' or investigate; see $LOG."
  fi
  exit 0
fi
# Back on main — clear any off-main skip streak so the next divergence alerts fresh.
rm -f "$OFFMAIN_COUNT_FILE" 2>/dev/null || true

# --- guard 2: bail to a clean tree if a prior run left a merge/rebase open -----
if [ -f .git/MERGE_HEAD ] || [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  # Audit 2026-10-01 (findings 5 / 24, security 4): this clone is shared with live sessions. A
  # session that stopped on a merge conflict and is resolving it BY HAND in the working tree has
  # exactly this signature, and an abort here throws its resolution away (the #2900 guard pins
  # commits, not an uncommitted resolution). The daemon cannot tell its own leftover from a peer's
  # in-flight merge by presence alone, so apply the same liveness rule HEAD.lock already uses: a
  # merge state YOUNGER than one tick interval (MERGE_STATE_GRACE, default 900s) is treated as live
  # and the tick steps aside (exit 0, benign); an older one is the stale leftover this guard exists
  # for and is aborted as before.
  _merge_state_path=".git/MERGE_HEAD"
  [ -f "$_merge_state_path" ] || { [ -d .git/rebase-merge ] && _merge_state_path=".git/rebase-merge"; } \
    || { [ -d .git/rebase-apply ] && _merge_state_path=".git/rebase-apply"; }
  _merge_state_age=$(( $(date +%s) - $(portable_mtime "$_merge_state_path" || echo 0) ))
  if [ "$_merge_state_age" -lt "${MERGE_STATE_GRACE:-900}" ]; then
    log "merge/rebase in progress at $_merge_state_path is fresh (${_merge_state_age}s < ${MERGE_STATE_GRACE:-900}s) — likely a live session resolving it; leaving it alone, skip this cycle"
    exit 0
  fi
  log "merge/rebase in progress from a prior run (state age ${_merge_state_age}s) — aborting to clean tree, skip"
  # #2900: pin at-risk unpushed local commits under a durable ref BEFORE the abort so an
  # abort that regresses HEAD (esp. `rebase --abort` to a stale ORIG_HEAD) can never
  # silently drop them — then verify + surface any regression afterward.
  preserve_local_commits_before_abort
  git merge --abort >> "$LOG" 2>&1 || git rebase --abort >> "$LOG" 2>&1 || true
  # Self-heal a CORRUPT rebase-merge (missing head-name) that --abort cannot clear —
  # otherwise this guard trips every tick forever and the fleet's sync wedges silently
  # (reference_corrupt_rebase_merge_wedges_git_sync). The helper force-clears ONLY the
  # provably-safe signature; anything else it leaves for manual recovery.
  bash "$REPO/scripts/git-unwedge-corrupt-rebase.sh" "$REPO" >> "$LOG" 2>&1 || true
  verify_no_local_commit_loss_after_abort || true
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
# Same for a stale HEAD.lock (T-SYNC-13): an orphaned one blocks every commit/merge
# this tick, so reclaim it up front or step aside if a live op still holds it.
if ! heal_head_lock; then
  exit 0
fi

# --- keep Tier-1 projections fresh before staging ----------------------------
# Root-cause guard for the stale-projection class (#350): a session can mutate
# canonical tasks.json and commit without re-rendering task-queue.md / OPEN_TASKS
# / live-status / projects. The daemon would then push that inconsistent state to
# main. Re-rendering here every tick means any drift becomes a tracked change this
# tick (staged + committed below) and is self-healing for drift already on main.
# Idempotent and fail-soft: an invalid or mid-write tasks.json must never block a
# sync tick — CI (render diff --exit-code) and pre-merge-check remain the backstops.
if [ -f "$REPO/scripts/render-tier1-state.py" ]; then
  "$PYBIN" "$REPO/scripts/render-tier1-state.py" write >> "$LOG" 2>&1 \
    || log "render-tier1-state failed — skipping projection refresh this tick"
fi

# --- ff-first probe: know our divergence BEFORE deciding to commit (#3561) -----
# The tick used to commit local changes and only THEN pull. On a node holding nothing but
# governed-state churn (lease prunes, revision bumps, projection re-renders) that single
# commit converts what would have been a lossless FAST-FORWARD into a real 3-way merge.
# When that merge resolved lossily the #1605 silent-drop guard correctly refused the push
# and reset to PRE_PULL_HEAD — and the next tick re-committed the same churn and repeated.
# m2air 2026-08-18: behind=153, "-134 lines" on a receipts test file, every tick for hours,
# the box unable to receive ANY code. The guard was right; the merge should never have
# existed. So measure divergence here and let the commit decision below stand down.
#
# FAIL-OPEN by design: if the fetch fails (offline laptop, lock contention) _ffirst_known
# stays 0 and the tick behaves exactly as it did before this block.
_sync_ahead=0; _sync_behind=0; _ffirst_known=0; _ffirst_deferred=0
if git fetch -q origin "$BRANCH" >> "$LOG" 2>&1; then
  _sync_ahead=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)
  _sync_behind=$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)
  case "$_sync_ahead$_sync_behind" in *[!0-9]*) _sync_ahead=0; _sync_behind=0 ;; *) _ffirst_known=1 ;; esac
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
    #
    # #448: unstage ONLY the deletions — NOT everything. The old `git reset` (whole
    # index) also threw away legit governed-state ADDITIONS/MODIFICATIONS staged in the
    # same tick (e.g. a freshly created task), reopening the exact clobber window #447
    # closed at the caller. Now the additions/mods still commit; only the suspicious
    # deletions are held back (left deleted-but-unstaged in the working tree) for a
    # human to commit deliberately. Wipe protection is preserved (deletions never
    # auto-commit); durability is too (no staged addition is ever silently discarded).
    log "REFUSING auto-commit of $DELETED_COUNT staged deletions (> $DELETE_LIMIT) — looks like a partial-tree wipe. Unstaging the DELETIONS ONLY; additions/modifications still commit. Commit bulk deletes manually."
    printf '%s\n' "$DELETED" | grep . | while IFS= read -r _del; do
      git reset -q -- "$_del" >> "$LOG" 2>&1 || true
    done
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
      # #995 F1: batch the lease/liveness firehose. Commit now on a meaningful delta or once the
      # heartbeat interval (~30m) has elapsed; a churn-only tick (lease/claims/projection bumps)
      # DEFERS and leaves its changes staged for a later tick — leases stay valid ~45m so cross-
      # machine reads are never stale. Fail-safe: any classifier error → commit (rc != 10).
      # Kill-switch: OPENCLAW_AUTOSYNC_BATCH=0 restores commit-every-tick behavior.
      _autosync_commit=1
      # The heartbeat marker is advanced AFTER a successful `git commit` (mark_autosync_commit), never
      # on the classifier's decision: ff-first below can override a COMMIT verdict, and a marker that
      # moved without a commit made lease-only state wait a whole extra heartbeat (audit 2026-10-01,
      # findings 15 / 23). The decision script no longer takes --mark-on-commit from the daemon.
      if [ "${OPENCLAW_AUTOSYNC_BATCH:-1}" = "1" ] && [ -f "$REPO/scripts/autosync-commit-decision.py" ]; then
        "$PYBIN" "$REPO/scripts/autosync-commit-decision.py" >> "$LOG" 2>&1
        _rc=$?
        [ "$_rc" = "10" ] && _autosync_commit=0
      fi
      # #3561 ff-first: take the update BEFORE creating a commit that would force a merge.
      # Deliberately placed AFTER the classifier so it also overrides the ~30m heartbeat
      # FORCE — the heartbeat is exactly what wedged m2air (the classifier had correctly
      # deferred the same churn for hours; the forced commit is the one that diverged us).
      # Requires _sync_ahead == 0: with no local commits an ff-only pull cannot discard
      # anything, so this is lossless. A node holding REAL local commits (ahead > 0) is
      # untouched and still merges + pushes exactly as before.
      # Nothing is dropped by deferring: the staged changes stay in the tree, get stashed
      # before the pull, are restored after it, and commit on the next tick as a plain
      # fast-forward push. Self-clearing — once the pull lands, behind is 0 and this
      # condition is false.
      if [ "$_autosync_commit" = "1" ] && [ "$_ffirst_known" = "1" ] \
         && [ "$_sync_ahead" -eq 0 ] && [ "$_sync_behind" -gt 0 ]; then
        _autosync_commit=0
        _ffirst_deferred=1
        log "ff-first (#3561): behind=$_sync_behind with NO local commits — deferring this auto-commit so the pull below FAST-FORWARDS instead of manufacturing a merge the #1605 drop-guard would have to block. Staged changes are stashed/restored around the pull and committed AFTER it lands, this same tick (commit-after-pull)."
      fi
      if [ "$_autosync_commit" = "1" ]; then
        if git commit -m "[auto-sync] $TIMESTAMP" >> "$LOG" 2>&1; then
          mark_autosync_commit
          log "committed local changes ($DELETED_COUNT deletions, within limit)"
        else
          log "WARNING: auto-commit FAILED (see git output above) — staged changes held for a later tick"
        fi
      elif [ "${_ffirst_deferred:-0}" = "1" ]; then
        : # already logged the ff-first reason above; do not relabel it as a churn defer (audit finding 2)
      else
        log "deferred auto-commit (F1 batch): churn-only tick, heartbeat interval not elapsed — staged changes held for a later tick"
      fi
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
STASH_SHA=""
prune_autosync_stashes       # clear the daemon's own over-cap strays before adding a new one
prune_stale_foreign_stashes  # age out abandoned non-auto-sync stashes into the archive pipeline
DIRTY_AFTER_COMMIT=$(git status --porcelain)
if [ -n "$DIRTY_AFTER_COMMIT" ]; then
  # #886-daemon: DEFER while a session is actively editing. DIRTY_AFTER_COMMIT is the set of
  # uncommitted WORKING edits the daemon could NOT auto-commit above (source files, excluded
  # paths) — exactly the in-flight work a stash/pull/reset would sweep out from under a live
  # turn. If a Claude Edit/Write refreshed the session-editing marker within the TTL, skip this
  # tick entirely; the marker goes stale on its own when the turn ends, so sync resumes within
  # one tick. Committed work is unaffected (a clean tree never reaches this branch). This is the
  # non-hostile fix for "the daemon swept my work mid-turn" (Ant 2026-07-21). exit 0 = benign
  # skip (no failure alert). Env: OPENCLAW_EDIT_MARKER / OPENCLAW_EDIT_TTL (default 900s = the tick).
  _EDIT_MARKER="${OPENCLAW_EDIT_MARKER:-$HOME/.openclaw/session-editing}"
  _EDIT_TTL="${OPENCLAW_EDIT_TTL:-900}"
  if [ -f "$_EDIT_MARKER" ]; then
    _edit_mtime=$(portable_mtime "$_EDIT_MARKER" || echo 0)
    _edit_age=$(( $(date +%s) - _edit_mtime ))
    if [ "$_edit_age" -lt "$_EDIT_TTL" ]; then
      # #886b: max-drift CEILING. The per-tick defer above is correct in isolation, but
      # under sustained multi-session load the edit marker is refreshed EVERY tick and
      # never goes stale — so pull/push starve indefinitely. That is exactly how this
      # checkout diverged 298 commits ahead / 73 behind over 39h (2026-07-23 -> 24), which
      # silently fail-opened hooks whose files only existed upstream. Cap it: once local
      # drifts more than OPENCLAW_SYNC_MAX_DRIFT commits ahead OR behind origin, stop
      # deferring and let the normal stash -> pull -> push below run. The stash/restore
      # machinery still protects in-flight edits, and a genuinely un-automergeable
      # divergence escalates via the existing abort+alert path instead of hiding forever.
      _MAXDRIFT="${OPENCLAW_SYNC_MAX_DRIFT:-40}"
      git fetch --quiet origin "$BRANCH" 2>/dev/null || true
      _ahead=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo 0)
      _behind=$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)
      if [ "${_ahead:-0}" -lt "$_MAXDRIFT" ] && [ "${_behind:-0}" -lt "$_MAXDRIFT" ]; then
        # #886c (2026-09-11): the defer exists to protect in-flight SOURCE edits from a stash/pull
        # sweep. It must NOT strand regenerable merge-driver STATE — above all fleet-sessions.jsonl,
        # which the publisher rewrites every ~60s. The old code exit-0'd here before pushing, so on
        # an always-busy machine (marker never goes stale) the state commit this tick just made
        # never reached origin; the 6h publish TTL then aged out cross-machine rows and every
        # machine's MetisTerm roster collapsed to own-machine-only. Two safe releases before we
        # defer, NEITHER of which touches the working tree (so in-flight source is never at risk):
        #   (A) ff-push the [auto-sync] state commit(s) this tick already made, when 0-behind — a
        #       plain push moves no files. Restricted to the daemon's OWN [auto-sync] commits so a
        #       human's ungated SOURCE commit is never force-shipped past the pre-push gate.
        #   (B) if there is NO dirty source at all (only regenerable state is dirty), don't defer —
        #       fall through to the normal stash -> pull -> push (restore_stash drops churn-only
        #       stash conflicts, so nothing in-flight is at risk).
        _dirty_source=1   # conservative default: classifier unavailable -> treat as source, defer
        if [ "${#SOURCE_EXCLUDES[@]}" -gt 0 ] 2>/dev/null; then
          _dirty_source=$(git status --porcelain -- . "${SOURCE_EXCLUDES[@]}" 2>/dev/null | grep -c . || true)
        fi
        if [ "${_behind:-0}" -eq 0 ] && [ "${_ahead:-0}" -gt 0 ]; then
          _nonauto=$(git log --format='%s' "origin/$BRANCH..HEAD" 2>/dev/null | grep -cv '^\[auto-sync\]' || true)
          if [ "${_nonauto:-1}" -eq 0 ]; then
            # Gated like every other push to $BRANCH (audit finding 21): memory is STATE, so an
            # [auto-sync] commit can carry an over-cap or dangling-link memory file; this site used
            # to ship it past the gate. A RED/unrunnable gate just leaves the commit for the normal
            # gated path below on a later tick — never an ungated push.
            if [ "${OPENCLAW_SYNC_PREPUSH_GATE:-1}" = "1" ] && ! run_prepush_gate; then
              log "#886c(A): pre-push gate RED/unavailable for the state ff-push — NOT pushing ungated; the state commit(s) wait for a clean gate"
            elif push_with_timeout push origin "$BRANCH"; then
              log "#886c(A): pushed ${_ahead} [auto-sync] state commit(s) before deferring pull — ledger/governed state propagate during the active-edit tick (working tree untouched)"
            else
              log "#886c(A): safe ff-push of state commit(s) failed/raced — will retry next tick"
            fi
          fi
        fi
        if [ "${_dirty_source:-1}" -ne 0 ]; then
          log "active edit session (marker ${_edit_age}s < ${_EDIT_TTL}s TTL) + uncommitted SOURCE edits — deferring stash/pull this tick to avoid sweeping in-flight work (#886)"
          exit 0
        fi
        log "active edit session (marker ${_edit_age}s) but only regenerable STATE churn is dirty — NOT deferring, so the ledger + governed state still propagate this tick (#886c-B)"
      else
        log "defer CEILING hit (#886b): drift ahead=${_ahead}/behind=${_behind} >= ${_MAXDRIFT} — forcing reconcile despite active edit marker (stash protects in-flight work; conflicts escalate via abort+alert)"
      fi
    fi
  fi
  STASH_MSG="auto-sync pre-pull stash $TIMESTAMP"
  # Give a transient LIVE index.lock (a concurrent session's git op on this shared clone)
  # up to ~1.8s to clear so the stash below doesn't needlessly degrade to a dirty-tree
  # pull under load (#0728). On timeout this is a no-op and the existing fallback runs.
  wait_for_index_lock || true
  if git stash push --include-untracked -m "$STASH_MSG" >> "$LOG" 2>&1; then
    # Identify OUR stash by its unique timestamped message, not by position: a concurrent session's
    # `git stash` in the sub-second window after ours would otherwise make stash@{0} a FOREIGN stash
    # that the daemon then pops and may drop (audit 2026-10-01 finding 6). Fall back to position only
    # if the message lookup finds nothing (older git formats).
    STASH_REF=$(git stash list --format='%gd %gs' 2>/dev/null | awk -v m="$STASH_MSG" 'index($0, m){print $1; exit}')
    [ -n "$STASH_REF" ] || STASH_REF=$(git stash list | head -1 | cut -d: -f1)   # e.g. stash@{0}
    STASH_SHA=$(git rev-parse "$STASH_REF" 2>/dev/null)   # stable identity for restore
    DIRTY_COUNT=$(printf '%s\n' "$DIRTY_AFTER_COMMIT" | grep -c .)
    log "stashed $DIRTY_COUNT file(s) before pull (ref: $STASH_REF, sha: ${STASH_SHA:0:8})"
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
      restore_stash || true
      rm -f "$PULL_OUT"
      exit 0
    fi
  fi
  if [ -f "$PULL_OUT" ] && grep -q 'HEAD.lock' "$PULL_OUT"; then
    if heal_head_lock; then
      log "pull hit stale HEAD.lock — retrying once after cleanup"
      if git pull --no-rebase origin "$BRANCH" > "$PULL_OUT" 2>&1; then
        rm -f "$PULL_OUT"
      else
        cat "$PULL_OUT" >> "$LOG"
      fi
    else
      log "pull blocked by live HEAD.lock holder — skipping this cycle, will retry next tick"
      restore_stash || true
      rm -f "$PULL_OUT"
      exit 0
    fi
  fi
  # A tree write that RACED in between the commit above and this pull (the ~60s
  # fleet-session-publish rewrite of fleet-sessions.jsonl is the usual one) makes git refuse
  # the merge outright: "Your local changes ... would be overwritten by merge". No merge has
  # started, so this is not a conflict — but it fell through to the Tier-3 "unresolved
  # conflict" abort, exit 1, every tick the publisher won the race: <<MACHINE_1_ID>> sat 19 behind
  # origin and reverted a deploy-script ff twice (2026-10-12). Stash ONLY the paths git names
  # (never the whole tree — in-flight source edits elsewhere stay put, per the #886 defer) and
  # retry once; the normal restore_stash below pops them back after the merge.
  if [ -f "$PULL_OUT" ] && grep -q 'would be overwritten by merge' "$PULL_OUT" && [ -z "${STASH_SHA:-}" ]; then
    _raced=$(awk '/would be overwritten by merge/{f=1;next} /^Please commit|^Aborting/{f=0} f && /^[[:space:]]/{gsub(/^[[:space:]]+/,""); print}' "$PULL_OUT")
    if [ -n "$_raced" ]; then
      STASH_MSG="auto-sync race stash $TIMESTAMP"
      # shellcheck disable=SC2086  # one path per line, none contain spaces (repo convention)
      if git stash push -m "$STASH_MSG" -- $_raced >> "$LOG" 2>&1; then
        STASH_REF=$(git stash list --format='%gd %gs' 2>/dev/null | awk -v m="$STASH_MSG" 'index($0, m){print $1; exit}')
        STASH_SHA=$(git rev-parse "$STASH_REF" 2>/dev/null)
        log "pull blocked by a tree write that raced the commit ($(printf '%s' "$_raced" | tr '\n' ' ')) — stashed those path(s) only, retrying once"
        if git pull --no-rebase origin "$BRANCH" > "$PULL_OUT" 2>&1; then
          rm -f "$PULL_OUT"
        else
          cat "$PULL_OUT" >> "$LOG"
        fi
      fi
    fi
  fi
  if [ -f "$PULL_OUT" ] && [ -s "$PULL_OUT" ]; then
    if grep -qiE 'could not resolve host|could not read from remote|unable to access|connection (refused|timed out)|operation timed out|network is (unreachable|down)|temporary failure in name resolution' "$PULL_OUT"; then
      log "remote unreachable (offline) — skipping this cycle, will retry next tick"
      restore_stash || true
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
        restore_stash || true
        rm -f "$PULL_OUT"
        exit 1
      fi
      if git commit --no-edit >> "$LOG" 2>&1; then
        log "pull conflict auto-resolved (rerere/merge-driver) — merge completed ($(git rev-parse --short HEAD))"
        # fall through to stash-restore + push below
      else
        log "rerere recovery: merge commit failed — aborting to clean tree"
        git merge --abort >> "$LOG" 2>&1 || true
        restore_stash || true
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
        restore_stash || true
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
# SOURCE deletions ONLY. Without the exclusions this counted governed/ephemeral STATE as source,
# and that is not hypothetical: on 2026-08-17 a routine cleanup of 8
# docs/process/state/relay-requests/*.json files read as "8 source files deleted (> 5)", so <<MACHINE_2_ID>>
# refused the pull and reset to PRE_PULL_HEAD on EVERY tick — 106 resets in one day. It could
# neither land its own 22 commits nor durably receive any incoming code (it briefly pulled the
# fleet-health reporting code and the next reset rolled it straight back off), and it was silent.
# A guard that resets the tree must measure the thing it claims to measure: SOURCE_EXCLUDES is the
# repo's canonical state-vs-source split (scripts/lib/source-pathspec.sh), already sourced above.
MERGE_DELETED=$(git diff --diff-filter=D --name-only "$PRE_PULL_HEAD" HEAD -- \
  '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.py' '*.sh' '*.css' '*.html' '*.json' \
  "${SOURCE_EXCLUDES[@]}" 2>/dev/null)
MERGE_DELETED_COUNT=$(printf '%s\n' "$MERGE_DELETED" | grep -c .)
if [ "$MERGE_DELETED_COUNT" -gt "$DELETE_LIMIT" ]; then
  log "REFUSING push: incoming pull-merge deleted $MERGE_DELETED_COUNT source files (> $DELETE_LIMIT) — suspected cross-session clobber (T-SYNC-11). Resetting to pre-pull $PRE_PULL_HEAD; manual review needed."
  printf '%s\n' "$MERGE_DELETED" >> "$LOG"
  git reset --hard "$PRE_PULL_HEAD" >> "$LOG" 2>&1 || true
  # #4861: this refuse-path exits before the restore_stash below, so pop THIS tick's stash now
  # or the operator's pre-pull uncommitted edits are stranded. The reset put the tree back at
  # PRE_PULL_HEAD — the stash's own base — so the pop applies cleanly (and on the unexpected
  # conflict restore_stash still leaves a clean tree + preserves the stash, never wedging).
  restore_stash || true
  exit 1
fi

# --- guard #1605: silent delete-vs-unmodified / merge-artifact drop protection --
# T-SYNC-11 above only catches a BULK (>DELETE_LIMIT) whole-file wipe of specific
# extensions in one tick. It misses the data-loss class that actually recurred: a merge
# (delete-vs-unmodified, or the Tier-3 AI resolver / rerere) silently removing a file or a
# large block that NO explicit non-merge commit deleted — no conflict, so no marker guard or
# resolver ever sees it. audit_silent_drops attributes each removal: an intentional delete has
# a non-merge delete commit in the incoming range (allowed); a merge-artifact drop has none
# (refused). Precise (catches even ONE silent drop; never resurrects a deliberately-deleted
# file). Refuse+reset+alert, exactly like T-SYNC-11. Fail-open only if the lib is missing.
if [ "$(git rev-parse HEAD)" != "$PRE_PULL_HEAD" ] && command -v audit_silent_drops >/dev/null 2>&1; then
  SILENT_DROPS=$(audit_silent_drops "$PRE_PULL_HEAD" "$(git rev-parse HEAD)")
  if [ -n "$SILENT_DROPS" ]; then
    SILENT_N=$(printf '%s\n' "$SILENT_DROPS" | grep -c .)
    OFFENDING_MERGE=$(git rev-parse HEAD)
    # Resetting is right either way — this node refuses to build on a lossy merge — but it only
    # UNDOES the drop when the merge was this node's own. If the merge is already published, origin
    # still has it and the next tick pulls it straight back, so "manual merge needed" sends the
    # operator after something a reset cannot achieve. Say heal-forward instead: restore the paths
    # on top of the published merge and push that, which is also what propagates the fix.
    _drop_published=false
    if git rev-parse --verify -q "origin/$BRANCH" >/dev/null 2>&1 \
       && git merge-base --is-ancestor "$OFFENDING_MERGE" "origin/$BRANCH" 2>/dev/null; then
      DROP_FIX="already published on origin/$BRANCH, so a reset cannot clear it — restore the path(s) on top of ${OFFENDING_MERGE:0:8} and push that"
      _drop_published=true
    else
      DROP_FIX="manual merge needed"
    fi
    # #4861 finding 6: on the ONE designated heal-forward node, AUTO-heal a PUBLISHED drop rather
    # than refuse forever — restore the dropped paths on top of the published merge (HEAD) and let
    # the push carry the fix fleet-wide. Any OTHER node, an UNPUBLISHED drop (a reset genuinely
    # clears that — re-minting it as a heal would be wrong), or a heal that restored nothing falls
    # through to the unchanged refuse+reset+page path.
    if [ "$_drop_published" = true ] && is_heal_forward_node \
       && heal_forward_drops "$PRE_PULL_HEAD" "$OFFENDING_MERGE" "$SILENT_DROPS"; then
      log "HEAL-FORWARD (#1605/#4861): auto-healed $SILENT_N published silently-dropped path(s) on top of ${OFFENDING_MERGE:0:8}; pushing the fix (this is the designated heal-forward node)."
      printf '%s\n' "$SILENT_DROPS" >> "$LOG"
      if [ "$(cat "$DROP_MARKER" 2>/dev/null || true)" = "healed:$OFFENDING_MERGE" ]; then
        log "heal-forward already applied for ${OFFENDING_MERGE:0:8} — staying quiet"
      else
        printf 'healed:%s\n' "$OFFENDING_MERGE" > "$DROP_MARKER"
        alert_discord "🟠 git-sync HEAL-FORWARD on $(hostname -s) (#1605/#4861): restored $SILENT_N silently-dropped path(s) on top of published merge ${OFFENDING_MERGE:0:8}, pushing the fix. Paths: $(printf '%s' "$SILENT_DROPS" | tr '\n' ' ')"
      fi
      # fall through to restore_stash + push below — deliberately NOT reset/exit.
    else
      log "REFUSING push: incoming merge SILENTLY dropped $SILENT_N tracked path(s) with no explicit delete commit (delete-vs-unmodified / resolver artifact, #1605). Resetting to pre-pull $PRE_PULL_HEAD; $DROP_FIX."
      printf '%s\n' "$SILENT_DROPS" >> "$LOG"
      git reset --hard "$PRE_PULL_HEAD" >> "$LOG" 2>&1 || true
      # #4861: pop THIS tick's stash before the exit-1 below (same reason as T-SYNC-11) — the
      # reset returned the tree to the stash's PRE_PULL_HEAD base, so the pop applies cleanly.
      restore_stash || true
      if [ "$(cat "$DROP_MARKER" 2>/dev/null || true)" = "$OFFENDING_MERGE" ]; then
        log "silent-drop refusal repeats the previous tick's merge (${OFFENDING_MERGE:0:8}) — already alerted, staying quiet (#4621)"
      else
        printf '%s\n' "$OFFENDING_MERGE" > "$DROP_MARKER"
        alert_discord "🔴 git-sync BLOCKED a silent delete-vs-unmodified drop of $SILENT_N path(s) on $(hostname -s) (#1605) — reset to ${PRE_PULL_HEAD:0:8}; $DROP_FIX. Paths: $(printf '%s' "$SILENT_DROPS" | tr '\n' ' ')"
      fi
      exit 1
    fi
  fi
fi

# --- restore stashed edits after a successful pull ----------------------------
# restore_stash pops ONLY our own stash by SHA; on conflict it leaves a CLEAN tree
# (no markers to wedge the next tick's guard) and preserves the stash, returning 1.
restore_stash || exit 1   # don't push — manual resolution needed, tree left clean

# --- commit-after-pull: land the state ff-first deferred, THIS tick (audit 2026-10-01 finding 2) --
# ff-first's "self-clearing" assumption (once the pull lands, behind is 0 next tick) does not hold on
# a busy fleet: a peer pushes between almost every pair of ticks, so behind was 1-3 at nearly every
# probe and the deferral repeated for hours (measured: 1887 deferrals, streaks of 81 / 58 ticks with
# the classifier saying "meaningful delta" every time). The pull just fast-forwarded and the stash
# was restored, so committing now and pushing is a plain ff with ahead=0 — exactly the lossless
# shape ff-first wanted. The same staging rules apply (state-only under split lanes, no conflict
# markers, no bulk/protected deletions); anything unsafe is simply left for the next tick.
if [ "${_ffirst_deferred:-0}" = "1" ] && [ -z "${SKIP_COMMIT:-}" ] && [ -n "$(git status --porcelain)" ]; then
  if [ "$OPENCLAW_SPLIT_LANES" = "1" ]; then git_add_state; else git add -A -- ':(exclude)workspace/lanes'; fi
  _cap_unsafe=0
  _cap_del=$(git diff --cached --diff-filter=D --name-only)
  [ "$(printf '%s\n' "$_cap_del" | grep -c .)" -gt "$DELETE_LIMIT" ] && _cap_unsafe=1
  for p in "${PROTECTED[@]}"; do printf '%s\n' "$_cap_del" | grep -qxF "$p" && _cap_unsafe=1; done
  git diff --cached -U0 | grep -qE '^\+(<<<<<<< |>>>>>>> )' && _cap_unsafe=1
  if [ -z "$(git diff --cached --name-only)" ]; then
    : # the pull already carried everything we had staged — nothing left to commit
  elif [ "$_cap_unsafe" = "1" ]; then
    log "commit-after-pull: staged set is unsafe to auto-commit (bulk/protected deletion or conflict markers) — unstaging, held for next tick"
    git reset >> "$LOG" 2>&1 || true
  elif git commit -m "[auto-sync] $TIMESTAMP" >> "$LOG" 2>&1; then
    mark_autosync_commit
    log "commit-after-pull (ff-first): committed the state deferred before the fast-forward — pushes this tick as a plain ff instead of waiting for a quiet fleet"
  else
    log "commit-after-pull: commit failed (see git output above) — staged changes held for next tick"
  fi
fi

# --- T-SYNC-15: re-render Tier-1 projections after a merge (consistency before gate) --
# The rendered projections (task-queue.md / OPEN_TASKS.md / live-status.md / projects.md)
# now resolve keep-ours on a merge conflict (.gitattributes merge=keepours) — that ends the
# smith-timeout wedge that stranded <<MACHINE_2_ID>>, but keep-ours leaves them matching OUR pre-merge
# tasks.json, not the merged one (the taskstate driver may have folded in the peer's task
# changes). The always-on render-consistency pre-push gate (autosync_prepush_gate.py →
# render-tier1-state.py diff --exit-code) would then RED-refuse the push. So whenever the pull
# actually changed HEAD, re-render from the merged state and fold any projection drift into a
# commit — the pushed board is consistent, and the wedge cannot resurface as a gate-block.
# Idempotent + fail-soft: no drift → no commit; a render failure never blocks the push below.
if [ "$(git rev-parse HEAD)" != "$PRE_PULL_HEAD" ] && [ -f "$REPO/scripts/render-tier1-state.py" ]; then
  "$PYBIN" "$REPO/scripts/render-tier1-state.py" write >> "$LOG" 2>&1 \
    || log "post-merge re-render failed — pre-push render-consistency gate remains the backstop"
  PROJECTION_PATHS=(docs/process/task-queue.md docs/process/live-status.md \
                    docs/process/projects.md workspace/state/OPEN_TASKS.md)
  if [ -n "$(git status --porcelain -- "${PROJECTION_PATHS[@]}")" ]; then
    git add -- "${PROJECTION_PATHS[@]}" >> "$LOG" 2>&1 || true
    if [ -n "$(git diff --cached --name-only)" ]; then
      git commit -m "[auto-sync] re-render projections after merge $TIMESTAMP" >> "$LOG" 2>&1 \
        && log "re-rendered Tier-1 projections to match merged tasks.json"
    fi
  fi
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
    if [ -n "$_src_tree" ]; then
      _autosync_parent=$(git rev-parse --verify "refs/heads/$AUTOSYNC_BRANCH" 2>/dev/null || git rev-parse HEAD)
      _autosync_tree=$(git rev-parse "${_autosync_parent}^{tree}" 2>/dev/null || echo "")
      # #3893 Part 2: carry autosync-tip-only source files forward so a working-tree reset can't
      # silently drop them from the durability tip. Index-scoped + non-blocking; inert when nothing
      # tip-only is dropping. Kill-switch: OPENCLAW_SOURCE_SNAPSHOT_PRESERVE_TIPONLY=0.
      if [ "${OPENCLAW_SOURCE_SNAPSHOT_PRESERVE_TIPONLY:-1}" = "1" ]; then
        _src_tree=$(preserve_tiponly_source_tree "$_src_idx" "$_autosync_tree" "$_src_tree" "$LOG")
      fi
      rm -f "$_src_idx"
      if [ "$_src_tree" != "$_autosync_tree" ]; then
        _src_commit=$(git commit-tree -p "$_autosync_parent" -m "[auto-sync source] $TIMESTAMP" "$_src_tree" 2>>"$LOG" || true)
        if [ -n "$_src_commit" ]; then
          git update-ref "refs/heads/$AUTOSYNC_BRANCH" "$_src_commit" 2>>"$LOG" \
            || log "source-snap: update-ref failed (will retry next tick)"
          if push_with_timeout push origin "$AUTOSYNC_BRANCH"; then
            log "source-snap: pushed $AUTOSYNC_BRANCH ($(git rev-parse --short "$_src_commit" 2>/dev/null || echo '?'))"
          else
            log "source-snap: push of $AUTOSYNC_BRANCH failed (non-fatal; local ref durable, retries next tick)"
          fi
        fi
      fi
    else
      rm -f "$_src_idx"
    fi
  else
    rm -f "$_src_idx"
    log "source-snap: scratch-index staging failed — skipping source snapshot this tick"
  fi
fi

# --- #471 pre-push gate: never auto-push a RED tree to main ---------------------
# The daemon pushes to main OUTSIDE PR CI, so a stale projection / untagged memory / red
# test that rides this path lands unverified (#438 left two reds on main that blocked every
# cloud merge until hand-repaired). Run the FAST mirror of the gating CI jobs and REFUSE the
# push on red — alerting once per incident like any other sync failure (the recovery ping
# below clears it on the next clean push). Kill-switch: OPENCLAW_SYNC_PREPUSH_GATE=0.
# The memory-limits red is the ONE gate class that is deterministically self-fixable, so it gets
# an auto-heal below instead of only a page. This marker bounds that heal to ONCE per incident
# (cleared on the next clean gate) so a non-retirable over-cap file can't loop memory-maintain
# every tick. Defined out here so the clean-gate path can clear it.
MEMHEAL_MARKER="$LOCK_DIR/git-sync.memheal"
if [ "${OPENCLAW_SYNC_PREPUSH_GATE:-1}" = "1" ]; then
  # The gate's output is captured to a per-tick file (still teed to $LOG) so the heal branch can see
  # WHICH check reddened without re-grepping the ever-growing log.
  run_prepush_gate; _gate_rc=$?
  if [ "$_gate_rc" -ne 0 ]; then
    # rc 1 = the tree really is red. rc 2 = the GATE ITSELF could not run (it fails closed by
    # design). Both block the push, but they need different humans doing different things, and
    # calling a crashed gate "RED" sends whoever reads this log hunting for failing tests that do
    # not exist. A check must never describe its own breakage as the thing it was checking for.
    if [ "$_gate_rc" -eq 2 ]; then
      log "ERROR: pre-push gate COULD NOT RUN (rc=2, failing closed) — refusing to push $BRANCH. This is a gate/infra fault on THIS node, not a red tree: look for the 'gate: internal error' line above (missing dep, unreadable repo, bad PYBIN='$PYBIN'). Work will strand here until it is fixed."
    else
      log "ERROR: pre-push gate RED — refusing to push $BRANCH (see gate output above)"
      # #memheal auto-heal: memory-limits is the ONE red-gate class that is DETERMINISTICALLY
      # self-fixable — MEMORY.md over its byte cap (>23500/>24400) clears by retiring closed
      # #active entries, which is exactly the sanctioned `memory-maintain.py --apply` pass. Left
      # to page-only, a trivially-fixable cap strands the WHOLE fleet's main-sync for hours: on
      # 2026-09-17 <<MACHINE_1_ID>> piled up 45 unpushed commits behind a 24296-byte MEMORY.md until it was
      # hand-trimmed. So do it automatically, ONCE per incident (MEMHEAL_MARKER), and let the next
      # tick re-gate. An over-60-line file that --apply CANNOT trim produces no commit → we fall
      # through and page exactly as before (that class genuinely needs a human). Kill: OPENCLAW_SYNC_MEMHEAL=0.
      if [ "${OPENCLAW_SYNC_MEMHEAL:-1}" = "1" ] \
         && grep -q '\[memory-limits\] FAILED' "$_gate_out" 2>/dev/null \
         && [ ! -f "$MEMHEAL_MARKER" ] \
         && [ -f "$REPO/ClaudeCode/scripts/memory-maintain.py" ]; then
        date '+%Y-%m-%d %H:%M:%S' > "$MEMHEAL_MARKER"
        _pre_heal="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)"
        log "pre-push gate RED on memory-limits — running sanctioned auto-heal (memory-maintain --apply --commit)"
        "$PYBIN" "$REPO/ClaudeCode/scripts/memory-maintain.py" --apply --commit >> "$LOG" 2>&1 || true
        _post_heal="$(git -C "$REPO" rev-parse HEAD 2>/dev/null)"
        if [ -n "$_post_heal" ] && [ "$_pre_heal" != "$_post_heal" ]; then
          log "memory-limits auto-heal committed a retire pass ($_post_heal) — next tick re-gates"
          alert_discord "🩹 git-sync auto-healed a memory-limits RED gate on $(hostname -s) — retired closed entries to clear the MEMORY.md cap (${_post_heal:0:8}); re-gating next tick."
        else
          log "memory-limits auto-heal: nothing retirable (likely an over-60-line file --apply can't trim) — leaving it to page"
        fi
      fi
    fi
    # No inline on_fail_edge here: the EXIT trap fires it for exit 1 (audit 2026-10-01 findings
    # 7 / 16 — the inline call double-counted every RED tick, so the "page after 3" grace was 2).
    exit 1
  fi
  rm -f "$MEMHEAL_MARKER" 2>/dev/null || true   # clean gate → incident over, re-arm future heals
fi

# The fleet git-health self-report (#3505) used to sit HERE, before the push. It now runs from the
# EXIT trap (see publish_git_health, top of file) so it also fires on the eleven `exit 1` guard
# paths above — the stranded states it exists to expose. Do not re-add an inline call: a node that
# reports only on healthy ticks is a node whose silence is indistinguishable from health.

# --- push ---------------------------------------------------------------------
if push_with_timeout push origin "$BRANCH"; then
  log "sync complete ($(git rev-parse --short HEAD))"
  rm -f "${FAIL_MARKER%.failing}.failcount"   # clean sync → reset the self-heal-grace counter
  if [ -f "$FAIL_MARKER" ]; then          # we were failing; this clean sync is the recovery edge
    rm -f "$FAIL_MARKER"
    alert_discord "🟢 git-sync RECOVERED on $(hostname -s) — back in sync at $(git rev-parse --short HEAD)"
  fi
  # Clearing here is correct ONLY because a stranding tick never reaches this line: restore_stash
  # returns 1 and the tick exits before the push. If stranding is ever made non-fatal, this clear
  # will run on the same tick that set the marker and the dedup above will silently stop working —
  # so that exit code is asserted in the #3685 scenario rather than left as an assumption.
  rm -f "$STRAND_MARKER" 2>/dev/null || true
  if [ -f "$DROP_MARKER" ]; then          # the silent-drop block cleared; say so explicitly
    rm -f "$DROP_MARKER"
    alert_discord "🟢 git-sync silent-drop block CLEARED on $(hostname -s) (#1605) — syncing again at $(git rev-parse --short HEAD)"
  fi
  # --- #7368 deploy-now: reload the dashboard when synced code changed its backend --------
  # The FastAPI dashboard is SERVED from this checkout, but ant.dashboard's KeepAlive only keeps
  # the PROCESS alive — nothing reloads code after a pull lands new backend commits. So after any
  # dashboard push <<MACHINE_1_ID>> kept serving the STALE build until a hand-run restart-dashboard.sh (the
  # Metis Learn catalog-404 this session: app/routers/learn.py reached origin, <<MACHINE_1_ID>> served the
  # old routes for ~15 min). Restart exactly when the dashboard's loaded backend differs from HEAD,
  # and only on the node that actually runs it. Runs only on THIS success path — gate-passed code
  # that reached origin, never a tree a guard is about to reset. The pull-side RECONCILE is already
  # durable (git-sync-divergence-watch auto-invokes git-sync-unwedge every ~10 min); this closes the
  # remaining deploy-lag. Content-addressed on the app/ subtree object id, which changes iff app/
  # changed → no thrash on no-op ticks; the marker is advanced BEFORE the restart so a flaky smoke
  # can never loop the restart (at most one attempt per code version). Kill: OPENCLAW_SYNC_DASHBOARD_DEPLOY=0.
  if [ "${OPENCLAW_SYNC_DASHBOARD_DEPLOY:-1}" = "1" ] && [ -f "$HOME/Library/LaunchAgents/ant.dashboard.plist" ]; then
    _dash_tree=$(git rev-parse -q --verify "HEAD:projects/dashboard/app" 2>/dev/null || true)
    _dash_marker="$LOCK_DIR/dashboard.deployed-tree"
    _dash_prev=$(cat "$_dash_marker" 2>/dev/null || true)
    if [ -n "$_dash_tree" ] && [ "$_dash_tree" != "$_dash_prev" ]; then
      if [ -z "$_dash_prev" ]; then
        # First run on this node: assume the live process already matches HEAD; seed, don't restart.
        printf '%s\n' "$_dash_tree" > "$_dash_marker"
        log "deploy-now: seeded dashboard deploy marker (${_dash_tree:0:12}) — no restart on first observation"
      else
        log "deploy-now: dashboard backend changed (${_dash_prev:0:12} -> ${_dash_tree:0:12}) — restarting to serve it"
        printf '%s\n' "$_dash_tree" > "$_dash_marker"   # advance FIRST: one attempt per code version, never a restart loop
        if bash "$REPO/scripts/restart-dashboard.sh" >> "$LOG" 2>&1; then
          log "deploy-now: dashboard restarted + contract-verified onto ${_dash_tree:0:12}"
        else
          log "deploy-now: dashboard restart reported FAILURE onto ${_dash_tree:0:12} (see restart output above) — NOT looping; next backend change re-triggers"
        fi
      fi
    fi
  fi
else
  # #4861: a push can fail simply because a peer pushed between our pull and our push —
  # the branch moved under us. That is a benign race, not a broken node: next tick pulls
  # the peer's commit and pushes cleanly. Classify it like the offline case (restore the
  # stash, exit 0, no page) so on_fail_edge fires ONLY on a genuine push failure.
  # Match ONLY the unambiguous non-fast-forward signals — deliberately NOT the bare
  # "failed to push some refs" line, which also covers a pre-push HOOK/guard rejection
  # (e.g. #1605 drop-guard, sync-drop-audit) that MUST still page.
  if [ -s "$PUSH_OUT" ] \
     && grep -qiE '\((fetch first|non-fast-forward)\)|tip of your current branch is behind' "$PUSH_OUT"; then
    log "push lost a benign race (remote moved under us) — will pull + retry next tick"
    restore_stash || true
    exit 0
  fi
  log "ERROR: push failed"
  exit 1
fi
