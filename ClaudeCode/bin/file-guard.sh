#!/usr/bin/env bash
# file-guard.sh — Optimistic concurrency guard for concurrent Claude Code sessions.
#
# No locks. No blocking. Just:
#   1. Track which sessions recently read/wrote which files
#   2. Before a write, check if another session touched the file recently
#   3. If so, tell Claude to re-read the file before proceeding
#   4. After a read/write, record the activity
#
# Usage:
#   file-guard.sh pre-check   <tool_input_json> [session_id]  # PreToolCall Edit|Write
#   file-guard.sh post-write  <tool_input_json> [session_id]  # PostToolCall Edit|Write
#   file-guard.sh post-read   <tool_input_json> [session_id]  # PostToolCall Read
#   file-guard.sh status                                       # one-line for statusline
#   file-guard.sh list                                         # show recent activity
#   file-guard.sh clean                                        # remove old entries

set -euo pipefail

ACTIVITY_DIR="$HOME/.claude/file-activity"
READS_DIR="$HOME/.claude/file-activity/reads"
RECENT_WINDOW=120  # seconds — flag if another session wrote within this window
# Shared statusline cache (#743 perf): the statusline is re-rendered continuously by
# EVERY concurrent session and each render recomputed cmd_status (N activity files × jq
# forks). Across ~13 <<MACHINE_1_ID>> sessions this fork churn dominated steady-state load and, under
# load, a single `status` call could take tens of seconds. The cache is shared (ACTIVITY_DIR
# is one dir all sessions read) so the machine recomputes at most once per TTL regardless of
# render rate. Display-only — a few seconds of staleness in a guard counter is harmless.
# Portable mtime, epoch seconds. `stat -f %m` is BSD/macOS; on GNU coreutils -f means
# "filesystem status", so on Linux this read never produced an mtime and every caller fell
# through to its `|| echo 0` default. Invisible on a Mac; on Linux the status cache read as
# permanently stale, so cmd_status recomputed on every render — exactly the fork churn the cache
# exists to prevent (#3945). Caught by test-file-guard.sh the first time it ran on Linux CI.
# GNU form first (it fails cleanly on BSD: "illegal option -- c"), then BSD — and the guard is on
# DIGITS, not exit status, because the BSD form on GNU can succeed while emitting a non-number for
# a directive -f does not know. That is the same bug one layer over in the sync daemon, whose
# portable_mtime carries this helper verbatim; the two trees do not share a lib. A non-number here
# would break the `(( ))` comparisons below rather than fall back.
_mtime() {
  local m
  m=$(stat -c %Y "$1" 2>/dev/null)
  [[ "$m" =~ ^[0-9]+$ ]] || m=$(stat -f %m "$1" 2>/dev/null)
  [[ "$m" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$m"
}

STATUS_CACHE="$ACTIVITY_DIR/.status-cache"
STATUS_CACHE_TTL="${FILE_GUARD_STATUS_TTL:-5}"  # seconds

# Marker pruning (#3945): activity/read markers are ephemeral but nothing ever deleted them —
# 13,290 files (52MB) had accumulated on <<MACHINE_1_ID>>. cmd_status globbed ALL of them and forked one
# jq per file, so a single "cached" recompute could not finish inside its own 5s TTL: the
# statusline recomputed continuously across every session, and the fork/exec churn (~2.4k procs
# per minute) pinned tccd/trustd. Bound the marker dir, and bound the scan (see cmd_status).
PRUNE_MARKER="$ACTIVITY_DIR/.last-prune"
PRUNE_INTERVAL="${FILE_GUARD_PRUNE_INTERVAL:-3600}"  # seconds between opportunistic prunes
STALE_MINUTES="${FILE_GUARD_STALE_MINUTES:-20}"      # markers older than this are dead (RECENT_WINDOW*10)
mkdir -p "$ACTIVITY_DIR" "$READS_DIR"

# Read stdin once for hook calls (CC 2.1.159+ sends hook payload via stdin).
# Guard with -t 0 to avoid blocking on direct CLI calls (e.g. file-guard.sh status).
if [[ ! -t 0 ]]; then
    _HOOK_STDIN=$(cat 2>/dev/null || true)
else
    _HOOK_STDIN=""
fi

abs_path() {
    python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1" 2>/dev/null || echo "$1"
}

file_hash() {
    echo -n "$1" | shasum -a 256 | cut -c1-16
}

extract_file_path() {
    # Parse with jq (≈5-10× cheaper to start than python3, and jq is already a hard dep
    # of this script) — #743 per-hook fork reduction. Try positional arg (old direct-JSON
    # format) then stdin (CC 2.1.159+ wraps the tool fields under .tool_input). --arg keeps
    # arbitrary payload bytes safe; fromjson fails soft to the next source.
    local src out
    for src in "${1:-}" "$_HOOK_STDIN"; do
        [[ -z "$src" ]] && continue
        out=$(jq -rn --arg s "$src" '($s|fromjson) as $d | (($d.tool_input // $d).file_path // "")' 2>/dev/null) || out=""
        [[ -n "$out" ]] && { printf '%s\n' "$out"; return; }
    done
    echo ""
}

get_sid() {
    # Resolve the session id with provider-neutral precedence. The hook command
    # often passes a literal "unknown" sentinel (when its env var was absent — note
    # Claude Code exports CLAUDE_CODE_SESSION_ID, not CLAUDE_SESSION_ID), so an
    # explicit argv value only wins when it's real.
    local passed="${1:-}"
    if [[ -n "$passed" && "$passed" != "unknown" ]]; then
        echo "$passed"; return
    fi
    # Canonical hook contract: both Claude Code (2.1.159+) and Codex put session_id
    # in the stdin JSON payload. This is the reliable cross-provider source.
    local from_stdin
    from_stdin=$(jq -rn --arg s "$_HOOK_STDIN" '($s|fromjson).session_id // ""' 2>/dev/null || echo "")
    if [[ -n "$from_stdin" ]]; then
        echo "$from_stdin"; return
    fi
    # Env fallbacks: neutral override → Codex → Claude Code → legacy.
    echo "${AGENT_SESSION_ID:-${CODEX_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-unknown}}}}"
}

# Locate metis-os's source_tokens.py for overlap-aware drift decisions. Only present
# in the metis-os repo; elsewhere the guard degrades to the legacy unconditional warning.
_source_tokens_py() {
    local st="${METIS_HOME:-$HOME/metis-os}/scripts/lib/source_tokens.py"
    [[ -f "$st" ]] && echo "$st" || echo ""
}

# A drift was detected. Decide whether it is a REAL overlap and emit the right
# PreToolUse response (#696 slice 2): suppress provably non-overlapping edits (kills
# the false-positive that fired on disjoint edits), surface true conflicts with the
# reason, and — only under METIS_READ_TOKEN_GUARD=1 (soak flag) — hard-deny the write.
# $1 = human context prefix, $2 = raw hook payload (tool_input JSON).
_emit_drift() {
    local prefix="$1" payload="$2"
    local st decision reason
    st=$(_source_tokens_py)
    decision="UNKNOWN"
    if [[ -n "$st" && -n "$payload" ]]; then
        decision=$(python3 "$st" edit-guard "$payload" 2>/dev/null || echo "UNKNOWN")
    fi

    case "$decision" in
        SAFE)
            # Exact-string Edit target is still intact on disk: the change is provably
            # non-overlapping with the concurrent write. No warning — let it proceed.
            exit 0 ;;
        CONFLICT*)
            reason=$(printf '%s' "${decision#CONFLICT	}")
            if [[ "${METIS_READ_TOKEN_GUARD:-0}" == "1" ]]; then
                printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "%s edit target OVERLAPS a concurrent change (%s). Re-read, reapply your change onto the current content, then write."}}\n' "$prefix" "$reason"
            else
                printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "%s your edit target OVERLAPS a concurrent change (%s). Re-read and reapply before writing (set METIS_READ_TOKEN_GUARD=1 to hard-block)."}}\n' "$prefix" "$reason"
            fi
            exit 0 ;;
        WRITE)
            # Whole-file Write over changed content — cannot prove non-overlap.
            if [[ "${METIS_READ_TOKEN_GUARD:-0}" == "1" ]]; then
                printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "%s this whole-file write would clobber content that changed since you read it. Re-read, merge your changes in, then write."}}\n' "$prefix"
            else
                printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "%s this whole-file write may clobber a concurrent change — re-read and merge before writing."}}\n' "$prefix"
            fi
            exit 0 ;;
        *)
            # No decision (non-metis repo / helper absent): legacy advisory warning.
            printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "%s re-read the file to incorporate any newer content before writing."}}\n' "$prefix"
            exit 0 ;;
    esac
}

cmd_pre_check() {
    local tool_input="${1:-}"
    local sid
    sid=$(get_sid "${2:-}")

    local file_path
    file_path=$(extract_file_path "$tool_input")
    [[ -z "$file_path" ]] && exit 0

    local payload="${tool_input:-$_HOOK_STDIN}"
    local fp
    fp=$(abs_path "$file_path")

    # #886-daemon / #4861: signal "a session is actively editing METIS-OS" so the git-sync daemon
    # DEFERS its stash/pull/reset while a turn is in-flight (it sweeps only when this marker is
    # STALE AND the tree is dirty). This MUST be gated on the edit target being under the synced
    # repo: the touch was previously unconditional (fired before the path was even extracted), so
    # an Edit/Write to a scratchpad file or ANOTHER repo pinned the metis marker fresh and starved
    # metis sync for the whole turn even though no metis file was touched. Both sides are realpath'd
    # (fp already is) so a symlinked edit — e.g. ~/.claude/* into ClaudeCode/ — still matches.
    # Goes stale on its own when the turn ends. Deliberately NOT touched on `status`/`list`.
    local _metis_root
    _metis_root=$(abs_path "${METIS_HOME:-$HOME/metis-os}")
    case "$fp" in
        "$_metis_root"/*) { mkdir -p "$HOME/.openclaw" && touch "$HOME/.openclaw/session-editing"; } 2>/dev/null || true ;;
    esac
    local hash
    hash=$(file_hash "$fp")
    local af="$ACTIVITY_DIR/${hash}.json"
    local rf="$READS_DIR/${hash}-${sid}.json"

    # ── Check 1: Was this file written by another session recently? ──
    if [[ -f "$af" ]]; then
        local last_sid last_ts last_pid
        # One jq extracting all three fields (was three separate jq forks) — #743.
        IFS=$'\t' read -r last_sid last_ts last_pid < <(jq -r '[.session_id, .timestamp, .pid] | @tsv' "$af" 2>/dev/null) || true
        [[ "$last_sid" == "null" ]] && last_sid=""
        [[ "$last_pid" == "null" ]] && last_pid=""
        [[ -z "$last_ts" || "$last_ts" == "null" ]] && last_ts=0

        if [[ "$last_sid" != "$sid" ]]; then
            local now age
            now=$(date +%s)
            age=$(( now - last_ts ))

            if (( age <= RECENT_WINDOW )) && [[ -n "$last_pid" ]] && kill -0 "$last_pid" 2>/dev/null; then
                _emit_drift "CONCURRENT EDIT on $(basename "$fp") (another active session wrote it ${age}s ago):" "$payload"
            fi
        fi
    fi

    # ── Check 2: Stale read detection — did the file change on disk since we last read it? ──
    if [[ -f "$rf" ]]; then
        local read_ts read_mtime
        IFS=$'\t' read -r read_ts read_mtime < <(jq -r '[.timestamp, .file_mtime] | @tsv' "$rf" 2>/dev/null) || true
        [[ -z "$read_ts" || "$read_ts" == "null" ]] && read_ts=0
        [[ -z "$read_mtime" || "$read_mtime" == "null" ]] && read_mtime=0

        # Get current file mtime
        local current_mtime
        if [[ -f "$fp" ]]; then
            current_mtime=$(_mtime "$fp" || echo "0")
        else
            current_mtime="0"
        fi

        if [[ "$current_mtime" != "0" ]] && [[ "$read_mtime" != "0" ]] && (( current_mtime > read_mtime )); then
            _emit_drift "STALE READ on $(basename "$fp") (changed on disk since you read it):" "$payload"
        fi
    fi

    exit 0
}

cmd_post_write() {
    local tool_input="${1:-}"
    local sid
    sid=$(get_sid "${2:-}")

    local file_path
    file_path=$(extract_file_path "$tool_input")
    [[ -z "$file_path" ]] && exit 0

    local fp
    fp=$(abs_path "$file_path")
    local hash
    hash=$(file_hash "$fp")
    local af="$ACTIVITY_DIR/${hash}.json"

    # Record the write
    cat > "$af" <<JSON
{"file":"$fp","session_id":"$sid","pid":${PPID:-$$},"timestamp":$(date +%s),"host":"$(hostname -s)","type":"write"}
JSON

    # Also update our own read record (we know the current state since we just wrote it)
    local mtime
    mtime=$(_mtime "$fp" || echo "$(date +%s)")
    local rf="$READS_DIR/${hash}-${sid}.json"
    cat > "$rf" <<JSON
{"file":"$fp","session_id":"$sid","timestamp":$(date +%s),"file_mtime":$mtime}
JSON
    exit 0
}

cmd_post_read() {
    local tool_input="${1:-}"
    local sid
    sid=$(get_sid "${2:-}")

    local file_path
    file_path=$(extract_file_path "$tool_input")
    [[ -z "$file_path" ]] && exit 0

    local fp
    fp=$(abs_path "$file_path")
    local hash
    hash=$(file_hash "$fp")
    local rf="$READS_DIR/${hash}-${sid}.json"

    # Record when we read and what the file's mtime was
    local mtime
    mtime=$(_mtime "$fp" || echo "$(date +%s)")
    cat > "$rf" <<JSON
{"file":"$fp","session_id":"$sid","timestamp":$(date +%s),"file_mtime":$mtime}
JSON
    exit 0
}

cmd_status() {
    # One-line output for statusline: count of active files being edited.
    # #743 perf: serve a shared cached line if fresh (< TTL) — the statusline renders
    # constantly across every session, so recomputing each render is the dominant cost.
    local now
    now=$(date +%s)
    if [[ -f "$STATUS_CACHE" ]]; then
        local cache_mtime
        cache_mtime=$(_mtime "$STATUS_CACHE" || echo 0)
        if (( now - cache_mtime < STATUS_CACHE_TTL )); then
            cat "$STATUS_CACHE" 2>/dev/null
            return
        fi
    fi
    # Opportunistic prune, rate-limited to once per PRUNE_INTERVAL (#3945). Detached so a
    # statusline render never waits on it.
    local prune_mtime=0
    [[ -f "$PRUNE_MARKER" ]] && prune_mtime=$(_mtime "$PRUNE_MARKER" || echo 0)
    if (( now - prune_mtime > PRUNE_INTERVAL )); then
        : > "$PRUNE_MARKER" 2>/dev/null
        ( find "$ACTIVITY_DIR" "$READS_DIR" \( -name '*.json' -o -name '.status-cache.*' \) \
            -mmin "+$STALE_MINUTES" -delete 2>/dev/null & ) >/dev/null 2>&1
    fi
    # Recompute over CANDIDATES ONLY (#3945): a marker whose mtime predates RECENT_WINDOW cannot
    # describe an active write, so filter by mtime in ONE find before forking anything per-file.
    # This bounds the work by concurrent-session count instead of by lifetime marker count —
    # the glob version scaled with every write the machine had ever made.
    local active_count=0 active_files=""
    while IFS= read -r af; do
        [[ -f "$af" ]] || continue
        local pid ts file
        IFS=$'\t' read -r pid ts file < <(jq -r '[.pid, .timestamp, .file] | @tsv' "$af" 2>/dev/null) || true
        [[ -z "$ts" || "$ts" == "null" ]] && ts=0
        local age=$(( now - ts ))
        if (( age <= RECENT_WINDOW )) && [[ -n "$pid" && "$pid" != "null" ]] && kill -0 "$pid" 2>/dev/null; then
            active_count=$((active_count + 1))
            active_files="${active_files:+$active_files,}${file##*/}"
        fi
    done < <(find "$ACTIVITY_DIR" -name '*.json' -newermt "-${RECENT_WINDOW} seconds" 2>/dev/null)
    local out=""
    (( active_count > 0 )) && out="guard:${active_count}f(${active_files})"
    # Cache atomically (temp + mv) so a concurrent reader never sees a partial line. The temp is
    # trapped (#4405): Claude Code kills a slow statusline, and a process that died between the
    # write and the mv stranded its temp forever -- 45,829 of them (169MB) on <<MACHINE_2_ID>>, which made
    # the dir slower, which caused more kills, which stranded more temps. The trap covers the
    # signal path; the prune above covers SIGKILL, which no trap can catch.
    local tmp="$STATUS_CACHE.$$"
    trap 'rm -f "$tmp" 2>/dev/null' EXIT INT TERM
    printf '%s\n' "$out" > "$tmp" 2>/dev/null && mv -f "$tmp" "$STATUS_CACHE" 2>/dev/null
    rm -f "$tmp" 2>/dev/null
    [[ -n "$out" ]] && printf '%s\n' "$out"
    # empty output = nothing to show
}

cmd_list() {
    local now
    now=$(date +%s)
    local found=0

    echo "=== Write Activity ==="
    for af in "$ACTIVITY_DIR"/*.json; do
        [[ -f "$af" ]] || continue
        local file sid pid ts
        file=$(jq -r '.file' "$af" 2>/dev/null || echo "?")
        sid=$(jq -r '.session_id' "$af" 2>/dev/null || echo "?")
        pid=$(jq -r '.pid' "$af" 2>/dev/null || echo "?")
        ts=$(jq -r '.timestamp' "$af" 2>/dev/null || echo "0")
        local age=$(( now - ts ))
        local status="stale"
        if (( age <= RECENT_WINDOW )); then
            kill -0 "$pid" 2>/dev/null && status="ACTIVE" || status="recent"
        fi
        printf "  %-40s  %-7s  session=%-16s  pid=%-6s  %ds ago\n" \
            "$(basename "$file")" "$status" "$sid" "$pid" "$age"
        found=1
    done

    echo "=== Read Tracking ==="
    for rf in "$READS_DIR"/*.json; do
        [[ -f "$rf" ]] || continue
        local file sid ts mtime
        file=$(jq -r '.file' "$rf" 2>/dev/null || echo "?")
        sid=$(jq -r '.session_id' "$rf" 2>/dev/null || echo "?")
        ts=$(jq -r '.timestamp' "$rf" 2>/dev/null || echo "0")
        mtime=$(jq -r '.file_mtime' "$rf" 2>/dev/null || echo "0")
        local age=$(( now - ts ))

        # Check if file changed since read
        local current_mtime stale_flag=""
        if [[ -f "$file" ]]; then
            current_mtime=$(_mtime "$file" || echo "0")
            if [[ "$current_mtime" != "0" ]] && [[ "$mtime" != "0" ]] && (( current_mtime > mtime )); then
                stale_flag=" STALE"
            fi
        fi
        printf "  %-40s  session=%-16s  read %ds ago%s\n" \
            "$(basename "$file")" "$sid" "$age" "$stale_flag"
        found=1
    done

    if [[ $found -eq 0 ]]; then
        echo "  no file activity recorded"
    fi
}

cmd_clean() {
    # #3945: prune by mtime with a single find. The previous implementation forked a jq per file
    # just to read .timestamp — the cleanup was as expensive as the leak it existed to fix, so on
    # a dir that had grown to 13k files it was effectively unrunnable.
    local before after
    before=$(find "$ACTIVITY_DIR" "$READS_DIR" \( -name '*.json' -o -name '.status-cache.*' \) 2>/dev/null | wc -l | tr -d ' ')
    find "$ACTIVITY_DIR" "$READS_DIR" \( -name '*.json' -o -name '.status-cache.*' \) \
        -mmin "+$STALE_MINUTES" -delete 2>/dev/null
    after=$(find "$ACTIVITY_DIR" "$READS_DIR" \( -name '*.json' -o -name '.status-cache.*' \) 2>/dev/null | wc -l | tr -d ' ')
    : > "$PRUNE_MARKER" 2>/dev/null
    echo "cleaned $(( before - after )) old entries ($after remaining)"
}

case "${1:-help}" in
    pre-check)   cmd_pre_check "${2:-}" "${3:-}" ;;
    post-write)  cmd_post_write "${2:-}" "${3:-}" ;;
    post-read)   cmd_post_read "${2:-}" "${3:-}" ;;
    status)      cmd_status ;;
    list)        cmd_list ;;
    clean)       cmd_clean ;;
    *)
        echo "Usage: file-guard.sh {pre-check|post-write|post-read|status|list|clean}"
        exit 1
        ;;
esac
