#!/usr/bin/env bash
# reap-bg-tasks.sh — Kill orphaned background tasks from dead Claude Code sessions.
#
# PROBLEM: When Claude Code's `run_in_background: true` Bash tasks from a PRIOR
# session complete while a NEW session is active, the new session receives spurious
# task-notifications — noise during unrelated work (real case: stale Robinhood searches
# completing mid-close of an infra session).
#
# APPROACH: Two passes.
#
# Pass 1 — Age-based process kill: finds bash/python processes matching known
#   long-running Lane patterns (dispatch, jlane, openclaw search/browse) that
#   have been running past their expected timeout. dispatch has a 300s hard
#   timeout; anything running >STALE_MINUTES (default 15) is orphaned.
#
# Pass 2 — Stale session marker cleanup: /tmp/claude-session-*.init files are
#   created by Claude Code when a session starts and never cleaned up. Delete
#   ones older than SESSION_MAX_AGE_DAYS to prevent /tmp accumulation.
#
# Dry-run (default) — prints what would be killed but does not kill.
# Live — pass --kill to terminate found processes.
#
# Usage:
#   scripts/reap-bg-tasks.sh            # dry-run (safe to call always)
#   scripts/reap-bg-tasks.sh --kill     # reap for real (call at close/checkpoint)
#   scripts/reap-bg-tasks.sh --kill --quiet  # same but only log kills, not dry details

set -euo pipefail

DRY_RUN=1
QUIET=0
STALE_MINUTES=15     # processes older than this are considered orphaned
SESSION_MAX_AGE_DAYS=2  # clean up .init files older than this

for arg in "$@"; do
    case "$arg" in
        --kill)   DRY_RUN=0 ;;
        --quiet)  QUIET=1 ;;
        --help|-h)
            grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

log() {
    [[ $QUIET -eq 1 && $DRY_RUN -eq 1 ]] && return
    echo "[reap-bg] $1"
}

killed=0
skipped=0

# ── Pass 1: kill stale Lane/dispatch processes ────────────────────────────────
#
# Match patterns that indicate a long-running CLI tool started by a Lane call:
#   dispatch (renamed jlane), jlane, openclaw (gateway CLI)
#
# We match the COMMAND column from `ps`, not the full argv, to avoid false positives.
# Using macOS `ps` with -eo: pid, etime (elapsed mm:ss or hh:mm:ss or dd-hh:mm), comm

STALE_SECS=$((STALE_MINUTES * 60))

# `ps -eo pid,etime,command` — command is the full argv on macOS
while IFS= read -r line; do
    pid=$(echo "$line" | awk '{print $1}')
    etime=$(echo "$line" | awk '{print $2}')
    cmd=$(echo "$line" | cut -d' ' -f3-)

    # Skip our own PID and ps itself
    [[ "$pid" -eq $$ ]] && continue

    # Match known Lane-related patterns
    is_lane=0
    case "$cmd" in
        *dispatch*|*jlane*|*/openclaw\ *)
            is_lane=1 ;;
        *python*dispatch*|*python*jlane*)
            is_lane=1 ;;
    esac
    [[ $is_lane -eq 0 ]] && continue

    # Parse etime (macOS format: [[dd-]hh:]mm:ss)
    elapsed_secs=0
    case "$etime" in
        *-*)
            # dd-hh:mm:ss
            days=$(echo "$etime" | cut -d- -f1)
            rest=$(echo "$etime" | cut -d- -f2)
            h=$(echo "$rest" | cut -d: -f1)
            m=$(echo "$rest" | cut -d: -f2)
            s=$(echo "$rest" | cut -d: -f3)
            elapsed_secs=$(( days*86400 + h*3600 + m*60 + s ))
            ;;
        *:*:*)
            # hh:mm:ss
            h=$(echo "$etime" | cut -d: -f1)
            m=$(echo "$etime" | cut -d: -f2)
            s=$(echo "$etime" | cut -d: -f3)
            elapsed_secs=$(( h*3600 + m*60 + s ))
            ;;
        *:*)
            # mm:ss
            m=$(echo "$etime" | cut -d: -f1)
            s=$(echo "$etime" | cut -d: -f2)
            elapsed_secs=$(( m*60 + s ))
            ;;
    esac

    if [[ $elapsed_secs -ge $STALE_SECS ]]; then
        elapsed_min=$(( elapsed_secs / 60 ))
        if [[ $DRY_RUN -eq 1 ]]; then
            log "DRY RUN — would kill pid $pid (${elapsed_min}m): ${cmd:0:80}"
        else
            if kill -0 "$pid" 2>/dev/null; then
                kill -TERM "$pid" 2>/dev/null && log "killed pid $pid (${elapsed_min}m): ${cmd:0:80}" || log "WARN: could not kill $pid"
                killed=$((killed + 1))
            fi
        fi
    else
        skipped=$((skipped + 1))
        [[ $QUIET -eq 0 && $DRY_RUN -eq 0 ]] && log "skip pid $pid (${elapsed_secs}s < ${STALE_SECS}s threshold): ${cmd:0:60}"
    fi
done < <(ps -eo pid,etime,command 2>/dev/null | tail -n +2)

# ── Pass 2: clean stale session .init markers ─────────────────────────────────
# Never remove the current session's marker — it may be long-lived but is still active.

stale_markers=0
CURRENT_SID="${CLAUDE_CODE_SESSION_ID:-}"
while IFS= read -r marker; do
    # Skip current session regardless of age
    [[ -n "$CURRENT_SID" && "$marker" == *"$CURRENT_SID"* ]] && continue
    age_days=$(( ( $(date +%s) - $(stat -f "%m" "$marker" 2>/dev/null || echo 0) ) / 86400 ))
    if [[ $age_days -ge $SESSION_MAX_AGE_DAYS ]]; then
        stale_markers=$((stale_markers + 1))
        if [[ $DRY_RUN -eq 0 ]]; then
            rm -f "$marker" "${marker%.init}.metrics" 2>/dev/null || true
            log "removed stale session marker (${age_days}d): $(basename "$marker")"
        else
            log "DRY RUN — would remove stale marker (${age_days}d): $(basename "$marker")"
        fi
    fi
done < <(find /private/tmp -maxdepth 1 -name "claude-session-*.init" 2>/dev/null)

# ── Pass 3: reap detached, long-idle claude-<N> tmux sessions ─────────────────
# The 5-hour rate-limit pool is SHARED across every live Claude session on this
# machine. A pileup of persistent `claude-tmux.sh` sessions (claude-1..N) that
# nobody is using and that have sat idle for hours is both window-burn risk (if
# anything re-invokes them) and the "managing all these terminal sessions is
# exhausting" clutter. Reversible: the transcript persists on disk and the
# session resumes via `claude --resume`, so reaping only costs a reconnect.
#
# Two tiers, chosen so an operator briefly away is never killed out from under:
#   • DETACHED (no client) + idle > REAP_HOURS (4h)          → reap
#   • ATTACHED  + idle > REAP_ATTACHED_HOURS (16h)           → reap
# The attached tier exists because a dead ttyd/mobile client leaves the session
# marked attached forever; 16h with zero pane activity is a provably dead client,
# not someone thinking. Detached uses the shorter bar since nobody's watching.
REAP_HOURS="${REAP_HOURS:-4}"
REAP_ATTACHED_HOURS="${REAP_ATTACHED_HOURS:-16}"
tmux_sessions_reaped=0
if command -v tmux >/dev/null 2>&1; then
    now_ts=$(date +%s)
    reap_detached_secs=$(( REAP_HOURS * 3600 ))
    reap_attached_secs=$(( REAP_ATTACHED_HOURS * 3600 ))
    while IFS='|' read -r sname sact sattached; do
        [[ "$sname" == claude-* ]] || continue
        idle_secs=$(( now_ts - sact ))
        if [[ "${sattached:-0}" -eq 0 ]]; then
            [[ $idle_secs -ge $reap_detached_secs ]] || continue
            why="detached"
        else
            [[ $idle_secs -ge $reap_attached_secs ]] || continue
            why="stale-attached"
        fi
        idle_h=$(( idle_secs / 3600 ))
        if [[ $DRY_RUN -eq 1 ]]; then
            log "DRY RUN — would reap tmux $sname ($why, idle ${idle_h}h)"
        else
            tmux kill-session -t "$sname" 2>/dev/null \
                && { log "reaped tmux $sname ($why, idle ${idle_h}h)"; tmux_sessions_reaped=$((tmux_sessions_reaped + 1)); } \
                || log "WARN: could not reap tmux $sname"
        fi
    done < <(tmux list-sessions -F "#{session_name}|#{session_activity}|#{session_attached}" 2>/dev/null)
fi

# ── Summary ──────────────────────────────────────────────────────────────────

if [[ $DRY_RUN -eq 1 ]]; then
    log "dry-run complete — pass --kill to act. stale markers: $stale_markers"
else
    log "done — killed: $killed  stale markers cleaned: $stale_markers  tmux sessions reaped: $tmux_sessions_reaped"
fi
