#!/usr/bin/env bash

# Receives session context JSON from Claude Code on stdin each refresh
ctx=$(cat 2>/dev/null)

# ── Single-pass ctx parse (recurring-reboot root cause, cont'd from the git-cache fix
# above) ─────────────────────────────────────────────────────────────────────────────
# Was ~13 separate `jq` forks below (one per field, several repeated verbatim for the
# display value vs. the metrics-file value) — with ~19 restored sessions re-rendering
# every refresh that was 13x19=247 process forks per tick, the other primary driver of
# the load-collapse reboots alongside the git-status walk above. One jq call now emits
# `j_var=<shell-quoted value>` assignment lines (jq's @sh format) which bash `eval`s
# directly — no delimiter to split on, so there is nothing for an empty/missing field
# to collapse or misalign (a TSV row fed through `IFS=$'\t' read` was tried first and
# is broken: bash's `read` treats tab as collapsible IFS whitespace and silently drops
# a leading empty field, shifting every later value left by one). `eval` here is safe:
# the input is our own trusted local Claude Code context JSON, and @sh guarantees
# proper shell quoting of whatever it wraps.
eval "$(printf '%s' "$ctx" | jq -r '
    def s(v): (v // "" | tostring);
    "j_session_name=" + (s(.session_name) | @sh),
    "j_cwd=" + (s(.cwd) | @sh),
    "j_model=" + (((.model.display_name)? // (.model.id | ltrimstr("claude-"))? // "") | @sh),
    "j_ctx_pct=" + (s(.context_window.used_percentage) | @sh),
    "j_r5=" + (((.rate_limits.five_hour.used_percentage // 0) | round | tostring) | @sh),
    "j_r7=" + (((.rate_limits.seven_day.used_percentage // 0) | round | tostring) | @sh),
    "j_session_id=" + (s(.session_id) | @sh),
    "j_m5r=" + (s(.rate_limits.five_hour.resets_at) | @sh),
    "j_m7r=" + (s(.rate_limits.seven_day.resets_at) | @sh),
    "j_mctx=" + (((.context_window.used_percentage // 0) | round | tostring) | @sh),
    "j_last_api_ts=" + (s(.turn_start_time) | @sh),
    "j_rate_raw=" + ((.rate_limits // {} | tojson) | @sh)
  ' 2>/dev/null)"
# jq's ltrimstr can leave incidental whitespace on display_name; trim without a fork.
j_model="${j_model#"${j_model%%[![:space:]]*}"}"
j_model="${j_model%"${j_model##*[![:space:]]}"}"

# ── Session name ──────────────────────────────────────────────────────────────
session_part="$j_session_name"

# ── CWD (prefer JSON cwd) ─────────────────────────────────────────────────────
raw_cwd="$j_cwd"
[ -z "$raw_cwd" ] && raw_cwd=$(pwd)
dir=$(echo "$raw_cwd" | sed "s|$HOME|~|")

# ── Git ───────────────────────────────────────────────────────────────────────
# PERF (recurring-reboot root cause): `git status --porcelain` walks the whole worktree, and
# metis-os is huge. With ~19 restored sessions each re-rendering, 19× that walk per refresh was
# a primary driver of the load-collapse reboots. Cache the dirty count PER-REPO (shared across
# every session in the same repo) with a short TTL, so it runs at most once per TTL regardless
# of how many sessions render. Fail-safe: any miss/staleness falls back to a live count.
git_part=""
if git -C "$raw_cwd" rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
  branch=$(git -C "$raw_cwd" branch --show-current 2>/dev/null | tr -d '[:space:]')
  if [ -n "$branch" ]; then
    _gkey=$(printf '%s' "$raw_cwd" | md5 -q 2>/dev/null || printf 'default')
    _gcache="/tmp/claude-sl-git-${_gkey}.dirty"
    _gttl="${STATUSLINE_GIT_TTL:-5}"
    if [ -f "$_gcache" ] && [ "$(( $(date +%s) - $(stat -f %m "$_gcache" 2>/dev/null || echo 0) ))" -lt "$_gttl" ]; then
      dirty=$(cat "$_gcache" 2>/dev/null)
    else
      dirty=$(git -C "$raw_cwd" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
      printf '%s' "${dirty:-0}" > "$_gcache" 2>/dev/null
    fi
    git_part="$branch"
    [ "${dirty:-0}" -gt 0 ] 2>/dev/null && git_part="$git_part *$dirty"
  fi
fi

# ── Model ─────────────────────────────────────────────────────────────────────
model_part="$j_model"

# ── Context usage ─────────────────────────────────────────────────────────────
ctx_part=""
pct="$j_ctx_pct"
if [ -n "$pct" ]; then
  ctx_part="ctx ${pct}%"
fi

# ── Rate limits (5h + weekly) — 5h shown >=40%, weekly >=10% for awareness ────
# Weekly is the scarce cap Ant most wants to track, so it surfaces at a low floor;
# 5h only matters under active pressure, so it stays hidden until 40%.
# `round` (done in the single jq pass above) normalises the API's fractional
# percentages to integers so the bash -ge tests never error on a float (#125).
rate_part=""
r5="${j_r5:-0}"; r7="${j_r7:-0}"
[ "$r5" -ge 40 ] 2>/dev/null && rate_part="5h ${r5}%"
if [ "$r7" -ge 10 ] 2>/dev/null; then
  [ -n "$rate_part" ] && rate_part="${rate_part} · 7d ${r7}%" || rate_part="7d ${r7}%"
fi

# ── Weekly-runway offload pressure (#1297, advisory) ──────────────────────────
# Graduated soft/firm/hard from the SAME 7d-runway math as claude_budget.fleet_pressure
# (kept inline here — one awk, no python fork — to stay off the load-collapse path;
# thresholds mirror _FIRM_RATIO=1.0 / _HARD_RATIO=0.6). Raw 7d %-left ignores where in
# the week we are; runway = (7d %-left) / (% of the 7d window still open). Shows ONLY at
# firm/hard (soft = silent, no noise) and ONLY when the reset epoch is present (an absent
# rate_limits block writes 7d=0 via `// 0`; showing that as "hard" would be a fabricated
# signal). This is the interactive-seat nudge to spin up an offload session / conserve —
# advisory only, never auto-routes the interactive session (Ant 2026-07-31).
pressure_part=""
if [ -n "$j_m7r" ] && [ "$j_m7r" -eq "$j_m7r" ] 2>/dev/null; then
  pressure_part=$(awk -v used="${j_r7:-0}" -v reset="$j_m7r" -v now="$(date +%s)" 'BEGIN{
    left=100-used; if(left<0)left=0;
    frac=(reset-now)/(7*86400); if(frac>1)frac=1; if(frac<0.05)frac=0.05;
    ratio=(left/100)/frac;
    if(ratio>=1.0){ printf "" }
    else if(ratio>=0.6){ printf "pace:firm↓" }
    else { printf "pace:HARD⛔offload" }
  }')
fi

# ── Cache metrics for hooks + dashboard ───────────────────────────────────────
# Single producer for three consumers: this statusline display, the prompt-guard
# limiter (hook-prompt-guard.sh), and the dashboard ratelimits router. Percentages
# are rounded to integers so downstream integer parsers/compares are safe; resets
# are epoch seconds so consumers can reason about reset proximity instead of mtime.
session_id="$j_session_id"
if [ -n "$session_id" ]; then
  m5="${j_r5:-0}"
  m5r="$j_m5r"
  m7="${j_r7:-0}"
  m7r="$j_m7r"
  mctx="${j_mctx:-0}"
  last_api_ts="$j_last_api_ts"
  [ -z "$last_api_ts" ] && last_api_ts=$(date +%s)
  {
    printf 'RATE_5H_PCT=%s\n' "${m5:-0}"
    printf 'RATE_5H_RESETS=%s\n' "${m5r}"
    printf 'RATE_7D_PCT=%s\n' "${m7:-0}"
    printf 'RATE_7D_RESETS=%s\n' "${m7r}"
    # Verbatim rate_limits object so any per-model / Fable weekly window Claude
    # Code now emits (e.g. the app's "Fable only" bar) is OBSERVABLE without
    # guessing a field name — parse the confirmed key downstream, never `// 0`.
    rate_raw="$j_rate_raw"; [ -z "$rate_raw" ] && rate_raw='{}'
    printf 'RATE_LIMITS_RAW=%s\n' "$rate_raw"
    printf 'CTX_PCT=%s\n' "${mctx:-0}"
    printf 'LAST_API_TS=%s\n' "${last_api_ts}"
  } > "/tmp/claude-session-${session_id}.metrics"
fi

# ── Main-session burn indicator (#7073, passive) ──────────────────────────────
# The weekly assessment found ~88% of weekly output tokens are interactive
# main-session Opus that NO automation touches (~184 main turns per dispatched
# job). This surfaces THIS session's live turn count so that interactive burn is
# visible for self-regulation — proposal 1 of the 235B main-burn design, PASSIVE
# variant only (Ant: "passive statusline only" — display, never a nudge/interrupt).
# Cheap by construction: a tiny per-session state file parsed with builtin `read`
# and written with `printf` — NO process fork on the render hot path (the same
# load-collapse constraint the single-jq-parse above exists to honour). Wholly
# SEPARATE from the metrics-file block above (which the usage pipeline depends on)
# — it is neither read nor written here. `turn_start_time` changes exactly once
# per turn, so a changed non-empty value counts one new turn (statusline may
# re-render many times within a turn; those are correctly not counted).
burn_part=""
if [ -n "$session_id" ]; then
  _bstate="/tmp/claude-burn-${session_id}.state"
  s_turns=0; s_lastts=""
  [ -f "$_bstate" ] && read -r s_turns s_lastts < "$_bstate" 2>/dev/null
  [ -z "$s_turns" ] && s_turns=0
  turns="$s_turns"
  if [ -n "$j_last_api_ts" ] && [ "$j_last_api_ts" != "$s_lastts" ]; then
    turns=$((s_turns + 1))
  fi
  printf '%s %s\n' "$turns" "$j_last_api_ts" > "$_bstate" 2>/dev/null
  # Passive display only past a floor, so early sessions stay uncluttered. Optional
  # weekly turns-per-dispatch baseline (emitted by weekly-usage-assessment.py) ties
  # the live count to the known ~/job ratio. Read from the git-tracked, fleet-synced
  # repo path FIRST so the annotation shows on every machine (the assessment runs on
  # <<MACHINE_1_ID>> but the daemon carries the file everywhere); fall back to the legacy
  # machine-local path, then degrade to the live turn count alone if neither exists.
  _bfloor="${STATUSLINE_BURN_FLOOR:-20}"
  if [ "${turns:-0}" -ge "$_bfloor" ] 2>/dev/null; then
    burn_part="burn ${turns}t"
    s_base=""
    for _bbase in "${METIS_HOME:-$HOME/metis-os}/workspace/state/weekly-usage/mainburn-baseline" "$HOME/.openclaw/state/mainburn-baseline"; do
      if [ -f "$_bbase" ]; then
        read -r s_base < "$_bbase" 2>/dev/null
        [ -n "$s_base" ] && break
      fi
    done
    [ -n "$s_base" ] && [ "$s_base" -eq "$s_base" ] 2>/dev/null && burn_part="${burn_part} · ~${s_base}/disp"
  fi
fi

# ── Remote control status ─────────────────────────────────────────────────────
# Claude Code does not expose RC state in the statusline context JSON.
# Proxy: remoteControlAtStartup in settings.json AND Claude.app process running.
rc_part=""
# PERF: was a full `python3 -c` interpreter startup EVERY render (× ~19 sessions = a major fork
# cost in the load-collapse). jq is already a dependency here and starts ~20× cheaper; identical output.
rc_startup=$(jq -r '.remoteControlAtStartup // false' ~/.claude/settings.json 2>/dev/null || echo "false")
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

# ── Goal lane (#325 — exported by scripts/lane.sh panes; display-only) ────────
lane_part=""
[ -n "${METIS_LANE:-}" ] && lane_part="⊦ ${METIS_LANE}"

# ── Assemble segments ─────────────────────────────────────────────────────────
SEP="  |  "
segments=()
[ -n "$lane_part"    ] && segments+=("$lane_part")
[ -n "$session_part" ] && segments+=("$session_part")
[ -n "$dir"          ] && segments+=("$dir")
[ -n "$git_part"     ] && segments+=("$git_part")
[ -n "$model_part"   ] && segments+=("$model_part")
[ -n "$ctx_part"     ] && segments+=("$ctx_part")
[ -n "$rate_part"    ] && segments+=("$rate_part")
[ -n "$pressure_part" ] && segments+=("$pressure_part")
[ -n "$burn_part"    ] && segments+=("$burn_part")
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
