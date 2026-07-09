#!/usr/bin/env bash
# Manual git-sync lock wrapper.
#
# Usage:
#   source scripts/git-lock.sh acquire   — hold the lock for this shell's lifetime
#                                          (blocks auto-sync until you release or the shell exits)
#   scripts/git-lock.sh release          — release the lock
#   scripts/git-lock.sh run <cmd>        — run a command while holding the lock (auto-releases on exit)
#
# Portable mkdir lock (macOS has no flock(1)). Same lock object used by
# scripts/openclaw-git-sync.sh:
#   ~/.openclaw/locks/git-sync.lock.d   (a directory; contains a `pid` file)
#
# The lock stores the holder PID. The auto-sync reclaims a lock whose holder PID
# is dead, so a leaked lock (shell killed without release) self-heals next tick.
#
# Examples:
#   source scripts/git-lock.sh acquire   # hold for a shell session of manual git ops
#   scripts/git-lock.sh run git rebase -i HEAD~3

LOCK_DIR="${OPENCLAW_LOCK_DIR:-$HOME/.openclaw/locks}"   # override: isolate the lock for tests (#452)
LOCK="$LOCK_DIR/git-sync.lock.d"
mkdir -p "$LOCK_DIR"

# Shared lock-holder helper (#452): lets us reclaim a leaked orphan (bare `sleep`
# reparented to PID 1 after a SIGKILLed holder) instead of blocking on it forever.
_LOCK_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/git-sync-lock.sh"
[ -f "$_LOCK_LIB" ] && . "$_LOCK_LIB"

# Blocking acquire with stale-holder reclaim. Stores $$ as the holder PID — when
# sourced, $$ is the interactive shell, so the lock lives as long as that shell.
_acquire_blocking() {
  while true; do
    if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; return 0; fi
    local holder; holder=$(cat "$LOCK/pid" 2>/dev/null)
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      # Alive holder: wait — UNLESS it's a leaked orphan (#452), then reclaim it.
      if command -v holder_is_leaked >/dev/null 2>&1 && holder_is_leaked "$holder"; then
        echo "[git-lock] reclaimed leaked orphan lock holder $holder (bare sleep, PPID=1)" >&2
        rm -rf "$LOCK"; continue
      fi
      sleep 1; continue          # live legitimate holder — wait
    fi
    rm -rf "$LOCK"               # dead/unknown holder — reclaim and retry
  done
}

case "${1:-}" in
  acquire)
    _acquire_blocking
    echo "Lock acquired (holder pid $$). Auto-sync will skip until you run: scripts/git-lock.sh release"
    echo "Or close this shell — the auto-sync reclaims the lock once this pid exits."
    ;;
  release)
    rm -rf "$LOCK"
    echo "Lock released."
    ;;
  run)
    shift
    if [ $# -eq 0 ]; then
      echo "Usage: scripts/git-lock.sh run <command> [args...]" >&2
      exit 1
    fi
    _acquire_blocking
    trap 'rm -rf "$LOCK"' EXIT INT TERM
    # Heal stale .git/index.lock before running. Git creates this during index
    # operations and removes it on clean exit; a crashed process leaves it behind
    # and blocks all subsequent git commands with "Unable to create index.lock".
    git_dir=$(git rev-parse --git-dir 2>/dev/null)
    if [ -n "$git_dir" ]; then
      index_lock="${git_dir}/index.lock"
      if [ -f "$index_lock" ]; then
        lock_owner=$(lsof "$index_lock" 2>/dev/null | awk 'NR>1{print $2; exit}')
        if [ -z "$lock_owner" ]; then
          rm -f "$index_lock"
          echo "[git-lock] removed stale index.lock (no owning process)" >&2
        fi
      fi
    fi
    # Divergence guard: warn before pushing if remote is significantly ahead.
    # Fetches quietly so the check reflects actual remote state, not a stale local ref.
    if printf '%s ' "$@" | grep -q 'git push'; then
      git fetch --quiet origin 2>/dev/null
      behind=$(git rev-list HEAD..origin/main --count 2>/dev/null || echo 0)
      if [ "$behind" -gt 20 ]; then
        echo "[git-lock] ⚠️  Remote is ${behind} commits ahead of HEAD. Consider pulling before pushing to avoid conflict." >&2
      fi
    fi
    "$@"
    ;;
  *)
    echo "Usage: scripts/git-lock.sh acquire|release|run <cmd>" >&2
    exit 1
    ;;
esac
