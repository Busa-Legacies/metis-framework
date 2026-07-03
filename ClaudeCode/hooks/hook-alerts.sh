#!/usr/bin/env bash
# Stop hook — warns when rate limit or context window is getting critical.
# Fires at the end of every Claude turn.

data=$(cat 2>/dev/null)
session_id=$(printf '%s' "$data" | jq -r '.session_id // empty' 2>/dev/null | tr -d '[:space:]')
[ -z "$session_id" ] && exit 0

metrics_file="/tmp/claude-session-${session_id}.metrics"
[ -f "$metrics_file" ] || exit 0

# shellcheck source=/dev/null
source "$metrics_file"

RATE_5H_PCT=${RATE_5H_PCT:-0}
CTX_PCT=${CTX_PCT:-0}

warnings=()

if [ "$RATE_5H_PCT" -ge 80 ] 2>/dev/null; then
  warnings+=("5-hour rate limit is at ${RATE_5H_PCT}% — route generation to <<MACHINE_1_ID>>'s Ollama lanes (smith/scout/warden) to protect the cap")
elif [ "$RATE_5H_PCT" -ge 70 ] 2>/dev/null; then
  warnings+=("5-hour rate limit is at ${RATE_5H_PCT}%")
fi

if [ "$CTX_PCT" -ge 85 ] 2>/dev/null; then
  warnings+=("Context window is at ${CTX_PCT}% — consider /compact")
elif [ "$CTX_PCT" -ge 75 ] 2>/dev/null; then
  warnings+=("Context window is at ${CTX_PCT}%")
fi

# ── Auto-checkpoint detection ──────────────────────────────────────────────────
# If new intentional commits landed since the last checkpoint, write a pending
# marker that UserPromptSubmit will pick up on the next turn and inject as context.
: "${METIS_HOME:=$HOME/metis-os}"
REPO="$METIS_HOME"
CP_SHA_FILE="$HOME/.claude/last-checkpoint-sha"

if [ ! -f "$CP_SHA_FILE" ]; then
  # Seed on first use — prevents flagging all historical commits
  git -C "$REPO" rev-parse HEAD 2>/dev/null > "$CP_SHA_FILE"
fi

LAST_SHA=$(cat "$CP_SHA_FILE" 2>/dev/null)
CURRENT_SHA=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)

if [ -n "$LAST_SHA" ] && [ "$LAST_SHA" != "$CURRENT_SHA" ] && [ -n "$session_id" ]; then
  NEW_WORK=$(git -C "$REPO" log "${LAST_SHA}..${CURRENT_SHA}" --invert-grep --grep='\[auto-sync\]' --oneline 2>/dev/null)
  [ -n "$NEW_WORK" ] && touch "/tmp/claude-checkpoint-pending-${session_id}"
fi

if [ ${#warnings[@]} -gt 0 ]; then
  # Join warnings with " | "
  msg=$(printf '%s' "${warnings[0]}")
  for ((i=1; i<${#warnings[@]}; i++)); do
    msg="$msg | ${warnings[$i]}"
  done
  printf '{"systemMessage": "%s"}\n' "$msg"
fi
