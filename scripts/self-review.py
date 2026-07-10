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

import argparse, json, os, glob, re, subprocess, sys, datetime, hashlib
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from network import JARRY_IP  # canonical, env-overridable (scripts/lib/network.py)

HOME = os.path.expanduser("~")
REPO = os.environ.get("REPO_ROOT") or os.environ.get("METIS_HOME") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_TRANSCRIPTS = os.path.join(HOME, ".claude", "projects")
JARRY_MIRROR = os.path.join(HOME, ".claude", "projects-<<MACHINE_2_ID>>")
JARRY_SSH = f"<<MACHINE_2_USER>>@{JARRY_IP}"
JARRY_KEY = os.path.join(HOME, ".ssh", "jarry_access")
DIGEST_DIR = os.path.join(REPO, "workspace", "state", "self-review")
LEDGER = os.path.join(DIGEST_DIR, "ledger.json")
BOARD = os.path.join(REPO, "workspace", "state", "OPEN_TASKS.md")
GOV_CLI = os.path.join(REPO, "scripts", "update-tier1-state.py")
MAX_CANDIDATES = 50
MAX_PROMOTE = 3  # cap new governed tasks per run (avoid flooding)
ROUTING_LINE_THRESHOLD = 12
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
                if tu["name"] in ("Write", "Edit") and not saw_lane_call:
                    n = lines_in_edit(tu)
                    if n >= ROUTING_LINE_THRESHOLD:
                        cands.append(
                            {
                                "session": label,
                                "machine": machine,
                                "category": "routing_miss",
                                "ts": turn["ts"],
                                "user": "(no user turn — structural)",
                                "context": f"{tu['name']} {tu['input'].get('file_path', '')} — {n} lines inline, no <<MACHINE_1_ID>>-lane call in session",
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
                "180",
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


def run_scout(candidates, lane):
    payload = [
        f'[{i}] cat={c["category"]} machine={c["machine"]} | user="{c["user"]}" | ctx={c["context"]}'
        for i, c in enumerate(candidates)
    ]
    return call_lane(lane, SCOUT_PROMPT + "\n".join(payload))


def run_shield(patterns, lane):
    if not patterns:
        return None
    payload = [
        f'[{i}] title="{p.get("title", "")}" | proposed_fix="{p.get("fix", "")}" | evidence="{p.get("evidence", "")}"'
        for i, p in enumerate(patterns)
    ]
    return call_lane(lane, SHIELD_PROMPT.replace("{ctx}", SYSTEM_CONTEXT) + "\n".join(payload))


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
    patch = {
        "taskId": task_id,
        "title": title[:80],
        "priority": priority,
        "state": "queued",
        "owner": owner or "claude",
        "summary": summary[:300],
        "currentStep": "Proposed by weekly self-review; awaiting triage/execution.",
        "expectedArtifact": fix[:300],
        "verificationMethod": (
            vmethod or "Confirm the recurring signal drops in a later self-review run."
        )[:300],
        "blockerOrNone": "none",
        "nextAction": fix[:300],
        "mainFiles": [],
        "nextDecisionPoint": None,
    }
    try:
        r = subprocess.run(
            [
                "python3",
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
            return False
        return True
    except Exception as e:
        sys.stderr.write(f"[self-review] create-task {task_id} error ({e}).\n")
        return False


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
            persist = f" ⚠️persists×{f['occurrences']}" if f.get("occurrences", 1) > 1 else ""
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
            tag = {"approve": "✅ approved", "revise": "✏️ revised", "reject": "❌ rejected"}.get(
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
    L.append("## Confirmed misses (sample)")
    for c, v in real[:12]:
        L.append(
            f"- [{v.get('category', '')}] ({c['machine']}) {c['user'][:110]}  \n  ↳ _{v.get('lesson', '')}_"
        )
    open(path, "w").write("\n".join(L))
    return path


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument(
        "--latest", action="store_true", help="session mode: only the most-recent transcript"
    )
    ap.add_argument("--lane", default="scout")
    ap.add_argument("--verify-lane", default="warden")
    ap.add_argument("--no-pull", action="store_true")
    ap.add_argument("--no-promote", action="store_true")
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
        scout = None if (args.no_llm or not deduped) else run_scout(deduped, args.lane)
        led = load_ledger()
        if not args.dry_run:
            led["weekly_signals"].setdefault(date_str, {})
            for k, v in cat_counts.items():
                led["weekly_signals"][date_str][k] = led["weekly_signals"][date_str].get(k, 0) + v
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
    warden = None if (args.no_llm or not patterns) else run_shield(patterns, args.verify_lane)

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
                        f"✅ '{f['title']}' — `{cat}` dropped {before}→0 since fix shipped (effective)."
                    )
                elif before and after >= before:
                    effectiveness.append(
                        f"⚠️ '{f['title']}' — `{cat}` still {after} (was {before}); fix not yet effective — task bumped."
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
                ok = create_governed_task(
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
                    "taskId": tid if ok else None,
                    "status": "promoted" if ok else "proposed",
                    "first_seen": date_str,
                    "last_seen": date_str,
                    "occurrences": 1,
                    "history": [
                        {
                            "date": date_str,
                            "note": "promoted to governed task" if ok else "promotion failed",
                        }
                    ],
                }
                if ok:
                    promoted.append((tid, p.get("title", "")))
                    new_count += 1

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


if __name__ == "__main__":
    main()
