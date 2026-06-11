#!/usr/bin/env bash
# task-verify.sh — Run verification for a task before marking it complete.
#
# Usage: scripts/task-verify.sh "task label or #NNN slug"
#
# Exit codes:
#   0  — verified PASS (safe to commit + unclaim)
#   1  — verified FAIL (do not commit; surface error to operator)
#   2  — no automated verification found; prints "Done when:" criterion for manual confirm
#
# Verification tiers (in order):
#   1. Explicit Verify: field in task-queue.md → run that shell command
#   2. Section heuristic → run the canonical smoke test for that task type
#   3. "Done when:" field in task-queue.md → print it and exit 2 (manual)
#   4. No info → print notice and exit 2

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TASK_QUEUE="$REPO/docs/process/task-queue.md"
TASK_DOMAIN="$REPO/scripts/task-domain.py"

TASK="${*:-}"
if [[ -z "$TASK" ]]; then
  echo "Usage: task-verify.sh <task-label>" >&2
  exit 2
fi

# VERIFY_SKIP=1: manual override — operator confirmed "Done when:" manually
if [[ "${VERIFY_SKIP:-0}" == "1" ]]; then
  echo "verify: VERIFY_SKIP=1 — manual override acknowledged for '$TASK'"
  exit 0
fi

# ── helpers ──────────────────────────────────────────────────────────────────

run_check() {
  local label="$1"; shift
  echo "  → $label"
  if "$@"; then
    echo "  ✓ PASS: $label"
    return 0
  else
    echo "  ✗ FAIL: $label"
    return 1
  fi
}

# ── tier 1: explicit Verify: field in task-queue.md ──────────────────────────
#
# Scans for the task entry, then grabs the first "Verify:" line within its block.
# A block ends at the next blank line followed by "- **" (next task).

extract_field() {
  local field="$1"
  python3 - "$TASK_QUEUE" "$TASK" "$field" <<'PYEOF'
import re, sys, pathlib

queue = pathlib.Path(sys.argv[1])
task_query = sys.argv[2].lower().strip()
field = sys.argv[3]  # e.g. "Verify" or "Done when"

task_query_clean = re.sub(r"^#\d+\s*", "", task_query)
found_task = False
result = []

with open(queue) as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    # Find the task line
    m = re.search(r"\*\*([^*]+)\*\*", line)
    if m and not found_task:
        label = re.sub(r"^#\d+\s*`?", "", m.group(1).strip().lower().rstrip("`"))
        if task_query_clean in label or label in task_query_clean:
            found_task = True
            continue
    if found_task:
        # End of block: new top-level task bullet
        if re.match(r"^- \*\*", line) and i > 0:
            break
        # Look for the field
        fm = re.match(rf"\s+- \*\*{re.escape(field)}:\*\* (.+)", line)
        if fm:
            result.append(fm.group(1).strip())

print("\n".join(result))
PYEOF
}

VERIFY_CMD=$(extract_field "Verify")
DONE_WHEN=$(extract_field "Done when")

if [[ -n "$VERIFY_CMD" ]]; then
  echo "verify: running explicit Verify command for '$TASK'"
  echo "  cmd: $VERIFY_CMD"
  echo ""
  if (cd "$REPO" && eval "$VERIFY_CMD"); then
    echo ""
    echo "✓ PASS — task verification passed"
    exit 0
  else
    echo ""
    echo "✗ FAIL — task verification failed"
    echo "  Fix the failure above before committing."
    exit 1
  fi
fi

# ── tier 2: section heuristic ─────────────────────────────────────────────────

SECTION=$(python3 "$TASK_DOMAIN" "$TASK" 2>/dev/null || echo "unknown")
LABEL_LOWER=$(echo "$TASK" | tr '[:upper:]' '[:lower:]')

echo "verify: no explicit Verify: field — running heuristic for section '$SECTION'"
echo ""

PASS=0; FAIL=0; SKIP=0

heuristic_run() {
  local label="$1"; shift
  if run_check "$label" "$@"; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
  fi
}

case "$SECTION" in
  Dashboard)
    heuristic_run "dashboard API smoke test" bash "$REPO/scripts/smoke-api-all.sh"
    ;;
  "Remote Access")
    # Dashboard terminal tasks → also smoke the API
    if echo "$LABEL_LOWER" | grep -q "dashboard\|terminal\|pty"; then
      heuristic_run "dashboard API smoke test" bash "$REPO/scripts/smoke-api-all.sh"
    else
      SKIP=$((SKIP+1))
    fi
    ;;
  Automation)
    if echo "$LABEL_LOWER" | grep -q "sync\|guard\|git"; then
      heuristic_run "git-sync guard tests" zsh "$REPO/scripts/test-git-sync-guards.sh"
    elif echo "$LABEL_LOWER" | grep -q "lane\|jlane\|health"; then
      heuristic_run "lane health check" bash -c "cd '$REPO' && scripts/lane-health 2>&1 | tail -5"
    else
      SKIP=$((SKIP+1))
    fi
    ;;
  "OpenClaw Infrastructure")
    if echo "$LABEL_LOWER" | grep -q "close\|integrity\|end-protocol\|checkpoint\|session"; then
      heuristic_run "close integrity check" bash "$REPO/scripts/close-integrity-check.sh"
    elif echo "$LABEL_LOWER" | grep -q "lane\|jlane\|forge\|scout\|shield\|echo"; then
      heuristic_run "lane health check" bash -c "cd '$REPO' && scripts/lane-health 2>&1 | tail -5"
    elif echo "$LABEL_LOWER" | grep -q "sync\|git-lock\|guard"; then
      heuristic_run "git-sync guard tests" zsh "$REPO/scripts/test-git-sync-guards.sh"
    elif echo "$LABEL_LOWER" | grep -q "pivot\|domain\|session-pivot\|task-domain"; then
      # Self-referential: verify this script and task-domain.py are present and runnable
      heuristic_run "session-pivot.sh exists + executable" test -x "$REPO/scripts/session-pivot.sh"
      heuristic_run "task-domain.py returns known concern" bash -c \
        "python3 '$REPO/scripts/task-domain.py' --concern 'dashboard-terminal-verify' | grep -q 'infrastructure\|product\|trading'"
    else
      SKIP=$((SKIP+1))
    fi
    ;;
  "Trading Bot")
    BOT_DIR="$REPO/projects/trading-bot"
    # 1. Bot code compiles — stdlib-only, runs on any machine (incl. Jarry, which
    #    does not install the bot's runtime deps). Catches syntax/import breakage,
    #    the actual failure mode of a code edit.
    heuristic_run "bot.py + src compile" python3 -m py_compile \
      "$BOT_DIR/bot.py" $(find "$BOT_DIR/src" -name '*.py')
    # 2. Risk-config schema sane. Prefer the live config; fall back to the tracked
    #    example so this works on a clean checkout (config.yaml is gitignored).
    CFG="$BOT_DIR/config/config.yaml"
    [[ -f "$CFG" ]] || CFG="$BOT_DIR/config/config.example.yaml"
    if python3 -c "import yaml" 2>/dev/null; then
      heuristic_run "risk config keys present (yaml)" python3 -c "
import yaml, sys
risk = (yaml.safe_load(open('$CFG')) or {}).get('risk', {})
missing = [k for k in ('max_daily_drawdown', 'max_trade_loss', 'take_profit') if k not in risk]
sys.exit('missing risk keys: ' + ', '.join(missing) if missing else 0)
"
    else
      # pyyaml absent (e.g. Jarry) — degrade to a presence check rather than a false FAIL.
      heuristic_run "risk config keys present (grep, pyyaml absent)" bash -c \
        "grep -q 'max_daily_drawdown' '$CFG' && grep -q 'max_trade_loss' '$CFG' && grep -q 'take_profit' '$CFG'"
    fi
    ;;
  *)
    SKIP=$((SKIP+1))
    ;;
esac

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "✗ FAIL — $PASS passed, $FAIL failed"
  exit 1
elif [[ $PASS -gt 0 ]]; then
  echo "✓ PASS — $PASS check(s) passed"
  exit 0
fi

# ── tier 3: surface "Done when" for manual confirm ────────────────────────────

echo "verify: no automated check available for '$TASK'"
if [[ -n "$DONE_WHEN" ]]; then
  echo ""
  echo "  Done when: $DONE_WHEN"
  echo ""
  echo "  Confirm manually, then re-run with VERIFY_SKIP=1 to proceed."
else
  echo "  No 'Done when' criterion found either."
  echo "  Add a Verify: or Done when: field to the task entry to enable automation."
fi
exit 2
