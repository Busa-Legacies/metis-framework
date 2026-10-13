#!/usr/bin/env python3
"""
self-review.py — Cross-session self-analysis of Claude Code transcripts.

Pipeline (each stage fails SOFT so the weekly LaunchAgent never hard-crashes):
  0. PULL      — rsync <<MACHINE_2_ID>>'s transcripts to a local mirror so coverage spans
                 both machines (<<MACHINE_1_ID>> + <<MACHINE_2_ID>>).
  1. HEURISTIC — cheap regex/structural scan surfaces candidate friction moments
                 (corrections, tool-error chains, reverts, rate-limit cap-hits,
                 <<MACHINE_1_ID>>-routing misses), tagged by machine.
  2. SCOUT     — free local lane classifies each candidate (real miss vs false
                 positive) and synthesizes recurring patterns + proposed fixes.
  3. SHIELD    — free local lane VERIFIES each proposed fix for accuracy /
                 applicability / effectiveness, refines it, and writes a concrete
                 verificationMethod. Only warden-approved fixes get promoted.
  4. PROMOTE   — approved fixes become governed tasks via update-tier1-state.py
                 (canonical tasks.json) and surface on the OPEN_TASKS board.
                 Idempotent: a recurring pattern bumps its existing task instead
                 of spawning a duplicate.
  5. LEDGER    — durable record (workspace/state/self-review/ledger.json) of weekly
                 signal counts + every fix's lifecycle, so EFFECTIVENESS is
                 checked over time: did the signal drop after a fix shipped?

Modes:
  --days N      weekly mode: scan last N days across both machines, full pipeline
  --latest      session mode: scan only the most-recent transcript (end protocol),
                lightweight — no warden/promote, just flag misses + feed ledger
  --no-pull / --no-promote / --no-llm / --dry-run    stage toggles

Usage:
  self-review.py [--days 7] [--lane scout] [--verify-lane warden]
  self-review.py --latest          # end-of-session reflection
"""

import argparse, json, os, glob, re, subprocess, sys, datetime, hashlib, urllib.request
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from network import JARRY_IP  # canonical, env-overridable (scripts/lib/network.py)
import studio235  # fleet verdict envelope (audit rec 3): validate + degraded-stamp warden verdicts

HOME = os.path.expanduser("~")
REPO = os.environ.get("REPO_ROOT") or os.environ.get("METIS_HOME") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_TRANSCRIPTS = os.path.join(HOME, ".claude", "projects")
JARRY_MIRROR = os.path.join(HOME, ".claude", "projects-<<MACHINE_2_ID>>")
JARRY_SSH = f"<<MACHINE_2_USER>>@{JARRY_IP}"
JARRY_KEY = os.path.join(HOME, ".ssh", "jarry_access")
DIGEST_DIR = os.path.join(REPO, "<<MACHINE_1_ID>>", "state", "self-review")
LEDGER = os.path.join(DIGEST_DIR, "ledger.json")
BOARD = os.path.join(REPO, "<<MACHINE_1_ID>>", "state", "OPEN_TASKS.md")
GOV_CLI = os.path.join(REPO, "scripts", "update-tier1-state.py")
MAX_CANDIDATES = 50
MAX_PROMOTE = 3  # cap new governed tasks per run (avoid flooding)
# #5048: raised 12 -> 50. A small focused write (a 30-line doc, a statusline tweak,
# a config edit) is not reusable code that belonged in a <<MACHINE_1_ID>> lane; flagging it is
# the false-positive class this heuristic kept firing. Only a substantial write with
# no lane call reads as codegen that should have been routed.
ROUTING_LINE_THRESHOLD = 50
BOARD_START = "<!-- SELF-REVIEW:START -->"
BOARD_END = "<!-- SELF-REVIEW:END -->"

# Short system context handed to warden so "applicable" is grounded in Ant's setup.
SYSTEM_CONTEXT = (
    "Ant's system: Claude Code is an orchestrator that should ROUTE codegen/research "
    "to free local Ollama lanes (smith/scout/warden/echo) to save Claude quota; it has "
    "a session 'end' protocol, a governed tasks.json pipeline, LaunchAgent automations, "
    "and dashboards. Two machines: <<MACHINE_1_ID>> (<<MACHINE_1_ID>>) and <<MACHINE_2_ID>>. Fixes are things like hooks, "
    "CLAUDE.md rules, LaunchAgents, or habit changes."
)

# ---------------------------------------------------------------- heuristics
USER_SIGNALS = {
    "correction": re.compile(
        r"\b(no,|nope\b|that'?s (wrong|not right|incorrect)|that'?s not what i|not what i (wanted|asked|meant)|i (said|meant)\b|you (misunderstood|got that wrong))",
        re.I,
    ),
    "redirect": re.compile(
        r"\b(actually,|instead of|wait,? (no|stop)|hold on|back up|before (you|we) (do|go))", re.I
    ),
    "repeat": re.compile(
        r"\b(i already (said|told you|asked)|like i (said|told you)|as i (said|mentioned)|again,? (you|it)|still (broken|not|wrong|failing))",
        re.I,
    ),
    "challenge": re.compile(
        r"\b(why (did|are|would) you|who (told|asked) you to|you (just|keep) (did|doing)|you weren'?t supposed)",
        re.I,
    ),
    "frustration": re.compile(
        r"(\bugh\b|come on|seriously\?|for fuck|jesus christ|this is (annoying|frustrating)|wtf\b)",
        re.I,
    ),
    "revert": re.compile(
        r"\b(revert (that|it)|undo (that|it)|put it back|roll(ing)? back|that broke|you broke)",
        re.I,
    ),
    "verify_miss": re.compile(
        r"\b(don'?t assume|you assumed|stop assuming|did you (actually )?(verify|check|test)|you didn'?t (verify|check|test|run))",
        re.I,
    ),
}
RATE_LIMIT = re.compile(r"rate.?limit|usage limit|5-hour", re.I)
TOOL_ERR = re.compile(
    r"(command not found|no such file|traceback|error:|exception|fatal:|permission denied|failed to|cannot )",
    re.I,
)

# #5048 — routing_miss should fire only on clearly reusable CODE that belonged in a
# <<MACHINE_1_ID>> lane, never on a small focused write, a doc/reference/config file, or a
# hands-on incident-diagnosis writeup. These carve those out.
_ROUTING_DOC_EXT = (".md", ".mdx", ".markdown", ".rst", ".txt", ".json", ".yaml",
                    ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".csv")
_ROUTING_DOC_PATH = re.compile(
    r"(^|/)(docs?|memory|reference|incidents?|notes?)/|(^|/)reference_[^/]+$|"
    r"(^|/)MEMORY(\.md)?$|working-context|session-digest|OPEN_TASKS", re.I)
# Hands-on infra diagnosis: a session touching these was doing incident work at the
# machine, not producing lane-routable codegen — a write inside it is diagnosis, not a miss.
_HANDSON_DIAG = re.compile(
    r"\b(log show|launchctl|scutil|pmset|diskutil|tailscale|ioreg|systemsetup|"
    r"networksetup|dscl|kickstart)\b|\.plist\b", re.I)


def _routing_exempt(file_path: str) -> bool:
    """#5048: a routing_miss flag is a false positive on a doc/reference/config write —
    those are focused writes, not reusable code that belonged in a <<MACHINE_1_ID>> lane."""
    fp = (file_path or "").strip()
    if not fp:
        return False
    if fp.lower().endswith(_ROUTING_DOC_EXT):
        return True
    return bool(_ROUTING_DOC_PATH.search(fp))


def now_iso():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def text_of(msg):
    if isinstance(msg, str):
        return msg
    if isinstance(msg, dict):
        c = msg.get("content")
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return " ".join(
                b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"
            )
    return ""


def load_turns(path):
    turns = []
    try:
        lines = open(path, errors="replace").read().splitlines()
    except Exception:
        return turns
    for line in lines:
        try:
            r = json.loads(line)
        except Exception:
            continue
        t = r.get("type")
        if t not in ("user", "assistant"):
            continue
        msg = r.get("message", {})
        content = msg.get("content") if isinstance(msg, dict) else None
        tool_uses, tool_results, errored = [], [], False
        if isinstance(content, list):
            for b in content:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "tool_use":
                    tool_uses.append({"name": b.get("name"), "input": b.get("input", {})})
                elif bt == "tool_result":
                    rc = b.get("content")
                    rtext = (
                        rc
                        if isinstance(rc, str)
                        else " ".join(x.get("text", "") for x in rc if isinstance(x, dict))
                        if isinstance(rc, list)
                        else ""
                    )
                    tool_results.append(rtext[:600])
                    if b.get("is_error"):
                        errored = True
        turns.append(
            {
                "role": t,
                "text": text_of(msg).strip(),
                "tool_uses": tool_uses,
                "tool_results": tool_results,
                "errored": errored,
                "ts": r.get("timestamp", ""),
            }
        )
    return turns


def is_human_turn(turn):
    if turn["role"] != "user":
        return False
    if turn["tool_results"] and not turn["text"]:
        return False
    t = turn["text"]
    if not t or t.startswith("<") or len(t) < 3:
        return False
    low = t.lower()
    if low.startswith("this session is being continued") or low.startswith("caveat:"):
        return False
    if "operation stopped by hook" in low or "claude_rate_limit_bypass" in low:
        return False
    return True


def context_snippet(turns, i):
    acts = []
    for j in range(i - 1, max(-1, i - 3), -1):
        tr = turns[j]
        if tr["role"] == "assistant":
            for tu in tr["tool_uses"]:
                inp = tu.get("input", {})
                detail = inp.get("command") or inp.get("file_path") or inp.get("pattern") or ""
                acts.append(f"{tu['name']}({str(detail)[:60]})")
            snippet = tr["text"][:120].replace("\n", " ")
            if snippet:
                acts.append(f'said:"{snippet}"')
            if acts:
                break
    return " | ".join(acts[:4]) or "(no prior assistant action)"


def lines_in_edit(tu):
    inp = tu.get("input", {})
    blob = inp.get("content") or inp.get("new_string") or ""
    return blob.count("\n") + 1 if blob else 0


def scan_transcript(path, machine):
    turns = load_turns(path)
    label = f"{machine}:{os.path.basename(path)[:8]}"
    cands = []
    saw_lane_call = False
    saw_handson_diag = False  # #5048: session doing hands-on infra diagnosis, not codegen
    err_streak = 0
    cap_hit = False
    for i, turn in enumerate(turns):
        if (
            not cap_hit
            and turn["role"] == "user"
            and "operation stopped by hook" in turn["text"].lower()
            and "5-hour rate limit" in turn["text"].lower()
        ):
            cap_hit = True
            cands.append(
                {
                    "session": label,
                    "machine": machine,
                    "category": "rate_limit_cap_hit",
                    "ts": turn["ts"],
                    "user": "(session hit the 5-hour cap)",
                    "context": "session reached rate-limit cap at least once",
                }
            )
        if turn["role"] == "assistant":
            for tu in turn["tool_uses"]:
                cmd = str(tu.get("input", {}).get("command", ""))
                if "openclaw agent" in cmd or "--agent smith" in cmd or "--agent scout" in cmd:
                    saw_lane_call = True
                if cmd and _HANDSON_DIAG.search(cmd):
                    saw_handson_diag = True  # #5048: incident diagnosis at the machine
                if tu["name"] in ("Write", "Edit") and not saw_lane_call:
                    n = lines_in_edit(tu)
                    fp = tu["input"].get("file_path", "")
                    if (n >= ROUTING_LINE_THRESHOLD
                            and not _routing_exempt(fp)
                            and not saw_handson_diag):
                        cands.append(
                            {
                                "session": label,
                                "machine": machine,
                                "category": "routing_miss",
                                "ts": turn["ts"],
                                "user": "(no user turn — structural)",
                                "context": f"{tu['name']} {fp} — {n} lines inline, no <<MACHINE_1_ID>>-lane call in session",
                            }
                        )
        if turn["role"] == "user" and (
            turn["errored"] or any(TOOL_ERR.search(r) for r in turn["tool_results"])
        ):
            err_streak += 1
            if err_streak >= 3:
                cands.append(
                    {
                        "session": label,
                        "machine": machine,
                        "category": "tool_error_streak",
                        "ts": turn["ts"],
                        "user": "(repeated tool errors)",
                        "context": context_snippet(turns, i) + f" | streak={err_streak}",
                    }
                )
                err_streak = 0
        elif turn["role"] == "assistant":
            err_streak = 0
        if is_human_turn(turn):
            t = turn["text"][:500]
            cat = None
            for name, pat in USER_SIGNALS.items():
                if pat.search(t):
                    cat = name
                    break
            if not cat and RATE_LIMIT.search(t) and len(t) < 200:
                cat = "rate_limit_stall"
            if cat:
                cands.append(
                    {
                        "session": label,
                        "machine": machine,
                        "category": cat,
                        "ts": turn["ts"],
                        "user": t.replace("\n", " ")[:240],
                        "context": context_snippet(turns, i),
                    }
                )
    return cands


# ---------------------------------------------------------------- stage 0: pull
def pull_jarry():
    """rsync <<MACHINE_2_ID>>'s transcripts into a local mirror. Best-effort."""
    try:
        os.makedirs(JARRY_MIRROR, exist_ok=True)
        r = subprocess.run(
            [
                "rsync",
                "-az",
                "--timeout=30",
                "-e",
                f"ssh -i {JARRY_KEY} -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new",
                "--include=*/",
                "--include=*.jsonl",
                "--exclude=*",
                f"{JARRY_SSH}:.claude/projects/",
                JARRY_MIRROR + "/",
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )
        n = len(glob.glob(os.path.join(JARRY_MIRROR, "**", "*.jsonl"), recursive=True))
        if r.returncode != 0:
            sys.stderr.write(f"[self-review] <<MACHINE_2_ID>> pull rc={r.returncode}: {r.stderr[:200]}\n")
        return n
    except Exception as e:
        sys.stderr.write(f"[self-review] <<MACHINE_2_ID>> pull failed ({e}); continuing <<MACHINE_1_ID>>-only.\n")
        return 0


def discover(days, latest):
    roots = [(LOCAL_TRANSCRIPTS, "jay"), (JARRY_MIRROR, "<<MACHINE_2_ID>>")]
    files = []
    for root, machine in roots:
        for f in glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True):
            files.append((f, machine))
    if latest:
        # only the single most-recently-modified transcript (current session)
        files = sorted(files, key=lambda fm: os.path.getmtime(fm[0]), reverse=True)[:1]
        return files
    if days:
        cutoff = datetime.datetime.now().timestamp() - days * 86400
        files = [fm for fm in files if os.path.getmtime(fm[0]) >= cutoff]
    return files


# ---------------------------------------------------------------- stage 2: scout
SCOUT_PROMPT = """You are reviewing flagged moments from Claude Code agent sessions (the agent is "<<MACHINE_1_ID>>", working for Ant). A cheap heuristic flagged these as POSSIBLE misses/friction. Separate real misses from false positives, then find recurring patterns.

For EACH candidate: verdict = "real_miss" or "false_positive", a short category, a one-line lesson (empty if false_positive).
Then synthesize the top 3-6 RECURRING patterns across the real misses, each with a concrete proposed fix (a hook, a rule, a habit). Be specific; skip generic advice.

Return ONLY valid JSON, no prose:
{"items":[{"i":<index>,"verdict":"real_miss|false_positive","category":"...","lesson":"..."}],
 "patterns":[{"title":"...","evidence":"how often / which sessions","fix":"concrete action","priority":"P1|P2|P3","agent":"claude|smith|scout|warden"}]}

Candidates:
"""

# ---------------------------------------------------------------- stage 3: warden
SHIELD_PROMPT = """You are a QA reviewer verifying proposed self-improvement fixes for an AI agent system before they become tracked tasks. {ctx}

For EACH proposed fix below, judge it on three axes and decide a verdict:
- accurate: does it correctly address the stated pattern? (true/false)
- applicable: does it fit THIS system (routing lanes, hooks, CLAUDE.md, governed tasks)? (true/false)
- effective: is it likely to actually reduce recurrence, not just generic advice? (true/false)
verdict = "approve" (ship as-is) | "revise" (good idea, tighten the fix — give refined_fix) | "reject" (generic/inapplicable/wrong).
Also give a concrete verificationMethod: how we will later CONFIRM the fix worked (an observable signal, ideally one this very tool can measure next week).

Return ONLY valid JSON, no prose:
{"verdicts":[{"i":<index>,"verdict":"approve|revise|reject","accurate":true,"applicable":true,"effective":true,"refined_fix":"...","verificationMethod":"...","confidence":"high|med|low"}]}

Proposed fixes:
"""


SELF_REVIEW_SESSION_BLOAT_THRESHOLD = 20_000


def _reset_self_review_session_if_bloated(lane):
    """Reset the dedicated self-review-{lane} session if it exceeds the bloat threshold.
    Uses the same archive+delete pattern as jlane to avoid cold-start timeouts."""
    import shutil, time as _time
    agents_dir = Path.home() / '.openclaw' / 'agents'
    sessions_path = agents_dir / lane / 'sessions' / 'sessions.json'
    if not sessions_path.exists():
        return
    with open(sessions_path) as f:
        data = json.load(f)
    # --session-id creates 'explicit:<id>' key; --session-key creates '<key>' directly
    session_key = f'agent:{lane}:explicit:self-review-{lane}'
    info = data.get(session_key, {})
    tokens = int(info.get('inputTokens') or 0)
    if tokens <= SELF_REVIEW_SESSION_BLOAT_THRESHOLD:
        return
    session_id = info.get('sessionId', '')
    stamp = int(_time.time())
    sessions_dir = agents_dir / lane / 'sessions'
    for ext in ['.jsonl', '.trajectory.jsonl', '.trajectory-path.json']:
        src = sessions_dir / f'{session_id}{ext}'
        if src.exists():
            shutil.copy2(str(src), str(sessions_dir / f'{session_id}{ext}.archived-{stamp}'))
    data.pop(session_key, None)
    with open(sessions_path, 'w') as f:
        json.dump(data, f, indent=2)
    sys.stderr.write(
        f'[self-review] reset {lane} session (was {tokens:,} tokens > {SELF_REVIEW_SESSION_BLOAT_THRESHOLD:,})\n'
    )


def call_lane(lane, message, timeout=240):
    _reset_self_review_session_if_bloated(lane)
    try:
        proc = subprocess.run(
            [
                "openclaw",
                "agent",
                "--agent",
                lane,
                # Dedicated session so this batch reflection never contaminates the
                # interactive agent:<lane>:main session. Without it, the weekly
                # self-review's SCOUT_PROMPT (verdict/pattern JSON) lingered in
                # scout's main session and bled into the next interactive scout call.
                "--session-id",
                f"self-review-{lane}",
                "--message",
                message,
                "--json",
                "--timeout",
                str(max(5, timeout - 10)),
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        raw = proc.stdout
        env = json.loads(raw[raw.find("{") :])
        out = env["result"]["payloads"][0]["text"]
        m = re.search(r"\{.*\}", out, re.S)
        return json.loads(m.group(0)) if m else None
    except Exception as e:
        sys.stderr.write(f"[self-review] lane {lane} failed ({e}).\n")
        return None


# --latest (session/close-time) mode is documented as "lightweight" and runs inline
# in the /end protocol, which expects it back in seconds. It used to inherit
# call_lane's 240s default, so a cold/slow lane could legitimately block session
# close for up to 4 minutes — the exact >2m hang this constant fixes (#546).
# Failing soft here just drops the "Top lessons" line; the heuristic summary
# (the part /end actually depends on) is unaffected.
LATEST_SCOUT_TIMEOUT = 20


def run_scout(candidates, lane, timeout=240):
    payload = [
        f'[{i}] cat={c["category"]} machine={c["machine"]} | user="{c["user"]}" | ctx={c["context"]}'
        for i, c in enumerate(candidates)
    ]
    return call_lane(lane, SCOUT_PROMPT + "\n".join(payload), timeout=timeout)


def run_shield(patterns, lane, engine="studio-235b"):
    if not patterns:
        return None
    payload = [
        f'[{i}] title="{p.get("title", "")}" | proposed_fix="{p.get("fix", "")}" | evidence="{p.get("evidence", "")}"'
        for i, p in enumerate(patterns)
    ]
    prompt = SHIELD_PROMPT.replace("{ctx}", SYSTEM_CONTEXT) + "\n".join(payload)
    # HEAVY tier (rec 3): try the frontier 235B first — a frontier verdict stamps degraded:false,
    # so downstream (the promote gate) can weigh it fully. On any 235B failure this returns None
    # and we fall back to the local lane below (degraded:true) — the weekly run never breaks.
    if engine == "studio-235b":
        verdicts, info = studio235.verdicts_via_235b(prompt, caller="self-review:warden")
        if verdicts is not None:
            if info:
                sys.stderr.write(
                    f"[self-review] warden(235B): dropped {len(info)} malformed verdict(s): {info}\n")
            return {"verdicts": verdicts}
        sys.stderr.write(
            f"[self-review] warden: 235B unavailable ({info}); falling back to lane '{lane}' (degraded).\n")
    # local lane (a non-235B model, e.g. <<MACHINE_1_ID>> 35B) — a DEGRADED source: validate each verdict
    # against the fleet envelope and stamp degraded:true; drop any malformed one so a bad shape
    # can't gate-approve a fix downstream.
    result = call_lane(lane, prompt)
    if isinstance(result, dict) and isinstance(result.get("verdicts"), list):
        valid, errors = studio235.conform_verdict_batch(result["verdicts"], degraded=True)
        if errors:
            sys.stderr.write(
                f"[self-review] warden: dropped {len(errors)} malformed verdict(s): {errors}\n")
        result["verdicts"] = valid
    return result


# ---------------------------------------------------------------- ledger
VALID_OWNERS = {"claude", "smith", "scout", "warden", "scribe",
                "forge", "shield", "echo"}  # legacy (pre-Guild-rename) accepted


def norm_owner(agent):
    """Scout sometimes returns an agent name ('jay'/'main') instead of a lane.
    Normalize to a real owner; infra fixes default to claude (applies inline)."""
    a = (agent or "").strip().lower()
    return a if a in VALID_OWNERS else "claude"


def sig_of(title):
    norm = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
    return hashlib.sha1(norm.encode()).hexdigest()[:10]


def load_ledger():
    try:
        return json.load(open(LEDGER))
    except Exception:
        return {"version": 1, "updatedAt": None, "weekly_signals": {}, "fixes": {}}


def save_ledger(led):
    os.makedirs(DIGEST_DIR, exist_ok=True)
    led["updatedAt"] = now_iso()
    json.dump(led, open(LEDGER, "w"), indent=2)


CAT_ALIASES = {
    "rate_limit_stall": ["rate limit", "usage limit", "usage cap", "quota"],
    "rate_limit_cap_hit": ["cap hit", "5-hour", "hit the cap"],
    "routing_miss": ["routing", "route", "lane", "inline", "workspace path", "file operation"],
    "correction": ["correction", "corrected", "clarification"],
    "redirect": ["scope", "redirect", "topic shift", "intent"],
    "revert": ["revert", "recovery", "recover", "rollback", "broke"],
    "repeat": ["repeat", "again", "unaddressed", "unfulfilled", "direct user need"],
    "tool_error_streak": ["tool error", "error streak", "infrastructure"],
    "verify_miss": ["assume", "verify", "unverified", "did not check"],
}


def category_of_pattern(pat, candidates, cands_by_cat):
    """Map a pattern to the dominant signal category. Prefer the candidate indices
    scout cites in its evidence (most accurate); fall back to keyword aliases."""
    from collections import Counter

    evidence = (pat.get("evidence", "") + " " + pat.get("title", "")).lower()
    idxs = [
        int(n)
        for n in re.findall(r"\b(\d{1,2})\b", pat.get("evidence", ""))
        if int(n) < len(candidates)
    ]
    if idxs:
        cnt = Counter(candidates[i]["category"] for i in idxs)
        if cnt:
            return cnt.most_common(1)[0][0]
    for cat, words in CAT_ALIASES.items():
        if cat in cands_by_cat and any(w in evidence for w in words):
            return cat
    title = pat.get("title", "").lower()
    for cat in cands_by_cat:
        if cat.replace("_", " ") in title or cat in title:
            return cat
    return None


# ---------------------------------------------------------------- stage 4: promote
def create_governed_task(task_id, title, priority, owner, summary, fix, vmethod):
    # NOTE: task_id is only an internal label (the T-RVW-* signature) for logging — it is NOT
    # sent as the board taskId. create-task requires '#NNN' or omit-to-auto-mint (#3348), so we
    # omit taskId, let the mutator auto-assign, and return the REAL '#NNNN' it minted.
    patch = {
        "title": title[:80],
        "priority": priority,
        "state": "queued",
        "owner": owner or "claude",
        "summary": summary[:300],
        # Required board fields — without these, create-task rejects the mint and the promoted
        # fix silently never lands (the 2+-month rot fixed in #3348). how/why/project/area/agent/
        # machine are all REQUIRED per update-tier1-state.py schema; keep this list in sync with it.
        "why": (
            "Recurring friction/miss pattern surfaced by the weekly transcript self-review; "
            "landing the fix stops the same class of error from recurring."
        ),
        "how": fix[:300],
        "project": "agent-coordination",
        "area": "Automation",
        "agent": "claude",
        "machine": "either",
        "origin": "system",
        "currentStep": "Proposed by weekly self-review; awaiting triage/execution.",
        "expectedArtifact": fix[:300],
        "verificationMethod": (
            vmethod or "Confirm the recurring signal drops in a later self-review run."
        )[:300],
        "blockerOrNone": "none",
        "nextAction": fix[:300],
        # #6798 caller intentionality: a self-review fix is judged in a later run —
        # carry its verification text as explicit acceptance criteria.
        "doneWhen": {"type": "acceptance",
                     "criteria": [(vmethod or fix or summary).strip()[:300]]},
        "mainFiles": [],
        "nextDecisionPoint": None,
    }
    try:
        r = subprocess.run(
            [
                sys.executable,
                GOV_CLI,
                "create-task",
                "--actor",
                "self-review",
                "--patch",
                json.dumps(patch),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            env={**os.environ, "REPO_ROOT": REPO},
        )
        if r.returncode != 0:
            sys.stderr.write(f"[self-review] create-task {task_id} failed: {r.stderr[:300]}\n")
            return None
        m = re.search(r"Created task (#\d+)", r.stdout or "")
        if not m:
            sys.stderr.write(
                f"[self-review] create-task {task_id} returned 0 but no '#NNN' minted "
                f"(out={r.stdout[:150]!r}); treating as unpersisted.\n"
            )
            return None
        return m.group(1)
    except Exception as e:
        sys.stderr.write(f"[self-review] create-task {task_id} error ({e}).\n")
        return None


def write_board(led):
    """Regenerate a managed self-review block on the dashboard board from the ledger."""
    open_fixes = [
        f
        for f in led["fixes"].values()
        if f.get("status") in ("promoted", "executed") and f.get("taskId")
    ]
    lines = [
        BOARD_START,
        "## Self-Review | P2 | active",
        "> Verified fixes from the weekly transcript self-analysis. Auto-managed — do not edit inside markers.",
    ]
    if not open_fixes:
        lines.append("- _(no open self-review fixes)_")
    else:
        for f in sorted(open_fixes, key=lambda x: x.get("priority", "P3")):
            persist = f" (persists x{f['occurrences']})" if f.get("occurrences", 1) > 1 else ""
            lines.append(
                f"- [{f.get('priority', 'P3')}] [ ] **{f['title']}** ({f['taskId']}){persist} "
                f"— {f.get('fix', '')[:120]} @agent:{f.get('owner', 'claude')} @machine:<<MACHINE_1_ID>>"
            )
    lines.append(BOARD_END)
    block = "\n".join(lines)
    try:
        content = open(BOARD).read() if os.path.exists(BOARD) else "# Open Tasks\n"
    except Exception:
        content = "# Open Tasks\n"
    if BOARD_START in content and BOARD_END in content:
        content = re.sub(
            re.escape(BOARD_START) + ".*?" + re.escape(BOARD_END), block, content, flags=re.S
        )
    else:
        content = content.rstrip() + "\n\n" + block + "\n"
    open(BOARD, "w").write(content)


# ---------------------------------------------------------------- digest
def _graduation_lines():
    """Surface the per-work-class autonomy trust tiers (#3444) on the self-review cadence — this is
    the tuning loop where trust signals accumulate, so it's the natural place to watch a class climb
    toward graduation. Best-effort: a reader error just omits the section (never breaks the digest)."""
    reader = os.path.join(REPO, "scripts", "autonomy-graduation-reader.py")
    try:
        # Record today's snapshot first (idempotent per date) so the sustained-trust track record
        # accumulates on the self-review beat, then read the current tiers.
        subprocess.run([sys.executable, reader, "--snapshot"],
                       capture_output=True, text=True, timeout=30)
        r = subprocess.run([sys.executable, reader, "--json"],
                           capture_output=True, text=True, timeout=30)
        rows = json.loads(r.stdout) if r.stdout.strip() else []
    except Exception:
        return []
    if not rows:
        return []
    out = ["## Autonomy graduation (trust tiers, doctrine §2e)"]
    for row in sorted(rows, key=lambda x: -x.get("tier", 0)):
        sc = row.get("score")
        sc_s = f"{sc:.2f}" if isinstance(sc, (int, float)) else "n/a"
        out.append(f"- **{row['label']}** — tier {row['tier']} ({row['tier_label']}), "
                   f"score {sc_s} · _{row['next_tier_gap']}_")
    out.append("")
    return out


def write_digest(date_str, cands, scout, warden, led, n_files, machines, promoted, effectiveness):
    os.makedirs(DIGEST_DIR, exist_ok=True)
    path = os.path.join(DIGEST_DIR, f"{date_str}.md")
    from collections import Counter

    cat_counts = Counter(c["category"] for c in cands)
    real = []
    if scout and scout.get("items"):
        verdict = {it["i"]: it for it in scout["items"] if isinstance(it.get("i"), int)}
        real = [
            (cands[i], verdict[i])
            for i in verdict
            if i < len(cands) and verdict[i].get("verdict") == "real_miss"
        ]
    L = [
        f"# Self-Review Digest — {date_str}",
        "",
        f"_Machines: {', '.join(machines)} · {n_files} transcripts · {len(cands)} candidates · "
        f"{len(real) if scout else 'n/a'} confirmed misses._",
        "",
    ]
    if effectiveness:
        L.append("## Effectiveness of prior fixes")
        for e in effectiveness:
            L.append(f"- {e}")
        L.append("")
    L.append("## Signal counts (this run)")
    for cat, n in cat_counts.most_common():
        L.append(f"- `{cat}` — {n}")
    L.append("")
    if scout and scout.get("patterns"):
        L.append("## Patterns → verified fixes")
        sv = {
            v["i"]: v
            for v in (warden.get("verdicts", []) if warden else [])
            if isinstance(v.get("i"), int)
        }
        for i, p in enumerate(scout["patterns"]):
            v = sv.get(i, {})
            verdict = v.get("verdict", "unverified")
            tag = {"approve": "approved", "revise": "revised", "reject": "rejected"}.get(
                verdict, "· unverified"
            )
            fix = v.get("refined_fix") or p.get("fix", "")
            L.append(f"### {p.get('title', '(untitled)')}  ·  {p.get('priority', 'P3')}  ·  {tag}")
            L.append(f"- **Evidence:** {p.get('evidence', '')}")
            L.append(f"- **Fix:** {fix}")
            if v.get("verificationMethod"):
                L.append(
                    f"- **Verify by:** {v['verificationMethod']}  _(warden confidence: {v.get('confidence', '?')})_"
                )
            if verdict == "reject":
                L.append(
                    f"- _shield rejected: accurate={v.get('accurate')} applicable={v.get('applicable')} effective={v.get('effective')}_"
                )
            L.append("")
    if promoted:
        L.append("## Promoted to governed tasks")
        for tid, title in promoted:
            L.append(f"- `{tid}` — {title}")
        L.append("")
    for gl in _graduation_lines():
        L.append(gl)
    L.append("## Confirmed misses (sample)")
    for c, v in real[:12]:
        L.append(
            f"- [{v.get('category', '')}] ({c['machine']}) {c['user'][:110]}  \n  ↳ _{v.get('lesson', '')}_"
        )
    open(path, "w").write("\n".join(L))
    return path


# ---------------------------------------------------------------- main
# ── compliance stage (#5100): run the Mode-2 auditor in-cadence, surface + persist + promote ──────
# Rules that represent a genuine unenforced BEHAVIORAL leak worth minting a fix-task for. Excludes
# the gate-block-rate rules (signoff/ask — a "block" is often the gate WORKING, not a failure) and
# the near-100 enforced/structured rules. Conservative on purpose: we only auto-file a task for a
# PERSISTENT dip in one of these, never a one-off or an artifact-prone gate rate.
# Checks a below-threshold reading of is almost certainly a REAL violation (not a measurement
# artifact) — safe to AUTO-MINT a governed fix-task. Widened (#5100 C3) with the unambiguous
# mechanical checks (a co-author trailer / SendFeedback call / fail-open log entry either exists or
# it doesn't). Fuzzier / judge-class rules stay OFF the auto-mint list — they surface loudly instead
# (see the uncurated-leak digest line) so nothing is invisible, without a flaky checker spamming the board.
# #5100 (compliance substance-gap fix): fake-done-reverify is mechanical + high-confidence — a FAIL
# means task-verify.sh returned non-zero on a task marked done, i.e. a CONCRETE fake-done — so it is
# safe to auto-mint. no-fake-done-judge is RE-ENABLED (2026-09-02): judge-validate.py measured the
# rubric at F1 1.0 / FN 0.0 on 41 labeled fixtures (perfect discrimination, zero laundered greens),
# AND fixed the real laundering bug it exposed — _judge_model was resolving to the 7B VISION model
# that sorts first on :8081 and rubber-stamps a third of fake-done (FN 0.33); it now pins the text 35B.
# With a validated rubric on the correct model the judge is trustworthy enough to auto-mint. Caveat:
# n=41 is a discrimination proof, not a fleet precision estimate — watch the live partial-flag rate.
COMPLIANCE_PROMOTABLE = {"verified-field-filled", "commit-intent", "fake-done-reverify",
                         "no-fake-done-judge", "redaction-money", "no-ai-coauthor",
                         "forbidden-tool-calls", "lease-guard-integrity"}
# #5245 edge-1 follow-on ("promote after N cadence runs"): the behavioral judges start OFF this set
# and are added ONLY once judge-promote.py has flipped them in judge-promotion-state.json, on real-
# cadence evidence (>=N samples across >=N runs, re-validated FN=0 / precision>=floor). Data-driven,
# so a promotion never needs a code edit here.
PROMOTION_LEDGER = os.path.join(REPO, "<<MACHINE_1_ID>>", "state", "compliance", "judge-promotion-state.json")
JUDGE_PROMOTE = os.path.join(REPO, "scripts", "compliance", "judge-promote.py")


def _promoted_behavioral_rules():
    try:
        with open(PROMOTION_LEDGER) as fh:
            led = json.load(fh)
        return {r for r, v in led.items() if isinstance(v, dict) and v.get("promoted")}
    except Exception:
        return set()


COMPLIANCE_THRESHOLD = 0.75
AUDIT = os.path.join(REPO, "scripts", "compliance", "audit.py")
COMPLIANCE_HISTORY = os.path.join(REPO, "<<MACHINE_1_ID>>", "state", "compliance", "history.jsonl")

# Phase 3/4 (#5245): fleet aggregation + the 35B-weekly / 235B-monthly judge split.
# The per-machine cadence + weekly Mode-1 scenarios judge on the fast, VALIDATED local 35B
# (judge-validate.py F1 1.0 / FN 0.0). The higher-fidelity 235B frontier judge is a MONTHLY
# escalation (first cadence run of each month) — batch/async, needs Studio reachable + GPU
# headroom, so it never gates the weekly loop. This is the build plan's recommended default
# (docs/process/state/run-results/policy-diagnostics-build-plan.md, "Open decision for Ant").
FLEET_AGGREGATE = os.path.join(REPO, "scripts", "compliance", "fleet-aggregate.py")
FLEET_LATEST = os.path.join(REPO, "docs", "process", "state", "policy-diagnostics", "fleet-latest.json")
JUDGE_WEEKLY = "<<MACHINE_1_ID>>-35b"       # fast, validated, always-run
JUDGE_MONTHLY = "studio-235b"     # frontier, monthly escalation only


def run_compliance_stage(led, date_str, latest, dry_run, no_promote):
    """Run scripts/compliance/audit.py in the self-review cadence, print the scorecard summary,
    persist the rates into the ledger, and (weekly, non-dry) mint ONE governed fix-task for a
    PERSISTENT promotable leak (below threshold this run AND the previous recorded run) — reusing
    PROMOTE + LEDGER. Fully guarded: any failure prints a note and returns, never breaking self-review."""
    try:
        # #5100 (compliance substance-gap fix): the fake-done checks — the system's CENTRAL promise —
        # ran dark, because the cadence passed neither --reverify nor --judge (audit's outside-party
        # audit, G1/§1). So the green "overall" was a mean of STRUCTURAL checks only and never a
        # substance read. Turn both on every cadence: --reverify is mechanical (re-runs task-verify.sh
        # on done tasks; a FAIL is a concrete fake-done) and --judge records the local-35B substance
        # read so no-fake-done-judge becomes a LIVE, visible signal instead of an inert list entry
        # (G4). Timeout raised 180->600 to cover the reverify shell re-runs + the bounded judge pass.
        # #5480: the fast 35B judge over-flags real sign-off prose (FN 0.0 but precision ~0.63), so
        # escalate ONLY its flagged turns to the higher-fidelity 235B confirmer — a violation counts
        # on 2-judge agreement, killing the false positives. The confirmer probe (:8082 /v1/models,
        # validated live to clear 7/7 known FPs). Only the flagged minority escalate, so it is cheap
        # enough to run WEEKLY; if the 235B is down that week, audit withholds the rate (no false
        # auto-mint). Resolved via lane_endpoints (never a hardcoded IP).
        audit_cmd = [sys.executable, AUDIT, "--reverify", "--judge"]
        try:
            import lane_endpoints as _le
            for _u in _le.studio_235b_urls():
                try:
                    urllib.request.urlopen(_u.rstrip("/") + "/v1/models", timeout=6).read()
                    audit_cmd += ["--confirm-judge", _u]
                    break
                except Exception:
                    continue
        except Exception:
            pass  # confirmer optional — fall back to primary-only judging
        subprocess.run(audit_cmd, cwd=REPO, capture_output=True, text=True, timeout=900)
        lines = [json.loads(l) for l in open(COMPLIANCE_HISTORY) if l.strip()]
    except Exception as e:
        print(f"[self-review:compliance] audit skipped ({e})")
        return
    if not lines:
        return
    run = lines[-1]
    rates, overall = run.get("rates", {}) or {}, run.get("overall_rate")
    leaks = sorted([(r, v) for r, v in rates.items() if v is not None and v < COMPLIANCE_THRESHOLD],
                   key=lambda x: x[1])
    ov = "—" if overall is None else f"{overall:.0%}"
    print(f"[self-review:compliance] overall {ov}; "
          + (", ".join(f"{r} {v:.0%}" for r, v in leaks[:4]) if leaks else "no rule below threshold"))
    if dry_run:
        return
    led.setdefault("compliance_history", {})[date_str] = {"overall": overall, "rates": rates}
    # SELF-HEAL arm (#5100 D1): relink any stripped hook symlink (safe/idempotent) + surface infra
    # drift (bootstrap-list gap, stale settings refs). Runs every cadence; heals only the provably-
    # safe class, reports the rest.
    try:
        sh = subprocess.run([sys.executable, os.path.join(REPO, "scripts/compliance/self-heal.py"), "--heal"],
                            cwd=REPO, capture_output=True, text=True, timeout=60)
        for line in (sh.stdout or "").splitlines():
            s = line.strip()
            if ("relinked" in s) or (("GAP" in s or "STRIPPED" in s or "NO-REPO" in s or "UNION" in s) and "none" not in s):
                print(f"[self-review:self-heal] {s}")
    except Exception as e:
        print(f"[self-review:self-heal] skipped ({e})")
    # PROMOTION arm (#5245 edge-1 follow-on): the audit run above ACCRETED this cadence's confirmer-
    # ruled turns as real-prose fixtures; now run the gate. It re-validates each candidate behavioral
    # judge on base+accreted and flips it to auto-mint only once it has enough real samples across
    # enough runs AND still holds FN=0 / precision>=floor. Guarded + validates on the fast 35B (the
    # model that would auto-mint), so a promotion is earned on the same judge that will act on it.
    try:
        pr = subprocess.run([sys.executable, JUDGE_PROMOTE, "--check"],
                            cwd=REPO, capture_output=True, text=True, timeout=600)
        for line in (pr.stdout or "").splitlines():
            s = line.strip()
            if "PROMOTED -> auto-mint" in s or "held surfaced-only" in s:
                print(f"[self-review:promote] {s}")
    except Exception as e:
        print(f"[self-review:promote] skipped ({e})")
    if no_promote:
        return  # explicit opt-out only. NOTE (#5100 C3): --latest (session-end) now flows through to
        # regression-detect + promote so a leak appearing BETWEEN weekly runs is caught at the next
        # session end, not weeks later. Bounded: the two-run persistence guard + the fixes[] dedup +
        # the one-task-per-run cap mean at most ONE governed task per distinct persistent leak.
    prev_dates = sorted([d for d in led["compliance_history"] if d < date_str])
    prev_rates = led["compliance_history"][prev_dates[-1]]["rates"] if prev_dates else {}
    # C1 regression alert: surface a drop in the digest (the loop must NOTICE a backslide, not just
    # trend silently). Overall down >5pts, or any rule down >10pts vs the last recorded run.
    prev_overall = led["compliance_history"][prev_dates[-1]].get("overall") if prev_dates else None
    if prev_overall and overall is not None and overall < prev_overall - 0.05:
        print(f"[self-review:compliance] ⚠ REGRESSION overall {prev_overall:.0%} -> {overall:.0%} (down {100*(prev_overall-overall):.0f}pts)")
    for _r, _v in (rates or {}).items():
        _pv = prev_rates.get(_r)
        if _pv is not None and _v is not None and _v < _pv - 0.10:
            print(f"[self-review:compliance] ⚠ REGRESSION {_r} {_pv:.0%} -> {_v:.0%}")
    promotable = COMPLIANCE_PROMOTABLE | _promoted_behavioral_rules()
    for rule, v in leaks:
        persistent = prev_rates.get(rule, 1.0) < COMPLIANCE_THRESHOLD
        if rule not in promotable:
            # C3: a persistent leak outside the auto-mint set is no longer invisible — surface it
            # loudly so it can be minted deliberately (kept OFF auto-mint because it is a judge/fuzzy
            # class where a below-threshold reading may still be a measurement artifact).
            if persistent:
                print(f"[self-review:compliance] ⚑ persistent UNCURATED leak '{rule}' at {v:.0%} — "
                      "not auto-minted (judge/fuzzy class); if real, mint deliberately after reading "
                      "the flagged records (scripts/compliance/audit.py --last 10)")
            continue
        if prev_rates.get(rule, 1.0) >= COMPLIANCE_THRESHOLD:
            continue  # only dipped this run — wait for a second run to confirm it's persistent
        sig = sig_of(f"compliance leak {rule}")
        if led["fixes"].get(sig):
            led["fixes"][sig]["last_seen"] = date_str
            continue  # already an open governed task
        tid = f"T-CMP-{date_str.replace('-', '')}"
        title = f"compliance leak: {rule} persistently below {int(COMPLIANCE_THRESHOLD * 100)}%"
        summary = (f"The Mode-2 auditor scored '{rule}' at {v:.0%} across two consecutive runs. "
                   "Investigate whether this is real behavioral drift or a measurement artifact, then "
                   "fix the behavior or tighten the checker (scripts/compliance/audit.py).")
        fix = f"Read the flagged records for '{rule}' in the latest workspace/state/compliance/compliance-*.json; root-cause and close."
        minted = create_governed_task(tid, title, "P3", "claude", summary, fix,
                                      f"audit.py shows '{rule}' back at/above {COMPLIANCE_THRESHOLD} on a later run")
        if minted:
            led["fixes"][sig] = {"sig": sig, "title": title, "category": f"compliance-{rule}",
                                 "priority": "P3", "owner": "claude", "taskId": minted, "status": "promoted",
                                 "first_seen": date_str, "last_seen": date_str, "occurrences": 1,
                                 "history": [{"date": date_str, "note": "compliance leak promoted"}]}
            print(f"[self-review:compliance] filed governed fix-task {minted} for persistent leak '{rule}'")
            break  # cap: one compliance task per run

    # B2: auto-run the Mode-1 protocol scenarios (weekly only — a ~4min model run) so the
    # regression gate actually gates. Records the mean into mode1_history and alerts on a drop.
    # Weekly on the validated 35B; the 235B frontier judge is a MONTHLY escalation (#5245 Phase 4).
    run_mode1_scenarios(led, date_str, judge=JUDGE_WEEKLY, hist_key="mode1_history")
    if _is_first_cadence_of_month(led, date_str):
        print(f"[self-review:mode1] monthly escalation — re-judging protocol scenarios on {JUDGE_MONTHLY}")
        run_mode1_scenarios(led, date_str, judge=JUDGE_MONTHLY, hist_key="mode1_history_235b",
                            timeout=1200)

    # #5245 coverage edge 2: per-lane protocol-adherence — score each active lane against the doctrine
    # scenarios (light lanes weekly, heavy 235B on the monthly tier). Guarded; a down lane is skipped.
    run_lane_adherence_stage(led, date_str)
    run_routing_distill_stage(date_str)
    run_fix_ledger_stage(date_str)

    # Phase 3 (#5245): blend the per-machine partitions into the fleet view + mint on backfired/DOA.
    run_fleet_aggregate_stage(led, date_str, dry_run=False, no_promote=no_promote)


def run_lane_adherence_stage(led, date_str):
    """Run scripts/compliance/lane-adherence.py — score each reachable lane's output against the 18
    doctrine scenarios (weekly tier by default; the full/heavy tier on the first cadence of the month),
    print the per-lane scores, and surface the tool's own >10pt-drop regression alerts. Fully guarded:
    an unreachable lane or a missing bench is skipped, never breaks self-review."""
    tier = "all" if _is_first_cadence_of_month(led, date_str) else "weekly"
    script = os.path.join(REPO, "scripts", "compliance", "lane-adherence.py")
    try:
        r = subprocess.run([sys.executable, script, "--tier", tier], cwd=REPO,
                           capture_output=True, text=True, timeout=1500)
        for line in (r.stdout or "").splitlines():
            s = line.strip()
            if s.startswith("[lane]") or "REGRESSION" in s or "adherence" in s.lower():
                print(f"[self-review:lane] {s}")
    except Exception as e:
        print(f"[self-review:lane] skipped ({e})")


def run_routing_distill_stage(date_str):
    """#3068: regenerate the learned-from-outcomes routing surface on the weekly cadence
    (workspace/state/self-review/routing-distill.{json,md}) and print any measured-best-vs-
    policy-default divergence so it reaches the digest reader. Guarded: never breaks review."""
    script = os.path.join(REPO, "scripts", "dispatch-outcome-distill.py")
    try:
        r = subprocess.run([sys.executable, script, "--days", "28"], cwd=REPO,
                           capture_output=True, text=True, timeout=180)
        for line in (r.stdout or "").splitlines():
            if line.startswith("[distill]"):
                print(f"[self-review:routing] {line[len('[distill] '):]}")
    except Exception as e:
        print(f"[self-review:routing] skipped ({e})")


def run_fix_ledger_stage(date_str):
    """#3124: read the fix-capture ledger for recurrence + framework gaps (a mistake class
    fixed >=2x with no framework prevention) so the review sees where the system keeps
    being fixed by hand. Guarded: never breaks review."""
    script = os.path.join(REPO, "scripts", "fix-capture.py")
    try:
        r = subprocess.run([sys.executable, script, "report", "--days", "30"], cwd=REPO,
                           capture_output=True, text=True, timeout=60)
        for line in (r.stdout or "").splitlines():
            if line.strip():
                print(f"[self-review:fixes] {line.strip()}")
    except Exception as e:
        print(f"[self-review:fixes] skipped ({e})")


def _is_first_cadence_of_month(led, date_str):
    """True on the first cadence run of the calendar month (drives the monthly 235B escalation).
    Uses the mode1 history the cadence itself records, so it is self-tracking and idempotent."""
    hist = led.get("mode1_history_235b", {})
    month = date_str[:7]
    return not any(k.startswith(month) for k in hist)


def run_mode1_scenarios(led, date_str, judge=JUDGE_WEEKLY, hist_key="mode1_history", timeout=420):
    """Run scripts/bench/tasksets/compliance-scenarios.json on the durable lane + `judge`, record
    the mean into led[hist_key], and alert on a regression. Fully guarded; skips if the lane/bench is
    unavailable. `judge` is a metis-bench judge id ('<<MACHINE_1_ID>>-35b' weekly, 'studio-235b' monthly)."""
    bench = os.path.join(REPO, "scripts/bench/metis-bench.py")
    targets = os.path.join(REPO, "scripts/bench/targets-compliance.json")
    taskset = os.path.join(REPO, "scripts/bench/tasksets/compliance-scenarios.json")
    if not all(os.path.exists(p) for p in (bench, targets, taskset)):
        return
    try:
        out_dir = os.path.join(REPO, "workspace/state/compliance/mode1")
        subprocess.run([sys.executable, bench, "--targets", targets, "--taskset", taskset,
                        "--only", "models", "--judge", judge, "--out", out_dir],
                       cwd=REPO, capture_output=True, text=True, timeout=timeout)
        runs = sorted(glob.glob(os.path.join(out_dir, "bench-*.json")), key=os.path.getmtime)
        if not runs:
            return
        d = json.load(open(runs[-1]))
        # metis-bench now reports objective- and judge-means SEPARATELY (never one blended number, #5100).
        # The compliance-scenarios taskset is entirely judge-scored, so track judge_mean_score; fall back to
        # objective_mean_score if a future scenario is objectively scored.
        q = next((m.get("quality") for m in d.get("models", []) if m.get("quality")), None) or {}
        mean = q.get("judge_mean_score")
        if mean is None:
            mean = q.get("objective_mean_score")
        if mean is None:
            return
        print(f"[self-review:mode1] protocol-scenario score {mean:.0%} on {judge}")
        hist = led.setdefault(hist_key, {})
        prev = [hist[k] for k in sorted(hist) if k < date_str]
        if prev and mean < prev[-1] - 0.10:
            print(f"[self-review:mode1] ⚠ REGRESSION protocol scenarios ({judge}) {prev[-1]:.0%} -> {mean:.0%}")
        hist[date_str] = mean
    except Exception as e:
        print(f"[self-review:mode1] skipped ({judge}: {e})")


def run_fleet_aggregate_stage(led, date_str, dry_run, no_promote):
    """Phase 3 (#5245): run fleet-aggregate.py to blend the per-machine policy-diagnostics partitions,
    surface the fleet bands + DOA + backfired-effect findings, alert on regressions, and mint AT MOST
    ONE governed task per run for the highest-signal finding — a backfired shipped improvement first,
    else a persistent set of fleet DOA candidates. Reuses create_governed_task + the fixes[] dedup +
    the one-task-per-run cap. Fully guarded; never breaks self-review."""
    try:
        subprocess.run([sys.executable, FLEET_AGGREGATE], cwd=REPO,
                       capture_output=True, text=True, timeout=300)
        fleet = json.load(open(FLEET_LATEST)) if os.path.exists(FLEET_LATEST) else None
    except Exception as e:
        print(f"[self-review:fleet] aggregate skipped ({e})")
        return
    if not fleet:
        return
    summ = fleet.get("summary", {})
    bands = fleet.get("bands", {})
    ov = bands.get("overall_rate")
    ov_s = "—" if ov is None else f"{ov:.0%}"
    backfired = summ.get("backfired", [])
    doa = fleet.get("doa_candidates", [])
    print(f"[self-review:fleet] {summ.get('n_machines', 0)} machines · overall {ov_s} · "
          f"{summ.get('doa_candidate_count', 0)} DOA candidates · {len(backfired)} backfired")

    # regression alert: a new backfire or a jump in DOA candidates vs the last recorded fleet run.
    fh = led.setdefault("fleet_history", {})
    prev_dates = sorted([d for d in fh if d < date_str])
    prev = fh[prev_dates[-1]] if prev_dates else {}
    if prev:
        new_backfires = sorted(set(backfired) - set(prev.get("backfired", [])))
        if new_backfires:
            print(f"[self-review:fleet] ⚠ NEW BACKFIRE(s): {', '.join(new_backfires)}")
        pdoa = prev.get("doa_candidate_count")
        if pdoa is not None and summ.get("doa_candidate_count", 0) > pdoa + 5:
            print(f"[self-review:fleet] ⚠ DOA candidates rose {pdoa} -> {summ.get('doa_candidate_count')}")
    if not dry_run:
        fh[date_str] = {"overall": ov, "doa_candidate_count": summ.get("doa_candidate_count", 0),
                        "backfired": backfired}
    if dry_run or no_promote:
        return

    # Mint one governed task for the highest-signal finding. Backfired first (a shipped change made
    # things WORSE — the strongest signal this whole suite exists to catch), else a persistent DOA set.
    if backfired:
        sig = sig_of("fleet backfired improvements")
        if not led["fixes"].get(sig):
            tid = f"T-FLEET-BF-{date_str.replace('-', '')}"
            names = ", ".join(backfired[:6])
            title = f"backfired shipped improvement(s) flagged by fleet diagnostics: {names}"
            summary = ("The fleet policy-diagnostics aggregate flags shipped improvement(s) whose "
                       f"post-ship violation-attempt rate ROSE on at least one machine: {names}. "
                       "Confirm the regression per improvement (docs/process/state/policy-diagnostics/"
                       "fleet-latest.json > effects), then fix or roll back the change.")
            fix = ("Read fleet-latest.json effects[] for each backfired id; reproduce the block-rate "
                   "before/after delta, then remediate the regressing hook/rule or roll it back.")
            minted = create_governed_task(tid, title, "P2", "claude", summary, fix,
                                          "fleet-latest.json shows the improvement no longer backfired")
            if minted:
                led["fixes"][sig] = {"sig": sig, "title": title, "category": "fleet-backfired",
                                     "priority": "P2", "owner": "claude", "taskId": minted,
                                     "status": "promoted", "first_seen": date_str, "last_seen": date_str,
                                     "occurrences": 1,
                                     "history": [{"date": date_str, "note": "fleet backfire promoted"}]}
                print(f"[self-review:fleet] filed governed fix-task {minted} for backfired improvement(s)")
            return  # one task per run

    # No backfire: a persistent fleet DOA set (dead on every machine across TWO consecutive fleet runs)
    # is worth a single consolidated REVIEW task — never per-rule, never an auto-retire.
    if doa and prev.get("doa_candidate_count"):  # requires a prior fleet run to establish persistence
        sig = sig_of("fleet doa review")
        if not led["fixes"].get(sig):
            tid = f"T-FLEET-DOA-{date_str.replace('-', '')}"
            title = f"fleet DOA review: {len(doa)} rules dead on every machine — confirm-or-retire"
            summary = (f"{len(doa)} rules are DOA candidates fleet-wide (0 fires + 0 references on every "
                       "machine) across two consecutive fleet runs. Review each to confirm it is truly "
                       "dead process-debt (retire) or dormant-because-followed (keep). This is a REVIEW, "
                       "never an auto-retire. Full list: fleet-latest.json > doa_candidates.")
            fix = ("Walk fleet-latest.json doa_candidates; for each, decide retire (delete the rule) or "
                   "keep (add a reference/test so it is no longer 0-referenced). Close when the list is triaged.")
            minted = create_governed_task(tid, title, "P3", "claude", summary, fix,
                                          "the fleet DOA candidate list has been triaged (retire/keep each)")
            if minted:
                led["fixes"][sig] = {"sig": sig, "title": title, "category": "fleet-doa",
                                     "priority": "P3", "owner": "claude", "taskId": minted,
                                     "status": "promoted", "first_seen": date_str, "last_seen": date_str,
                                     "occurrences": 1,
                                     "history": [{"date": date_str, "note": "fleet DOA review promoted"}]}
                print(f"[self-review:fleet] filed governed review-task {minted} for {len(doa)} fleet DOA candidates")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument(
        "--latest", action="store_true", help="session mode: only the most-recent transcript"
    )
    ap.add_argument("--lane", default="scout")
    ap.add_argument("--verify-lane", default="warden")
    ap.add_argument("--verify-engine",
                    default=os.environ.get("SELF_REVIEW_VERIFY_ENGINE", "studio-235b"),
                    choices=["studio-235b", "local"],
                    help="warden heavy tier: 'studio-235b' (frontier verdict, degraded:false, "
                         "auto-falls-back to --verify-lane when Studio is dark) or 'local' "
                         "(the --verify-lane model directly, degraded:true). Default studio-235b.")
    ap.add_argument("--no-pull", action="store_true")
    ap.add_argument("--no-promote", action="store_true")
    ap.add_argument("--no-compliance", action="store_true", help="skip the Mode-2 compliance audit stage (#5100)")
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="no governed/board/ledger writes")
    args = ap.parse_args()

    machines = ["jay"]
    if not args.latest and not args.no_pull:
        n = pull_jarry()
        if n:
            machines.append("<<MACHINE_2_ID>>")

    files = discover(None if args.latest else args.days, args.latest)
    cands = []
    for f, machine in files:
        cands.extend(scan_transcript(f, machine))

    # de-noise + cap
    seen, deduped = set(), []
    for c in cands:
        key = (c["category"], c["user"][:60])
        if key not in seen:
            seen.add(key)
            deduped.append(c)
    deduped = deduped[:MAX_CANDIDATES]

    date_str = datetime.date.today().isoformat()
    from collections import Counter

    cat_counts = dict(Counter(c["category"] for c in deduped))

    # session (end-protocol) mode: lightweight — flag + feed ledger, no warden/promote
    if args.latest:
        scout = (
            None
            if (args.no_llm or not deduped)
            else run_scout(deduped, args.lane, timeout=LATEST_SCOUT_TIMEOUT)
        )
        led = load_ledger()
        if not args.dry_run:
            led["weekly_signals"].setdefault(date_str, {})
            for k, v in cat_counts.items():
                led["weekly_signals"][date_str][k] = led["weekly_signals"][date_str].get(k, 0) + v
            if not args.no_compliance:
                run_compliance_stage(led, date_str, True, args.dry_run, True)
            save_ledger(led)
        print(
            f"[self-review:session] {len(deduped)} flagged moments this session: "
            + ", ".join(f"{k}×{v}" for k, v in cat_counts.items())
            or "(none)"
        )
        if scout and scout.get("patterns"):
            print("  Top lessons:")
            for p in scout["patterns"][:3]:
                print(f"   · {p.get('title')}: {p.get('fix', '')[:90]}")
        return

    # weekly mode: full pipeline
    scout = None if (args.no_llm or not deduped) else run_scout(deduped, args.lane)
    patterns = scout.get("patterns", []) if scout else []
    warden = None if (args.no_llm or not patterns) else run_shield(patterns, args.verify_lane, args.verify_engine)

    led = load_ledger()
    # effectiveness check: compare this run's category counts to the last recorded run
    effectiveness = []
    prev_dates = sorted([d for d in led["weekly_signals"] if d < date_str])
    if prev_dates:
        prev = led["weekly_signals"][prev_dates[-1]]
        for f in led["fixes"].values():
            cat = f.get("category")
            if f.get("status") in ("promoted", "executed") and cat:
                before = prev.get(cat, 0)
                after = cat_counts.get(cat, 0)
                if before and after == 0:
                    effectiveness.append(
                        f"[effective] '{f['title']}' — `{cat}` dropped {before}->0 since fix shipped."
                    )
                elif before and after >= before:
                    effectiveness.append(
                        f"[not-yet-effective] '{f['title']}' — `{cat}` still {after} (was {before}); task bumped."
                    )

    # promote warden-approved fixes (idempotent via sig), capped
    promoted = []
    if not args.no_promote and not args.dry_run and warden:
        sv = {v["i"]: v for v in warden.get("verdicts", []) if isinstance(v.get("i"), int)}
        approved = [
            (i, patterns[i], sv[i])
            for i in sv
            if i < len(patterns) and sv[i].get("verdict") in ("approve", "revise")
        ]
        new_count = 0
        for i, p, v in approved:
            sig = sig_of(p.get("title", ""))
            cat = category_of_pattern(p, deduped, cat_counts)
            existing = led["fixes"].get(sig)
            if existing:
                # recurring pattern: bump, don't duplicate
                existing["occurrences"] = existing.get("occurrences", 1) + 1
                existing["last_seen"] = date_str
                existing.setdefault("history", []).append(
                    {"date": date_str, "note": "pattern recurred"}
                )
            else:
                if new_count >= MAX_PROMOTE:
                    continue
                tid = f"T-RVW-{date_str.replace('-', '')}-{new_count + 1}"
                fix = v.get("refined_fix") or p.get("fix", "")
                owner = norm_owner(p.get("agent"))
                minted_id = create_governed_task(
                    tid,
                    p.get("title", ""),
                    p.get("priority", "P3"),
                    owner,
                    p.get("evidence", ""),
                    fix,
                    v.get("verificationMethod", ""),
                )
                led["fixes"][sig] = {
                    "sig": sig,
                    "title": p.get("title", ""),
                    "category": cat,
                    "priority": p.get("priority", "P3"),
                    "owner": owner,
                    "fix": fix,
                    "verificationMethod": v.get("verificationMethod", ""),
                    "taskId": minted_id,  # the REAL auto-minted '#NNNN', not the T-RVW label
                    "status": "promoted" if minted_id else "proposed",
                    "first_seen": date_str,
                    "last_seen": date_str,
                    "occurrences": 1,
                    "history": [
                        {
                            "date": date_str,
                            "note": "promoted to governed task" if minted_id else "promotion failed",
                        }
                    ],
                }
                if minted_id:
                    promoted.append((minted_id, p.get("title", "")))
                    new_count += 1

    # compliance stage (#5100): audit + surface + persist rates + promote a persistent leak
    if not args.no_compliance:
        run_compliance_stage(led, date_str, False, args.dry_run, args.no_promote)

    # record this run's signals + persist ledger + regenerate board
    if not args.dry_run:
        led["weekly_signals"][date_str] = cat_counts
        write_board(led)
        save_ledger(led)

    digest = write_digest(
        date_str, deduped, scout, warden, led, len(files), machines, promoted, effectiveness
    )
    print(
        f"[self-review] {', '.join(machines)} · {len(files)} transcripts · {len(deduped)} candidates · "
        f"{'scout+warden' if warden else ('scout' if scout else 'heuristic')} · "
        f"{len(promoted)} promoted · digest: {digest}"
    )

    # Reasoning distiller (A3, PLAN-reasoning-trust-loop.md): on the same weekly
    # cadence, synthesize Ant's reasoning corpus (mindset ledger + decision ratings
    # + resolved decisions) into PROPOSED doctrine deltas + WSJF weights. Balanced
    # posture (Ant 2026-08-15): the distiller only reports recurring/explicit patterns,
    # and every proposal is HELD in docs/process/reasoning-proposals/ behind the
    # validation gate — nothing auto-applies. Best-effort + non-fatal + MLX-down-safe.
    if not args.dry_run:
        try:
            here = os.path.dirname(os.path.abspath(__file__))
            r = subprocess.run(
                [sys.executable, os.path.join(here, "reasoning-synthesize.py")],
                # Outer cap must exceed reasoning-synthesize's own MLX worst-case
                # (_MLX_TIMEOUT_S=300 x _MLX_RETRIES=3 = 900s) or a slow/retrying MLX
                # guarantees a timeout and the flagship distiller never produces a proposal
                # (#3344). 960s = 900 + margin; still best-effort + non-fatal below.
                capture_output=True, text=True, timeout=960,
            )
            tail = (r.stdout or r.stderr or "").strip().splitlines()
            print(f"[self-review] distiller: {tail[-1] if tail else 'ran'}")
        except Exception as e:  # noqa: BLE001 — never let the distiller sink the weekly review
            sys.stderr.write(f"[self-review] distiller skipped ({e}).\n")

    # WSJF effort back-calibration (#3049 sibling loop): on the same weekly cadence,
    # distill measured execution actuals (runs-ledger duration) into a per-domain effort
    # table so the WSJF denominator stops being inert. Honesty-gated — writes an INERT
    # calibration (zero behaviour change) until enough clean signal accrues; --apply is
    # safe because wsjf.m_effort falls back to neutral on any missing/malformed file.
    if not args.dry_run:
        try:
            here = os.path.dirname(os.path.abspath(__file__))
            r = subprocess.run(
                [sys.executable, os.path.join(here, "wsjf-calibrate.py"), "--apply"],
                capture_output=True, text=True, timeout=120,
            )
            tail = (r.stdout or r.stderr or "").strip().splitlines()
            print(f"[self-review] wsjf-calibrate: {tail[0] if tail else 'ran'}")
        except Exception as e:  # noqa: BLE001 — never let calibration sink the weekly review
            sys.stderr.write(f"[self-review] wsjf-calibrate skipped ({e}).\n")

    # Voice-correction distiller (the parent template of the reasoning distiller): the
    # capture edge (Studio -> voice-deltas.jsonl) and the synthesizer both exist and are
    # review-gated, but nothing fired the distiller on a cadence. Wire it here beside its
    # twin. Empty-bank safe (no deltas -> prints "nothing to synthesize", exit 0) and
    # MLX-down safe (raw-aggregation fallback). Writes only to voice-proposals/ — never
    # the Ant-locked voice-profile.md. Self-activates once Ant edits drafts in Studio.
    if not args.dry_run:
        try:
            here = os.path.dirname(os.path.abspath(__file__))
            r = subprocess.run(
                [sys.executable, os.path.join(here, "writing-voice-synthesize.py")],
                capture_output=True, text=True, timeout=420,
            )
            tail = (r.stdout or r.stderr or "").strip().splitlines()
            print(f"[self-review] voice-distiller: {tail[-1] if tail else 'ran'}")
        except Exception as e:  # noqa: BLE001 — never let the voice distiller sink the review
            sys.stderr.write(f"[self-review] voice-distiller skipped ({e}).\n")

    # Calibration-coverage snapshot (Ant 2026-08-16: quantify + self-improvement stances):
    # the calibration-coverage model measures how completely Ant's value-system is captured
    # across the decision-domain taxonomy. Snapshot it each run to a history ledger so growth
    # or drift (a domain regressing to thin/empty) is trackable over time — the calibration
    # process self-monitoring. Read-only + best-effort; never sinks the review.
    if not args.dry_run:
        try:
            here = os.path.dirname(os.path.abspath(__file__))
            r = subprocess.run(
                [sys.executable, os.path.join(here, "calibration-coverage.py"), "--json"],
                capture_output=True, text=True, timeout=60,
            )
            data = json.loads(r.stdout) if r.stdout.strip() else {}
            summ = data.get("summary", {})
            if summ:
                snap = {
                    "date": datetime.date.today().isoformat(),
                    "stances": summ.get("stances"),
                    "covered": summ.get("covered"),
                    "thin": summ.get("thin"),
                    "empty": summ.get("empty"),
                    "empty_domains": [g["domain"] for g in data.get("gaps", [])
                                      if g.get("status") == "empty"],
                }
                hist = os.path.join(os.path.dirname(here), "<<MACHINE_1_ID>>", "state",
                                    "calibration-coverage-history.jsonl")
                os.makedirs(os.path.dirname(hist), exist_ok=True)
                with open(hist, "a", encoding="utf-8") as f:
                    f.write(json.dumps(snap) + "\n")
                print(f"[self-review] calibration-coverage: {snap['stances']} stances "
                      f"({snap['covered']} covered / {snap['thin']} thin / {snap['empty']} empty)")
        except Exception as e:  # noqa: BLE001 — never let the coverage snapshot sink the review
            sys.stderr.write(f"[self-review] calibration-coverage skipped ({e}).\n")


if __name__ == "__main__":
    main()
