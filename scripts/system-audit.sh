#!/usr/bin/env bash
set -euo pipefail

# Recurring full-architecture system audit.
# Runs a headless `claude -p` read-only pass over the ENTIRE repo (openclaw
# framework, dashboard, trading-bot, scripts/automation, git-sync, memory/RAG,
# docs) and produces a dated markdown report + a Discord digest.
#
# v1 = report-then-review: it WRITES a report and pings Discord. It does NOT
# auto-file tasks — a human triages the report into task-queue.md. Auto-filing
# is a v2 step once the signal is trusted.
#
# Portable by design: derives REPO from git and uses $HOME, so it runs on <<MACHINE_2_ID>>
# or <<MACHINE_1_ID>> unchanged. <<MACHINE_1_ID>> is only the scheduled HOST; the audit TARGET is the
# whole repo architecture.

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

# --- Resolve repo root (portable, no hardcoded per-machine paths) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$SCRIPT_DIR/.." && git rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR/..")}"

DATE="${DATE:-$(date +%Y-%m-%d)}"
AUDIT_DIR="$REPO/docs/process/audits"
REPORT="$AUDIT_DIR/system-audit-$DATE.md"
LOG_DIR="${LOG_DIR:-$HOME/.openclaw/logs}"
LOG="$LOG_DIR/system-audit.log"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
# Headless jobs must PIN their model — an unpinned `claude -p` inherits the
# interactive default from ~/.claude/settings.json, which can silently jump to a
# premium tier (2026-07-04: fable-5[1m] default made this audit + its subagent
# fan-out eat ~75% of a 5h window before Ant woke). Sonnet is the routing-standard
# tier for headless workhorse jobs (model-effort-and-routing-standard.md).
AUDIT_MODEL="${AUDIT_MODEL:-sonnet}"
# Gate the sign-off Stop hook off for this unattended session (#512).
export METIS_HEADLESS=1
CURL_BIN="${CURL_BIN:-curl}"
OPENCLAW_JSON="${OPENCLAW_JSON:-$HOME/.openclaw/openclaw.json}"
DISCORD_CHANNEL="${DISCORD_CHANNEL}"
CLAUDE_TIMEOUT_SECONDS="${CLAUDE_TIMEOUT_SECONDS:-900}"

mkdir -p "$AUDIT_DIR" "$LOG_DIR"
exec >> "$LOG" 2>&1

echo "=== System audit starting $(date) (repo=$REPO) ==="

# --- Concurrency guard: directory lock (flock unavailable in LaunchAgent env) ---
LOCK_DIR=/tmp/system-audit.lock.d
acquire_lock() {
  while true; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "$$" > "$LOCK_DIR/pid"
      trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
      return 0
    fi
    local holder
    holder=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      echo "Already running under pid $holder, skipping."
      exit 0
    fi
    echo "Reclaiming stale audit lock."
    rm -rf "$LOCK_DIR"
  done
}
acquire_lock

# --- Timeout wrapper (flock-free, macOS LaunchAgent safe) ---
run_to_file() {
  local seconds="$1"
  local stdout_file="$2"
  shift 2
  python3 - "$seconds" "$stdout_file" "$LOG" "$@" <<'PYEOF'
import subprocess, sys
seconds = int(sys.argv[1]); stdout_path = sys.argv[2]; log_path = sys.argv[3]; cmd = sys.argv[4:]
try:
    with open(stdout_path, "w") as out, open(log_path, "a") as err:
        proc = subprocess.run(cmd, stdout=out, stderr=err, timeout=seconds)
    sys.exit(proc.returncode)
except subprocess.TimeoutExpired:
    with open(log_path, "a") as log:
        log.write(f"[ERROR] command timed out after {seconds}s: {' '.join(cmd[:2])}\n")
    sys.exit(124)
PYEOF
}

# --- Discord helper (token from openclaw.json; $HOME-portable) ---
discord_post() {
  local msg="$1"
  local token
  token=$(python3 -c "import json; d=json.load(open('$OPENCLAW_JSON')); print(d['channels']['discord']['token'])" 2>/dev/null || echo "")
  [ -z "$token" ] && return
  "$CURL_BIN" -s -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL/messages" \
    -H "Authorization: Bot $token" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"$msg\"}" > /dev/null || true
}

# --- The audit prompt: full-architecture, read-only, markdown to stdout ---
read -r -d '' AUDIT_PROMPT <<'PROMPT' || true
You are running an unattended FULL-ARCHITECTURE health audit of this repository
(an AI-assistant infrastructure monorepo). Audit the ENTIRE system, not any one
component: the OpenClaw multi-agent framework, the FastAPI dashboard
(projects/dashboard), the Kraken trading-bot (projects/trading-bot), the
scripts/ automation + LaunchAgents, the git auto-sync machinery, the memory/RAG
layer, and the docs/process governance (tasks.json, task-queue.md, leases).

Read CLAUDE.md, AGENTS.md, docs/process/ for context first, then sample the code.
Focus on finding REAL, HIGH-VALUE issues, ranked by impact:
  - Correctness/safety bugs (esp. anything touching money, trading, or data loss)
  - Security: leaked secrets, missing auth, injection, world-readable creds
  - Reliability: silent failures, missing error handling, race conditions
  - Architecture drift: duplication, hardcoded paths/IPs, dead code, config that
    is defined but never wired up
  - Process gaps: tasks that are stale/done-but-open, missing tests, no monitoring

Be skeptical and verify by reading the actual code — do NOT report speculative
issues you have not confirmed in a file. For each finding give: a one-line title,
severity (P1/P2/P3), the file:line evidence, and a concrete suggested fix.

Respond with ONLY a Markdown report (start with '# System Audit'). Sections:
'## Summary' (2-3 sentences + counts by severity),
'## P1 — Critical', '## P2 — Important', '## P3 — Nice-to-have'
(each finding as a '### <title>' with **Severity**, **Evidence** file:line,
**Fix**), and '## Suggested tasks' (a short bullet list a human can paste into
task-queue.md). Do not invent file paths — only cite files you actually read.
PROMPT

TEMP_OUTPUT=$(mktemp)
HEARTBEAT_FILE="${HEARTBEAT_FILE:-/tmp/system-audit-last-run}"

AUDIT_EXIT=0
# #415: deliberately NOT isolated with --setting-sources '' (unlike insights/claude-task).
# This is a semantic audit of whether the standards are actually followed — it must see the
# same inherited CLAUDE.md context a real session does. Output is a human-read report, so a
# trailing sign-off block is harmless. See docs/process/claude-code-background-task-policy.md §6.
run_to_file "$CLAUDE_TIMEOUT_SECONDS" "$TEMP_OUTPUT" \
  "$CLAUDE_BIN" -p "$AUDIT_PROMPT" --model "$AUDIT_MODEL" \
  --allowedTools 'Read,Grep,Glob,Bash(ls *),Bash(find *),Bash(git log *),Bash(git status*),Task' \
  || AUDIT_EXIT=$?

if [ "$AUDIT_EXIT" -eq 124 ]; then
  echo "[WARN] Audit timed out after ${CLAUDE_TIMEOUT_SECONDS}s — retrying with --max-turns 10"
  discord_post "⏱️ System audit timed out — retrying with reduced scope (max-turns 10)"
  RETRY_EXIT=0
  run_to_file "$CLAUDE_TIMEOUT_SECONDS" "$TEMP_OUTPUT" \
    "$CLAUDE_BIN" -p "$AUDIT_PROMPT" --model "$AUDIT_MODEL" --max-turns 10 \
    --allowedTools 'Read,Grep,Glob,Bash(ls *),Bash(find *),Bash(git log *),Bash(git status*),Task' \
    || RETRY_EXIT=$?
  if [ "$RETRY_EXIT" -ne 0 ]; then
    echo "[ERROR] Retry also failed (exit $RETRY_EXIT) — writing degraded report"
    printf '# System Audit — DEGRADED\n\nAudit failed after retry (original timeout %ss, retry exit %s).\nManual review required. Check %s\n' \
      "$CLAUDE_TIMEOUT_SECONDS" "$RETRY_EXIT" "$LOG" > "$TEMP_OUTPUT"
    discord_post "🚨 System audit FAILED after retry ($DATE) — degraded report written. P1:? P2:? P3:? — check $LOG"
  fi
elif [ "$AUDIT_EXIT" -ne 0 ]; then
  echo "[ERROR] claude audit exited $AUDIT_EXIT; attempting to use partial output"
fi

# Heartbeat: watchdog (#296) monitors this file
date > "$HEARTBEAT_FILE"

if [ ! -s "$TEMP_OUTPUT" ]; then
  echo "=== FAILED: empty audit output ==="
  printf '# System Audit — FAILED\n\nEmpty output (exit %s). Check %s\n' "$AUDIT_EXIT" "$LOG" > "$TEMP_OUTPUT"
  discord_post "⚠️ System audit empty output ($DATE) — check $LOG"
fi

# --- Persist the report (script owns the write; claude only returns prose) ---
{
  echo "<!-- Generated by scripts/system-audit.sh on $(date) | repo=$REPO -->"
  echo
  cat "$TEMP_OUTPUT"
} > "$REPORT"
rm -f "$TEMP_OUTPUT"

# --- Count severities for the digest ---
P1_COUNT=$(awk '/^## P1/{f=1;next} /^## /{f=0} f&&/^### /{c++} END{print c+0}' "$REPORT")
P2_COUNT=$(awk '/^## P2/{f=1;next} /^## /{f=0} f&&/^### /{c++} END{print c+0}' "$REPORT")
P3_COUNT=$(awk '/^## P3/{f=1;next} /^## /{f=0} f&&/^### /{c++} END{print c+0}' "$REPORT")

discord_post "🔍 System audit ready ($DATE) — P1:$P1_COUNT P2:$P2_COUNT P3:$P3_COUNT. Review report: docs/process/audits/system-audit-$DATE.md"
echo "=== System audit complete. P1:$P1_COUNT P2:$P2_COUNT P3:$P3_COUNT → $REPORT ==="
