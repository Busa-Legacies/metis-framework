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
SYNC_LOG="$HOME/.openclaw/logs/git-sync.log"
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
    echo "HEARTBEAT: last successful sync was ${age_min}m ago (> ${STALE_MIN}m) — sync may be dead."
    echo "  check: tail -5 '$SYNC_LOG'; launchctl list | grep openclaw-git-sync"
    rc=1
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

exit $rc
