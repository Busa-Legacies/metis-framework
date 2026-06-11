#!/usr/bin/env bash
# close-tasks.sh — batch-close governed tasks via correct-state --retroactive
# Usage: close-tasks.sh <#NNN[:reason]> [<#NNN[:reason]> ...]
# Reason can be inline after : or defaults to "closed via batch close-tasks.sh"
# Rerenders task-queue.md projection once at the end.
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPTS/.." && pwd)"

usage() { echo "Usage: $0 '#NNN[:reason]' ['#NNN[:reason]' ...]"; exit 1; }
[ $# -eq 0 ] && usage

FAILED=0
for arg in "$@"; do
  task_id="${arg%%:*}"
  reason="${arg#*:}"
  [ "$reason" = "$arg" ] && reason="closed via batch close-tasks.sh"

  # look up current revision from tasks.json
  rev=$(python3 -c "
import json, sys
tasks = json.load(open('$REPO/docs/process/state/tasks.json'))
for t in tasks['tasks']:
    if t.get('taskId') == '$task_id':
        print(t.get('revision', 1))
        sys.exit(0)
print('')
" 2>/dev/null)

  if [ -z "$rev" ]; then
    echo "SKIP  $task_id — not found in tasks.json"
    continue
  fi

  if python3 "$SCRIPTS/update-tier1-state.py" correct-state \
      --task-id "$task_id" \
      --expected-revision "$rev" \
      --actor claude \
      --to-state done \
      --reason "$reason" \
      --retroactive 2>&1; then
    echo "DONE  $task_id (rev $rev → $((rev+1)))"
  else
    echo "FAIL  $task_id"
    FAILED=$((FAILED+1))
  fi
done

echo ""
echo "── Regenerating projection…"
python3 "$SCRIPTS/render-tier1-state.py" write 2>&1

[ $FAILED -eq 0 ] && echo "close-tasks: all done." || { echo "close-tasks: $FAILED failure(s)."; exit 1; }
