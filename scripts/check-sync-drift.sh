#!/usr/bin/env bash
# Detect when a machine's LIVE git-sync script has drifted from the canonical
# repo-tracked copy. The 2026-05-30 corruption incident happened because hardened
# fixes (branch guard, marker guard) were documented as "deployed" but the live
# script on <<MACHINE_1_ID>> was still the old unguarded version. This catches that silently.
#
# Usage: scripts/check-sync-drift.sh   (exit 0 = in sync, 1 = drift/missing)
# Wire into session-start or a cron alert per machine.

. "$(dirname "$0")/lib/paths.env"
REPO="$METIS_HOME"
CANONICAL="$REPO/scripts/openclaw-git-sync.sh"
LIVE="$HOME/.local/bin/openclaw-git-sync.sh"
SYNC_LOG="${OPENCLAW_SYNC_LOG:-$HOME/.openclaw/logs/git-sync.log}"
STALE_MIN="${OPENCLAW_SYNC_STALE_MIN:-15}"   # warn if last successful sync is older than this (minutes)

rc=0

# --- drift check: live script content vs canonical -----------------------------
if [ ! -f "$LIVE" ]; then
  echo "DRIFT: live script missing at $LIVE — run: cp '$CANONICAL' '$LIVE' && chmod +x '$LIVE'"
  rc=1
elif [ ! -f "$CANONICAL" ]; then
  echo "DRIFT: canonical script missing at $CANONICAL (repo not synced?)"
  rc=1
elif diff -q "$CANONICAL" "$LIVE" >/dev/null 2>&1; then
  echo "OK: live git-sync matches canonical ($(git -C "$REPO" rev-parse --short HEAD 2>/dev/null))"
else
  echo "DRIFT: $LIVE differs from canonical $CANONICAL"
  echo "  review: diff '$CANONICAL' '$LIVE'"
  echo "  redeploy: cp '$CANONICAL' '$LIVE' && chmod +x '$LIVE'"
  rc=1
fi

# --- heartbeat check: is the sync actually RUNNING? ----------------------------
# Drift can't catch a script that matches canonical but silently no-ops every tick
# (e.g. the flock-on-macOS regression — sync skipped every tick, content unchanged).
# The script logs "sync complete" on every successful tick (~5 min), so a stale
# newest entry means the sync is dead. Surface it at session start.
last=$(grep 'sync complete' "$SYNC_LOG" 2>/dev/null | tail -1)
if [ -z "$last" ]; then
  echo "HEARTBEAT: no 'sync complete' ever logged in $SYNC_LOG — is the LaunchAgent loaded? (launchctl list | grep openclaw-git-sync)"
  rc=1
else
  # extract the leading [YYYY-MM-DD HH:MM:SS] and convert to epoch (BSD date — macOS)
  ts="${last#\[}"; ts="${ts%%\]*}"
  last_epoch=$(date -j -f '%Y-%m-%d %H:%M:%S' "$ts" +%s 2>/dev/null || echo 0)
  now_epoch=$(date +%s)
  age_min=$(( (now_epoch - last_epoch) / 60 ))
  if [ "$last_epoch" = "0" ]; then
    echo "HEARTBEAT: could not parse last sync timestamp ('$ts') — check $SYNC_LOG manually"
  elif [ "$age_min" -gt "$STALE_MIN" ]; then
    # A stale "sync complete" is not always a dead sync: during an active edit session the
    # daemon deliberately DEFERS stash/pull to avoid sweeping in-flight work (#886), so it
    # keeps ticking (and writing this log) but logs no completion until the turn ends. Only a
    # daemon that has ALSO stopped ticking (log file itself gone stale) is genuinely dead, so
    # a live daemon (fresh log) + a fresh session-editing marker is the benign deferral case,
    # not an alert. Mirrors the daemon's own #886 gate (OPENCLAW_EDIT_MARKER/_TTL).
    EDIT_MARKER="${OPENCLAW_EDIT_MARKER:-$HOME/.openclaw/session-editing}"
    EDIT_TTL="${OPENCLAW_EDIT_TTL:-900}"
    log_mtime=$(stat -f %m "$SYNC_LOG" 2>/dev/null || stat -c %Y "$SYNC_LOG" 2>/dev/null || echo 0)
    log_age_min=$(( (now_epoch - log_mtime) / 60 ))
    edit_age="$EDIT_TTL"
    if [ -f "$EDIT_MARKER" ]; then
      edit_mtime=$(stat -f %m "$EDIT_MARKER" 2>/dev/null || stat -c %Y "$EDIT_MARKER" 2>/dev/null || echo 0)
      edit_age=$(( now_epoch - edit_mtime ))
    fi
    if [ "$log_age_min" -le "$STALE_MIN" ] && [ "$edit_age" -lt "$EDIT_TTL" ]; then
      echo "OK: last full sync ${age_min}m ago, but the daemon is live (log ${log_age_min}m fresh) and an active edit session (${edit_age}s < ${EDIT_TTL}s) is deferring pulls (#886) — expected, not dead"
    else
      echo "HEARTBEAT: last successful sync was ${age_min}m ago (> ${STALE_MIN}m) — sync may be dead."
      echo "  check: tail -5 '$SYNC_LOG'; launchctl list | grep openclaw-git-sync"
      rc=1
    fi
  else
    echo "OK: last successful sync ${age_min}m ago (within ${STALE_MIN}m)"
  fi
fi

# --- daemon-stash accumulation check (T-SYNC-15 follow-on) ---------------------
# In healthy operation the daemon pops its "auto-sync pre-pull stash" within the same
# tick. A LINGERING one means a stash-pop conflict left it behind (orphaned-gitlink
# wedge, same-file race, etc.) — and they pile up silently, holding uncommitted work
# (5 accumulated by 2026-06-13, one holding a 515-line lane-output found nowhere else).
# Surface at session start and route to the reconciler instead of a manual `git stash`.
STASH_WARN="${OPENCLAW_STASH_WARN:-2}"
STASH_STALE_MIN="${OPENCLAW_STASH_STALE_MIN:-15}"
stash_rows=$(git -C "$REPO" stash list --format='%gd	%gs' 2>/dev/null | grep 'auto-sync pre-pull stash' || true)
daemon_stashes=$(printf '%s\n' "$stash_rows" | sed '/^$/d' | wc -l | tr -d ' ')
oldest_age_min=0
oldest_ref=""
if [ "${daemon_stashes:-0}" -gt 0 ]; then
  while IFS="$(printf '\t')" read -r ref subject; do
    [ -n "$ref" ] || continue
    ts=$(printf '%s\n' "$subject" | sed -nE 's/.*auto-sync pre-pull stash ([0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}).*/\1/p')
    [ -n "$ts" ] || continue
    stash_epoch=$(date -j -f '%Y-%m-%d %H:%M:%S' "$ts" +%s 2>/dev/null || echo 0)
    [ "$stash_epoch" = "0" ] && continue
    age_min=$(( (now_epoch - stash_epoch) / 60 ))
    if [ "$age_min" -gt "$oldest_age_min" ]; then
      oldest_age_min="$age_min"
      oldest_ref="$ref"
    fi
  done <<EOF_STASH_ROWS
$stash_rows
EOF_STASH_ROWS
fi
if [ "${daemon_stashes:-0}" -ge "$STASH_WARN" ] || [ "${oldest_age_min:-0}" -gt "$STASH_STALE_MIN" ]; then
  if [ "${daemon_stashes:-0}" -ge "$STASH_WARN" ]; then
    echo "STASH: $daemon_stashes orphaned daemon stashes accumulated (>= ${STASH_WARN}) — a stash-pop has been failing."
  else
    echo "STASH: daemon stash $oldest_ref is ${oldest_age_min}m old (> ${STASH_STALE_MIN}m) — a stash-pop has been failing."
  fi
  echo "  inventory: python3 '$REPO/scripts/reconcile-daemon-stashes.py'        (dry-run, safe)"
  echo "  reconcile: python3 '$REPO/scripts/reconcile-daemon-stashes.py' --apply (archive→recover→clear)"
  rc=1
elif [ "${daemon_stashes:-0}" -ge 1 ]; then
  echo "OK: $daemon_stashes daemon stash present but newest/oldest age is below ${STASH_STALE_MIN}m — likely mid-tick"
fi

# --- merge-driver registration guard (2026-07-09) ------------------------------
# The root cause of the recurring stuck-merge class: a high-churn file mapped to a custom
# merge=<driver> in .gitattributes whose driver is NOT registered in THIS clone's git config
# falls back to a raw 3-way merge -> conflict -> daemon wedge (MEMORY.md / working-context.md
# hit this twice on 2026-07-09; tasks.json #147; health-checks.json #437). Any driver named
# in .gitattributes but missing from `git config merge.<name>.driver` is the same latent bug.
# `union` is a git built-in and needs no registration. Self-heal by re-running the registrar.
unregistered=""
for drv in $(sed -nE 's/.*[[:space:]]merge=([A-Za-z0-9_-]+).*/\1/p' "$REPO/.gitattributes" 2>/dev/null | sort -u); do
  [ "$drv" = "union" ] && continue
  git -C "$REPO" config --get "merge.$drv.driver" >/dev/null 2>&1 || unregistered="$unregistered $drv"
done
# A config entry for a BUILT-IN driver shadows it: merge.union.driver=true turned every
# union ledger into keep-ours and silently dropped other machines' lines (2026-10-05).
for _bi in union text binary; do
  if git -C "$REPO" config --get "merge.$_bi.driver" >/dev/null 2>&1; then
    echo "DRIFT: git config merge.$_bi.driver is set — it shadows git's built-in $_bi merge"
    echo "  fix: git -C '$REPO' config --unset-all merge.$_bi.driver"
    rc=1
  fi
done
if [ -n "$unregistered" ]; then
  echo "DRIFT: .gitattributes maps files to unregistered merge driver(s):$unregistered"
  echo "  a raw 3-way merge on those files will wedge the auto-sync daemon."
  echo "  fix: bash '$REPO/scripts/register-merge-drivers.sh'"
  rc=1
else
  echo "OK: all .gitattributes merge drivers are registered in git config"
fi

exit $rc
