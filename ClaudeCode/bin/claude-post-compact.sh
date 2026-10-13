#!/bin/bash
# Re-inject authoritative forward-state after Claude Code compacts the context window.
# Prevents a resumed session from losing task state / dropping in-flight work.
#
# MECHANISM (verified 2026-08-07): registered as a SessionStart hook with matcher "compact"
# (settings.json). SessionStart fires after both auto-compact and manual /compact; the docs
# guarantee that whatever this command writes to STDOUT is injected into the resumed context.
# We emit PLAIN TEXT (not a hookSpecificOutput JSON envelope) on purpose: the harness only
# schema-validates JSON output, and PreCompact/PostCompact/SessionStart are NOT in the
# additionalContext schema on this CC build — a JSON envelope gets rejected and NOTHING is
# injected (that is exactly the failure this file replaces). Plain stdout can never hit the
# validator, so it is the robust path.
#
# Injects TWO layers:
#   1. working-context.md  — shared, cross-session board state (may be a little stale)
#   2. this session's ledger tail — the Stop-hook banks every sign-off to
#      ~/.openclaw/session-ledgers/<session>.jsonl, so this is THIS session's freshest
#      Done/Next/Asks, which working-context.md may not yet reflect. This is the layer
#      that stops a post-compaction session from re-deciding a half-done feature "done"
#      or dropping the next step. Deterministic, session-scoped, read-only.

data=$(cat)
session_id=$(printf '%s' "$data" | jq -r '.session_id // empty' 2>/dev/null | tr -d '[:space:]')
# Compaction wiped the injected machine identity — clear the once-per-session flag so
# claude-machine-identity.sh re-injects on the next prompt (#528).
[ -n "$session_id" ] && rm -f "/tmp/claude-session-${session_id}.machine-id"

WORKING_CTX="${METIS_HOME:-$HOME/metis-os}/workspace/memory/working-context.md"
LEDGER="$HOME/.openclaw/session-ledgers/${session_id}.jsonl"

export POSTCOMPACT_WORKING_CTX="$WORKING_CTX"
export POSTCOMPACT_LEDGER="$LEDGER"

# Everything below is best-effort and read-only — it must NEVER break the session start.
# We capture python's stdout into a var so we can (1) emit it verbatim to context and
# (2) log a deterministic firing-marker WITHOUT polluting stdout. The marker is the
# hard artifact that proves the hook actually ran on a real compaction — verification
# then does not depend on the model noticing the injected text in its own context.
out=$(python3 <<'PY' 2>/dev/null
import os

TURNS = 3          # how many most-recent sign-offs to re-surface
FIELD_CAP = 320    # per-field truncation so the injection stays lean

def clip(v):
    if not v:
        return ""
    v = " ".join(str(v).split())
    return v if len(v) <= FIELD_CAP else v[:FIELD_CAP - 1] + "…"

parts = []

# Layer 1 — shared board state
ctx_path = os.environ.get("POSTCOMPACT_WORKING_CTX", "")
try:
    with open(ctx_path) as f:
        ctx = f.read().strip()
    if ctx:
        # Lean digest (2026-10-05, #7608): the full file is ~24KB and was re-injected on EVERY
        # compaction (108 in 14 days). Keep headings + each line clipped, cap the section, point
        # at the file for the rest — this session's own sign-offs below carry the freshest state.
        CTX_CAP, LINE_CAP = 5500, 240
        kept, total = [], 0
        for ln in ctx.splitlines():
            ln = ln.split("<!--")[0].rstrip()   # drop ownership/ts comment tails
            if not ln.strip():
                continue
            ln = ln if len(ln) <= LINE_CAP else ln[:LINE_CAP - 1] + "…"
            if total + len(ln) > CTX_CAP:
                kept.append("…[truncated — full board: workspace/memory/working-context.md]")
                break
            kept.append(ln); total += len(ln) + 1
        parts.append("working-context.md digest (shared board — cross-session, may lag this session):\n"
                     + "\n".join(kept))
except OSError:
    pass

# Layer 2 — this session's freshest sign-offs (deterministic freshness floor)
import json
led_path = os.environ.get("POSTCOMPACT_LEDGER", "")
try:
    with open(led_path) as f:
        rows = [json.loads(l) for l in f if l.strip()]
except OSError:
    rows = []

if rows:
    lines = []
    for r in rows[-TURNS:]:
        tid = r.get("task_id") or ""
        hdr = " ".join(x for x in [r.get("area", ""), r.get("task_slug", ""), tid] if x).strip()
        seg = [f"• [{r.get('ts','')}] {hdr}".rstrip()]
        for label in ("status", "done", "verified", "next", "asks"):
            val = clip(r.get(label))
            if val:
                seg.append(f"    {label.capitalize()}: {val}")
        lines.append("\n".join(seg))
    parts.append(
        "THIS SESSION's most recent sign-offs (freshest state — trust over the shared board "
        "where they conflict; resume from the latest Next/Asks):\n" + "\n".join(lines)
    )

if not parts:
    raise SystemExit(0)

header = (
    "CONTEXT WAS JUST COMPACTED. Re-injecting authoritative forward-state so nothing in "
    "flight is lost. Resume from this — do not re-derive it from the summary above.\n\n"
)
# PLAIN STDOUT — no JSON envelope (see header comment).
print(header + "\n\n".join(parts))
PY
)
rc=$?

# (1) Inject into the resumed context — stdout only, nothing else.
printf '%s' "$out"
# (1b) The END-OF-TURN CONTRACT (Ant 2026-10-12). UserPromptSubmit does not fire on the
#      compaction-continuation turn, so the contract that every other turn carries was
#      missing exactly here (1 of 14 such turns had it; 5 of 25 unanswered stops since the
#      gate repair were these turns). Same text as hook-turn-contract.sh, plain stdout.
_contract="${METIS_HOME:-$HOME/metis-os}/ClaudeCode/hooks/lib/turn-contract.txt"
if [ -r "$_contract" ]; then
  printf '\n\n'
  cat "$_contract"
fi

# (2) Deterministic firing-marker (NOT on stdout — appended to a logfile). This is the
#     provable artifact: `cat ~/.openclaw/compaction-hook.log` after any compaction shows
#     the hook fired, its exit code, and the exact byte-count it injected. rc/chars>0 with
#     source=compact == the floor worked, independent of model introspection.
{
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  src=$(printf '%s' "$data" | jq -r '.source // empty' 2>/dev/null)
  chars=$(printf '%s' "$out" | wc -c | tr -d ' ')
  log="$HOME/.openclaw/compaction-hook.log"
  printf '%s session=%s source=%s rc=%s chars=%s\n' \
    "$ts" "${session_id:-?}" "${src:-?}" "$rc" "$chars" \
    >> "$log"
  # Size-cap the receipt so it can't grow unbounded across a marathon of sessions:
  # keep only the most recent LOG_KEEP lines (atomic rewrite, race-safe).
  LOG_KEEP=500
  lines=$(wc -l < "$log" 2>/dev/null | tr -d ' ')
  if [ "${lines:-0}" -gt "$LOG_KEEP" ]; then
    tmp="${log}.$$"
    tail -n "$LOG_KEEP" "$log" > "$tmp" 2>/dev/null && mv -f "$tmp" "$log"
  fi
} 2>/dev/null || true

exit 0
