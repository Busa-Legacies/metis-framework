#!/usr/bin/env bash
# session-pivot.sh — Spawn a new tmux window for a pivot task and launch claude in it.
#
# Usage: scripts/session-pivot.sh "task-label"
#
# Intended to be called at the end of a /checkpoint when a domain pivot is detected.
# The calling session should then run the full /end close before exiting.
#
# Behavior:
#   - Inside tmux (normal case): creates a new window in the ccc session named after the task
#   - Outside tmux (edge case): creates a new named tmux session
#   In both cases, claude is launched in CCC_DIR and will pick up via /start

set -e

TASK="${1:-}"
CCC_DIR="${CCC_DIR:-${METIS_HOME:-$HOME/metis-os}}"
CCC_SESSION="ccc"

if [[ -z "$TASK" ]]; then
  echo "Usage: session-pivot.sh <task-label>" >&2
  exit 1
fi

# Sanitize task label to a valid tmux window name: lowercase, hyphens, max 24 chars
WINDOW_NAME=$(echo "$TASK" \
  | tr '[:upper:]' '[:lower:]' \
  | sed 's/#[0-9]* //' \
  | tr ' ' '-' \
  | sed 's/[^a-z0-9-]//g' \
  | sed 's/--*/-/g' \
  | cut -c1-24 \
  | sed 's/-$//')

if [[ -n "$TMUX" ]]; then
  # Running inside tmux — create a new window in the ccc session if it exists, else current session
  if tmux has-session -t "$CCC_SESSION" 2>/dev/null; then
    TARGET="$CCC_SESSION"
  else
    TARGET="$(tmux display-message -p '#S')"
  fi

  tmux new-window -t "$TARGET" -n "$WINDOW_NAME" "cd '$CCC_DIR' && exec '$CCC_DIR/scripts/claude-tmux.sh'"

  echo ""
  echo "✓ pivot: new tmux window '$WINDOW_NAME' opened in session '$TARGET'"
  echo "  switch to it: Ctrl-b n  (next window)  or  Ctrl-b w  (window list)"
  echo "  it will run /start automatically at session init"
else
  # Not in tmux — create a new detached session
  if tmux has-session -t "$WINDOW_NAME" 2>/dev/null; then
    echo "Session '$WINDOW_NAME' already exists — attach with: tmux attach -t $WINDOW_NAME" >&2
    exit 1
  fi

  tmux new-session -d -s "$WINDOW_NAME" -x 220 -y 50 -c "$CCC_DIR" \
    "cd '$CCC_DIR' && exec '$CCC_DIR/scripts/claude-tmux.sh'"

  echo ""
  echo "✓ pivot: new tmux session '$WINDOW_NAME' created"
  echo "  attach with: tmux attach -t $WINDOW_NAME"
fi
