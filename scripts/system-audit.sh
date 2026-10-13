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
source "$SCRIPT_DIR/lib/discord-curl.sh" 2>/dev/null || true
REPO="${REPO:-$(cd "$SCRIPT_DIR/.." && git rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR/..")}"

DATE="${DATE:-$(date +%Y-%m-%d)}"
AUDIT_DIR="$REPO/workspace/state/audits"
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
  discord_curl "$token" -s -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL/messages" \
    -H "Content-Type: application/json" \
    -d "{\"content\": \"$msg\"}" > /dev/null || true
}

# Repoint the audit onto the ops pool so this scheduled full-repo pass doesn't drain the
# interactive 5h/weekly window (#1345). Override with CLAUDE_SPAWN_ACCOUNT (default ops);
# 'personal' keeps the ambient login. Applied before the budget band so the personal-window
# SKIP is bypassed when we're spending ops (ops has its own headroom).
source "$SCRIPT_DIR/lib/claude-account.sh"
claude_account_apply
[ "$CLAUDE_SPAWN_ACCOUNT_ACTIVE" != "personal" ] && echo "system-audit: Claude on account $CLAUDE_SPAWN_ACCOUNT_ACTIVE"

# --- Budget guard (#730): size the run to the REAL 5h window before launch ---
# The 2026-07-04 burn was a fixed-size subagent fan-out with no ceiling. Now the
# wrapper probes the account-wide 5h budget (server-derived via claude_budget.py's
# ledger, #482) and either SKIPS a thin window (defers to the next scheduled run)
# or injects a "+Nk" token-target directive that arms the harness's Workflow
# budget — making any fan-out inside the run mechanically self-limiting.
BAND_JSON=$(python3 "$REPO/scripts/lib/claude_budget.py" band 2>/dev/null || echo '{}')
BAND_SKIP=$(printf '%s' "$BAND_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('skip', False))" 2>/dev/null || echo "False")
BAND_TARGET_K=$(printf '%s' "$BAND_JSON" | python3 -c "import json,sys; v=json.load(sys.stdin).get('token_target_k'); print(v if v else '')" 2>/dev/null || echo "")
BAND_PCT=$(printf '%s' "$BAND_JSON" | python3 -c "import json,sys; v=json.load(sys.stdin).get('pct_left_5h'); print(v if v is not None else '?')" 2>/dev/null || echo "?")
# The band reads the PERSONAL 5h window; only honor its SKIP when we're actually spending
# personal. A run repointed to ops has its own headroom, so a thin personal window must not
# defer it (#1345). The token-target directive below is a coarse self-limiting cap and stays
# harmless either way.
if [ "$BAND_SKIP" = "True" ] && [ "$CLAUDE_SPAWN_ACCOUNT_ACTIVE" = "personal" ]; then
  echo "=== SKIPPED: 5h window too thin (${BAND_PCT}% left) — deferring to next scheduled run ==="
  discord_post "⏭️ System audit skipped ($DATE): 5h window at ${BAND_PCT}% — deferring rather than burning a thin window (#730)"
  date > "${HEARTBEAT_FILE:-/tmp/system-audit-last-run}"
  exit 0
fi
BUDGET_DIRECTIVE=""
if [ -n "$BAND_TARGET_K" ]; then
  BUDGET_DIRECTIVE="+${BAND_TARGET_K}k
Budget rule for this run: the +${BAND_TARGET_K}k token target above is sized to the
account's remaining 5h window (${BAND_PCT}% left) — spend up to it on deeper, more
thorough inline reading. This is a NON-INTERACTIVE headless run: audit INLINE with
your own Read/Grep/Glob calls. Do NOT launch background work (Workflow) or a
Task/subagent fan-out and 'wait for a notification' — there is no interactive loop to
receive one, so the process would exit before a report is composed. You MUST emit the
complete Markdown report in THIS response before you finish. If scope is large,
prioritize P1/P2 correctness + security findings over exhaustive P3 coverage.

"
  echo "Budget guard: 5h ${BAND_PCT}% left → +${BAND_TARGET_K}k target injected"
fi

# --- The audit prompt: full-architecture, read-only, markdown to stdout ---
read -r -d '' AUDIT_PROMPT <<'PROMPT' || true
You are running an unattended FULL-ARCHITECTURE health audit of this repository
(an AI-assistant infrastructure monorepo). Audit the ENTIRE system, not any one
component: the OpenClaw multi-agent framework, the FastAPI dashboard
(projects/dashboard), the trading bot (projects/trading-bot), the
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
  "$CLAUDE_BIN" -p "${BUDGET_DIRECTIVE}${AUDIT_PROMPT}" --model "$AUDIT_MODEL" \
  --allowedTools 'Read,Grep,Glob,Bash(ls *),Bash(find *),Bash(git log *),Bash(git status*)' \
  || AUDIT_EXIT=$?

if [ "$AUDIT_EXIT" -eq 124 ]; then
  echo "[WARN] Audit timed out after ${CLAUDE_TIMEOUT_SECONDS}s — retrying with --max-turns 10"
  discord_post "⏱️ System audit timed out — retrying with reduced scope (max-turns 10)"
  RETRY_EXIT=0
  run_to_file "$CLAUDE_TIMEOUT_SECONDS" "$TEMP_OUTPUT" \
    "$CLAUDE_BIN" -p "${BUDGET_DIRECTIVE}${AUDIT_PROMPT}" --model "$AUDIT_MODEL" --max-turns 10 \
    --allowedTools 'Read,Grep,Glob,Bash(ls *),Bash(find *),Bash(git log *),Bash(git status*)' \
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

discord_post "🔍 System audit ready ($DATE) — P1:$P1_COUNT P2:$P2_COUNT P3:$P3_COUNT. Review report: workspace/state/audits/system-audit-$DATE.md"

# --- Route findings to the board (#529): P1/P2 -> inbox tasks (deduped by
# fingerprint so recurring findings refresh, not re-mint); P1 -> Discord page.
# An audit whose findings nobody actions manufactures false confidence.
ROUTE_OUT=$(python3 "$REPO/scripts/route-audit-findings.py" --report "$REPORT" --apply 2>>"$LOG" || true)
echo "$ROUTE_OUT"
PAGES_JSON=$(printf '%s\n' "$ROUTE_OUT" | sed -n 's/^PAGES_JSON=//p' | tail -1)
if [ -n "$PAGES_JSON" ]; then
  # Page each newly-filed P1 individually so a real critical finding can't hide
  # inside the count digest above.
  printf '%s' "$PAGES_JSON" | python3 -c "import json,sys
try: titles=json.load(sys.stdin)
except Exception: titles=[]
[print(t) for t in titles]" | while IFS= read -r title; do
    [ -n "$title" ] && discord_post "🚨 New P1 audit finding ($DATE): ${title} — filed to inbox. Report: workspace/state/audits/system-audit-$DATE.md"
  done
fi

echo "=== System audit complete. P1:$P1_COUNT P2:$P2_COUNT P3:$P3_COUNT → $REPORT ==="
