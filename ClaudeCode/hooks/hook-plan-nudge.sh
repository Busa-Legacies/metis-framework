#!/bin/bash
# hook-plan-nudge.sh — Claude Code UserPromptSubmit hook.
# Detects strong design/planning intent in the user prompt and nudges the
# session into plan mode (which == Opus under opusplan). Zero-LLM, pure regex.
# Conservative by design: stays silent on trivial edits and slash commands.

prompt="$(python3 -c 'import sys,json;
try:
    d=json.load(sys.stdin); print(d.get("prompt",""))
except Exception:
    pass' 2>/dev/null)"

# Guard: empty / too short
[ "${#prompt}" -lt 25 ] && exit 0

lc="$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')"

# Guard: slash command
case "$lc" in /*) exit 0 ;; esac

# Guard: trivial-edit signals
if printf '%s' "$lc" | grep -Eq 'typo|one[- ]line|rename|just fix|quick fix|tweak|bump version'; then
    exit 0
fi

# Strong planning-intent signals
if printf '%s' "$lc" | grep -Eq \
'(^|[^a-z])plan( out| this| for|ning|s)?([^a-z]|$)|a plan|how should (we|i) (approach|build|structure|design|implement)|let'\''?s (build|implement|design|architect)|design the|architect|spec (out|this)|multiple tasks|several tasks|break (this|it) down|decompose|what'\''?s the best (way|approach) to|think through'; then
    cat <<'JSON'
{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "PLANNING SIGNAL DETECTED: This looks like design/planning work. Before acting, enter plan mode (EnterPlanMode) so reasoning runs on Opus; gather any external facts via the scout lane, then present the plan via ExitPlanMode for approval before execution. Skip this only if the task is actually a trivial mechanical edit."}}
JSON
fi

exit 0
