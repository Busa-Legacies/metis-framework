#!/usr/bin/env bash
# PreToolUse hook (Write|Edit) — enforces the redaction rule "money is never logged" for personal work.
# Closes the one enforcement gap in the tiered-context architecture (§4): redaction was judgment-only.
#
# Tightly scoped to the personal-memory surface so ordinary code/config edits (which legitimately
# contain `$`) are NEVER touched: it only inspects writes whose target path is a personal-log file or
# whose content carries the `#personal` tag. On a high-confidence money pattern it returns a `deny`
# decision asking the agent to redact (generalize the amount away) before writing — a hard backstop,
# not a prose reminder. Full rule: ClaudeCode/CLAUDE.md "Personal Work Capture" + AGENTS.md memory rules.
#
# Fail-open: any parse problem or missing jq → allow (exit 0). Never block on the hook's own error.

data=$(cat 2>/dev/null)
command -v jq >/dev/null 2>&1 || exit 0

tool=$(printf '%s' "$data" | jq -r '.tool_name // empty' 2>/dev/null)
case "$tool" in
  Write|Edit) : ;;
  *) exit 0 ;;
esac

path=$(printf '%s' "$data" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
# Content being written: Write → .content ; Edit → .new_string.
content=$(printf '%s' "$data" | jq -r '.tool_input.content // .tool_input.new_string // empty' 2>/dev/null)
[ -z "$content" ] && exit 0

# --- scope gate: only personal-log files, or content explicitly tagged #personal ---
in_scope=0
case "$path" in
  *personal-log*|*personal-log.md|*/personal/*) in_scope=1 ;;
esac
if [ "$in_scope" -eq 0 ]; then
  printf '%s' "$content" | grep -q '#personal' && in_scope=1
fi
[ "$in_scope" -eq 0 ] && exit 0

# --- high-confidence money patterns (numeric only — word-only like "significant" is too broad) ---
# $-amounts, k/m/bn suffixes, money words after a number, comma-grouped thousands.
money_re='(\$[0-9])|([0-9]([.,][0-9]+)?[[:space:]]?[kmb]([^a-z]|$))|([0-9][[:space:]]?(thousand|million|billion|dollars?|usd|grand|bucks))|([0-9]{1,3}(,[0-9]{3})+)'
hit=$(printf '%s' "$content" | grep -ioE "$money_re" 2>/dev/null | head -3 | paste -sd',' - 2>/dev/null)
[ -z "$hit" ] && exit 0

reason="Redaction rule (money is never logged): the personal-memory write contains what looks like a money amount [${hit}]. Generalize it away — e.g. 'a concentrated high-risk asset', 'a significant sum' → omit entirely — then write again. Holdings/people become roles; amounts are omitted (no ranges, no 'significant'). See ClaudeCode/CLAUDE.md > Personal Work Capture. If this is a false positive (not money), rephrase to avoid the numeric pattern."

jq -n --arg r "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}'
exit 0
