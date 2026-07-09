#!/usr/bin/env bash
# Shared helper for the git-sync.lock.d mutex (#452).
#
# The lock at ~/.openclaw/locks/git-sync.lock.d is acquired by THREE code paths:
#   - scripts/openclaw-git-sync.sh   (the auto-sync daemon)
#   - scripts/git-lock.sh            (manual git ops)
#   - scripts/update-tier1-state.py  (governed-state mutations; mirrors this in Python)
# All three already reclaim a lock whose holder PID is DEAD. This adds the one case
# that defeated that reclaim: a holder PID that is ALIVE but is a leaked ORPHAN.
#
# THE FAILURE (live 2026-06-27, holders 66980 then 24703 = `sleep 3000`):
#   A session held the lock ad-hoc to pause auto-sync (`git-lock.sh acquire`/`run`,
#   or a wedged /checkpoint|/end) and was SIGKILLed — context-limit kills are common
#   on these long-running sessions. SIGKILL bypasses the EXIT/TERM trap, so the lock
#   directory leaks AND the backgrounded `sleep` child reparents to init (PPID=1) and
#   keeps running. `kill -0 holder` then SUCCEEDS (the sleep IS alive), so pid-liveness
#   reclaim never fires. Auto-sync + every checkpoint/commit across all sessions stalls
#   for the remaining sleep duration (up to ~50 min). SIGKILL can never be trapped, so
#   the only durable cure is reclaim-side: recognize the leaked orphan and steal it.
#
# holder_is_leaked PID  -> exit 0 if PID is a reclaimable leaked orphan, 1 otherwise.
#
# CONSERVATIVE BY CONSTRUCTION: returns 1 (treat as a genuine holder; do NOT reclaim)
# unless it is CERTAIN the holder is a leaked bare `sleep`. A legit interactive holder
# (`source git-lock.sh acquire` -> the shell) shows comm=zsh/bash, not sleep, so it is
# never stolen. macOS note: launchd is PID 1, so the real daemon also has PPID==1 — the
# bare-`sleep` command match (a real lock holder is NEVER the sleep binary) is what makes
# acting on PPID==1 safe. bash 3.2 compatible (no mapfile/assoc arrays).

holder_is_leaked() {
  local pid="$1" info ppid cmd
  [ -n "$pid" ] || return 1
  # ps prints nothing for a dead pid — caller's existing dead-pid path handles that.
  info=$(ps -o ppid=,comm= -p "$pid" 2>/dev/null) || return 1
  [ -n "$info" ] || return 1
  ppid=$(printf '%s\n' "$info" | awk '{print $1}')
  cmd=$(printf '%s\n'  "$info" | awk '{print $2}')
  [ "$ppid" = "1" ] || return 1            # has a live parent -> genuine holder
  case "$cmd" in
    sleep|*/sleep) return 0 ;;             # orphaned bare sleep -> leaked, reclaim it
    *) return 1 ;;                          # anything else -> stay conservative
  esac
}
