#!/usr/bin/env bash

# Receives session context JSON from Claude Code on stdin each refresh
ctx=$(cat 2>/dev/null)

# ── Session name ──────────────────────────────────────────────────────────────
session_part=""
if [ -n "$ctx" ]; then
  name=$(printf '%s' "$ctx" | jq -r '.session_name // empty' 2>/dev/null)
  if [ -n "$name" ]; then
    session_part="$name"
  fi
fi

# ── CWD (prefer JSON cwd) ─────────────────────────────────────────────────────
raw_cwd=""
if [ -n "$ctx" ]; then
  raw_cwd=$(printf '%s' "$ctx" | jq -r '.cwd // empty' 2>/dev/null)
fi
[ -z "$raw_cwd" ] && raw_cwd=$(pwd)
dir=$(echo "$raw_cwd" | sed "s|$HOME|~|")

# ── Git ───────────────────────────────────────────────────────────────────────
git_part=""
if git -C "$raw_cwd" rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  branch=$(git -C "$raw_cwd" branch --show-current 2>/dev/null | tr -d '[:space:]')
  if [ -n "$branch" ]; then
    dirty=$(git -C "$raw_cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    git_part="$branch"
    [ "$dirty" -gt 0 ] && git_part="$git_part *$dirty"
  fi
fi

# ── Model ─────────────────────────────────────────────────────────────────────
model_part=""
if [ -n "$ctx" ]; then
  model_part=$(printf '%s' "$ctx" | jq -r '.model.display_name // (.model.id | ltrimstr("claude-")) // empty' 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
fi

# ── Context usage ─────────────────────────────────────────────────────────────
ctx_part=""
if [ -n "$ctx" ]; then
  pct=$(printf '%s' "$ctx" | jq -r '.context_window.used_percentage // empty' 2>/dev/null | tr -d '[:space:]')
  if [ -n "$pct" ] && [ "$pct" != "null" ]; then
    ctx_part="ctx ${pct}%"
  fi
fi

# ── Rate limits (5h + weekly) — 5h shown >=40%, weekly >=10% for awareness ────
# Weekly is the scarce cap Ant most wants to track, so it surfaces at a low floor;
# 5h only matters under active pressure, so it stays hidden until 40%.
# `round` normalises the API's fractional percentages to integers so the
# bash -ge tests never error on a float (the #125 silent-no-op bug).
rate_part=""
if [ -n "$ctx" ]; then
  r5=$(printf '%s' "$ctx" | jq -r '(.rate_limits.five_hour.used_percentage // 0) | round' 2>/dev/null | tr -d '[:space:]')
  r7=$(printf '%s' "$ctx" | jq -r '(.rate_limits.seven_day.used_percentage // 0) | round' 2>/dev/null | tr -d '[:space:]')
  [ "${r5:-0}" -ge 40 ] 2>/dev/null && rate_part="5h ${r5}%"
  if [ "${r7:-0}" -ge 10 ] 2>/dev/null; then
    [ -n "$rate_part" ] && rate_part="${rate_part} · 7d ${r7}%" || rate_part="7d ${r7}%"
  fi
fi

# ── Cache metrics for hooks + dashboard ───────────────────────────────────────
# Single producer for three consumers: this statusline display, the prompt-guard
# limiter (hook-prompt-guard.sh), and the dashboard ratelimits router. Percentages
# are rounded to integers so downstream integer parsers/compares are safe; resets
# are epoch seconds so consumers can reason about reset proximity instead of mtime.
if [ -n "$ctx" ]; then
  session_id=$(printf '%s' "$ctx" | jq -r '.session_id // empty' 2>/dev/null | tr -d '[:space:]')
  if [ -n "$session_id" ]; then
    m5=$(printf '%s' "$ctx" | jq -r '(.rate_limits.five_hour.used_percentage // 0) | round' 2>/dev/null | tr -d '[:space:]')
    m5r=$(printf '%s' "$ctx" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null | tr -d '[:space:]')
    m7=$(printf '%s' "$ctx" | jq -r '(.rate_limits.seven_day.used_percentage // 0) | round' 2>/dev/null | tr -d '[:space:]')
    m7r=$(printf '%s' "$ctx" | jq -r '.rate_limits.seven_day.resets_at // empty' 2>/dev/null | tr -d '[:space:]')
    mctx=$(printf '%s' "$ctx" | jq -r '(.context_window.used_percentage // 0) | round' 2>/dev/null | tr -d '[:space:]')
    last_api_ts=$(printf '%s' "$ctx" | jq -r '.turn_start_time // empty' 2>/dev/null | tr -d '[:space:]')
    [ -z "$last_api_ts" ] && last_api_ts=$(date +%s)
    {
      printf 'RATE_5H_PCT=%s\n' "${m5:-0}"
      printf 'RATE_5H_RESETS=%s\n' "${m5r}"
      printf 'RATE_7D_PCT=%s\n' "${m7:-0}"
      printf 'RATE_7D_RESETS=%s\n' "${m7r}"
      printf 'CTX_PCT=%s\n' "${mctx:-0}"
      printf 'LAST_API_TS=%s\n' "${last_api_ts}"
    } > "/tmp/claude-session-${session_id}.metrics"
  fi
fi

# ── Remote control status ─────────────────────────────────────────────────────
# Claude Code does not expose RC state in the statusline context JSON.
# Proxy: remoteControlAtStartup in settings.json AND Claude.app process running.
rc_part=""
rc_startup=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.claude/settings.json'))); print(d.get('remoteControlAtStartup','false'))" 2>/dev/null || echo "false")
# shellcheck disable=SC2009
if [ "$rc_startup" = "True" ] || [ "$rc_startup" = "true" ]; then
  if pgrep -x "Claude" >/dev/null 2>&1; then
    rc_part="rc:on"
  else
    rc_part="rc:off"
  fi
fi

# ── File guard (concurrent edit tracking — only shows when active) ────────────
guard_part=""
guard_out=$(~/.local/bin/file-guard.sh status 2>/dev/null)
[ -n "$guard_out" ] && guard_part="$guard_out"

# ── Assemble segments ─────────────────────────────────────────────────────────
SEP="  |  "
segments=()
[ -n "$session_part" ] && segments+=("$session_part")
[ -n "$dir"          ] && segments+=("$dir")
[ -n "$git_part"     ] && segments+=("$git_part")
[ -n "$model_part"   ] && segments+=("$model_part")
[ -n "$ctx_part"     ] && segments+=("$ctx_part")
[ -n "$rate_part"    ] && segments+=("$rate_part")
[ -n "$rc_part"      ] && segments+=("$rc_part")
[ -n "$guard_part"   ] && segments+=("$guard_part")

# ── Autowrap to terminal width ────────────────────────────────────────────────
# Get terminal width; fall back to 120 if unavailable
cols=$(tput cols 2>/dev/null) || cols=120
[ -z "$cols" ] || [ "$cols" -lt 40 ] 2>/dev/null && cols=120
sep_len=${#SEP}

# Build line, dropping middle segments (session name, dir) first when too wide
full=""
for seg in "${segments[@]}"; do
  if [ -z "$full" ]; then
    full="$seg"
  else
    full="${full}${SEP}${seg}"
  fi
done

# If it fits, output as-is
if [ ${#full} -le "$cols" ]; then
  printf '%s\n' "$full"
  exit 0
fi

# Too wide: shorten session name and dir progressively
# First: truncate session name to 24 chars
if [ -n "$session_part" ] && [ ${#session_part} -gt 24 ]; then
  segments[0]="${session_part:0:23}…"
fi

# Rebuild
full="${segments[0]}"
for i in "${!segments[@]}"; do
  [ "$i" -eq 0 ] && continue
  full="${full}${SEP}${segments[$i]}"
done

if [ ${#full} -le "$cols" ]; then
  printf '%s\n' "$full"
  exit 0
fi

# Still too wide: shorten dir to basename only
if [ -n "$dir" ]; then
  short_dir="~/…/$(basename "$dir")"
  for i in "${!segments[@]}"; do
    [ "${segments[$i]}" = "$dir" ] && segments[$i]="$short_dir" && break
  done
fi

full="${segments[0]}"
for i in "${!segments[@]}"; do
  [ "$i" -eq 0 ] && continue
  full="${full}${SEP}${segments[$i]}"
done

if [ ${#full} -le "$cols" ]; then
  printf '%s\n' "$full"
  exit 0
fi

# Last resort: drop session name entirely
out="${segments[0]}"
skip_session=true
for i in "${!segments[@]}"; do
  [ "$i" -eq 0 ] && continue
  $skip_session && [ "${segments[$i]}" = "${session_part:0:23}…" ] && skip_session=false && continue
  $skip_session && [ "${segments[$i]}" = "$session_part" ] && skip_session=false && continue
  out="${out}${SEP}${segments[$i]}"
done

printf '%s\n' "$out"
