#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="${SOURCE_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
TMP_REPO="$(mktemp -d "${TMPDIR:-/tmp}/task-ready-projection-lag.XXXXXX")"
trap 'rm -rf "$TMP_REPO"' EXIT

mkdir -p \
  "$TMP_REPO/scripts/lib" \
  "$TMP_REPO/docs/process/state" \
  "$TMP_REPO/docs/process"

cp "$SOURCE_REPO/scripts/task-ready.sh" "$TMP_REPO/scripts/task-ready.sh"
cp "$SOURCE_REPO/scripts/task-ready-blockers.py" "$TMP_REPO/scripts/task-ready-blockers.py"
cp "$SOURCE_REPO/scripts/lib/task_state.py" "$TMP_REPO/scripts/lib/task_state.py"
chmod +x "$TMP_REPO/scripts/task-ready.sh" "$TMP_REPO/scripts/task-ready-blockers.py"

cat > "$TMP_REPO/scripts/task-verify.sh" <<'EOF_VERIFY'
#!/usr/bin/env bash
exit 1
EOF_VERIFY
chmod +x "$TMP_REPO/scripts/task-verify.sh"

cat > "$TMP_REPO/scripts/task-domain.py" <<'EOF_DOMAIN'
#!/usr/bin/env python3
print("unknown")
EOF_DOMAIN
chmod +x "$TMP_REPO/scripts/task-domain.py"

cat > "$TMP_REPO/docs/process/state/tasks.json" <<'EOF_JSON'
{
  "tasks": [
    {
      "taskId": "#199",
      "title": "Canonical prerequisite",
      "state": "done",
      "blockerOrNone": "none"
    },
    {
      "taskId": "#200",
      "title": "Task gated by canonical prerequisite",
      "state": "queued",
      "blockerOrNone": "blocked by #199"
    }
  ]
}
EOF_JSON

cat > "$TMP_REPO/docs/process/task-queue.md" <<'EOF_MD'
# Task Queue

## Queued
- [ ] #199 Canonical prerequisite
- [ ] #200 Task gated by canonical prerequisite (blocked by #199)
EOF_MD

OUTPUT_FILE="$TMP_REPO/task-ready.out"

set +e
REPO_ROOT="$TMP_REPO" bash "$TMP_REPO/scripts/task-ready.sh" "#200" >"$OUTPUT_FILE" 2>&1
status=$?
set -e

if [[ $status -ne 0 ]]; then
  echo "expected task-ready to pass when tasks.json marks the prerequisite done"
  cat "$OUTPUT_FILE"
  exit 1
fi

grep -q "prerequisite #199 is done" "$OUTPUT_FILE" || {
  echo "expected canonical prerequisite success message"
  cat "$OUTPUT_FILE"
  exit 1
}

grep -q "✓ READY" "$OUTPUT_FILE" || {
  echo "expected READY summary"
  cat "$OUTPUT_FILE"
  exit 1
}

if grep -q "BLOCKED: prerequisite #199 is not done" "$OUTPUT_FILE"; then
  echo "projection lag regression: stale markdown incorrectly blocked the task"
  cat "$OUTPUT_FILE"
  exit 1
fi