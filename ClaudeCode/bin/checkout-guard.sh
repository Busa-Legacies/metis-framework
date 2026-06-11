#!/usr/bin/env bash
# checkout-guard.sh — PreToolCall hook for Edit|Write
#
# Checks if the file being edited is inside a repo that uses the agent checkout
# protocol. If so, warns Claude if there's no active checkout for this session.
#
# Usage (hook):
#   checkout-guard.sh <tool_input_json> [session_id]
#
# Skips silently for files outside tracked repos.
# Compatible with bash 3.2 (macOS default).

set -euo pipefail

# ── Tracked repo config ──
REPO_ROOT="${METIS_HOME:-$HOME/metis-os}"
if [[ "$REPO_ROOT" = "$HOME/Ant-openclaw-framework" ]] && [[ -d "$HOME/metis-os/.git" ]]; then
    REPO_ROOT="$HOME/metis-os"
elif [[ ! -d "$REPO_ROOT/.git" && -d "$HOME/metis-os/.git" ]]; then
    REPO_ROOT="$HOME/metis-os"
fi
STATE_FILE="$REPO_ROOT/docs/process/state/active-checkouts.json"

# Read stdin once for hook calls (CC 2.1.159+ sends hook payload via stdin).
if [[ ! -t 0 ]]; then
    _HOOK_STDIN=$(cat 2>/dev/null || true)
else
    _HOOK_STDIN=""
fi

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

abs_path() {
    python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1" 2>/dev/null || echo "$1"
}

get_sid() {
    local passed="${1:-}"
    if [[ -n "$passed" && "$passed" != "unknown" ]]; then
        echo "$passed"
        return
    fi

    local from_stdin
    from_stdin=$(python3 -c "
import sys, json
try:
    print(json.loads(sys.argv[1]).get('session_id','') or '')
except Exception:
    print('')
" "$_HOOK_STDIN" 2>/dev/null || echo "")
    if [[ -n "$from_stdin" ]]; then
        echo "$from_stdin"
        return
    fi

    echo "${AGENT_SESSION_ID:-${CODEX_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-unknown}}}}"
}

main() {
    local tool_input="${1:-}"
    local sid
    sid=$(get_sid "${2:-}")

    local file_path
    file_path=$(extract_file_path "$tool_input")
    [[ -z "$file_path" ]] && exit 0

    local fp
    fp=$(abs_path "$file_path")

    # Not inside the tracked repo — skip
    case "$fp" in
        "$REPO_ROOT"/*) ;;
        *) exit 0 ;;
    esac

    # No state file yet — warn
    if [[ ! -f "$STATE_FILE" ]]; then
        echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"CHECKOUT REQUIRED: $(basename "$fp") is inside a repo that uses the agent checkout protocol ($REPO_ROOT), but no checkouts exist yet. Run: scripts/agent-checkout <issue> --agent <name> --auto-worktree\"}}"
        exit 0
    fi

    # ── Check for active checkouts ──
    local now
    now=$(date +%s)

    local has_any_active
    has_any_active=$(jq --arg now "$now" '
        [.checkouts[] |
         select(.status != "done" and .status != "released" and .status != "blocked" and .status != "expired" and .status != "stolen") |
         select((.leaseExpiresAt | fromdateiso8601) > ($now | tonumber))
        ] | length
    ' "$STATE_FILE" 2>/dev/null || echo "0")

    # No active checkouts — soft notice
    if [[ "$has_any_active" == "0" ]]; then
        echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"CHECKOUT NOTICE: Editing $(basename "$fp") in $REPO_ROOT with no active agent checkouts. If this is agent work on a GitHub issue, run: scripts/agent-checkout <issue> --agent <name> --auto-worktree. Direct maintenance by Tony can proceed.\"}}"
        exit 0
    fi

    # Active checkouts exist — check if this session has one
    local has_session_checkout
    has_session_checkout=$(jq --arg sid "$sid" --arg now "$now" '
        [.checkouts[] |
         select(.session == $sid) |
         select(.status != "done" and .status != "released" and .status != "blocked" and .status != "expired" and .status != "stolen") |
         select((.leaseExpiresAt | fromdateiso8601) > ($now | tonumber))
        ] | length
    ' "$STATE_FILE" 2>/dev/null || echo "0")

    if [[ "$has_session_checkout" == "0" ]]; then
        local active_agents
        active_agents=$(jq -r --arg now "$now" '
            [.checkouts[] |
             select(.status != "done" and .status != "released" and .status != "blocked" and .status != "expired" and .status != "stolen") |
             select((.leaseExpiresAt | fromdateiso8601) > ($now | tonumber)) |
             "\(.agent) on #\(.issue) (\(.branch))"
            ] | join(", ")
        ' "$STATE_FILE" 2>/dev/null || echo "unknown")

        echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"CHECKOUT WARNING: Editing $(basename "$fp") in $REPO_ROOT but this session has no active checkout. Active checkouts: $active_agents. Check out an issue first or confirm with Tony this is direct maintenance.\"}}"
        exit 0
    fi

    # Session has an active checkout — all clear
    exit 0
}

main "$@"
