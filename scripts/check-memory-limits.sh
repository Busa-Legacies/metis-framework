#!/usr/bin/env bash
# Enforce the memory-frontmatter standard's hard limits (docs: MEMORY.md max 200 lines,
# individual memory files max 60). Over-limit files mean memory is storing code/history
# that belongs in the repo. Exit 0 if all within limits; else prints offenders + exit 1.
# Repo-relative so it works on any machine (memory dir is symlinked into ClaudeCode/memory).
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && git rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR/..")"
MEM="$REPO/ClaudeCode/memory"
bad=""

idx="$MEM/MEMORY.md"
if [ -f "$idx" ]; then
    n=$(wc -l < "$idx")
    [ "$n" -gt 200 ] && bad="${bad}MEMORY.md is $n lines (>200) — prune/merge a stale entry"$'\n'
fi

while IFS= read -r f; do
    n=$(wc -l < "$f")
    if [ "$n" -gt 60 ]; then
        bad="${bad}$(basename "$f") is $n lines (>60) — trim to the durable fact"$'\n'
    fi
done < <(find "$MEM" -name '*.md' ! -name MEMORY.md 2>/dev/null)

[ -z "$bad" ] && exit 0
printf '%s' "$bad"
exit 1
