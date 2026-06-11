#!/usr/bin/env bash
# Born-governed guard (#248) — WARN-ONLY commit-msg hook.
#
# Enforces #098 "born governed": a commit that references #NNN should have a
# governed task entry (taskId "#NNN") in docs/process/state/tasks.json BEFORE
# the commit lands. On 2026-06-09 a session committed #235-#242 as loose refs
# with no tasks.json entries (#237 never created), caught only by a daily-log
# eyeball. This makes the gap mechanical.
#
# It NEVER blocks (exit 0 always) — born-governed is a discipline, not a
# release gate, and hard-blocking would break emergency/auto-sync commits.
# Auto-sync and merge commits are skipped entirely.
#
# Arg: $1 = path to the commit message file (git commit-msg hook contract).
set -u

MSG_FILE="${1:-}"
[ -n "$MSG_FILE" ] && [ -f "$MSG_FILE" ] || exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
TASKS="$ROOT/docs/process/state/tasks.json"
[ -f "$TASKS" ] || exit 0

MSG="$(cat "$MSG_FILE")"

# Skip machine-generated commits — they legitimately reference whatever they merge.
case "$MSG" in
  *"[auto-sync]"*|"Merge "*|"Revert "*|"fixup!"*|"squash!"*) exit 0 ;;
esac

# Extract unique #NNN tokens (3+ digits to avoid matching #1/#12 noise like issue refs).
nums="$(printf '%s\n' "$MSG" \
  | grep -oE '#[0-9]{3,4}' \
  | sed 's/#//' \
  | sort -u)"
[ -n "$nums" ] || exit 0

missing=""
for num in $nums; do
  # taskId is stored as "#NNN" (e.g. "taskId": "#234") — tolerate any whitespace.
  if ! grep -qE "\"taskId\"[[:space:]]*:[[:space:]]*\"#${num}\"" "$TASKS"; then
    missing="$missing #${num}"
  fi
done

if [ -n "$missing" ]; then
  echo "⚠️  born-governed guard (#248): commit references task ID(s) with NO governed" >&2
  echo "    tasks.json entry:$missing" >&2
  echo "    Create them first:  python3 scripts/agent-work.py alloc-id  +  /add-task" >&2
  echo "    (warning only — commit proceeds; #098 born-governed is the standard)" >&2
fi

exit 0
