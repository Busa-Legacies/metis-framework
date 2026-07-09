#!/usr/bin/env bash
# task-ready.sh — Pre-start check: is this task workable right now?
#
# Usage: scripts/task-ready.sh "exact task title or #NNN"
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
#   3  — UNKNOWN: no canonical task entry found or canonical task state unreadable

set -euo pipefail

REPO="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
TASK_DOMAIN="$REPO/scripts/task-domain.py"
TASK_VERIFY="$REPO/scripts/task-verify.sh"
TASK_READY_BLOCKERS="$REPO/scripts/task-ready-blockers.py"

TASK="${*:-}"
if [[ -z "$TASK" ]]; then
  echo "Usage: task-ready.sh <exact-task-title-or-#NNN>" >&2
  exit 3
fi

resolve_task_identity() {
  REPO_ROOT="$REPO" python3 - "$1" <<'PYEOF'
import os
import sys

repo = os.environ["REPO_ROOT"]
sys.path.insert(0, os.path.join(repo, "scripts"))
from lib import task_state

try:
    tasks = task_state.snapshot()
    resolved = task_state.resolve(sys.argv[1], tasks)
    record = task_state.fields(resolved, tasks) if resolved else None
except task_state.TaskStateReadError as exc:
    print(f"task-ready: canonical task state unreadable: {exc}", file=sys.stderr)
    raise SystemExit(3)

if resolved:
    title = (record or {}).get("title") or resolved
    print(f"{resolved}\t{title}")
PYEOF
}

task_prerequisite_statuses() {
  local task_ref="$1"
  REPO_ROOT="$REPO" python3 "$TASK_READY_BLOCKERS" --status "$task_ref"
}

echo "ready-check: '$TASK'"
echo ""

TASK_IDENTITY_EXIT=0
TASK_IDENTITY="$(resolve_task_identity "$TASK" 2>&1)" || TASK_IDENTITY_EXIT=$?

if [[ $TASK_IDENTITY_EXIT -ne 0 ]]; then
  echo ""
  if [[ -n "$TASK_IDENTITY" ]]; then
    echo "$TASK_IDENTITY" | sed 's/^/  /'
  fi
  echo ""
  echo "✗ UNKNOWN — canonical task state unreadable; verify manually before starting"
  exit 3
fi

if [[ -z "$TASK_IDENTITY" ]]; then
  echo "  ? UNKNOWN: no canonical task entry found for exact id/title '$TASK'"
  echo ""
  echo "✗ UNKNOWN — verify manually before starting"
  exit 3
fi

IFS=$'\t' read -r RESOLVED_TASK CANONICAL_TITLE <<< "$TASK_IDENTITY"

if [[ -z "${CANONICAL_TITLE:-}" ]]; then
  CANONICAL_TITLE="$TASK"
fi

if [[ "$RESOLVED_TASK" != "$TASK" || "$CANONICAL_TITLE" != "$TASK" ]]; then
  echo "  → resolved canonically to $RESOLVED_TASK: $CANONICAL_TITLE"
fi

BLOCKED=0

# ── check 1: blocked-by prerequisites (canonical tasks.json only) ─────────────

PREREQ_STATUS_EXIT=0
PREREQ_STATUS_OUTPUT="$(task_prerequisite_statuses "$RESOLVED_TASK" 2>&1)" || PREREQ_STATUS_EXIT=$?

if [[ $PREREQ_STATUS_EXIT -ne 0 ]]; then
  echo ""
  if [[ -n "$PREREQ_STATUS_OUTPUT" ]]; then
    echo "$PREREQ_STATUS_OUTPUT" | sed 's/^/  /'
  fi
  echo ""
  echo "✗ UNKNOWN — verify manually before starting"
  exit 3
fi

if [[ -n "$PREREQ_STATUS_OUTPUT" ]]; then
  while IFS=$'\t' read -r prereq prereq_state; do
    [[ -z "${prereq:-}" ]] && continue
    if [[ "${prereq_state:-}" == "done" ]]; then
      echo "  ✓ prerequisite $prereq is done"
    else
      echo "  ✗ BLOCKED: prerequisite $prereq is not done"
      BLOCKED=$((BLOCKED+1))
    fi
  done <<< "$PREREQ_STATUS_OUTPUT"
fi

# ── check 2: maybe already done (run task-verify) ─────────────────────────────

echo "  → checking if task may already be complete..."
verify_exit=0
verify_out=$(VERIFY_SKIP=0 REPO_ROOT="$REPO" bash "$TASK_VERIFY" "$RESOLVED_TASK" 2>&1) || verify_exit=$?

if [[ $verify_exit -eq 0 ]]; then
  echo ""
  echo "  ⚠ MAYBE DONE: task-verify passed before you started"
  echo "  Verify output:"
  echo "$verify_out" | sed 's/^/    /'
  echo ""
  echo "  This task may already be complete. Confirm before re-working."
  echo ""
  echo "✗ NOT READY — task appears already complete"
  exit 2
elif [[ $verify_exit -eq 2 ]]; then
  echo "  → no automated verify available (normal for new/research tasks)"
else
  echo "  → verify failed (expected — task not yet done)"
fi

# ── check 3: required services ────────────────────────────────────────────────

SECTION=$(REPO_ROOT="$REPO" python3 "$TASK_DOMAIN" "$RESOLVED_TASK" 2>/dev/null || echo "unknown")
TITLE_LOWER=$(echo "$CANONICAL_TITLE" | tr '[:upper:]' '[:lower:]')

check_url() {
  local url="$1"
  curl -sf "$url" >/dev/null 2>&1
}

case "$SECTION" in
  Dashboard|"Remote Access")
    if echo "$TITLE_LOWER" | grep -q "dashboard\|terminal\|panel\|api"; then
      if check_url "http://127.0.0.1:8080/api/all"; then
        echo "  ✓ dashboard service is up (port 8080)"
      else
        echo "  ✗ dashboard service is DOWN — restart with: bash scripts/restart-dashboard.sh"
        BLOCKED=$((BLOCKED+1))
      fi
    fi
    ;;
  "OpenClaw Infrastructure"|Automation)
    if echo "$TITLE_LOWER" | grep -q "lane\|smith\|scout\|warden\|echo\|jlane\|ollama"; then
      if check_url "http://localhost:11434/api/tags"; then
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
  echo "✓ READY — start working on '$RESOLVED_TASK'"
  exit 0
fi