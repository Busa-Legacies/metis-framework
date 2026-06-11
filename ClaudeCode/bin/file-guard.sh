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
    python3 -c "
import sys, json
# Try positional arg (old direct-JSON format) then stdin (CC 2.1.159+ wraps in tool_input)
for src in [sys.argv[1] if len(sys.argv) > 1 else '', sys.argv[2] if len(sys.argv) > 2 else '']:
    try:
        d = json.loads(src)
        if 'tool_input' in d:
            d = d['tool_input']
        fp = d.get('file_path', '')
        if fp:
            print(fp)
            sys.exit(0)
    except Exception:
        pass
print('')
" "${1:-}" "$_HOOK_STDIN" 2>/dev/null || echo ""
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
    from_stdin=$(python3 -c "
import sys, json
try:
    print(json.loads(sys.argv[1]).get('session_id','') or '')
except Exception:
    print('')
" "$_HOOK_STDIN" 2>/dev/null || echo "")
    if [[ -n "$from_stdin" ]]; then
        echo "$from_stdin"; return
    fi
    # Env fallbacks: neutral override → Codex → Claude Code → legacy.
    echo "${AGENT_SESSION_ID:-${CODEX_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-unknown}}}}"
}

cmd_pre_check() {
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
    local rf="$READS_DIR/${hash}-${sid}.json"

    # ── Check 1: Was this file written by another session recently? ──
    if [[ -f "$af" ]]; then
        local last_sid last_ts last_pid
        last_sid=$(jq -r '.session_id' "$af" 2>/dev/null || echo "")
        last_ts=$(jq -r '.timestamp' "$af" 2>/dev/null || echo "0")
        last_pid=$(jq -r '.pid' "$af" 2>/dev/null || echo "")

        if [[ "$last_sid" != "$sid" ]]; then
            local now age
            now=$(date +%s)
            age=$(( now - last_ts ))

            if (( age <= RECENT_WINDOW )) && [[ -n "$last_pid" ]] && kill -0 "$last_pid" 2>/dev/null; then
                echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"CONCURRENT EDIT DETECTED: $(basename "$fp") was written by another active session ${age}s ago (session=$last_sid). You MUST re-read this file before writing to avoid overwriting their changes. Read the file now, incorporate any new content, then proceed with your edit.\"}}"
                exit 0
            fi
        fi
    fi

    # ── Check 2: Stale read detection — did the file change on disk since we last read it? ──
    if [[ -f "$rf" ]]; then
        local read_ts read_mtime
        read_ts=$(jq -r '.timestamp' "$rf" 2>/dev/null || echo "0")
        read_mtime=$(jq -r '.file_mtime' "$rf" 2>/dev/null || echo "0")

        # Get current file mtime
        local current_mtime
        if [[ -f "$fp" ]]; then
            current_mtime=$(stat -f %m "$fp" 2>/dev/null || echo "0")
        else
            current_mtime="0"
        fi

        if [[ "$current_mtime" != "0" ]] && [[ "$read_mtime" != "0" ]] && (( current_mtime > read_mtime )); then
            echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"STALE READ WARNING: $(basename "$fp") has been modified on disk since you last read it. The file changed after your read. Re-read the file now to get the latest version before editing.\"}}"
            exit 0
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
    mtime=$(stat -f %m "$fp" 2>/dev/null || echo "$(date +%s)")
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
    mtime=$(stat -f %m "$fp" 2>/dev/null || echo "$(date +%s)")
    cat > "$rf" <<JSON
{"file":"$fp","session_id":"$sid","timestamp":$(date +%s),"file_mtime":$mtime}
JSON
    exit 0
}

cmd_status() {
    # One-line output for statusline: count of active files being edited
    local now active_count=0 active_files=""
    now=$(date +%s)
    for af in "$ACTIVITY_DIR"/*.json; do
        [[ -f "$af" ]] || continue
        local pid ts
        pid=$(jq -r '.pid' "$af" 2>/dev/null || echo "")
        ts=$(jq -r '.timestamp' "$af" 2>/dev/null || echo "0")
        local age=$(( now - ts ))
        if (( age <= RECENT_WINDOW )) && [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
            active_count=$((active_count + 1))
            local fname
            fname=$(jq -r '.file' "$af" 2>/dev/null | xargs basename 2>/dev/null || echo "?")
            active_files="${active_files:+$active_files,}$fname"
        fi
    done
    if (( active_count > 0 )); then
        echo "guard:${active_count}f(${active_files})"
    fi
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
            current_mtime=$(stat -f %m "$file" 2>/dev/null || echo "0")
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
    local now cleaned=0
    now=$(date +%s)
    for af in "$ACTIVITY_DIR"/*.json; do
        [[ -f "$af" ]] || continue
        local ts
        ts=$(jq -r '.timestamp' "$af" 2>/dev/null || echo "0")
        local age=$(( now - ts ))
        if (( age > RECENT_WINDOW * 10 )); then
            rm -f "$af"
            cleaned=$((cleaned + 1))
        fi
    done
    for rf in "$READS_DIR"/*.json; do
        [[ -f "$rf" ]] || continue
        local ts
        ts=$(jq -r '.timestamp' "$rf" 2>/dev/null || echo "0")
        local age=$(( now - ts ))
        if (( age > RECENT_WINDOW * 10 )); then
            rm -f "$rf"
            cleaned=$((cleaned + 1))
        fi
    done
    echo "cleaned $cleaned old entries"
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
