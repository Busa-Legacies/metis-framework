#!/usr/bin/env bash
# auto-checkpoint-on-close.sh — fires after agent-work.py unclaim on a done task.
#
# Seeds a descriptive checkpoint commit from the task's what/why so intentional
# history lands without a manual /checkpoint invocation.
#
# USAGE: scripts/auto-checkpoint-on-close.sh <task_id> <task_title> <task_summary>
#
# Called automatically by agent-work.py cmd_unclaim. Silent no-op if git-lock is
# unavailable or nothing to commit (idempotent via commit-or-intent.sh).

set -uo pipefail

TASK_ID="${1:-}"
TASK_TITLE="${2:-}"
TASK_SUMMARY="${3:-}"

if [[ -z "$TASK_ID" ]]; then
    echo "auto-checkpoint: usage: $0 <task_id> <task_title> <task_summary>" >&2
    exit 1
fi

# Resolve repo root and scripts dir portably (macOS bash 3.2 safe).
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPTS_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Step 1: re-render projections (task-queue.md, OPEN_TASKS.md, live-status.md).
python3 "$SCRIPTS_DIR/render-tier1-state.py" write >/dev/null 2>&1 || true

# Step 2: remove the task thread from working-context (best-effort; thread may not exist).
python3 "$SCRIPTS_DIR/working-context-update.py" --remove "$TASK_ID" >/dev/null 2>&1 || true

# Step 3: commit under the git lock with a seeded message.
MSG_FILE="$(mktemp)"
cat >"$MSG_FILE" <<MSGEOF
checkpoint: $TASK_ID $TASK_TITLE — done

$TASK_SUMMARY

Auto-checkpoint on task-close.
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
MSGEOF

# The git-lock inner command must use absolute paths to scripts/ since CWD may vary.
TASK_FILES="docs/process/state/tasks.json workspace/memory/working-context.md workspace/state/OPEN_TASKS.md docs/process/task-queue.md docs/process/live-status.md docs/process/projects.md"

"$SCRIPTS_DIR/git-lock.sh" run bash -c "
  cd '$REPO_ROOT'
  git add $TASK_FILES 2>/dev/null || true
  '$SCRIPTS_DIR/commit-or-intent.sh' --message-file '$MSG_FILE' -- $TASK_FILES
"

rm -f "$MSG_FILE"
echo "auto-checkpoint: $TASK_ID committed."
