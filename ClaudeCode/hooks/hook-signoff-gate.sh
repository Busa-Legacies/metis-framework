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
# DROPPED-REQUEST GATE (#7965, weekly self-review 2026-10-07 Candidates 2-4): the
# "no-closing-text" fail-open below is ALSO the exact shape of a zeroed-out turn — Ant
# asks for something ("check the dashboard logs"), the agent ends the turn with no text
# and no tool call, and the harness renders "No response requested". The prompt-side
# nudge (hook-response-required.sh) is inject-only, so nothing structural stopped it.
# Now, when the turn produced NO tool call AND NO visible text after the settle loop,
# and Ant's last real message classifies as a request (same regexes, via
# `hook-response-required.sh --classify`), the stop is blocked ONCE with the ask quoted
# back. Scoped tightly so the flush race stays fail-open everywhere else: any tool call
# this turn, headless/sdk-cli, stop_hook_active, slash/injected prompts → allow as before.
# Logged as reason=dropped-request (lint_fp_candidate) so the FP meter watches it.
#
# NOTE (feedback_heredoc_stdin_collision): hook payload arrives on stdin; capture it
# first and pass via argv — never pipe stdin into an inline python heredoc.

INPUT=$(cat)
HOOK_DIR="$(dirname "$0")"   # sibling hook-response-required.sh lives here (repo dir or ~/.claude symlink)

# /restart pending → restart-stop-hook.sh is about to respawn the pane; don't fight it.
[[ -f "$HOME/.openclaw/pending-restart" ]] && exit 0

# Headless/lane/cron sessions (claude-task.sh, system-audit, insights, scheduled
# `claude -p`) have no Ant on the other end and often a JSON/markdown-only output
# contract — blocking them burns a turn and corrupts their output (30 headless
# blocks observed, #512). Callers export METIS_HEADLESS=1; hooks inherit the env.
[[ -n "${METIS_HEADLESS:-}" ]] && exit 0

python3 - "$INPUT" "$HOOK_DIR" <<'PYEOF'
import json, re, sys, time, os, datetime, subprocess

LOG = os.environ.get("SIGNOFF_GATE_LOG") or os.path.expanduser("~/.openclaw/logs/signoff-gate.jsonl")  # override so tests never write the prod log (#5100)
# Per-session marker of the LAST block this gate issued (reason + ts). Read on the forced
# continuation (stop_hook_active) so the closing question can be re-checked exactly once
# when the first block was for another reason (diagnostics 2026-10-12: 5 of 12 unanswered
# post-repair stops were "blocked for malformed fields / premature stop, re-stopped, never
# evaluated again"). Tests override the dir so they never touch prod state.
STATE_DIR = os.environ.get("SIGNOFF_GATE_STATE_DIR") or os.path.expanduser("~/.openclaw/state/signoff-gate")

def _marker_path(sess):
    return os.path.join(STATE_DIR, re.sub(r"[^A-Za-z0-9_.-]", "_", sess or "unknown") + ".json")

def log(rec):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        rec["ts"] = datetime.datetime.now().isoformat(timespec="seconds")
        with open(LOG, "a") as fh:
            fh.write(json.dumps(rec) + "\n")
    except Exception:
        pass
    if rec.get("decision") == "block":
        try:
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(_marker_path(rec.get("session")), "w") as fh:
                json.dump({"reason": rec.get("reason"), "ts": time.time()}, fh)
        except Exception:
            pass

try:
    payload = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)  # fail open

path = payload.get("transcript_path") or ""
session = payload.get("session_id", "")

# Loop guard, bounded (Ant 2026-10-12): a continuation forced by a stop hook used to exit
# here unconditionally, so a stop blocked for malformed fields / premature stop and then
# re-emitted WITHOUT the closing question was never evaluated or logged. Now: if OUR last
# block on this session (<15 min) was for a reason other than the closing question, fall
# through in RECHECK mode and evaluate ONLY the closing question, once. A prior
# missing-closing-question block (or no marker / stale marker / another hook's block)
# still exits silently, so at most two blocks per stop and never a loop.
RECHECK = False
if payload.get("stop_hook_active"):
    try:
        with open(_marker_path(session)) as fh:
            _mk = json.load(fh)
        if (_mk.get("reason") not in (None, "missing-closing-question", "dropped-request")
                and time.time() - float(_mk.get("ts") or 0) < 900):
            RECHECK = True
    except Exception:
        RECHECK = False
    if not RECHECK:
        sys.exit(0)
HOOK_DIR = sys.argv[2] if len(sys.argv) > 2 else ""
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

def session_did_governed_work():
    """True = this session did real project work → sign-off block REQUIRED (work
    session). False = the transcript is readable AND shows none of the work markers
    → pure chat, block relaxed to a plain ending (Ant 2026-08-23, split-by-context
    endings, feedback_response_formatting).

    Markers = a git commit, a TASK checkout (agent-checkout / claim-next), or a
    tasks.json mutation (update-tier1-state, or an Edit/Write to a tasks.json path).
    Deliberately NOT counted: a bare `agent-work.py claim` ad-hoc lease — those are
    taken for incidental writes like saving a memory, which is still a chat turn.

    Fails toward True (enforce) on any read/parse trouble: losing the mobile-handoff
    block on a real work session is the harmful miss; an extra block on a chat turn
    is cheap."""
    try:
        with open(path) as fh:
            raw = fh.readlines()
    except Exception:
        return True  # unreadable → enforce
    WORK = re.compile(r'git\s+commit\b|agent-checkout\b|claim-next\b|'
                      r'update-tier1-state\b', re.I)
    for line in raw:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        content = rec.get("message", {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict) or b.get("type") != "tool_use":
                continue
            name = b.get("name", "")
            inp = b.get("input", {}) or {}
            if name == "Bash":
                if WORK.search(str(inp.get("command", ""))):
                    return True
            elif name in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                if "tasks.json" in str(inp.get("file_path", "")):
                    return True
    return False  # readable, no work markers → chat session

def pending_background_job(window_s=6 * 3600):
    """True = this session launched a background job (Bash/Agent run_in_background, or a
    Monitor) in the last `window_s` whose completion notification has NOT arrived yet.

    Why (#7545): 44 of 47 premature-stop blocks from 2026-09-12..10-01 were sessions
    correctly idling on their OWN background build/fork/print monitor ("on build success
    ...", "the export resumes me") — nothing takeable until the harness re-invokes them.
    Blocking those forces a pointless rework turn. Structural, not prose: the exemption
    needs a REAL launched job with no `<tool-use-id>` notification after it, so saying
    "waiting" without one still blocks. Fails toward False (enforce) on any trouble."""
    try:
        with open(path) as fh:
            raw = fh.readlines()
    except Exception:
        return False
    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc)
    # Scope to THIS turn (Ant 2026-10-12): only a job launched after Ant's last real
    # prompt can excuse this stop. A job from an earlier turn in the 6h window exempted
    # every later in-progress stop of a long session (5 of 12 unanswered post-repair
    # stops were print-babysitting turns riding an hours-old Monitor).
    turn_start = -1
    for i, line in enumerate(raw):
        if '"user"' not in line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if _is_real_prompt(rec):
            turn_start = i
    launches = []  # (line_index, tool_use_id)
    for i, line in enumerate(raw):
        if i <= turn_start:
            continue
        line = line.strip()
        if not line or '"tool_use"' not in line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        ts = rec.get("timestamp")
        if ts:
            try:
                t = _dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
                if t.tzinfo is None:
                    t = t.replace(tzinfo=_dt.timezone.utc)
                if (now - t).total_seconds() > window_s:
                    continue
            except Exception:
                pass
        content = rec.get("message", {}).get("content")
        if not isinstance(content, list):
            continue
        for b in content:
            if not isinstance(b, dict) or b.get("type") != "tool_use":
                continue
            inp = b.get("input", {}) or {}
            # Real transcripts store the flag as the STRING "true" (verified 2026-10-04), not a bool.
            bg = str(inp.get("run_in_background", "")).strip().lower() == "true"
            if (bg or b.get("name") == "Monitor") and b.get("id"):
                launches.append((i, b["id"]))
    for i, tid in launches:
        marker = f"<tool-use-id>{tid}</tool-use-id>"
        if not any(marker in later for later in raw[i + 1:]):
            return True
    return False


def _tail_lines(p, nbytes=262144):
    """Last ~256KB of the transcript as lines (first partial line dropped). Latency fix
    (harness audit 2026-10-05, #7608): the settle loop re-read + re-parsed the WHOLE
    transcript every 60ms iteration (1.6MB+ in long sessions)."""
    with open(p, "rb") as fh:
        fh.seek(0, 2)
        size = fh.tell()
        start = max(0, size - nbytes)
        fh.seek(start)
        data = fh.read()
    lines = data.decode("utf-8", "replace").splitlines(True)
    if start > 0 and lines:
        lines = lines[1:]
    return lines, start > 0

def _is_real_prompt(rec):
    """A user record that is Ant's message (not a tool_result, not meta/injected)."""
    if rec.get("type") != "user" or rec.get("isMeta"):
        return False
    c = (rec.get("message") or {}).get("content")
    if isinstance(c, str):
        return True
    if isinstance(c, list):
        kinds = {b.get("type") for b in c if isinstance(b, dict)}
        return "tool_result" not in kinds and bool(kinds & {"text", "image"})
    return False

def turn_last_tool_and_prompt():
    """(name of the LAST tool_use since Ant's last real message, that message's text).
    Name is None when the turn made no tool call; ("?", "") when the boundary can't be found."""
    tail, truncated = _tail_lines(path)
    recs = []
    for line in tail:
        try:
            recs.append(json.loads(line))
        except Exception:
            pass
    start = next((i for i in range(len(recs) - 1, -1, -1) if _is_real_prompt(recs[i])), None)
    if start is None and truncated:
        # Boundary older than the 256KB tail window: a heavy turn (big tool outputs,
        # injected context blocks) pushed Ant's last real prompt out of the tail, so
        # the tail alone has no prompt. Fall back to the full file rather than
        # returning "?" — which would blanket-EXEMPT the closing-question gate on
        # exactly the long working sessions that most need it (the inertness root
        # cause, 2026-10-06). Mirrors read_turn_text's full-file fallback; the tail
        # read itself is the #7608 latency fix, not a correctness boundary.
        try:
            with open(path) as fh:
                recs = []
                for line in fh:
                    try:
                        recs.append(json.loads(line))
                    except Exception:
                        pass
        except Exception:
            return ("?", "")
        start = next((i for i in range(len(recs) - 1, -1, -1) if _is_real_prompt(recs[i])), None)
    if start is None:
        return ("?", "")
    c = (recs[start].get("message") or {}).get("content")
    prompt = c if isinstance(c, str) else " ".join(
        b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
    # Headless `claude -p` / SDK runs record entrypoint "sdk-cli" (interactive = "cli"); nobody is
    # there to answer, so the closing question doesn't apply (2026-10-05: 371 of 400 recent
    # transcripts were sdk-cli, none ever asked). Several batch runners don't set METIS_HEADLESS.
    if any(r.get("entrypoint") == "sdk-cli" for r in recs[-50:]):
        return ("?", "")
    last = None
    for r in recs[start + 1:]:
        if r.get("type") == "assistant":
            for b in (r.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    last = b.get("name")
    return (last, prompt)

def read_turn_text():
    """Return (closing_text, partial_final_line) for the CURRENT turn.

    closing_text = concatenation of assistant text blocks AFTER the last user/tool
    record (the turn's visible closing message). None if no assistant text has
    landed yet for this turn. partial_final_line=True if the last physical line
    failed to parse (file mid-write) — caller should keep waiting.
    """
    try:
        raw, truncated = _tail_lines(path)
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
    if last_user == -1 and truncated:
        # boundary older than the tail window -> rare; fall back to the full file
        try:
            with open(path) as fh:
                raw = fh.readlines()
        except Exception:
            return (None, True)
        recs = []
        for line in raw:
            line = line.strip()
            if line:
                try:
                    recs.append(json.loads(line))
                except Exception:
                    pass
        for idx in range(len(recs) - 1, -1, -1):
            if recs[idx].get("type") == "user":
                last_user = idx
                break

    parts = [text_of(r) for r in recs[last_user + 1:] if is_assistant_text(r)]
    closing = "\n".join(p for p in parts if p.strip())
    return (closing if closing.strip() else None, partial)

def dropped_request():
    """(tier, prompt) when this turn DROPPED an explicit ask: Ant's last real message
    classifies as a request (hook-response-required.sh --classify -> ask|request|next|
    question) and the turn made NO tool call. Caller has already established there is no
    visible text. None (= allow, the old fail-open) on any doubt: a tool ran, boundary
    unknown or sdk-cli ("?"), slash / injected prompt, classifier missing or erroring."""
    try:
        last_tool, prompt = turn_last_tool_and_prompt()
    except Exception:
        return None
    if last_tool is not None or not prompt:
        return None
    p = prompt.strip()
    if not p or p.startswith("<") or p.startswith("/"):
        return None
    clf = os.path.join(HOOK_DIR, "hook-response-required.sh")
    if not HOOK_DIR or not os.path.exists(clf):
        return None
    try:
        tier = subprocess.run(["bash", clf, "--classify", p[:4000]], capture_output=True,
                              text=True, timeout=5).stdout.strip()
    except Exception:
        return None
    return (tier, p) if tier in ("ask", "request", "next", "question") else None

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
    # No visible text this turn. If Ant asked for something and NO action was taken
    # either, that is the dropped-request zero-out (#7965): block once, quote the ask.
    _dr = dropped_request()
    if _dr:
        _tier, _p = _dr
        log({"session": session, "decision": "block", "reason": "dropped-request",
             "tier": _tier, "lint_fp_candidate": True, "settle_iters": iters,
             "prompt": _p[:200]})
        print(json.dumps({"decision": "block", "reason": (
            "DROPPED-REQUEST GATE (#7965): Ant's last message is an explicit ask (" + _tier
            + "): \"" + _p[:160].replace("\n", " ") + "\" — and this turn produced NO "
            "visible response and NO action. A request never ends as 'no response requested'. "
            "Do the ask now (or answer it directly); if it cannot be done in this turn, say so "
            "explicitly and state what you need. Then close normally (sign-off block + "
            "AskUserQuestion on a work session).")}))
        sys.exit(0)
    # Otherwise the closing text never landed within budget → fail open (do NOT block).
    log({"session": session, "decision": "allow", "reason": "no-closing-text",
         "settle_iters": iters})
    sys.exit(0)

# ── Chat-vs-work split (Ant 2026-08-23) ─────────────────────────────────────
# The sign-off block exists for the mobile-handoff use case on real work. A pure
# conversational session (no commit / task checkout / tasks.json edit) doesn't need
# it — the block is clutter there. Relax for chat; keep full enforcement for work.
# Detection fails toward enforcement, so a real work session never loses its block.
if not session_did_governed_work():
    log({"session": session, "decision": "allow", "reason": "chat-session",
         "settle_iters": iters})
    sys.exit(0)

def closing_question_verdict(status):
    """(block_reason_or_None, allow_reason_or_None, last_tool). The one rule, used by the
    normal end-of-gate path and by the bounded RECHECK on a forced continuation."""
    try:
        last_tool, prompt = turn_last_tool_and_prompt()
    except Exception:
        last_tool, prompt = ("?", "")
    ending = bool(re.search(r"<command-name>/(end|close|restart)</command-name>", prompt or "")) \
        or bool(re.search(r"(?im)^\s*/(end|restart)\b", prompt or ""))
    if last_tool in ("AskUserQuestion", "?"):
        return (None, "compliant", last_tool)
    if ending:
        return (None, "end-advisory", last_tool)
    # Background exemption: NON-TERMINAL stops only (Ant 2026-10-06), job launched THIS
    # turn only (Ant 2026-10-12).
    if status in ("banked", "in-progress") and pending_background_job():
        return (None, "waiting-on-background", last_tool)
    return ("missing-closing-question", None, last_tool)

CLOSING_QUESTION_TEXT = (
    "CLOSING-QUESTION GATE: this work-session stop ends without an AskUserQuestion. "
    "Every stop, 'done' and 'blocked' included, closes with one "
    "(docs/process/session-output-standard.md § Close every turn with an "
    "AskUserQuestion); the only exception is a /end or /restart advisory. Do NOT redo "
    "work or re-emit the sign-off. Call AskUserQuestion now with the real next-step / "
    "direction choice or the decision that gates further work: 2-4 informed options, "
    "recommended first, Asks:/Proposed: content inside the question. If the only "
    "question you can think of is 'continue?', the work is not done: do it instead.")

if RECHECK:
    _rs = re.search(r'\*\*[^*\n]+(?:›|»|>)[^*\n]+\*\*\s*[—–\-]+\s*\*{0,2}'
                    r'(done|banked|blocked|in[\s-]?progress)', closing, re.I)
    _rstatus = re.sub(r'\s+', '-', _rs.group(1).strip().lower()) if _rs else ""
    _blk, _alw, _lt = closing_question_verdict(_rstatus)
    if _blk:
        log({"session": session, "decision": "block", "reason": _blk, "recheck": True,
             "status": _rstatus, "last_tool": _lt, "settle_iters": iters, "tail": closing[-400:]})
        print(json.dumps({"decision": "block", "reason": CLOSING_QUESTION_TEXT}))
    else:
        log({"session": session, "decision": "allow", "reason": _alw, "recheck": True,
             "status": _rstatus, "last_tool": _lt, "settle_iters": iters})
    sys.exit(0)

h = bool(HEADER.search(closing))
f = bool(FIELDS.search(closing))

# ── Stop-LEGITIMACY gate (2026-07-12, Ant) ──────────────────────────────────
# The format check above answers "is the sign-off well-formed?" It never asked
# the prior question: "should this turn have stopped at ALL?" A real premature
# stop got past it — a slice was banked mid-multi-step queue, with a Next: action
# and no ask, i.e. "I know the next step and need nothing from Ant." That is not a
# valid hand-back: "work banked" is not a standalone stop reason mid-task (see the
# doctrine — a turn may only end for input-needed / blocked / genuinely all-done).
#
# The pattern is detectable from the block itself: status is banked|in-progress
# (explicitly "continuing"), there IS a Next: action, and there is NO real Asks:
# and NO Check: (nothing Ant must provide or eyeball). done|blocked are terminal
# and always allowed; a real Asks:/Check: means Ant genuinely gates the next step.
# Fail-open on any ambiguity, and stop_hook_active (above) already caps this at one
# nudge per turn — a missed nudge is cheap, a trapped session is not.
def _field(label):
    m = re.search(r'^[\s\-*→›»•]*\*{0,2}' + label + r'\*{0,2}\s*:\s*(.*)$',
                  closing, re.I | re.M)
    return m.group(1).strip() if m else None

def _is_empty_or_none(s):
    if s is None:
        return True
    t = s.strip().lower().strip('.*_ ')
    if not t:
        return True
    # "none", "n/a", "nothing", "no ...", or a bare dash lead → not a real ask/check.
    return bool(re.match(r'(none|n/?a|nothing|no\b|[-—–])', t))

_sm = re.search(
    r'\*\*[^*\n]+(?:›|»|>)[^*\n]+\*\*\s*[—–\-]+\s*\*{0,2}'
    r'(done|banked|blocked|in[\s-]?progress)', closing, re.I)
_status = re.sub(r'\s+', '-', _sm.group(1).strip().lower()) if _sm else ""

_has_next = not _is_empty_or_none(_field("Next"))
_has_asks = not _is_empty_or_none(_field("Asks"))
_has_check = not _is_empty_or_none(_field("Check"))

# The premature-stop tell is status-AGNOSTIC at its core: a takeable Next: with no
# Asks:/Check: means "I know the next step and need nothing from Ant" — not a valid
# hand-back. `blocked` is the SOLE exemption (genuinely cannot proceed; its Next: is the
# planned resumption). `banked`/`in-progress` (explicitly "continuing") trip it, AND so
# does `done`: a `done` carrying a dangling forward Next: is the SAME premature stop
# wearing a terminal label — the loophole Ant hit 2026-07-21 (work marked 'done' with a
# takeable Next: and no ask slipped through as "compliant"). The doctrine already says a
# true `done` DROPS the forward Next:, so enforce that instead of trusting the label.
_dangling_next = _has_next and not _has_asks and not _has_check
_premature_active = _status in ("banked", "in-progress") and _dangling_next
_premature_done = _status == "done" and _dangling_next

if h and f and _premature_active and pending_background_job():
    # Idling on our own tracked background job is a legitimate stop (#7545): the harness
    # re-invokes the session on its notification; there is nothing takeable meanwhile.
    log({"session": session, "decision": "allow", "reason": "waiting-on-background",
         "status": _status, "settle_iters": iters})
    sys.exit(0)

if h and f and (_premature_active or _premature_done):
    _reason_tag = "done-with-dangling-next" if _premature_done else "premature-stop"
    log({"session": session, "decision": "block", "reason": _reason_tag,
         "status": _status, "settle_iters": iters, "tail": closing[-400:]})
    if _premature_done:
        _block_msg = (
            "STOP-LEGITIMACY GATE: you marked this stop 'done' but left a Next: action with "
            "no Asks:/Check: — a takeable next step you need nothing from Ant for. A true "
            "'done' hands back with NO forward-looking Next: (docs/process/"
            "session-output-standard.md § Stop discipline). Either (a) that Next: is in-scope "
            "takeable work — then it is NOT done: DO it now and keep working until you "
            "genuinely hit all-done / blocked / need-Ant; or (b) it is real future-scope — "
            "log it as a task or suggestion (never dangle a path-forward only in chat — "
            "feedback_log_suggestions_always) and DROP the Next: line. Do NOT just re-emit "
            "the same block unchanged."
        )
    else:
        _block_msg = (
            "STOP-LEGITIMACY GATE: your sign-off is status '" + _status + "' with a "
            "Next: action and no Asks:/Check: — you know the next step and need nothing "
            "from Ant. That is NOT a valid stop. 'Work banked' is not a standalone stop "
            "reason mid-task (docs/process/session-output-standard.md § Stop discipline): "
            "a turn may only end for input-needed, blocked, or genuinely-all-done. Banking "
            "(commit/push) is continuous, not a hand-back. Do NOT re-emit the sign-off — "
            "instead DO the Next: action and keep working through the remaining queued work "
            "until you hit a genuine pause: everything is done, you are blocked, or you need "
            "Ant's input (then state it in Asks:/Check:). If you truly are all-done, change "
            "the status to 'done' and drop the forward-looking Next:."
        )
    print(json.dumps({"decision": "block", "reason": _block_msg}))
    sys.exit(0)

# ── Substance lints (#519) ──────────────────────────────────────────────────
# The gate above proves the block is well-FORMED; it never checked whether the
# fields carry real SUBSTANCE. Ant corrected substance ~7 times (Asks: listing
# non-asks; bare option letters as the whole Next/Asks; play-by-play) and first-try
# compliance sat ~60%. These two lints are FAIL-OPEN (only high-confidence patterns
# fire; anything ambiguous is allowed) and every decision is logged with
# lint_fp_candidate:true so the self-heal FP meter can watch them for a week before
# they're trusted. Extends #345's enforcement-gap audit (two of its "needs-gate"
# items that were left honor-only). stop_hook_active caps this at one nudge/turn.
def _lint_substance():
    asks = _field("Asks")
    nxt = _field("Next")

    # Lint B — a bare option token as the WHOLE Next:/Asks: content ("2b", "a", "1a").
    # R10 (Ant 2026-07-14): a decide/confirm hand-back must restate the decidable
    # content on a `Proposed <X>:` line, never a bare key Ant can't map on mobile.
    # Token shape only (one letter ± ≤2 digits) → real word-actions never match.
    tok = re.compile(r'^\s*[*_]*\s*([0-9]{1,2}[a-z]?|[a-z][0-9]{0,2})\s*[*_.]*\s*$', re.I)
    for label, val in (("Next", nxt), ("Asks", asks)):
        if val is not None and tok.match(val):
            return ("SUBSTANCE LINT (bare option token): your " + label + ": line is just \""
                    + val.strip() + "\" — a bare option key. On mobile Ant can't map a bare "
                    "letter/number to what it selects. Put the decidable content on a "
                    "`Proposed <X>:` line (the option's real scope/copy) and make " + label
                    + ": a full imperative. See docs/process/session-output-standard.md R10.",
                    "bare-option-token")

    # Lint A — an Asks: line that is really the AGENT's own next action, not a request
    # TO Ant ("I'll…", "proceeding", "FYI…"). Empty/"none" is handled above (allowed);
    # this fires only on non-empty self-directed prose in the Asks slot.
    if asks is not None and asks.strip():
        selfdir = re.compile(
            r"^\s*[*_]*\s*(i['’]?ll\b|i will\b|i['’]?m going\b|i plan\b|proceeding\b|"
            r"continuing\b|moving on\b|will now\b|keep(ing)? going\b|next i\b|going to\b|"
            r"fyi\b|just (a )?not)", re.I)
        if selfdir.match(asks):
            return ("SUBSTANCE LINT (Asks is not an ask): your Asks: line \"" + asks.strip()[:80]
                    + "\" describes YOUR own next action, not something you need FROM Ant. Asks: "
                    "is an explicit blocker/action for Ant — if there is none, OMIT the line; if "
                    "it's your plan, move it to Next:. See docs/process/session-output-standard.md.",
                    "asks-not-an-ask")

    return (None, None)

if h and f:
    try:
        _lint_reason, _lint_tag = _lint_substance()
    except Exception:
        _lint_reason, _lint_tag = (None, None)  # fail open — never trap on a lint bug
    if _lint_reason:
        log({"session": session, "decision": "block", "reason": "substance-lint",
             "lint": _lint_tag, "lint_fp_candidate": True, "status": _status,
             "settle_iters": iters, "tail": closing[-400:]})
        print(json.dumps({"decision": "block", "reason": _lint_reason}))
        sys.exit(0)
    # ── Closing question (Ant 2026-07-27; enforced 2026-10-05) ─────────────────
    # session-output-standard.md: every work-session hand-back ENDS with an
    # AskUserQuestion; the sole exception is a /end or /restart advisory. Nothing
    # enforced it, and two restatements had drifted to "non-terminal" stops, so
    # fleet-wide only ~10-25% of `done` stops asked (audit 2026-10-05: <<MACHINE_1_ID>> 9.7%
    # of 93, <<MACHINE_2_ID>> 14.3% of 77, Air 25% of 12). The check: the LAST tool call of
    # the turn (since Ant's last real message) must be AskUserQuestion. Exempt: an
    # end/restart turn, and idling on our own tracked background job (the harness
    # re-invokes us; a question would block that). Fail open on any parse trouble;
    # stop_hook_active caps it at one nudge per stop.
    _blk, _alw, _last_tool = closing_question_verdict(_status)
    if _blk:
        log({"session": session, "decision": "block", "reason": _blk,
             "status": _status, "last_tool": _last_tool, "settle_iters": iters,
             "tail": closing[-400:]})
        print(json.dumps({"decision": "block", "reason": CLOSING_QUESTION_TEXT}))
        sys.exit(0)
    # Allow, labeled by the path that produced it (2026-10-12: every allow here used to read
    # "compliant", so background-exempt stops were invisible to the inertness audit).
    log({"session": session, "decision": "allow", "reason": _alw,
         "status": _status, "last_tool": _last_tool, "settle_iters": iters})
    sys.exit(0)

# Non-compliant: block once. Record the tail so the FP meter can spot regex misses, AND a
# `reason` tag (#5245 diagnostics: this fallthrough block logged no reason, so 69% of caught
# sign-off attempts read as "(empty reason)" in the audit — undiagnosable). Tag by what failed.
_fallthrough_reason = ("missing-signoff-block" if not h and not f
                       else "missing-signoff-header" if not h
                       else "malformed-signoff-fields")
log({"session": session, "decision": "block", "reason": _fallthrough_reason,
     "header_match": h, "fields_match": f, "settle_iters": iters, "tail": closing[-400:]})
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
