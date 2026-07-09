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

# --- never scan the memory INDEX: MEMORY.md aggregates one-line references to many
# memory files (and lists their `#personal` tag), but is not personal content itself.
# Scanning it false-tripped on SHAs / account-types / token counts in unrelated entries.
case "$path" in
  */MEMORY.md|MEMORY.md) exit 0 ;;
esac

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
# Two hardenings against false positives (the index/SHA/account-type blocks of 2026-06-15):
#  1. Suffix is [km] only, NOT [kmb]. `b` is the one money-suffix that is also a hex digit, so it
#     made every commit SHA containing "<digit>b" (e09b190, 8b7b…) look like an amount. Dropping
#     bare `b` removes ALL hex/SHA collisions (k/m never occur in hex); billions are still caught
#     via `$` (\$[0-9]) and the word "billion".
#  2. Strip retirement account TYPE "401k" from the match-copy — it's a name (ends in `k`), not an
#     amount. (403b/457b already fall out now that bare `b` is gone.)
# Suffix right-context is [^a-z0-9] so a digit right after k/m can't extend a false match.
scan=$(printf '%s' "$content" | sed -E 's/401[kK]//g')
money_re='(\$[0-9])|([0-9]+([.,][0-9]+)?[[:space:]]?[km]([^a-z0-9]|$))|([0-9][[:space:]]?(thousand|million|billion|dollars?|usd|grand|bucks))|([0-9]{1,3}(,[0-9]{3})+)'
hit=$(printf '%s' "$scan" | grep -ioE "$money_re" 2>/dev/null | head -3 | paste -sd',' - 2>/dev/null)
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
