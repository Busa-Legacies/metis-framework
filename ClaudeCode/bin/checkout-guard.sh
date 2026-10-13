#!/usr/bin/env bash
# checkout-guard.sh — PreToolCall hook for Edit|Write
#
# Lock-for-everyone (Ant 2026-07-31): if the file being edited is inside a repo that
# uses the agent checkout protocol, this session MUST hold a live checkout lease or the
# Edit/Write is DENIED — the owner's own interactive sessions included. Fails OPEN on any
# uncertainty (corrupt/missing state file) so a transient data problem can't wedge every
# session. Governance scripts write state via Bash, so they are never gated by this hook.
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
# `-e`, NOT `-d`: in a git WORKTREE `.git` is a FILE (a gitdir: pointer), not a directory. With
# -d this branch fired for every worktree, rewrote REPO_ROOT to the main clone, and the path test
# below then failed to match the worktree's own path — so the guard fell through and ALLOWED the
# write. Since `agent-checkout` defaults to --auto-worktree, lock-for-everyone was silently
# unenforced in the default agent workspace, and the hook harness (which runs in a worktree under
# the daemon's pre-push gate) failed its own un-leased-write assertion, holding main RED
# fleet-wide. Verified both ways after the fix: un-leased writes are denied in a worktree AND in
# the main clone, and a live lease-holder is still allowed in both.
elif [[ ! -e "$REPO_ROOT/.git" && -d "$HOME/metis-os/.git" ]]; then
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

# Canonicalize REPO_ROOT the SAME way the file path is canonicalized below. The path test is a
# prefix match, so comparing a realpath'd file against a NON-realpath'd root silently fails to
# match whenever the repo is reached through a symlink — on macOS /tmp is itself a symlink to
# /private/tmp, so a repo or worktree under it never matched and the guard fell through to ALLOW.
# Same enforcement-hole class as the -d/.git bug above (#1462): protection quietly absent, and
# invisible from the ordinary $HOME/metis-os path where both spellings are already identical.
REPO_ROOT="$(abs_path "$REPO_ROOT")"

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

    local now
    now=$(date +%s)

    # ── Canonical shared-state DENY (#519) ──────────────────────────────────────
    # `docs/process/state/*` (tasks.json, active-checkouts.json, file-claims.jsonl,
    # projections) is the strongest anti-collision surface: two sessions hand-editing
    # it concurrently corrupt the governed board. The written rule ("claim before the
    # first edit"; "never hand-edit tasks.json — use the scripts") was honor-only here
    # while sign-off FORMATTING got a blocking hook. Escalate to a hard DENY for a
    # direct Edit/Write to that dir when THIS session holds no live lease. The
    # governance scripts write state via Bash (not Edit/Write), so they never trip
    # this; a lease-holding session is mid-protocol and still allowed (warn path).
    case "$fp" in
        "$REPO_ROOT"/docs/process/state/*)
            local has_session_lease=0
            if [[ -f "$STATE_FILE" ]]; then
                has_session_lease=$(jq --arg sid "$sid" --arg now "$now" '
                    [.checkouts[] |
                     select(.session == $sid) |
                     select(.status != "done" and .status != "released" and .status != "blocked" and .status != "expired" and .status != "stolen") |
                     select((.leaseExpiresAt | fromdateiso8601) > ($now | tonumber))
                    ] | length
                ' "$STATE_FILE" 2>/dev/null || echo "0")
            fi
            if [[ "$has_session_lease" == "0" ]]; then
                local reason="CHECKOUT REQUIRED (deny): $(basename "$fp") is under docs/process/state/ — the canonical governed board (tasks.json, leases, projections). This session holds NO live lease, and direct hand-edits to shared state are the top anti-collision hazard. Do NOT edit it directly. To change task/lease state use the contract scripts (scripts/update-tier1-state.py, scripts/agent-work.py) via Bash — they lock, validate, and re-render the projections. To work an issue, claim it first: python3 scripts/agent-work.py claim '#NNN' --agent <name>. See docs/process/state/README.md."
                jq -n --arg r "$reason" '{
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: $r
                  }
                }'
                exit 0
            fi
            ;;
    esac

    # No state file yet — warn
    if [[ ! -f "$STATE_FILE" ]]; then
        echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"CHECKOUT REQUIRED: $(basename "$fp") is inside a repo that uses the agent checkout protocol ($REPO_ROOT), but no checkouts exist yet. Run: scripts/agent-checkout <issue> --agent <name> --auto-worktree\"}}"
        exit 0
    fi

    # ── Lock-for-everyone (Ant 2026-07-31): a live lease is required for ANY repo write ──
    # Every session — the owner's own interactive sessions included — must hold a live checkout
    # lease to Edit/Write any file under the repo. This closes the gap where the state/ DENY
    # above covered only the governed board while the rest of the repo (code, docs, hooks)
    # was advisory: a session could edit with no claim and silently collide with parallel
    # work. FAIL-OPEN on any uncertainty (unreadable/corrupt state file → jq error) so a
    # transient data problem can never wedge every session out of editing at once.
    local has_session_checkout
    has_session_checkout=$(jq --arg sid "$sid" --arg now "$now" '
        [.checkouts[] |
         select(.session == $sid) |
         select(.status != "done" and .status != "released" and .status != "blocked" and .status != "expired" and .status != "stolen") |
         select((.leaseExpiresAt | fromdateiso8601) > ($now | tonumber))
        ] | length
    ' "$STATE_FILE" 2>/dev/null || echo "FAILOPEN")

    # Could not determine lease ownership (corrupt/unreadable state) — fail OPEN, never wedge all sessions.
    if [[ "$has_session_checkout" == "FAILOPEN" || -z "$has_session_checkout" ]]; then
        # Non-silent fail-open (#5100): a PERSISTENTLY corrupt state file silently disables the
        # strongest gate for everyone. Log each fail-open (never affecting the hook — fully guarded)
        # so the compliance auditor / self-heal can surface a real, ongoing bypass. Transient failures
        # stay harmless; a run of them is now visible instead of silent.
        { _fo_log="$HOME/.openclaw/logs/checkout-guard-failopen.jsonl"
          mkdir -p "$(dirname "$_fo_log")" 2>/dev/null
          _fo_exists=$([[ -f "$STATE_FILE" ]] && echo true || echo false)
          printf '{"ts":"%s","session":"%s","file":"%s","state_exists":%s}\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sid" "$(basename "$fp")" "$_fo_exists" >> "$_fo_log"
        } 2>/dev/null || true
        echo "{\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"additionalContext\": \"CHECKOUT GUARD: could not read lease state for $(basename "$fp") (fail-open, allowing). If this persists, inspect $STATE_FILE.\"}}"
        exit 0
    fi

    if [[ "$has_session_checkout" == "0" ]]; then
        # AUTO-CLAIM (harness audit 2026-10-05, Ant-approved): the deny below was the #1 tool-error
        # source (94 in 14 days), each costing deny -> manual claim -> retry. Other sessions' leases
        # never block an edit here (only "does THIS session hold one" is checked), so claiming an
        # ad-hoc lease on the session's behalf keeps the lock-for-everyone guarantee (every write is
        # attributed to a live, visible lease) without the round trip. Falls through to the deny if
        # the claim fails. Disable with CHECKOUT_GUARD_AUTOCLAIM=0. Never reached for
        # docs/process/state/ (that deny above stays a hard stop).
        if [[ "${CHECKOUT_GUARD_AUTOCLAIM:-1}" == "1" && "$sid" != "unknown" && -n "$sid" && -f "$REPO_ROOT/scripts/agent-work.py" ]]; then
            local ac_label="auto: edits in $(basename "$REPO_ROOT") from session ${sid:0:8}"
            if python3 "$REPO_ROOT/scripts/agent-work.py" claim "$ac_label" --agent claude --session "$sid" >/dev/null 2>&1; then
                jq -n --arg f "$(basename "$fp")" --arg l "$ac_label" '{
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    additionalContext: ("CHECKOUT GUARD: no lease held, so an ad-hoc lease was auto-claimed (\($l)) to allow editing \($f). For real task work claim the task id instead (python3 scripts/agent-work.py claim '"'"'#NNN'"'"' --agent claude).")
                  }
                }'
                exit 0
            fi
        fi
        # This session holds NO live lease and auto-claim failed/disabled → DENY (lock-for-everyone).
        local active_agents
        active_agents=$(jq -r --arg now "$now" '
            [.checkouts[] |
             select(.status != "done" and .status != "released" and .status != "blocked" and .status != "expired" and .status != "stolen") |
             select((.leaseExpiresAt | fromdateiso8601) > ($now | tonumber)) |
             "\(.agent) on \(.taskId // (if .issue then "#\(.issue)" else null end) // .title // "unknown-task")\(if .branch then " (\(.branch))" else "" end)"
            ] | join(", ")
        ' "$STATE_FILE" 2>/dev/null || echo "")
        local others="none"
        [[ -n "$active_agents" ]] && others="$active_agents"
        local reason="CHECKOUT REQUIRED (deny): editing $(basename "$fp") in $REPO_ROOT, but this session holds no live checkout lease. This repo requires a lease before ANY Edit/Write (lock-for-everyone, Ant 2026-07-31). Claim one via Bash first, then retry: for a GitHub issue -> scripts/agent-checkout <issue> --agent <name> --auto-worktree; for ad-hoc work -> python3 scripts/agent-work.py claim '<short label>' --agent <name>. Governance scripts write state via Bash and are unaffected. Other active leases: ${others}."
        jq -n --arg r "$reason" '{
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: $r
          }
        }'
        exit 0
    fi

    # Session holds a live lease — all clear.
    exit 0
}

main "$@"
