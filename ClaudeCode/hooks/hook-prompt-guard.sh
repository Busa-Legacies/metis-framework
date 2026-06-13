#!/usr/bin/env bash
# UserPromptSubmit hook — detects end-session/checkpoint signals and enforces
# rate limit and context window thresholds.
# Runs before every prompt is sent to the model.

data=$(cat 2>/dev/null)
session_id=$(printf '%s' "$data" | jq -r '.session_id // empty' 2>/dev/null | tr -d '[:space:]')
[ -z "$session_id" ] && exit 0

additional_ctx=""
block_reason=""

# ── End-session + checkpoint detection ────────────────────────────────────────
# Runs regardless of metrics state so it fires even on the very first prompt.
user_prompt=$(printf '%s' "$data" | jq -r '.prompt // empty' 2>/dev/null)
PENDING_FILE="/tmp/claude-checkpoint-pending-${session_id}"
is_end=0

if [ -n "$user_prompt" ]; then
  prompt_lower=$(printf '%s' "$user_prompt" | tr '[:upper:]' '[:lower:]' | sed "s/[.!?,']//g" | tr -s ' ' | sed 's/^ //;s/ $//')
  word_count=$(printf '%s' "$prompt_lower" | wc -w | tr -d ' ')

  case "$prompt_lower" in
    "end session"|"end the session"|"close out"|"close session"|\
    "wrap up"|"wrap up the session"|"done for today"|"done for now"|\
    "all done for today"|"all done for now"|"log off"|"signing off"|\
    "thats all"|"that is all"|"finishing up"|"finishing up for today")
      is_end=1 ;;
  esac
  # Bare "end" only when the entire message is that single word
  [ "$word_count" -eq 1 ] && [ "$prompt_lower" = "end" ] && is_end=1
fi

if [ "$is_end" -eq 1 ]; then
  # /end handles all committing — suppress the checkpoint signal to avoid redundancy
  rm -f "$PENDING_FILE"
  additional_ctx="SESSION END SIGNAL: User is ending the session. Run the /end protocol immediately, starting with uncommitted work, then follow all steps in sequence."
elif [ -f "$PENDING_FILE" ]; then
  rm -f "$PENDING_FILE"
  additional_ctx="CHECKPOINT PENDING: New intentional commits exist since the last checkpoint. Run /checkpoint NOW before handling the user request."
fi

# ── Rate limit + context actions ──────────────────────────────────────────────
metrics_file="/tmp/claude-session-${session_id}.metrics"
if [ ! -f "$metrics_file" ]; then
  # No metrics yet — output any end/checkpoint context and exit cleanly
  if [ -n "$additional_ctx" ]; then
    escaped=$(printf '%s' "$additional_ctx" | sed 's/"/\\"/g')
    printf '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "%s"}}\n' "$escaped"
  fi
  exit 0
fi

# If the metrics file is older than 15 minutes, its rate limit value is stale
# (the 5h sliding window will have shifted enough to drop meaningfully).
# Treat stale metrics as safe — the statusline will refresh on next interaction.
metrics_age=$(( $(date +%s) - $(stat -f %m "$metrics_file" 2>/dev/null || echo 0) ))
if [ "$metrics_age" -gt 900 ] 2>/dev/null; then
  if [ -n "$additional_ctx" ]; then
    escaped=$(printf '%s' "$additional_ctx" | sed 's/"/\\"/g')
    printf '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "%s"}}\n' "$escaped"
  fi
  exit 0
fi

# shellcheck source=/dev/null
source "$metrics_file"

# Sanitize every metric to an integer. A producer that ever writes a float (the
# API returns fractional percentages like 14.0000002) would make every bash
# `[ -ge ]` test error under 2>/dev/null and silently no-op — disabling the whole
# limiter (the #125 root bug). Truncate any decimal; non-numeric becomes 0.
_int() { local v="${1%%.*}"; case "$v" in ''|*[!0-9]*) scribe 0;; *) echo "$v";; esac; }
r5=$(_int "${RATE_5H_PCT:-0}")
r7=$(_int "${RATE_7D_PCT:-0}")
cpct=$(_int "${CTX_PCT:-0}")

# A cached percentage describes the window that was live at the last statusline
# render. If that window's reset epoch has since passed, the window has rolled
# over and real usage has dropped to ~0 — the cached value is stale regardless of
# how recently the file was written (the mtime guard above measures file age, not
# window validity; this is the 80%-shown-when-live-is-21% bug at a reset boundary).
# The producer emits these reset epochs precisely so we can detect this here.
_window_reset_passed() {
  local epoch="${1%%.*}" now
  case "$epoch" in ''|*[!0-9]*) return 1;; esac  # no/invalid reset → can't tell, trust the value
  now=$(date +%s)
  [ "$now" -ge "$epoch" ]
}
_window_reset_passed "${RATE_5H_RESETS:-}" && r5=0
_window_reset_passed "${RATE_7D_RESETS:-}" && r7=0

# A hard block is pointless if the window is about to refill: skip it when the
# given reset epoch (seconds) is within 5 min ahead (or up to 1h stale-but-past).
_resets_soon() {
  local epoch="${1%%.*}" now
  case "$epoch" in ''|*[!0-9]*) return 1;; esac
  now=$(date +%s)
  [ $(( epoch - now )) -le 300 ] && [ $(( epoch - now )) -ge -3600 ]
}

# ── Bypass (both work for already-running sessions) ───────────────────────────
#   File:   touch /tmp/claude-rate-bypass     (remove when done)
#   EnvVar: CLAUDE_RATE_LIMIT_BYPASS=1 in the shell that launched Claude Code
_bypassed=0
[ "${CLAUDE_RATE_LIMIT_BYPASS:-0}" = "1" ] && _bypassed=1
[ -f "/tmp/claude-rate-bypass" ] && _bypassed=1

# ── Weekly window (seven_day) — the scarce cap ────────────────────────────────
# The only window worth hard-stopping on: it recovers solely on the weekly reset
# (no local-lane substitute), so blowing it throttles every session for days.
if [ "$r7" -ge 95 ] && [ "$_bypassed" -eq 0 ] && ! _resets_soon "${RATE_7D_RESETS:-}"; then
  block_reason="Weekly (7-day) rate limit is at ${r7}% — pausing to protect the cap, which recovers only on the weekly reset (no local substitute). Override: touch /tmp/claude-rate-bypass (remove it when done)."
elif [ "$r7" -ge 80 ]; then
  rate_msg="WEEKLY RATE LIMIT: 7-day window at ${r7}% — the scarce cap. Be maximally economical with Claude-API calls: route ALL generation, research, review, and drafting to Jay's Ollama lanes (smith/scout/warden/echo) and apply output inline. Reserve Claude for orchestration, git, and applying lane output."
  additional_ctx="${additional_ctx:+${additional_ctx} }${rate_msg}"
fi

# ── 5-hour window — sliding/recovering: steer to local lanes, NEVER hard-stop ─
# It refills continuously, so freezing the session is the wrong response (#125).
# Recovery detection: track HIGH/NORMAL state across turns via a per-session file
# so we can inject an auto-continue message on the first turn after recovery.
_rl_state_file="/tmp/claude-session-${session_id}.ratelimit-state"
_prev_rl_state=""
[ -f "$_rl_state_file" ] && _prev_rl_state=$(cat "$_rl_state_file" 2>/dev/null)

if [ "$r5" -ge 85 ]; then
  rate_msg="RATE LIMIT FALLBACK: 5-hour window at ${r5}% (it recovers continuously). Switch to local-model fallback NOW: route code generation, research, review, and drafting to Jay's Ollama lanes (smith/scout/warden/echo) and apply output inline. Reserve Claude-API for orchestration, git, and applying lane output. Be concise; avoid unnecessary tool calls."
  additional_ctx="${additional_ctx:+${additional_ctx} }${rate_msg}"
  printf 'HIGH\n' > "$_rl_state_file"
elif [ "$r5" -ge 70 ]; then
  rate_msg="RATE LIMIT NOTICE: 5-hour window at ${r5}%. Be concise and efficient; avoid unnecessary tool calls. Prefer routing generation to Jay's Ollama lanes (smith/scout/warden)."
  additional_ctx="${additional_ctx:+${additional_ctx} }${rate_msg}"
  printf 'HIGH\n' > "$_rl_state_file"
else
  # Recovered — inject auto-continue only on the first turn after transition from HIGH
  if [ "$_prev_rl_state" = "HIGH" ]; then
    recovery_msg="RATE LIMIT RECOVERED: 5-hour window back below 70%. Resume autonomous queue work now: python3 ~/metis-os/scripts/agent-work.py claim-next --agent claude"
    additional_ctx="${additional_ctx:+${additional_ctx} }${recovery_msg}"
  fi
  printf 'NORMAL\n' > "$_rl_state_file"
fi

# ── Context actions ───────────────────────────────────────────────────────────
if [ "$cpct" -ge 85 ]; then
  ctx_msg="CONTEXT NOTICE: Context window is at ${cpct}%. Prioritise running /compact before responding if the task allows. Avoid expanding context further."
  additional_ctx="${additional_ctx:+${additional_ctx} }${ctx_msg}"
elif [ "$cpct" -ge 75 ]; then
  ctx_msg="CONTEXT NOTICE: Context window is at ${cpct}%. Be concise and avoid verbose output."
  additional_ctx="${additional_ctx:+${additional_ctx} }${ctx_msg}"
fi

# ── Output ────────────────────────────────────────────────────────────────────
if [ -n "$block_reason" ]; then
  # Escape for JSON
  escaped=$(printf '%s' "$block_reason" | sed 's/"/\\"/g')
  printf '{"continue": false, "stopReason": "%s"}\n' "$escaped"
elif [ -n "$additional_ctx" ]; then
  escaped=$(printf '%s' "$additional_ctx" | sed 's/"/\\"/g')
  printf '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "%s"}}\n' "$escaped"
fi
