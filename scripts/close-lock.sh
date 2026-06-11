#!/usr/bin/env bash
# close-lock.sh — a NON-BLOCKING mutex around the single-writer session-close
# artifacts, so two sessions running /end (or /checkpoint) at once don't clobber
# each other. (#060)
#
# WHY THIS EXISTS
# ---------------
# Jay is always-on with several concurrent Claude Code sessions. The close protocol
# rewrites three single-writer files — Jay/memory/working-context.md,
# ClaudeCode/memory/MEMORY.md, and the daily log Jay/memory/<date>.md. When two
# closes overlap they race those files; live on 2026-06-02 a second close clobbered
# MEMORY.md and the surviving fix was ad-hoc (one session hand-deferred its writes).
#
# THE MODEL (differs from git-lock.sh on purpose)
# -----------------------------------------------
# git-lock.sh BLOCKS — a manual git op waits for the daemon. A close must NOT wait:
# the second session should immediately learn "another close is in progress" and do
# a SCOPED close (commit + push + its own uniquely-named memory file only — skipping
# the working-context/MEMORY.md/daily-log rewrites the first close owns). So
# `acquire` is non-blocking: it returns 0 if it took the lock, 1 if a live close
# already holds it.
#
# Usage in the close protocol:
#   if scripts/close-lock.sh acquire; then
#       ...full close (rewrite working-context, daily log, MEMORY.md)...
#       scripts/close-lock.sh release
#   else
#       ...SCOPED close: commit + push + new memory FILE only; skip shared rewrites...
#   fi
# Or wrap the shared-artifact section:  scripts/close-lock.sh run <cmd>
#
# Stale reclaim: a lock whose holder PID is dead, OR that is older than MAX_AGE
# (a close should never take that long), is reclaimed — a crashed close never
# wedges future closes.
set -u

LOCK_DIR="$HOME/.openclaw/locks"
LOCK="$LOCK_DIR/session-close.lock.d"
MAX_AGE=900        # seconds; a close older than this is presumed crashed
mkdir -p "$LOCK_DIR"

# 0 if held by a LIVE, FRESH holder; 1 otherwise (and reclaims a stale lock).
_holder_alive() {
  [ -d "$LOCK" ] || return 1
  local holder age now mtime
  holder=$(cat "$LOCK/pid" 2>/dev/null)
  # age check (portable stat: try GNU then BSD)
  now=$(date +%s 2>/dev/null)
  mtime=$(stat -f %m "$LOCK" 2>/dev/null || stat -c %Y "$LOCK" 2>/dev/null)
  if [ -n "$now" ] && [ -n "$mtime" ]; then
    age=$(( now - mtime ))
    if [ "$age" -gt "$MAX_AGE" ]; then rm -rf "$LOCK"; return 1; fi
  fi
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    return 0                      # live + fresh
  fi
  rm -rf "$LOCK"; return 1        # dead holder — reclaim
}

# Non-blocking acquire: 0 = acquired, 1 = another live close holds it.
_acquire() {
  if _holder_alive; then return 1; fi
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; return 0; fi
  # lost a race to a concurrent acquirer
  return 1
}

case "${1:-}" in
  acquire)
    if _acquire; then
      echo "close-lock: acquired (pid $$) — proceed with the FULL close."
      exit 0
    else
      echo "close-lock: another session is closing (holder pid $(cat "$LOCK/pid" 2>/dev/null)). Do a SCOPED close." >&2
      exit 1
    fi
    ;;
  release)
    rm -rf "$LOCK"; echo "close-lock: released."
    ;;
  check)
    if _holder_alive; then echo "held by pid $(cat "$LOCK/pid" 2>/dev/null)"; exit 0; else echo "free"; exit 1; fi
    ;;
  run)
    shift
    [ $# -gt 0 ] || { echo "Usage: close-lock.sh run <command>" >&2; exit 2; }
    if _acquire; then
      trap 'rm -rf "$LOCK"' EXIT INT TERM
      "$@"
    else
      echo "close-lock: another close in progress — refusing to run shared-artifact writes." >&2
      exit 1
    fi
    ;;
  *)
    echo "Usage: close-lock.sh acquire|release|check|run <cmd>" >&2
    exit 2
    ;;
esac
