#!/usr/bin/env bash
# M3: Sync-on-pause — called on B-entry before killing a session.
#
# Commits any dirty tracked files in the session's working directory to its
# current branch. Non-destructive: no force-push, no amend, no branch switch.
# Records LAST_SYNC_TS in the session's metrics file on success.
#
# Usage:
#   sync-session.sh <session-id> <cwd>
#
# Exit codes:
#   0  success (committed or nothing to commit)
#   1  argument/setup error

SESSION_ID="${1:-}"
CWD="${2:-}"
LOG="$HOME/.openclaw/logs/session-lifecycle.log"

_log() {
  local ts; ts=$(date -u '+%Y-%m-%dT%H:%M:%S')
  local msg="[$ts] sync-session: $*"
  echo "$msg"
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  echo "$msg" >> "$LOG" 2>/dev/null || true
}

_record_sync() {
  local sid="$1"
  local metrics="/tmp/claude-session-${sid}.metrics"
  [ -f "$metrics" ] || return 0
  local ts; ts=$(date +%s)
  local content
  content=$(grep -v '^LAST_SYNC_TS=' "$metrics" 2>/dev/null || true)
  printf '%s\nLAST_SYNC_TS=%s\n' "$content" "$ts" > "$metrics"
}

# ── Validation ────────────────────────────────────────────────────────────────
if [ -z "$SESSION_ID" ] || [ -z "$CWD" ]; then
  echo "usage: sync-session.sh <session-id> <cwd>" >&2
  exit 1
fi

if [ ! -d "$CWD" ]; then
  _log "SKIP $SESSION_ID: cwd $CWD does not exist"
  exit 0
fi

if ! git -C "$CWD" rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  _log "SKIP $SESSION_ID: $CWD is not inside a git repo"
  exit 0
fi

branch=$(git -C "$CWD" branch --show-current 2>/dev/null)
if [ -z "$branch" ]; then
  _log "SKIP $SESSION_ID: detached HEAD in $CWD — skipping sync"
  exit 0
fi

dirty=$(git -C "$CWD" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
if [ "$dirty" -eq 0 ]; then
  _log "OK $SESSION_ID: $CWD is clean — nothing to commit"
  _record_sync "$SESSION_ID"
  exit 0
fi

# ── Commit ────────────────────────────────────────────────────────────────────
short="${SESSION_ID:0:8}"
msg="auto-sync: session $short paused [$(date -u '+%Y-%m-%dT%H:%M:%SZ')]"

_log "syncing $SESSION_ID: $dirty dirty file(s) in $CWD on branch $branch"

# Stage tracked modifications only (no untracked files — avoids committing
# secrets, build artefacts, or anything the session never intended to track).
git -C "$CWD" add -u 2>&1 | while IFS= read -r line; do _log "  $line"; done

if git -C "$CWD" diff --cached --quiet 2>/dev/null; then
  _log "OK $SESSION_ID: nothing staged after add -u (untracked-only changes)"
  _record_sync "$SESSION_ID"
  exit 0
fi

if git -C "$CWD" commit -m "$msg" 2>&1 | while IFS= read -r line; do _log "  $line"; done; then
  _log "OK $SESSION_ID: committed on $branch"
else
  _log "WARN $SESSION_ID: git commit returned non-zero"
fi

# Push — non-fatal; commit is local + durable and auto-sync daemon will retry.
if ! git -C "$CWD" push 2>&1 | while IFS= read -r line; do _log "  push: $line"; done; then
  _log "WARN $SESSION_ID: push rejected — commit is local and durable"
fi

_record_sync "$SESSION_ID"
exit 0
