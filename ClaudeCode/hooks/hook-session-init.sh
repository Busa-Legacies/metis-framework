#!/usr/bin/env bash
# UserPromptSubmit hook — fires once per session (first prompt only).
# Injects working-context.md as additionalContext so every session starts oriented.
# Phase 2 (tiered-context-architecture.md): the injection is JUST-IN-TIME. If the first prompt is
# orientation-seeking (/start, /next, "what's next", "catch me up", bare openers) the session gets the
# full briefing (working-context + free-work list + live-status). If it's task-focused, it gets a
# trimmed working-context head + a one-line free-work signal and skips live-status — full detail is one
# /start, /next, or /free-work away. Safety alerts (drift/bloat/mirror/ollama/self-heal/stray-git)
# surface in BOTH modes. Also runs the git-sync drift check once per session and surfaces drift inline
# (catches the 2026-05-30 corruption gap: hardened live script silently reverted to the old unguarded
# version while docs claimed it was deployed).

data=$(cat 2>/dev/null)
session_id=$(printf '%s' "$data" | jq -r '.session_id // empty' 2>/dev/null | tr -d '[:space:]')
[ -z "$session_id" ] && exit 0

init_flag="/tmp/claude-session-${session_id}.init"
[ -f "$init_flag" ] && exit 0
touch "$init_flag"

# --- Phase 2: just-in-time gating (docs/process/tiered-context-architecture.md) ---
# Decide whether the session's FIRST prompt is orientation-seeking (wants the full briefing) or
# task-focused (wants a lean context). Orientation sessions get the full working-context + free-work +
# live-status as before; task-focused sessions get a trimmed working-context + a one-line free-work
# summary and skip live-status. Full detail is always one /start, /next, or /free-work away. Safety
# alerts (drift/bloat/mirror/ollama/self-heal/stray-git) surface in BOTH modes.
prompt=$(printf '%s' "$data" | jq -r '.prompt // empty' 2>/dev/null)
orientation_mode=0
_plen=$(printf '%s' "$prompt" | tr -d '[:space:]' | wc -c | tr -d '[:space:]')
if [ "${_plen:-0}" -le 12 ]; then
  # Bare openers ("/start", "hi", "gm", empty) → orient.
  orientation_mode=1
elif printf '%s' "$prompt" | grep -qiE '(^|[^a-z])(/?start|/?next|/?free.?work|orient|brief|catch.?up|catch me up|stand.?up|pick.?up|pick up|resume|where.*(left|were we)|what.*(should|to do|next|work on)|status|good morning)([^a-z]|$)'; then
  orientation_mode=1
fi

# Seed metrics file so hook-prompt-guard.sh + hook-alerts.sh have data from turn 1.
# Statusline will overwrite this with real values on its first refresh (~30s).
# All five keys seeded so dashboard never reads null for 7d window on session start.
metrics_file="/tmp/claude-session-${session_id}.metrics"
if [ ! -f "$metrics_file" ]; then
  printf 'RATE_5H_PCT=0\nRATE_5H_RESETS=\nRATE_7D_PCT=0\nRATE_7D_RESETS=\nCTX_PCT=0\n' > "$metrics_file"
fi

: "${METIS_HOME:=$HOME/metis-os}"
wc_file="$METIS_HOME/Jay/memory/working-context.md"
[ -f "$wc_file" ] || exit 0

# --- git-sync drift check (non-fatal; only surfaces output when it actually drifts) ---
drift_msg=""
drift_script="$METIS_HOME/scripts/check-sync-drift.sh"
if [ -x "$drift_script" ]; then
  drift_out=$("$drift_script" 2>&1)
  [ $? -ne 0 ] && drift_msg="$drift_out"
fi

# --- auto-sync daemon liveness (#101): reload it if found unloaded ---
# The daemon pushes close-push.sh-deferred commits; if it's down they strand silently.
autosync_msg=""
autosync_script="$METIS_HOME/scripts/ensure-autosync-loaded.sh"
if [ -x "$autosync_script" ]; then
  autosync_msg=$("$autosync_script" 2>&1)
fi

# --- self-heal agent parity: self-wire the daily self-heal LaunchAgent on every machine
#     (installs on Jarry/new machines automatically; silent if already loaded) ---
selfheal_agent_script="$METIS_HOME/scripts/ensure-self-heal-loaded.sh"
if [ -x "$selfheal_agent_script" ]; then
  sh_agent_out=$("$selfheal_agent_script" 2>&1)
  [ -n "$sh_agent_out" ] && autosync_msg="${autosync_msg:+$autosync_msg$'\n'}$sh_agent_out"
fi

# --- mirror drift check (Jay↔Jarry "how we work" config; surfaces only on drift) ---
mirror_msg=""
mirror_script="$METIS_HOME/scripts/mirror.py"
if [ -f "$mirror_script" ]; then
  mirror_out=$(python3 "$mirror_script" check --quiet 2>&1)
  [ $? -ne 0 ] && mirror_msg="$mirror_out"
fi

# --- Ollama routing check (surfaces only when baseUrl missing or unreachable on Jarry) ---
# Prevents silent lane failures after openclaw.json reset/upgrade.
# Skipped on Jay (antfox/Ant) — it IS the Ollama host; localhost:11434 works without baseUrl.
ollama_msg=""
_machine_hostname=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
if [ "$_machine_hostname" != "antfox" ] && [ "$USER" != "Ant" ]; then
  oc_json="$HOME/.openclaw/openclaw.json"
  if [ -f "$oc_json" ]; then
    ollama_base=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(d.get('models',{}).get('providers',{}).get('ollama',{}).get('baseUrl',''))
except: pass
" "$oc_json" 2>/dev/null)
    if [ -z "$ollama_base" ]; then
      ollama_msg="models.providers.ollama.baseUrl missing from ~/.openclaw/openclaw.json — lanes will fall back to localhost:11434 (broken on Jarry). Fix: add baseUrl: http://<<MACHINE_1_TAILSCALE_IP>>:11434"
    elif ! curl -s --max-time 4 "${ollama_base}/api/tags" >/dev/null 2>&1; then
      ollama_msg="Ollama unreachable at ${ollama_base} — lane calls will fail. Check Tailscale + Jay gateway."
    else
      # Pre-warm: load qwen3-coder:30b into VRAM in the background so the first lane
      # call this session doesn't pay the cold-start cost (30–170s model reload).
      ( curl -s --max-time 200 -X POST "${ollama_base}/api/generate" \
          -H "Content-Type: application/json" \
          -d '{"model":"qwen3-coder:30b","prompt":"hi","stream":false,"keep_alive":"2h"}' \
          -o /dev/null 2>/dev/null ) &
      disown $! 2>/dev/null || true
    fi
  fi
fi

# --- live-status.md (last 20 lines) — orientation sessions only (Phase 2 JIT) ---
live_status_msg=""
live_status_file="$METIS_HOME/docs/process/live-status.md"
if [ "$orientation_mode" = "1" ] && [ -f "$live_status_file" ]; then
  live_status_msg=$(tail -20 "$live_status_file" 2>/dev/null)
fi

# --- lane session bloat check (surfaces main sessions > 20k tokens) ---
lane_bloat_msg=""
lane_bloat_msg=$(python3 - <<'PYEOF' 2>/dev/null
import json
from pathlib import Path
THRESHOLD = 20_000
agents = Path.home() / '.openclaw' / 'agents'
bloated = []
for lane in ['smith', 'scout', 'warden', 'scribe', 'arbiter']:
    p = agents / lane / 'sessions' / 'sessions.json'
    if not p.exists(): continue
    try:
        d = json.loads(p.read_text())
        info = d.get(f'agent:{lane}:main', {})
        tokens = int(info.get('inputTokens') or 0)
        if tokens > THRESHOLD:
            bloated.append(f'{lane}:{tokens:,}')
    except Exception:
        pass
if bloated:
    print('Lane main sessions over 20k threshold — run `lane-health --reset-bloated`: ' + ', '.join(bloated))
PYEOF
)

# --- free-work.py (what's open/unclaimed for this machine) — Phase 2 JIT ---
# Orientation sessions get the full list; task-focused sessions get a one-line signal (full list is
# one /next or /free-work away), so a focused first prompt doesn't pay ~560 tokens it won't use.
free_work_msg=""
free_work_script="$METIS_HOME/scripts/free-work.py"
if [ -f "$free_work_script" ]; then
  _fw=$(timeout 8 python3 "$free_work_script" 2>/dev/null)
  if [ "$orientation_mode" = "1" ]; then
    free_work_msg="$_fw"
  elif [ -n "$_fw" ]; then
    _fwn=$(printf '%s\n' "$_fw" | grep -cE '^[[:space:]]*-[[:space:]]' 2>/dev/null | tr -d '[:space:]')
    if [ "${_fwn:-0}" -gt 0 ] 2>/dev/null; then
      free_work_msg="${_fwn} task(s) free/unclaimed for this machine — run /next or /free-work for the list."
    else
      free_work_msg="Open/unclaimed work may be available — run /next or /free-work for the list."
    fi
  fi
fi

# --- stray nested .git detector (#163) ---
# Allowlist: Jay/lanes (registered submodule), .claude/worktrees (CC worktrees), and ANY
# nested .git the outer repo gitignores (a deliberate separate repo like
# projects/polymarket-bot — invisible to outer git ops, so not a stray). Self-maintaining.
stray_git_msg=""
if [ -d "$METIS_HOME/.git" ]; then
  stray_git_msg=$(cd "$METIS_HOME" && find . -name ".git" \
    -not -path "./.git" \
    -not -path "./Jay/lanes/.git" \
    -not -path "./.claude/worktrees/*" \
    2>/dev/null | sed 's|^\./||' | sort | while IFS= read -r rel; do
      git check-ignore -q "$rel" 2>/dev/null || printf '%s,' "$rel"
    done)
fi

# --- self-heal worklist (agent-tier backlog from the daily self-heal run; #146) ---
# These are NOT Ant decisions — they are mechanical fixes a session should pick up.
# Surfaced here so the loop closes on the agent side, never via an Ant ping.
selfheal_msg=""
selfheal_file="$HOME/.openclaw/self-heal-worklist.json"
if [ -f "$selfheal_file" ]; then
  selfheal_msg=$(python3 - "$selfheal_file" <<'PYEOF' 2>/dev/null
import json, sys
try:
    items = json.load(open(sys.argv[1])).get("items", [])
except Exception:
    items = []
if items:
    lines = [f"- {it['title']} ({'; '.join(it.get('actions', []))})" for it in items]
    print("\n".join(lines))
PYEOF
)
fi

# --- resolved decisions not yet folded into their task (loop-closure for Ant's inbox answers) ---
# When Ant answers a decision in the cockpit, the answer lands but acting on it was a manual step.
# This surfaces any resolved decision whose linked task doesn't yet reflect the answer, so the
# session folds it. Agent-actionable (like self-heal), not an Ant ping.
folds_msg=""
folds_script="$METIS_HOME/scripts/pending-decision-folds.py"
if [ -f "$folds_script" ]; then
  _folds_out=$(timeout 8 python3 "$folds_script" 2>/dev/null)
  case "$_folds_out" in
    "✓"*|"") folds_msg="" ;;        # clean baseline — stay silent
    *) folds_msg="$_folds_out" ;;
  esac
fi

output=$(python3 - "$wc_file" "$drift_msg" "$mirror_msg" "$ollama_msg" "$live_status_msg" "$free_work_msg" "$lane_bloat_msg" "$autosync_msg" "$stray_git_msg" "$selfheal_msg" "$orientation_mode" "$folds_msg" <<'PYEOF'
import json, sys
path = sys.argv[1]
drift = sys.argv[2] if len(sys.argv) > 2 else ""
mirror = sys.argv[3] if len(sys.argv) > 3 else ""
ollama = sys.argv[4] if len(sys.argv) > 4 else ""
live_status = sys.argv[5] if len(sys.argv) > 5 else ""
free_work = sys.argv[6] if len(sys.argv) > 6 else ""
lane_bloat = sys.argv[7] if len(sys.argv) > 7 else ""
autosync = sys.argv[8] if len(sys.argv) > 8 else ""
stray_git = sys.argv[9] if len(sys.argv) > 9 else ""
selfheal = sys.argv[10] if len(sys.argv) > 10 else ""
orientation = sys.argv[11] if len(sys.argv) > 11 else "1"
folds = sys.argv[12] if len(sys.argv) > 12 else ""
with open(path) as f:
    ctx = f.read()
if not ctx.strip():
    sys.exit(0)
if orientation != "1" and len(ctx) > 3000:
    # Task-focused first prompt: inject only the head of working-context (focus + open threads),
    # capped ~3000 chars at a line boundary. Full scratchpad is a Read away.
    head = ctx[:3000]
    nl = head.rfind("\n")
    if nl > 0:
        head = head[:nl]
    ctx = head + ("\n\n[…working-context trimmed for a task-focused session — "
                  "read Jay/memory/working-context.md for the full scratchpad.]")
_label = "working-context.md" + ("" if orientation == "1" else " head")
msg = "SESSION ORIENTATION (" + _label + " — auto-injected at session start):\n\n" + ctx
if live_status.strip():
    msg += "\n\n--- live-status.md (tail) ---\n" + live_status
if free_work.strip():
    msg += "\n\n--- free-work (open/unclaimed for this machine) ---\n" + free_work
if lane_bloat.strip():
    msg += "\n\n⚠️ LANE BLOAT: " + lane_bloat
if autosync.strip():
    msg += "\n\n⚠️ AUTO-SYNC DAEMON: " + autosync
if drift.strip():
    msg += ("\n\n⚠️ GIT-SYNC DRIFT DETECTED (live ~/.local/bin/openclaw-git-sync.sh differs "
            "from the canonical repo copy — the 2026-05-30 corruption gap):\n" + drift +
            "\n→ Review/redeploy before trusting auto-sync.")
if mirror.strip():
    msg += ("\n\n⚠️ MIRROR DRIFT DETECTED (this machine's 'how we work' config differs from "
            "the canonical repo — symlinks/settings/lane routing):\n" + mirror +
            "\n→ NOTE: this is a snapshot taken at session start; a mid-session git-sync or "
            "another session may have healed it. Re-run `python3 scripts/mirror.py check` to "
            "confirm it's still live before acting."
            "\n→ Investigate which side is canonical before healing: check if LIVE holds "
            "the newer correct value (e.g. live model=claude-opus-4-8 vs stale canonical opusplan). "
            "Run `python3 scripts/mirror.py apply --settings` only if canonical is correct; "
            "otherwise update the canonical repo file first.")
if ollama.strip():
    msg += "\n\n⚠️ OLLAMA ROUTING BROKEN: " + ollama
if stray_git.strip():
    paths = stray_git.strip(",")
    msg += ("\n\n⚠️ STRAY NESTED .GIT: Unexpected nested .git dirs: " + paths +
            " -- may cause wrong-dir writes or silent git failures. "
            "Investigate and remove or register as submodule.")
if selfheal.strip():
    msg += ("\n\n🩺 SELF-HEAL WORKLIST (agent-tier maintenance from the daily self-heal run — "
            "these are YOURS to clear, not Ant's; act per the act-confidently doctrine, and "
            "escalate to Ant only if a fix trips the escalation bar):\n" + selfheal +
            "\n→ As you resolve one, the next self-heal run auto-clears it from the worklist.")
if folds.strip():
    msg += ("\n\n🗳️ RESOLVED DECISIONS TO FOLD (Ant answered these in the inbox — propagate each "
            "answer into its task: update state/scope/nextAction and reference the dec id so the "
            "loop closes; mint a follow-up if the answer raises a new question):\n" + folds)
print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": msg}}))
PYEOF
)

[ -n "$output" ] && printf '%s\n' "$output"
