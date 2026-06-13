#!/usr/bin/env bash
# task-ready.sh — Pre-start check: is this task workable right now?
#
# Usage: scripts/task-ready.sh "task label or #NNN slug"
#
# Run at session start (or before claiming a task) to catch:
#   - Tasks blocked by unfinished prerequisites
#   - Tasks that may already be done (verify passes before you start)
#   - Missing required services for the task type
#
# Exit codes:
#   0  — READY: claim it and start
#   1  — BLOCKED: prerequisites not met or required services down
#   2  — MAYBE DONE: task-verify passed before you started — confirm before re-working
#   3  — UNKNOWN: no task entry found; probably fine to start, verify manually

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TASK_QUEUE="$REPO/docs/process/task-queue.md"
TASK_DOMAIN="$REPO/scripts/task-domain.py"
TASK_VERIFY="$REPO/scripts/task-verify.sh"

TASK="${*:-}"
if [[ -z "$TASK" ]]; then
  echo "Usage: task-ready.sh <task-label>" >&2
  exit 3
fi

echo "ready-check: '$TASK'"
echo ""

BLOCKED=0; WARNINGS=()

# ── helper: extract a field from the task block ───────────────────────────────

extract_field() {
  local field="$1"
  python3 - "$TASK_QUEUE" "$TASK" "$field" <<'PYEOF'
import re, sys, pathlib

queue = pathlib.Path(sys.argv[1])
task_query = re.sub(r"^#\d+\s*", "", sys.argv[2].lower().strip())
field = sys.argv[3]
found_task = False
result = []

with open(queue) as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    m = re.search(r"\*\*([^*]+)\*\*", line)
    if m and not found_task:
        label = re.sub(r"^#\d+\s*`?", "", m.group(1).strip().lower().rstrip("`"))
        if task_query in label or label in task_query:
            found_task = True
            continue
    if found_task:
        if re.match(r"^- \*\*", line) and i > 0:
            break
        fm = re.match(rf"\s+- \*\*{re.escape(field)}:\*\* (.+)", line)
        if fm:
            result.append(fm.group(1).strip())

print("\n".join(result))
PYEOF
}

# ── check 1: blocked-by prerequisites ─────────────────────────────────────────
# extract_field handles both "Blocked by:" field and @blocked-by: inline tag

extract_blockers() {
  python3 "$REPO/scripts/task-ready-blockers.py" "$TASK_QUEUE" "$TASK"
}

BLOCKED_BY=$(extract_blockers)

if [[ -n "$BLOCKED_BY" ]]; then
  for prereq in $BLOCKED_BY; do
    prereq_num=$(echo "$prereq" | tr -d '#')
    # Check if prereq is marked done in task-queue.md
    done=$(python3 - "$TASK_QUEUE" "$prereq_num" <<'PYEOF'
import re, sys, pathlib

queue = pathlib.Path(sys.argv[1])
num = sys.argv[2].zfill(3)

with open(queue) as f:
    lines = f.readlines()

in_task = False
result = "open"
for line in lines:
    if re.search(rf"\*\*#{num}\b", line):
        in_task = True
        if re.search(r"status:done|DONE|✅|\[x\]", line, re.IGNORECASE):
            result = "done"
            break
        continue
    if in_task:
        if re.match(r"^- \*\*#", line):
            break
        if re.search(r"status:done|DONE|✅|\[x\]", line, re.IGNORECASE):
            result = "done"
            break
print(result)
PYEOF
)
    if [[ "$done" == "open" ]]; then
      echo "  ✗ BLOCKED: prerequisite $prereq is not done"
      BLOCKED=$((BLOCKED+1))
    else
      echo "  ✓ prerequisite $prereq is done"
    fi
  done
fi

# ── check 2: maybe already done (run task-verify) ─────────────────────────────

echo "  → checking if task may already be complete..."
verify_exit=0
verify_out=$(VERIFY_SKIP=0 bash "$TASK_VERIFY" "$TASK" 2>&1) || verify_exit=$?

if [[ $verify_exit -eq 0 ]]; then
  echo ""
  echo "  ⚠ MAYBE DONE: task-verify passed before you started"
  echo "  Verify output:"
  echo "$verify_out" | sed 's/^/    /'
  echo ""
  echo "  This task may already be complete. Confirm with Ant before re-working."
  echo ""
  BLOCKED=$((BLOCKED+1))
  WARNINGS+=("task may already be done — verify passed")
elif [[ $verify_exit -eq 2 ]]; then
  echo "  → no automated verify available (normal for new/research tasks)"
else
  echo "  → verify failed (expected — task not yet done)"
fi

# ── check 3: required services ────────────────────────────────────────────────

SECTION=$(python3 "$TASK_DOMAIN" "$TASK" 2>/dev/null || echo "unknown")
LABEL_LOWER=$(echo "$TASK" | tr '[:upper:]' '[:lower:]')

case "$SECTION" in
  Dashboard|"Remote Access")
    if echo "$LABEL_LOWER" | grep -q "dashboard\|terminal\|panel\|api"; then
      if curl -sf http://127.0.0.1:8080/api/all >/dev/null 2>&1; then
        echo "  ✓ dashboard service is up (port 8080)"
      else
        echo "  ✗ dashboard service is DOWN — restart with: bash scripts/restart-dashboard.sh"
        BLOCKED=$((BLOCKED+1))
      fi
    fi
    ;;
  "OpenClaw Infrastructure"|Automation)
    if echo "$LABEL_LOWER" | grep -q "lane\|smith\|scout\|warden\|echo\|jlane\|ollama"; then
      if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
        echo "  ✓ Ollama is up (port 11434)"
      else
        echo "  ✗ Ollama is DOWN — lanes won't work"
        BLOCKED=$((BLOCKED+1))
      fi
    fi
    ;;
  "Trading Bot")
    config="$REPO/projects/trading-bot/config/config.yaml"
    if [[ -f "$config" ]]; then
      echo "  ✓ trading bot config exists"
    else
      echo "  ✗ trading bot config missing: $config"
      BLOCKED=$((BLOCKED+1))
    fi
    ;;
esac

# ── summary ───────────────────────────────────────────────────────────────────

echo ""
if [[ $BLOCKED -gt 0 ]]; then
  echo "✗ NOT READY — $BLOCKED issue(s) must be resolved first"
  exit 1
else
  echo "✓ READY — start working on '$TASK'"
  exit 0
fi
