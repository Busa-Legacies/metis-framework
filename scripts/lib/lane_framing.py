"""Lane role framing — single canonical source (#189).

openclaw does NOT inject each lane's bootstrap.md (feedback_openclaw_bootstrap_injection
breadcrumb). Every caller that talks to a lane must frame the role itself. Import this
from ALL lane callers (dispatch, queue-runner) — do not hand-roll or copy preambles:
two sources drift, and an unframed lane improvises or carries a stale persona.

The work-specific envelope lives in scripts/lib/mission_packet.py. The intended
composition is:

    frame_message(lane, render_mission_packet(build_mission_packet(...)))

Preambles define the durable role. Mission packets define the current task.
"""

# openclaw does NOT inject each lane's bootstrap.md into the prompt (confirmed:
# feedback_openclaw_bootstrap_injection). So a lane runs with no role framing and
# either improvises (smith wrote code into its throwaway workspace and reported
# "implemented successfully" — useless, since Claude Code holds the real tree) or
# carries over a prior task's persona (scout returned self-review verdict/pattern
# JSON). Fix: prepend the role to every message here. Belt-and-suspenders: the
# return-only lanes also have their edit/write/exec/process/tmux tools denied in
# openclaw.json, so they physically cannot mutate files — code must come back as text.
LANE_PREAMBLES = {
    'smith': (
        "You are Smith, a TEXT-ONLY code-generation lane. ALL file-writing, editing, shell, exec, "
        "and process tools are DISABLED and will fail if called — calling them wastes tokens and "
        "bloats this session until it crashes. Claude Code (not you) applies your output to the "
        "real repo. Your ONLY output channel is this text reply.\n\n"
        "REQUIRED OUTPUT FORMAT — follow exactly:\n"
        "1. One line: the target file path (e.g. `app/routers/foo.py`)\n"
        "2. One fenced code block with the complete file contents\n\n"
        "Example:\n"
        "app/routers/example.py\n"
        "```python\n"
        "def hello(): return 'world'\n"
        "```\n\n"
        "Do NOT: call any tools, narrate steps, claim you saved/created anything, or produce "
        "text outside the path+fenced-block format. A reply with no fenced code block is a FAILED reply."
    ),
    'scout': (
        "You are Scout, a research/advice lane. Answer ONLY the question in THIS message. "
        "Ignore any task, output format, or persona from earlier in this session (e.g. "
        "self-review verdict/pattern JSON) — it does not apply here. Return prose unless asked "
        "for a specific format."
    ),
    'warden': (
        "You are Warden, a code-review/QA lane. Review only what is provided and return findings "
        "as text. Do not modify files or claim to have changed anything."
    ),
    'scribe': (
        "You are Scribe. Output ONLY the requested artifact body — no preamble, no 'I have "
        "composed', no closing remarks. The first word of your response is the first word of "
        "the artifact."
    ),
    'steward': (
        "You are Steward, a task-decomposition lane. Break the request into an ordered, "
        "queue-runner-ready sub-task list and return the list only. EVERY sub-task line "
        "must include exact lowercase routing tags `@agent:<smith|scout|warden|echo>` "
        "and `@machine:<<<MACHINE_1_ID>>|<<MACHINE_2_ID>>|either>` so it can be pasted directly into the task "
        "queue. Do not use labels like 'Lane:' or omit machine assignment."
    ),
    'arbiter': (
        "You are Arbiter, a JSON-only quality-gate lane. Return EXACTLY one parseable "
        "JSON object and nothing else — no markdown fences, no preamble, no trailing prose. "
        "Use this schema: {\"verdict\": \"approve|iterate|reject\", \"confidence\": 0.0, "
        "\"is_artifact\": true, \"issues\": [], \"safety_flags\": []}. The first "
        "character of your reply must be '{' and the last must be '}'."
    ),
}


# Lanes whose IN-TASK output involves craft decisions (architecture, dependencies, scope, polish,
# voice) get Ant's calibrated CRAFT stances prepended so their choices match his judgment — the
# executor half of the reasoning-trust loop (interactive sessions already get the full digest at
# SessionStart; lanes never did). arbiter is EXCLUDED: it must emit pure JSON and gains nothing from
# craft prose. Only the --scope craft subset is injected (never money/external/escalation/autonomy
# stances — a lane can't act on those and they'd only be noise).
_CRAFT_LANES = frozenset({'smith', 'scribe', 'warden', 'scout', 'steward'})

# Code-producing/reviewing lanes get a CORRECTNESS SELF-VERIFY block appended adjacent to the task.
# Motivation (2026-09-05, studio-lane quality diag): the smith framing enforced OUTPUT FORMAT and
# injected decision-philosophy craft stances, but had NO step telling the lane to check that its
# output actually ACHIEVES the goal. A 235B smith rewrite of a return-weir throat came back
# format-perfect but functionally wrong — it left a redundant Ø cylinder that defeats the taper it
# was asked to create, because nothing made it trace the final boolean result. This forces that trace.
_CODE_LANES = frozenset({'smith', 'warden'})
SELF_VERIFY_BLOCK = (
    "SELF-VERIFY before returning — this does NOT change your required output format:\n"
    "1. List every explicit constraint/goal stated in the task.\n"
    "2. Boolean CAD (union/difference): mentally evaluate the FINAL solid. Does any later union "
    "or added solid OVERRIDE or re-fill an earlier taper, bore, or cut? A straight cylinder unioned "
    "over a taper WINS and defeats it — remove the redundant solid so the intended feature survives.\n"
    "3. Code: confirm each stated constraint actually holds (time/space complexity, no input mutation, "
    "empty/edge cases, types).\n"
    "4. Return only once EVERY constraint is provably satisfied — fix your output until it is. Do NOT "
    "add commentary about this checking step; just return the corrected result in the required format."
)

import sys as _sys
import functools as _functools
import os as _os
import subprocess as _subprocess

_REPO = _os.environ.get('METIS_HOME', _os.path.expanduser('~/metis-os'))


@_functools.lru_cache(maxsize=1)
def _craft_principles():
    """Ant's craft/taste stances as a compact block for lane injection. Fail-safe: any error → ''
    (a lane MUST still run if the ledger/tool is missing). Cached once per process — a dispatch
    process is short-lived, so staleness within a run is a non-issue.

    Toggle: METIS_CRAFT_STANCES=0 disables injection (the CONTROL arm of the A/B test that measures
    whether the stances actually improve lane output)."""
    if _os.environ.get('METIS_CRAFT_STANCES', '1') == '0':
        return ''
    try:
        out = _subprocess.run(
            [_sys.executable, _os.path.join(_REPO, 'scripts/reasoning-context.py'),
             '--inject', '--scope', 'craft', '--max', '8'],
            capture_output=True, text=True, timeout=10, cwd=_REPO).stdout
    except Exception:
        return ''
    rules = [ln for ln in (out or '').splitlines() if ln.strip().startswith(('•', '-'))]
    if not rules:
        return ''
    return ("HOW ANT WANTS WORK DONE — his calibrated craft principles. Apply them to the task "
            "below; they do NOT change your required output format:\n" + '\n'.join(rules))


def craft_stances_applied(lane):
    """(n) craft stances that frame_message WOULD inject for this lane right now — for transcript
    observability so a dispatch is confirmable from the logs. 0 for a non-craft lane or when the
    toggle/ledger yields nothing."""
    if lane not in _CRAFT_LANES:
        return 0
    block = _craft_principles()
    return sum(1 for ln in block.splitlines() if ln.strip().startswith(('•', '-'))) if block else 0


def frame_message(lane, message):
    """Prepend the lane role so the model is framed even though openclaw won't inject bootstrap.md.
    For craft-producing lanes, also prepend Ant's craft stances ABOVE the role preamble so the
    preamble's strict output-format rules stay adjacent to the task. 'main' is the catch-all
    strategy lane — left unframed."""
    pre = LANE_PREAMBLES.get(lane)
    if not pre:
        return message
    if lane in _CRAFT_LANES:
        craft = _craft_principles()
        if craft:
            pre = f"{craft}\n\n{pre}"
    # Correctness self-verify sits BELOW the preamble (adjacent to the task) so the trace-your-
    # -output instruction stays freshest to the model. Toggle: METIS_SELF_VERIFY=0 = the A/B control.
    if lane in _CODE_LANES and _os.environ.get('METIS_SELF_VERIFY', '1') != '0':
        pre = f"{pre}\n\n{SELF_VERIFY_BLOCK}"
    return f"{pre}\n\n---\n\n{message}"
