#!/usr/bin/env bash
# hook-task-naming-gate.sh — Stop hook enforcing the task-naming taxonomy
# (feedback_task_titles_stand_alone). Ant, repeatedly: NEVER refer to a task by a bare
# number. The compliant form is the descriptive title with the id in parens —
# "the per-file-leases sync task (#234)" — never "flip #234 to live" / "#234 now runs 2nd".
# Documentation alone failed (a whole session of bare refs, 2026-07-23), so this gate checks
# the closing message mechanically and blocks ONCE with the fix, mirroring hook-signoff-gate.sh.
#
# Rule: every `#NNN` in Ant-facing prose must be immediately preceded by `(` (the parenthesised
# "title (#NNN)" form). Exempt: genuine external VCS refs ("PR #NNN"). A bare `#NNN` anywhere
# else is a violation → name the work.
#
# Zero-LLM: pure transcript regex. Loop-safe (stop_hook_active). Fails OPEN — a trapped session
# is the harmful failure; a missed nudge is cheap. Same settle-loop as the signoff gate for the
# transcript flush race. Decisions logged to ~/.openclaw/logs/task-naming-gate.jsonl.
#
# NOTE (feedback_heredoc_stdin_collision): payload arrives on stdin; capture first, pass via argv.

INPUT=$(cat)

[[ -f "$HOME/.openclaw/pending-restart" ]] && exit 0
[[ -n "${METIS_HEADLESS:-}" ]] && exit 0

python3 - "$INPUT" <<'PYEOF'
import json, re, sys, time, os, datetime

LOG = os.path.expanduser("~/.openclaw/logs/task-naming-gate.jsonl")

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

if payload.get("stop_hook_active"):
    sys.exit(0)

path = payload.get("transcript_path") or ""
session = payload.get("session_id", "")
if not path:
    sys.exit(0)

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
    try:
        with open(path) as fh:
            raw = fh.readlines()
    except Exception:
        return (None, True)
    recs, partial = [], False
    for i, line in enumerate(raw):
        line = line.strip()
        if not line:
            continue
        try:
            recs.append(json.loads(line))
        except Exception:
            if i >= len(raw) - 2:
                partial = True
    last_user = -1
    for idx in range(len(recs) - 1, -1, -1):
        if recs[idx].get("type") == "user":
            last_user = idx
            break
    parts = [text_of(r) for r in recs[last_user + 1:] if is_assistant_text(r)]
    closing = "\n".join(p for p in parts if p.strip())
    return (closing if closing.strip() else None, partial)

# settle loop — wait up to ~2s for the closing text to flush
deadline = time.time() + 2.0
closing, iters = None, 0
while time.time() < deadline:
    iters += 1
    closing, partial = read_turn_text()
    if closing is not None and not partial:
        break
    time.sleep(0.06)

if closing is None:
    log({"session": session, "decision": "allow", "reason": "no-closing-text"})
    sys.exit(0)

# Strip fenced code blocks and inline code — bare #NNN inside code/commands is not a
# task reference (e.g. a shell comment or a diff line), only prose refs are governed.
prose = re.sub(r"```.*?```", "", closing, flags=re.S)
prose = re.sub(r"`[^`]*`", "", prose)

bad = []
for m in re.finditer(r"(?<!\w)#(\d{2,5})\b", prose):
    start = m.start()
    prev = prose[start - 1] if start > 0 else ""
    pre = prose[max(0, start - 16):start].lower()
    if prev == "(":            # "title (#NNN)" — the compliant form
        continue
    if re.search(r"\b(pr|pull request|pull)\s*$", pre):   # external VCS ref
        continue
    bad.append("#" + m.group(1))

if bad:
    uniq = sorted(set(bad), key=bad.index)
    log({"session": session, "decision": "block", "reason": "bare-task-number",
         "refs": uniq, "settle_iters": iters, "tail": closing[-300:]})
    msg = (
        "TASK-NAMING GATE (feedback_task_titles_stand_alone): your message refers to "
        "task(s) by bare number — " + ", ".join(uniq) + " — with no descriptive title. Ant "
        "has ruled this out repeatedly: a bare #NNN is meaningless on mobile and the naming "
        "taxonomy exists so every reference stands alone. Rewrite each so the work is NAMED, "
        "with the id in parentheses after it: e.g. \"the per-file-leases sync task (#234)\", "
        "not \"#234\". The ONLY compliant form for a number is `(#NNN)` right after the "
        "descriptive title. Re-emit the message with every task named."
    )
    print(json.dumps({"decision": "block", "reason": msg}))
    sys.exit(0)

log({"session": session, "decision": "allow", "reason": "clean"})
sys.exit(0)
PYEOF
