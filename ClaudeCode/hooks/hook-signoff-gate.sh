#!/usr/bin/env bash
# hook-signoff-gate.sh — Stop hook enforcing the session final-output standard (#146 v2).
#
# Every turn that hands control back to Ant must end with the sign-off block
# (docs/process/session-output-standard.md): a `**<area> › <task>**` header plus at
# least one of Done/Verified/Check/Next/Asks. Prose-only compliance measured 2% over
# the standard's first 48h (363 stops audited 2026-06-07), so this gate checks the
# final assistant message mechanically and blocks the stop ONCE with instructions
# when the block is missing.
#
# FLUSH-RACE FIX (2026-06-07): the Stop hook can fire BEFORE the closing assistant
# text line is durably written to the transcript. The naive "last assistant text in
# the tail" then resolves to a stale earlier message and false-blocks a compliant
# turn (observed on this very feature's design-proposal turn). So we (a) skip a
# partial/unparseable final line, (b) evaluate ONLY the current turn's trailing
# assistant text (everything after the last user/tool record), and (c) SETTLE-LOOP:
# wait up to ~2s for that closing text to appear. If it never does, FAIL OPEN —
# blocking is the harmful action (it traps the session); a missed enforcement is not.
#
# Zero-LLM: pure transcript regex. Loop-safe: respects stop_hook_active. Every
# decision is logged to ~/.openclaw/logs/signoff-gate.jsonl for the compliance meter
# / false-positive review (self-heal harness).
#
# NOTE (feedback_heredoc_stdin_collision): hook payload arrives on stdin; capture it
# first and pass via argv — never pipe stdin into an inline python heredoc.

INPUT=$(cat)

# /restart pending → restart-stop-hook.sh is about to respawn the pane; don't fight it.
[[ -f "$HOME/.openclaw/pending-restart" ]] && exit 0

python3 - "$INPUT" <<'PYEOF'
import json, re, sys, time, os, datetime

LOG = os.path.expanduser("~/.openclaw/logs/signoff-gate.jsonl")

def log(rec):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        rec["ts"] = datetime.datetime.now().isoformat(timespec="seconds")
        with open(LOG, "a") as fh:
            fh.write(json.dumps(rec) + "\n")
    except Exception:
        pass

try:
    payload = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)  # fail open

# Loop guard: this stop is already a continuation forced by a stop hook.
if payload.get("stop_hook_active"):
    sys.exit(0)

path = payload.get("transcript_path") or ""
session = payload.get("session_id", "")
if not path:
    sys.exit(0)

HEADER = re.compile(r"\*\*[^*\n]+(?:›|»|>)[^*\n]+\*\*")
# Field labels: tolerate plain (`- Next:`), bold (`**Next:**`), or bare (`Next:`).
# Tolerate a decorative prefix before the field label — bullets and arrows like
# "- → Next:" or "• Done:" are valid sign-off lines (a real "- → Next:" block was
# false-blocked 2026-06-07; surfaced by the self-heal signoff FP meter).
FIELDS = re.compile(r"^[\s\-*→›»•]*\*{0,2}(Done|Verified|Check|Next|Asks)\*{0,2}\s*:", re.M)

def is_assistant_text(rec):
    return (rec.get("type") == "assistant" and not rec.get("isSidechain"))

def text_of(rec):
    c = rec.get("message", {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""

def read_turn_text():
    """Return (closing_text, partial_final_line) for the CURRENT turn.

    closing_text = concatenation of assistant text blocks AFTER the last user/tool
    record (the turn's visible closing message). None if no assistant text has
    landed yet for this turn. partial_final_line=True if the last physical line
    failed to parse (file mid-write) — caller should keep waiting.
    """
    try:
        with open(path) as fh:
            raw = fh.readlines()
    except Exception:
        return (None, True)  # treat as not-yet-readable → wait

    recs, partial = [], False
    for i, line in enumerate(raw):
        line = line.strip()
        if not line:
            continue
        try:
            recs.append(json.loads(line))
        except Exception:
            # Only a malformed *final* line signals an in-progress write.
            if i >= len(raw) - 2:
                partial = True
            # otherwise it's some other junk line; ignore it.

    # Find the boundary: the last user-role record (real prompt OR tool_result).
    last_user = -1
    for idx in range(len(recs) - 1, -1, -1):
        if recs[idx].get("type") == "user":
            last_user = idx
            break

    parts = [text_of(r) for r in recs[last_user + 1:] if is_assistant_text(r)]
    closing = "\n".join(p for p in parts if p.strip())
    return (closing if closing.strip() else None, partial)

# --- Settle loop: wait for the closing text to flush (max ~2s) ---
deadline = time.time() + 2.0
closing = None
iters = 0
while time.time() < deadline:
    iters += 1
    closing, partial = read_turn_text()
    if closing is not None and not partial:
        break
    time.sleep(0.06)

if closing is None:
    # Closing text never landed within budget → fail open (do NOT block).
    log({"session": session, "decision": "allow", "reason": "no-closing-text",
         "settle_iters": iters})
    sys.exit(0)

h = bool(HEADER.search(closing))
f = bool(FIELDS.search(closing))
if h and f:
    log({"session": session, "decision": "allow", "reason": "compliant",
         "settle_iters": iters})
    sys.exit(0)

# Non-compliant: block once. Record the tail so the FP meter can spot regex misses.
log({"session": session, "decision": "block", "header_match": h, "fields_match": f,
     "settle_iters": iters, "tail": closing[-400:]})
print(json.dumps({
    "decision": "block",
    "reason": (
        "SIGN-OFF GATE (#146): your final message is missing the required sign-off "
        "block — every stop returns control to Ant and must carry project+task context "
        "(docs/process/session-output-standard.md). Do NOT redo or continue any work. "
        "Emit ONE short message that is just the sign-off block: header "
        "`**<area> › <#id slug | ad-hoc label>** — <done|banked|blocked|in-progress>` "
        "followed by the applicable fields (Done: / Verified: / Check: / Next: / Asks:). "
        "Minimal form (header + Next: or Asks:) is fine for conversational turns."
    ),
}))
sys.exit(0)
PYEOF
exit 0
