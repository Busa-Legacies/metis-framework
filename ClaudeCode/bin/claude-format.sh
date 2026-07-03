#!/bin/bash
# Auto-format after Claude writes/edits a file.
# Reads file path from $TOOL_INPUT env var (Claude Code hook context).
# Silently skips if no formatter is installed.

FILE=$(echo "$TOOL_INPUT" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('file_path', d.get('path', '')))
except:
    pass
" 2>/dev/null)

[ -z "$FILE" ] && exit 0
[ ! -f "$FILE" ] && exit 0

EXT="${FILE##*.}"

case "$EXT" in
  py)
    if command -v ruff &>/dev/null; then
      ruff format --quiet "$FILE" 2>/dev/null || true
    elif command -v black &>/dev/null; then
      black --quiet "$FILE" 2>/dev/null || true
    fi
    ;;
  js|ts|jsx|tsx|css|html)
    if command -v prettier &>/dev/null; then
      prettier --write --log-level=silent "$FILE" 2>/dev/null || true
    fi
    ;;
  json)
    # Only format small JSON files (skip lock files etc)
    if command -v prettier &>/dev/null && [ "$(wc -c < "$FILE")" -lt 50000 ]; then
      prettier --write --log-level=silent "$FILE" 2>/dev/null || true
    fi
    ;;
esac

exit 0
