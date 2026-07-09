#!/bin/bash
# hook-plan-nudge.sh — Claude Code UserPromptSubmit hook.
# Turns two always-on doctrines into ACTIVE per-prompt policy (zero-LLM, pure regex):
#   1. Question-First Workflow (CLAUDE.md / decision-doctrine.md §2b) — on any
#      non-trivial BUILD prompt, front-load blocking questions in ONE batch, then
#      execute autonomously. This is the enforcement seam: doc text alone competes
#      with "Default: ACT" and gets ignored, so we inject the directive each turn.
#   2. Plan mode on strong DESIGN intent (== Opus under opusplan).
# Conservative by design: silent on trivial edits, slash commands, and short prompts.

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

# Guard: trivial-edit signals (question-first explicitly exempts these)
if printf '%s' "$lc" | grep -Eq 'typo|one[- ]line|rename|just fix|quick fix|tweak|bump version|revert|comment out'; then
    exit 0
fi

# Strong DESIGN/planning intent → plan mode + question-first
design_re='(^|[^a-z])plan( out| this| for|ning|s)?([^a-z]|$)|a plan|how should (we|i) (approach|build|structure|design|implement)|let'\''?s (build|implement|design|architect)|design the|architect|spec (out|this)|multiple tasks|several tasks|break (this|it) down|decompose|what'\''?s the best (way|approach) to|think through'

# BUILD/implementation intent (plainly-worded work — the case that was slipping
# through as "just documentation"). Broader than design intent but still bounded.
build_re='(^|[^a-z])(build|implement|integrate|buildout|refactor|migrate|scaffold)([^a-z]|$)|build out|set up|wire up|stand up|add (a|an|the|support|support for)|create (a|an|the)|new (feature|endpoint|integration|script|module|service|page|component|command|hook|skill|lane)|hook (up|into)|add .* (endpoint|integration|feature|command|route|page|hook)'

if printf '%s' "$lc" | grep -Eq "$design_re"; then
    cat <<'JSON'
{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "QUESTION-FIRST + PLANNING SIGNAL (doctrine, hook-enforced): This is non-trivial design work. (1) FRONT-LOAD every blocking decision into a SINGLE AskUserQuestion batch (decide-and-present: recommend a default for each) BEFORE building — do NOT dribble questions out one at a time mid-build. (2) Enter plan mode (EnterPlanMode) so reasoning runs on Opus; gather external facts via the scout lane. (3) Present via ExitPlanMode, then execute autonomously to done. Skip ONLY if this is genuinely a trivial mechanical edit."}}
JSON
    exit 0
fi

if printf '%s' "$lc" | grep -Eq "$build_re"; then
    cat <<'JSON'
{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "QUESTION-FIRST WORKFLOW (doctrine, hook-enforced): This looks like a non-trivial build. Before writing code, state a quick plan and FRONT-LOAD every blocking question into a SINGLE AskUserQuestion batch (decide-and-present: recommend a default for each) — do NOT dribble questions out one at a time mid-build, and do NOT start building past an unresolved fork. Once the batch is answered (or nothing blocks), execute autonomously to done without pausing for confirmation between steps. Skip ONLY for genuinely trivial edits."}}
JSON
    exit 0
fi

exit 0
