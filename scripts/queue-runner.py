#!/usr/bin/env python3
"""
Autonomous queue runner — dispatches Agent:smith/scout tasks from task-queue.md.
Runs on antfox (<<MACHINE_1_ID>>) via LaunchAgent every 30 min, 06:00-22:00 PT.

Design: docs/process/queue-runner-pattern.md + cron-checkpoint-runner.md
"""

import argparse
import os
import re
import sys
import json
import time
import subprocess
import datetime
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "lib"))
from dispatch_policy import resolve_default_engine

REPO = Path(__file__).resolve().parents[1]
TASK_QUEUE = REPO / "docs/process/task-queue.md"
TASKS_JSON = REPO / "docs/process/state/tasks.json"
LANE_OUTPUTS = REPO / "docs/process/lane-outputs"
GIT_LOCK = REPO / "scripts/git-lock.sh"
JAY_WORKSPACE = REPO / "<<MACHINE_1_ID>>"

# Canonical lane roles are a core convention (see CLAUDE.md agent routing).
DISPATCHABLE_AGENTS = {"smith", "scout", "scribe"}
SHIELD_REVIEW_AGENTS = {"smith"}  # only code-generating lanes get warden review
CURATOR_AGENTS = {"smith", "scout", "steward", "scribe"}  # all lane outputs get curated
ECHO_WRITE_AGENTS = {"scribe"}  # compose-mode lanes: produce file content only
# Which machines auto-run dispatch is org topology -> config/infrastructure.json.
import sys as _sys  # noqa: E402
_sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import infra_config as _infra  # noqa: E402

DISPATCHABLE_MACHINES = _infra.dispatchable_machines()
CURATOR_MAX_RETRIES = 2  # max re-dispatches on "iterate" verdict
LANE_SESSION_BLOAT_THRESHOLD = 20_000  # tokens — mirrors jlane's SESSION_BLOAT_THRESHOLD

# ── Parsing ──────────────────────────────────────────────────────────────────


def parse_tasks(text):
    """Parse task-queue.md into a list of task dicts."""
    tasks = []
    blocks = re.split(r"(?=^- \*\*)", text, flags=re.MULTILINE)
    for block in blocks:
        if not block.strip() or not block.startswith("- **"):
            continue
        task = {"raw_block": block}
        title_m = re.match(r"- \*\*(.+?)\*\*", block)
        if not title_m:
            continue
        task["title"] = title_m.group(1)

        # Single-line format: Priority: P2 · Agent: smith · Machine: antfox · Status: queued
        inline_m = re.search(
            r"Priority:\s*(\w+)\s*[·•]\s*Agent:\s*(\w+)\s*[·•]\s*Machine:\s*(\w+)\s*[·•]\s*Status:\s*([\w-]+)",
            block,
        )
        if inline_m:
            task["priority"] = inline_m.group(1)
            task["agent"] = inline_m.group(2).lower()
            task["machine"] = inline_m.group(3).lower()
            task["status"] = inline_m.group(4).lower()
        else:
            # Pipe-tag format: type:doc | area:openclaw | priority:P3 | agent:scout | machine:antfox | status:queued
            tag_line = re.search(r"type:\w+\s*\|[^\n]+", block)
            if tag_line:
                tl = tag_line.group(0)
                for field in ("agent", "machine", "status", "priority"):
                    m = re.search(rf"\b{field}:([\w-]+)", tl, re.IGNORECASE)
                    if m:
                        task[field] = m.group(1).lower()
            else:
                # Multi-line format
                for field in ("agent", "machine", "status", "priority"):
                    m = re.search(rf"- {field.capitalize()}:\s*([\w-]+)", block, re.IGNORECASE)
                    if m:
                        task[field] = m.group(1).lower()

        # Summary — first sub-bullet after fields that doesn't look like a field line
        summary_m = re.search(
            r"- Summary:\s*(.+?)(?=\n\s*-\s+\w|\Z)", block, re.DOTALL | re.IGNORECASE
        )
        if summary_m:
            task["summary"] = summary_m.group(1).strip()
        else:
            # Fall back: collect non-field sub-bullets
            body_lines = [
                ln.strip().lstrip("- ")
                for ln in block.splitlines()[1:]
                if ln.strip().startswith("-")
                and not re.match(
                    r"\s*-\s+(Priority|Agent|Machine|Status|Next action|Note):", ln, re.IGNORECASE
                )
            ]
            task["summary"] = " ".join(body_lines)[:400] or task["title"]

        tasks.append(task)
    return tasks


PRIORITY_ORDER = {"p1": 1, "p2": 2, "p3": 3}


def is_eligible(task, all_tasks=None):
    if not (
        task.get("agent") in DISPATCHABLE_AGENTS
        and task.get("machine") in DISPATCHABLE_MACHINES
        and task.get("status") == "queued"
    ):
        return False
    if all_tasks:
        # Parse @blocked-by:#NNN tags from the raw block
        blockers = re.findall(r"@blocked-by:#(\w+)", task.get("raw_block", ""))
        if blockers:
            # Build id→task map by extracting #NNN from titles
            task_by_id = {}
            for t in all_tasks:
                m = re.search(r"#(\w+)", t.get("title", ""))
                if m:
                    task_by_id[m.group(1)] = t
            for blocker_id in blockers:
                blocker = task_by_id.get(blocker_id)
                if blocker and blocker.get("status") not in ("done", "ready-to-apply"):
                    print(
                        f"[queue-runner] Skipping '{task['title']}' — blocked by #{blocker_id} ({blocker.get('status', 'unknown')})"
                    )
                    return False
    return True


# ── Ollama warm-check ─────────────────────────────────────────────────────────


def ollama_warm_check(warm_timeout_s=120):
    """Ensure qwen3-coder:30b is loaded before dispatching. Returns True if ready."""
    try:
        with urllib.request.urlopen("http://localhost:11434/api/ps", timeout=5) as resp:
            data = json.loads(resp.read())
        if any("qwen3-coder" in m.get("name", "") for m in data.get("models", [])):
            print("[queue-runner] Ollama: warm")
            return True
        # Cold — send a minimal generate to trigger model load
        print(f"[queue-runner] Ollama cold — warming qwen3-coder:30b (up to {warm_timeout_s}s)...")
        payload = json.dumps({
            "model": "qwen3-coder:30b", "prompt": "ping", "stream": False
        }).encode()
        req = urllib.request.Request(
            "http://localhost:11434/api/generate",
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=warm_timeout_s) as resp:
            resp.read()
        print("[queue-runner] Ollama: warm (after load)")
        return True
    except Exception as e:
        print(f"[queue-runner] Ollama warm-check failed: {e}")
        return False


# ── Status updates ────────────────────────────────────────────────────────────


def _update_status_in_text(text, task_title, old_status, new_status, extra_note=""):
    idx = text.find(f"**{task_title}**")
    if idx == -1:
        return None
    next_task = text.find("\n- **", idx + 1)
    block = text[idx:next_task] if next_task != -1 else text[idx:]

    # Match both capitalised "Status: foo" and pipe-tag "status:foo" formats
    new_block = re.sub(
        rf"\bstatus:\s*{re.escape(old_status)}\b",
        f"status:{new_status}",
        block,
        flags=re.IGNORECASE,
    )
    if extra_note:
        new_block = new_block.rstrip() + f"\n  - Note: {extra_note}\n"

    return text[:idx] + new_block + (text[next_task:] if next_task != -1 else "")


def update_task_status(task_title, old_status, new_status, extra_note=""):
    """Atomically rewrite task-queue.md status under the git lock."""
    text = TASK_QUEUE.read_text()
    new_text = _update_status_in_text(text, task_title, old_status, new_status, extra_note)
    if new_text is None:
        print(f"[queue-runner] WARN: could not find task '{task_title}' in task-queue.md")
        return False

    pid = os.getpid()
    content_file = f"/tmp/queue-runner-content-{pid}.txt"
    write_script = f"/tmp/queue-runner-write-{pid}.sh"

    Path(content_file).write_text(new_text)
    Path(write_script).write_text(f"#!/usr/bin/env bash\ncp '{content_file}' '{TASK_QUEUE}'\n")
    os.chmod(write_script, 0o755)

    try:
        result = subprocess.run(
            [str(GIT_LOCK), "run", write_script], capture_output=True, text=True, timeout=30
        )
        return result.returncode == 0
    finally:
        for f in (content_file, write_script):
            try:
                os.unlink(f)
            except FileNotFoundError:
                pass


# ── Dispatch ──────────────────────────────────────────────────────────────────


TIMEOUT_STRINGS = ("LLM request timed out", "request timed out", "timed out")

# Patterns that indicate the lane itself failed (tool unavailable, exec errors, etc.)
# These pass dispatch_lane's success check but are not real output — don't run arbiter on them.
INFRA_FAIL_STRINGS = (
    "I can't use the tool",
    "I cannot use the tool",
    "tool isn't available",
    "tool is not available",
    "tools are not available",
    "unable to use tools",
)

# Block notes written when a task is parked due to transient infra failure.
# Recovery sweep matches these to distinguish transient from genuine logic failures.
TRANSIENT_BLOCK_PATTERNS = (
    "Lane failed 2x on",    # double dispatch failure (Ollama cold start / session takeover)
    "Infra failure on",     # detect_infra_fail hit — lane returned "can't use tools"
    "Ready check failed on",  # task-ready.sh returned blocked (service down, prereq not met)
)
MAX_TRANSIENT_RETRIES = 3


def detect_infra_fail(text):
    """Return the first matching infra-fail pattern found in text, or None if clean."""
    t = text.lower()
    for s in INFRA_FAIL_STRINGS:
        if s.lower() in t:
            return s
    return None


def _recover_parked_tasks():
    """Reopen transient-blocked / infra-failed tasks to queued with date-based backoff.

    Only recovers tasks where the block note matches a known transient pattern (Ollama
    cold-start, LLM idle timeout, session takeover, tool unavailability). Tasks parked
    by genuine logic failures (arbiter-rejected, dep-blocked, explicit human note) are
    left untouched.

    Backoff rule: same-day failures stay parked (gives Ollama time to stabilise before
    the next 30-min run). A retry counter embedded in the Note line caps recovery at
    MAX_TRANSIENT_RETRIES — after that the task stays parked permanently.

    Returns the count of tasks reopened.
    """
    today = datetime.date.today().isoformat()
    tasks = parse_tasks(TASK_QUEUE.read_text())
    recovered = 0

    for task in tasks:
        status = task.get("status", "")
        if status not in ("blocked", "infra-failed"):
            continue

        raw = task.get("raw_block", "")
        is_transient = any(p.lower() in raw.lower() for p in TRANSIENT_BLOCK_PATTERNS)
        if not is_transient:
            continue

        # Backoff: same-day blocks stay parked — let the infra stabilise first.
        if f"on {today}" in raw:
            continue

        # Parse existing retry count from any prior recovery note.
        retry_m = re.search(r"\(retry (\d+)/\d+\)", raw)
        retry_count = int(retry_m.group(1)) if retry_m else 0
        if retry_count >= MAX_TRANSIENT_RETRIES:
            print(
                f"[queue-runner] Leaving '{task['title']}' parked — "
                f"exhausted {MAX_TRANSIENT_RETRIES} transient retries"
            )
            continue

        new_retry = retry_count + 1
        note = (
            f"Recovered from transient {status} "
            f"(retry {new_retry}/{MAX_TRANSIENT_RETRIES}) on {today}"
        )
        if update_task_status(task["title"], status, "queued", note):
            print(
                f"[queue-runner] Recovered '{task['title']}' from {status} "
                f"(retry {new_retry}/{MAX_TRANSIENT_RETRIES})"
            )
            recovered += 1

    if recovered:
        print(f"[queue-runner] Recovery sweep: reopened {recovered} parked task(s)")
    return recovered


def _crash_recovery_sweep():
    """Self-heal crash-orphaned governed state before picking work (#283).

    Runs reconcile.py --fix --apply: releases stale/duplicate leases (I1/I2)
    and requeues in_progress tasks whose session died leaving no live lease
    (I5, with grace window + two-strike + retry cap — see reconcile.py).
    A sweep failure must never block the queue run; it only logs."""
    try:
        proc = subprocess.run(
            [sys.executable, str(REPO / "scripts/reconcile.py"), "--fix", "--apply", "--json"],
            capture_output=True, text=True, timeout=120,
        )
        results = json.loads(proc.stdout or "{}").get("actions", [])
        for r in results:
            target = r.get("claimId") if r.get("action") == "release-lease" else r.get("taskId")
            tag = "recovered" if r.get("applied") else "RECOVERY-FAILED"
            print(f"[queue-runner] crash-recovery: {tag} {r.get('inv')} {r.get('action')} "
                  f"{target} '{r.get('label')}'" + ("" if r.get("applied") else f" — {r.get('error')}"))
    except Exception as e:
        print(f"[queue-runner] WARN: crash-recovery sweep failed: {e}")


def _cleanup_dispatch_session(agent: str, session_key: str) -> None:
    """Remove the ephemeral qr-* session files left by a completed dispatch."""
    sessions_path = Path.home() / ".openclaw" / "agents" / agent / "sessions" / "sessions.json"
    if not sessions_path.exists():
        return
    try:
        data = json.loads(sessions_path.read_text())
        key = f"agent:{agent}:{session_key}"
        entry = data.pop(key, None)
        if entry is None:
            return
        # Remove the session transcript files so they don't accumulate on disk.
        sessions_dir = sessions_path.parent
        sid = entry.get("sessionId", "")
        if sid:
            for ext in [".jsonl", ".trajectory.jsonl", ".trajectory-path.json"]:
                p = sessions_dir / f"{sid}{ext}"
                if p.exists():
                    p.unlink(missing_ok=True)
        sessions_path.write_text(json.dumps(data, indent=2))
    except Exception as e:
        print(f"[queue-runner] WARN: session cleanup failed for {session_key}: {e}")


def _sweep_stale_qr_sessions(lanes, max_age_hours=6):
    """Remove leftover qr-* sessions from prior runs that were hard-killed before
    _cleanup_dispatch_session could fire (launchd stop / crash mid-dispatch). These
    leak permanently otherwise — lane-health's idle guard protects named sessions,
    but qr-* are ephemeral by definition (#180 follow-up)."""
    current_time_ms = int(time.time() * 1000)
    max_age_ms = max_age_hours * 60 * 60 * 1000
    for lane in lanes:
        try:
            sessions_path = Path.home() / ".openclaw" / "agents" / lane / "sessions" / "sessions.json"
            if not sessions_path.exists():
                continue
            try:
                data = json.loads(sessions_path.read_text())
            except Exception:
                print(f"[queue-runner] WARN: failed to parse sessions.json for lane {lane}")
                continue
            sessions_dir = sessions_path.parent
            stale = []
            for key, entry in data.items():
                if not key.startswith(f"agent:{lane}:qr-"):
                    continue
                updated_at = entry.get("updatedAt")
                if updated_at is None or (current_time_ms - updated_at) > max_age_ms:
                    stale.append(key)
                    sid = entry.get("sessionId", "")
                    if sid:
                        for ext in [".jsonl", ".trajectory.jsonl", ".trajectory-path.json"]:
                            (sessions_dir / f"{sid}{ext}").unlink(missing_ok=True)
                    print(f"[queue-runner] swept stale session {key}")
            for key in stale:
                data.pop(key)
            if stale:
                sessions_path.write_text(json.dumps(data, indent=2))
        except Exception as e:
            print(f"[queue-runner] WARN: failed to sweep stale sessions for lane {lane}: {e}")


def _policy_hints(agent, task=None):
    if agent == "smith":
        return "implementation", "proposal-only"
    if agent == "warden":
        return "review", "read-only"
    if agent == "arbiter":
        return "quality", "read-only"
    if agent == "scribe":
        return "docs", "proposal-only"
    return "research", "read-only"


def _local_failure_count(task):
    raw = (task or {}).get("raw_block", "")
    notes = re.findall(r"local[- ]failures?[:=](\d+)", raw, re.I)
    if notes:
        return max(int(n) for n in notes)
    signals = (
        len(re.findall(r"Infra failure on", raw, re.I))
        + len(re.findall(r"Lane failed 2x on", raw, re.I))
        + len(re.findall(r"arbiter=(?:reject|iterate)", raw, re.I))
        + len(re.findall(r"verdict:\s*\*\*(?:reject|iterate)", raw, re.I))
    )
    return signals


def dispatch_lane(agent, message, timeout=480, task=None, preview=False, local_failures=None):
    """Call a lane through scripts/dispatch. Returns (success: bool, output: str)."""
    work_type, mutation = _policy_hints(agent, task)
    failures = _local_failure_count(task) if local_failures is None else local_failures
    cmd = [
        str(REPO / "scripts" / "dispatch"),
        "--agent", agent,
        "--message", message,
        "--timeout", str(timeout),
        "--work-type", work_type,
        "--mutation", mutation,
        "--local-failures", str(max(0, failures)),
    ]
    if preview:
        cmd.append("--preview")
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 60)
        if result.returncode != 0:
            return False, (result.stderr or result.stdout).strip()
        text = result.stdout.strip()
        # openclaw exits 0 even on LLM timeout — detect and treat as failure so retry fires
        if any(s.lower() in text.lower() for s in TIMEOUT_STRINGS):
            return False, text
        return True, text
    except subprocess.TimeoutExpired:
        return False, "openclaw call timed out"
    except Exception as e:
        return False, str(e)


# ── Output saving ─────────────────────────────────────────────────────────────


def slugify(title):
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:50]


def shield_review(task, forge_output):
    """Run warden over smith output. Returns review text or None on failure."""
    prompt = (
        f"Task: {task['title']}\n\nSummary: {task.get('summary', '')}\n\n"
        f"Smith produced the following output. Review it for correctness, security issues, "
        f"and completeness. Be concise — flag real problems only, not style nits.\n\n"
        f"--- FORGE OUTPUT ---\n{forge_output}\n--- END ---"
    )
    success, review = dispatch_lane("warden", prompt, timeout=480)
    if not success:
        print(f"[queue-runner] Warden review failed: {review[:100]}")
        return None
    return review


ECHO_INSTRUCTIONS = (
    "You are Scribe, a compose-mode lane. Output ONLY the requested artifact body — "
    "no preamble, no 'I have composed', no closing remarks, no markdown fences. "
    "First word of your response is the first word of the artifact. "
    "A Claude Code session will apply your output to the repo."
)

CURATOR_INSTRUCTIONS = """You are an automated quality gate. Evaluate the lane output below and respond with ONLY a valid JSON object — no preamble, no markdown fences, no explanation. First character must be '{', last must be '}'.

Required JSON schema:
{
  "verdict": "approve" | "iterate" | "reject",
  "confidence": <float 0.0-1.0>,
  "is_artifact": true | false,
  "issues": [<string>, ...],
  "hallucination_flags": [<string>, ...],
  "prereq_check": "pass" | "fail" | "partial" | "n/a",
  "prereq_note": <string>,
  "safety_flags": [<string>, ...],
  "iterate_prompt": <string>
}

Artifact check (CRITICAL — evaluate this first):
An artifact is applyable work: actual code, a concrete shell command sequence, a file diff/patch, or a complete file body ready to write. A PLAN is a description of what to do — numbered steps saying "1. Add X, 2. Replace Y with Z" without providing the actual code. Plans are NOT artifacts.
- is_artifact=true if the output IS actual code/commands/diff/file-body that can be applied directly.
- is_artifact=false if the output DESCRIBES what changes to make rather than providing them.
- For smith/scribe outputs: if is_artifact=false, verdict MUST be "iterate" (confidence capped at 0.5) with iterate_prompt asking the lane to return the actual implementation, not a description of it.
- For scout/steward outputs: is_artifact=false is acceptable (analysis and plans are their deliverable); set is_artifact=false but do not penalise verdict for it.

Rules:
- verdict=approve if output is correct, complete, no safety issues, prereq satisfied, confidence >= 0.75, AND is_artifact=true (for smith/scribe lanes)
- verdict=iterate if fixable problems exist or confidence < 0.75 (populate iterate_prompt with specific fix instructions)
- verdict=reject if dangerous (safety_flags non-empty), completely wrong, or confidence < 0.3
- issues: list every concrete problem found
- hallucination_flags: list specific file paths, unusual package names, unverifiable API endpoints, version numbers that need filesystem/external verification. Leave empty for standard libraries.
- safety_flags: dangerous ops only (rm -rf, DROP TABLE, git push --force, credential exposure). Leave empty if none.
- iterate_prompt: only if verdict=iterate — specific actionable fix instructions for the lane

Per-lane checks:
- smith: is_artifact? prereq satisfied? real imports? plausible file paths? real function APIs? warden issues? safety ops?
- scout: addresses the question? no contradictions? actionable? flag specific version/endpoint claims
- steward: valid agents (smith/scout/warden/scribe/steward/main)? valid machines (antfox/jarry/either)? no circular deps?
- scribe: starts directly with file content (e.g. '# Daily Log')? If starts with 'I have...', 'Here is...' → iterate"""


def curator_check(task, output, shield_review_text=None):
    """
    Run arbiter over lane output. Returns parsed verdict dict or None on failure.
    Verdict keys: verdict, confidence, issues, hallucination_flags, prereq_check,
                  prereq_note, safety_flags, iterate_prompt
    """
    shield_section = ""
    if shield_review_text:
        shield_section = f"\n\n--- SHIELD REVIEW ---\n{shield_review_text}\n--- END SHIELD ---"

    prompt = (
        f"{CURATOR_INSTRUCTIONS}\n\n"
        f"Task title: {task['title']}\n"
        f"Task summary: {task.get('summary', '')}\n"
        f"Lane: {task.get('agent', 'unknown')}\n\n"
        f"--- LANE OUTPUT ---\n{output}\n--- END OUTPUT ---"
        f"{shield_section}\n\n"
        f"RESPOND NOW WITH THE JSON OBJECT ONLY:"
    )
    success, raw = dispatch_lane("arbiter", prompt, timeout=480)
    if not success:
        print(f"[queue-runner] Arbiter failed: {raw[:100]}")
        return None

    # Extract JSON — arbiter may still wrap in markdown fences despite instructions
    json_str = raw.strip()
    if json_str.startswith("```"):
        json_str = re.sub(r"^```[a-z]*\n?", "", json_str)
        json_str = re.sub(r"\n?```$", "", json_str.strip())
    brace = json_str.find("{")
    if brace > 0:
        json_str = json_str[brace:]

    try:
        verdict = json.loads(json_str)
    except json.JSONDecodeError as e:
        print(f"[queue-runner] Arbiter returned invalid JSON: {e} — raw: {raw[:200]}")
        return None

    return verdict


def verify_hallucination_flags(flags):
    """
    Check hallucination_flags that look like file paths against the filesystem.
    Returns list of flags that failed verification (file not found).
    """
    failed = []
    for flag in flags:
        # Only check things that look like relative file paths
        if re.match(r"^[\w./\-]+\.(py|sh|md|json|yaml|yml|js|ts|html|css)$", flag.strip()):
            candidate = REPO / flag.strip()
            if not candidate.exists():
                failed.append(flag.strip())
    return failed


def _task_id_from_title(title: str) -> str | None:
    m = re.search(r"#(\d+)", title or "")
    return f"#{m.group(1)}" if m else None


def _governed_task_for_queue_task(task):
    try:
        data = json.loads(TASKS_JSON.read_text())
    except Exception:
        return None
    title = task.get("title", "")
    tid = _task_id_from_title(title)
    for governed in data.get("tasks", []):
        if tid and governed.get("taskId") == tid:
            return governed
        if governed.get("title") == title:
            return governed
    return None


def build_queue_runner_message(task, prior_output=None):
    """Build bounded task context; scripts/dispatch wraps this in a mission packet."""
    governed = _governed_task_for_queue_task(task) or {}
    fields = [
        f"Workspace: {JAY_WORKSPACE}",
        f"Queue task: {task.get('title', '')}",
        f"Summary: {governed.get('summary') or task.get('summary', '')}",
        f"Why: {governed.get('why', '')}",
        f"How: {governed.get('how', '')}",
        f"Current step: {governed.get('currentStep') or governed.get('firstStep') or ''}",
        f"Next action: {governed.get('nextAction', '')}",
        f"Expected artifact: {governed.get('expectedArtifact', '')}",
        f"Verification: {governed.get('verificationMethod', '')}",
    ]
    files = governed.get("mainFiles") or []
    if files:
        fields.append("Known files: " + ", ".join(files))
    if prior_output:
        fields.append("Prior output / retry context:\n" + prior_output)
    if task.get("agent") in ECHO_WRITE_AGENTS:
        fields.insert(0, ECHO_INSTRUCTIONS)
    else:
        fields.extend([
            "IMPORTANT: Return plain text output only.",
            "Do NOT call file-writing tools. Do NOT claim files were edited, saved, tested, or committed.",
            "For implementation work, return draft output for a tool-bearing applier to apply and verify.",
        ])
    return "\n\n".join(str(f) for f in fields if f)


def print_dispatch_preview(task):
    agent = task["agent"]
    message = build_queue_runner_message(task)
    work_type, mutation = _policy_hints(agent, task)
    failures = _local_failure_count(task)
    decision = resolve_default_engine(agent, message, work_type=work_type, mutation=mutation, local_failures=failures)
    print(
        f"[queue-runner:dry-run] {task['title']} -> {agent} "
        f"engine={decision.engine} work={decision.work_type} mutation={decision.mutation} "
        f"risk={decision.risk} approval={decision.requires_approval} local_failures={failures}"
    )
    ok, preview = dispatch_lane(agent, message, task=task, preview=True, local_failures=failures)
    print(preview)
    return ok


def _sync_governed_state(task, verdict):
    """After a terminal arbiter verdict, update tasks.json so free-work.py reflects done/rejected
    without waiting for manual session cleanup. Non-fatal — a failure just leaves the old state."""
    title = task.get("title", "")
    m = re.match(r"#(\d+)", title)
    if not m:
        return  # no governed taskId in title; projection-only entry, nothing to update
    task_id = f"#{m.group(1)}"
    to_state = "done" if verdict == "approve" else "rejected"
    try:
        data = json.loads(TASKS_JSON.read_text())
        governed = next((t for t in data.get("tasks", []) if t.get("taskId") == task_id), None)
        if not governed:
            return  # task not in governed store
        revision = governed.get("revision", 1)
        subprocess.run(
            [
                sys.executable,
                str(REPO / "scripts" / "update-tier1-state.py"),
                "correct-state",
                "--task-id", task_id,
                "--expected-revision", str(revision),
                "--actor", "queue-runner",
                "--to-state", to_state,
                "--reason", f"auto: arbiter verdict={verdict} ({datetime.date.today().isoformat()})",
            ],
            capture_output=True,
            timeout=10,
        )
        print(f"[queue-runner] governed state {task_id} → {to_state}")
    except Exception as e:
        print(f"[queue-runner] WARN: governed state sync failed for {task_id}: {e}")


def _lane_metrics(task, final_status, arbiter=None, infra_fail_reason=None):
    agent = task.get("agent", "unknown")
    message = build_queue_runner_message(task)
    work_type, mutation = _policy_hints(agent, task)
    failures = _local_failure_count(task)
    decision = resolve_default_engine(agent, message, work_type=work_type, mutation=mutation, local_failures=failures)
    verdict = arbiter.get("verdict") if arbiter else None
    return {
        "role": agent,
        "selected_engine": decision.engine,
        "route_reason": decision.reason,
        "work_type": decision.work_type,
        "risk": decision.risk,
        "mutation": decision.mutation,
        "requires_approval": decision.requires_approval,
        "local_failures": failures,
        "curator_verdict": verdict,
        "curator_confidence": arbiter.get("confidence") if arbiter else None,
        "artifact_kind": "lane-output",
        "final_status": final_status,
        "applied": final_status == "ready-to-apply",
        "used": final_status in {"ready-to-apply", "needs-review"},
        "discarded_reason": infra_fail_reason or ("arbiter rejected" if verdict == "reject" else None),
        "escalation_count": failures,
    }


def save_output(task, content, warden=None, arbiter=None, infra_fail_reason=None):
    LANE_OUTPUTS.mkdir(parents=True, exist_ok=True)
    date = datetime.date.today().isoformat()
    path = LANE_OUTPUTS / f"{date}-{slugify(task['title'])}.md"

    if infra_fail_reason:
        final_status = "infra-failed"
    elif arbiter:
        final_status = "ready-to-apply" if arbiter.get("verdict") == "approve" else "rejected"
    else:
        final_status = "needs-review"
    metrics = _lane_metrics(task, final_status, arbiter=arbiter, infra_fail_reason=infra_fail_reason)

    body = (
        f"# {task['title']}\n\n"
        f"Date: {date}  \nAgent: {task.get('agent')}  \nStatus: {final_status}\n\n"
        f"---\n\n## Lane Metrics\n\n```json\n{json.dumps(metrics, indent=2, ensure_ascii=False)}\n```\n\n"
        f"---\n\n## Output\n\n{content}\n"
    )
    if warden:
        body += f"\n---\n\n## Warden Review\n\n{warden}\n"
    if infra_fail_reason:
        body += (
            f"\n---\n\n## Infrastructure Failure\n\n"
            f"The lane returned an infrastructure error rather than task output.\n\n"
            f"> Matched pattern: `{infra_fail_reason}`\n"
        )
    elif arbiter:
        verdict = arbiter.get("verdict", "unknown")
        confidence = arbiter.get("confidence", 0.0)
        issues = "\n".join(f"- {i}" for i in arbiter.get("issues", [])) or "none"
        flags = "\n".join(f"- {f}" for f in arbiter.get("hallucination_flags", [])) or "none"
        is_artifact = arbiter.get("is_artifact")
        artifact_str = (
            "yes" if is_artifact is True else
            "no (plan/description — not directly applyable)" if is_artifact is False else
            "unknown"
        )
        body += (
            f"\n---\n\n## Arbiter Verdict\n\n"
            f"Verdict: **{verdict}**  Confidence: {confidence:.2f}  Artifact: {artifact_str}\n\n"
            f"Prereq: {arbiter.get('prereq_check', 'n/a')} — {arbiter.get('prereq_note', '')}\n\n"
            f"Issues:\n{issues}\n\n"
            f"Hallucination flags:\n{flags}\n"
        )
        if arbiter.get("safety_flags"):
            safety = "\n".join(f"- {s}" for s in arbiter["safety_flags"])
            body += f"\nSafety flags:\n{safety}\n"
    path.write_text(body)

    # Discord notification — fire-and-forget, never raises
    try:
        import importlib.util as _ilu
        _spec = _ilu.spec_from_file_location(
            "discord_notify", Path(__file__).parent / "discord_notify.py"
        )
        _dn = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_dn)
        _dn.notify_task_complete(
            task_title=task.get("title", "unknown"),
            agent=task.get("agent", "unknown"),
            curator_verdict=arbiter.get("verdict") if arbiter else None,
            confidence=arbiter.get("confidence") if arbiter else None,
            output_path=str(path),
            status=final_status,
        )
        # Post approval prompt — into task thread if one exists, else flat #subagent-threads
        thread_id = task.get("_discord_thread_id")
        if thread_id:
            _emoji = {"ready-to-apply": "✅", "rejected": "❌",
                      "needs-review": "⚠️", "infra-failed": "🔥"}.get(final_status, "❓")
            _curator_str = ""
            if arbiter:
                _curator_str = (
                    f"\nCurator: **{arbiter.get('verdict','?')}** "
                    f"({arbiter.get('confidence', 0.0):.2f})"
                )
            _dn.post_to_thread(
                thread_id,
                f"{_emoji} **{final_status}** | {task.get('title','unknown')}"
                f"{_curator_str}\nOutput: `{path.name}`\n\nReact 👍 to approve · 👎 to reject",
            )
        else:
            _dn.notify_task_thread(
                task_title=task.get("title", "unknown"),
                agent=task.get("agent", "unknown"),
                output_path=str(path),
                status=final_status,
            )
    except Exception:
        pass

    # Auto-update governed state on terminal arbiter verdicts — eliminates manual cleanup
    if arbiter and arbiter.get("verdict") in ("approve", "reject"):
        _sync_governed_state(task, arbiter["verdict"])

    return path, final_status


# ── Session bloat reset ───────────────────────────────────────────────────────


def _reset_bloated_sessions(lanes):
    """
    Reset main sessions over LANE_SESSION_BLOAT_THRESHOLD before dispatching.
    Mirrors jlane's pre-call guard so queue-runner doesn't leave accumulated
    context that causes cold-start timeouts for concurrent jlane callers.
    Direct dispatches in queue-runner use per-call --session-key UUIDs (isolated),
    but this clears any bloat left by other callers on the shared main sessions.
    """
    agents_dir = Path.home() / ".openclaw" / "agents"
    for lane in lanes:
        sessions_path = agents_dir / lane / "sessions" / "sessions.json"
        if not sessions_path.exists():
            continue
        try:
            data = json.loads(sessions_path.read_text())
            key = f"agent:{lane}:main"
            info = data.get(key, {})
            tokens = int(info.get("inputTokens") or 0)
            if tokens <= LANE_SESSION_BLOAT_THRESHOLD:
                continue
            # Archive session files, then evict from the index
            sessions_dir = sessions_path.parent
            session_id = info.get("sessionId", "")
            stamp = int(datetime.datetime.now().timestamp())
            for ext in [".jsonl", ".trajectory.jsonl", ".trajectory-path.json"]:
                src = sessions_dir / f"{session_id}{ext}"
                if src.exists():
                    src.replace(sessions_dir / f"{session_id}{ext}.archived-{stamp}")
            data.pop(key, None)
            sessions_path.write_text(json.dumps(data, indent=2))
            print(
                f"[queue-runner] Reset bloated {lane} session "
                f"({tokens:,} tokens > {LANE_SESSION_BLOAT_THRESHOLD:,})"
            )
        except Exception as e:
            print(f"[queue-runner] WARN: bloat reset failed for {lane}: {e}")


# ── Main ──────────────────────────────────────────────────────────────────────


def _load_free_work_module():
    """Load free-work.py by path (hyphenated name can't be imported normally)."""
    import importlib.util
    fw_path = Path(__file__).resolve().parent / "free-work.py"
    spec = importlib.util.spec_from_file_location("free_work", fw_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _pick_project_and_join(fw, queue_runner_session: str) -> str | None:
    """Pick the top active project from the board; write presence; return slug or None."""
    try:
        machine = fw.detect_machine(None)
        b = fw.build(machine)
        projects = fw.load_projects()
        presence = fw.load_presence()
        board = fw.build_project_board(b, projects, presence)
        # Top-ranked active project with free work
        for row in board:
            if row["status"] in ("active", "paused") and row["free"] > 0:
                slug = row["slug"]
                # Write presence (informational — never blocks any claim).
                import importlib.util as _ilu
                aw_path = Path(__file__).resolve().parent / "agent-work.py"
                spec = _ilu.spec_from_file_location("agent_work", aw_path)
                aw = _ilu.module_from_spec(spec)
                spec.loader.exec_module(aw)
                now = aw.utcnow()
                expires = now + __import__("datetime").timedelta(hours=4)
                state_path = aw.DEFAULT_STATE
                with aw.locked_state(state_path) as data:
                    if "presence" not in data:
                        data["presence"] = []
                    # Remove stale queue-runner presence records
                    data["presence"] = [
                        p for p in data["presence"]
                        if not (p.get("agent") == "queue-runner")
                    ]
                    data["presence"].append({
                        "session": queue_runner_session,
                        "agent": "queue-runner",
                        "machine": machine,
                        "project": slug,
                        "since": aw.iso(now),
                        "lastSeen": aw.iso(now),
                        "expiresAt": aw.iso(expires),
                    })
                print(f"[queue-runner] joined project '{slug}' (presence written, 4h TTL)")
                return slug
    except Exception as e:
        print(f"[queue-runner] project board unavailable ({e}), running globally")
    return None


def _tasks_json_project_map() -> dict[str, str]:
    """Return title → project mapping from tasks.json for project filtering."""
    try:
        with open(TASKS_JSON) as f:
            data = json.load(f)
        return {
            t.get("title", ""): t.get("project", "ops")
            for t in data.get("tasks", [])
        }
    except Exception:
        return {}


def run(dry_run=False, dry_run_limit=1):
    # Recovery sweep — reopen transient-blocked/infra-failed tasks before eligibility
    # check so they re-enter the pipeline on the next run after Ollama stabilises.
    if not dry_run:
        _recover_parked_tasks()

    # Crash-recovery sweep (#283): repair orphaned leases/in_progress tasks left
    # by crashed sessions or auto-sync re-roots before computing eligibility.
    if not dry_run:
        _crash_recovery_sweep()

    # Sweep qr-* sessions leaked by hard-killed prior runs (cleanup never fired).
    if not dry_run:
        _sweep_stale_qr_sessions(["smith", "scout", "warden", "scribe", "main", "steward", "arbiter"])

    # Re-parse after recovery so newly-reopened tasks enter the eligible set.
    text = TASK_QUEUE.read_text()
    tasks = parse_tasks(text)
    eligible = [t for t in tasks if is_eligible(t, all_tasks=tasks)]
    eligible.sort(key=lambda t: PRIORITY_ORDER.get(t.get("priority", "p3").lower(), 3))

    # Project-ranked selection: pick top project with free work, filter to it.
    queue_runner_session = f"queue-runner-{__import__('uuid').uuid4().hex[:8]}"
    if not dry_run:
        try:
            fw = _load_free_work_module()
            project_slug = _pick_project_and_join(fw, queue_runner_session)
            if project_slug and eligible:
                proj_map = _tasks_json_project_map()
                project_eligible = [
                    t for t in eligible
                    if proj_map.get(t.get("title", "")) == project_slug
                ]
                if project_eligible:
                    print(f"[queue-runner] project-scoped: {len(project_eligible)} task(s) in '{project_slug}'")
                    eligible = project_eligible
                else:
                    print(f"[queue-runner] project '{project_slug}' has no queue-runner eligible tasks — running globally")
        except Exception as e:
            print(f"[queue-runner] project selection failed ({e}), running globally")

    if not eligible:
        # Surface WHY the queue is dormant so callers can distinguish empty vs parked.
        n_blocked = sum(1 for t in tasks if t.get("status") == "blocked")
        n_infra = sum(1 for t in tasks if t.get("status") == "infra-failed")
        dispatchable = [
            t for t in tasks
            if t.get("agent") in DISPATCHABLE_AGENTS
            and t.get("machine") in DISPATCHABLE_MACHINES
        ]
        n_human = sum(
            1 for t in dispatchable
            if t.get("status") not in ("queued", "blocked", "infra-failed")
        )
        print(
            f"[queue-runner] No eligible tasks. "
            f"Parked: {n_blocked} blocked, {n_infra} infra-failed. "
            f"Human-gated or other non-dispatchable: {n_human}."
        )
        return

    print(f"[queue-runner] {len(eligible)} eligible task(s): {[t['title'] for t in eligible]}")

    if dry_run:
        for task in eligible[:max(1, dry_run_limit)]:
            print_dispatch_preview(task)
        print(f"[queue-runner:dry-run] previewed {min(len(eligible), max(1, dry_run_limit))} task(s); no status changes or lane execution.")
        return

    # Ensure Ollama is warm before any dispatch — cold start can exceed lane timeout
    if not ollama_warm_check():
        print("[queue-runner] Ollama not available — aborting this run.")
        return

    # Reset any bloated lane main sessions before dispatching
    _reset_bloated_sessions(DISPATCHABLE_AGENTS)

    for task in eligible:
        title = task["title"]
        agent = task["agent"]
        print(f"[queue-runner] → {title} ({agent})")

        # Pre-dispatch ready check — skip blocked tasks, warn on maybe-done
        try:
            ready = subprocess.run(
                ["bash", str(REPO / "scripts" / "task-ready.sh"), title],
                capture_output=True, timeout=20,
            )
            if ready.returncode == 1:
                # task-ready.sh signals blocked (prereq unmet, required service down, etc.)
                # Park the task as blocked so _recover_parked_tasks() can reopen it once
                # conditions improve — prevents the runner from hammering it every 30 min.
                reason = ready.stdout.decode().strip().split("\n")[-1]
                today = datetime.date.today().isoformat()
                park_note = f"Ready check failed on {today}: {reason}"
                if update_task_status(title, "queued", "blocked", park_note):
                    print(f"[queue-runner] PARKED '{title}': not ready — {reason}")
                else:
                    print(f"[queue-runner] SKIP '{title}': not ready (status update failed) — {reason}")
                continue
            if ready.returncode == 2:
                print(f"[queue-runner] WARN '{title}': may already be done — dispatching anyway")
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass  # ready check unavailable — proceed

        # Mark in-progress before dispatch — prevents double-dispatch on overlap
        if not update_task_status(title, "queued", "in-progress"):
            print(f"[queue-runner] WARN: status update failed for '{title}', skipping.")
            continue

        # Open a per-task Discord thread in the lane's home channel — fire-and-forget
        task["_discord_thread_id"] = None
        try:
            import importlib.util as _ilu_run
            _dns = _ilu_run.spec_from_file_location(
                "discord_notify", Path(__file__).parent / "discord_notify.py"
            )
            _dn_run = _ilu_run.module_from_spec(_dns)
            _dns.loader.exec_module(_dn_run)
            _home = _dn_run.PERSONAS.get(agent, {}).get("channel", _dn_run.THREADS_CHANNEL)
            task["_discord_thread_id"] = _dn_run.create_task_thread(_home, title)
            if task["_discord_thread_id"]:
                _dn_run.post_to_thread(
                    task["_discord_thread_id"],
                    f"Dispatching to **{agent}** lane…",
                    persona=agent,
                )
        except Exception:
            pass  # Discord unavailable — continue without thread

        message = build_queue_runner_message(task)
        success, output = dispatch_lane(agent, message, task=task)

        if not success:
            retry_failures = max(1, _local_failure_count(task) + 1)
            print(f"[queue-runner] Attempt 1 failed, retrying with local_failures={retry_failures}...")
            success, output = dispatch_lane(agent, message, task=task, local_failures=retry_failures)

        today = datetime.date.today().isoformat()
        if success:
            infra_fail_reason = detect_infra_fail(output)
            review = None
            if not infra_fail_reason and agent in SHIELD_REVIEW_AGENTS:
                print(f"[queue-runner] Running warden review for '{title}'...")
                review = shield_review(task, output)
                if review:
                    print(f"[queue-runner] Warden review complete.")
                    _tid = task.get("_discord_thread_id")
                    if _tid:
                        try:
                            import importlib.util as _ilu_sh
                            _shs = _ilu_sh.spec_from_file_location(
                                "discord_notify", Path(__file__).parent / "discord_notify.py"
                            )
                            _sh = _ilu_sh.module_from_spec(_shs)
                            _shs.loader.exec_module(_sh)
                            _sh.post_to_thread(
                                _tid,
                                review[:600] + ("…" if len(review) > 600 else ""),
                                persona="warden",
                            )
                        except Exception:
                            pass

            # Arbiter quality gate — retry up to CURATOR_MAX_RETRIES on "iterate"
            curator_verdict = None
            if not infra_fail_reason and agent in CURATOR_AGENTS:
                for attempt in range(CURATOR_MAX_RETRIES + 1):
                    print(f"[queue-runner] Arbiter check (attempt {attempt + 1}) for '{title}'...")
                    curator_verdict = curator_check(task, output, shield_review_text=review)

                    if curator_verdict is None:
                        print(f"[queue-runner] Arbiter unavailable — skipping gate.")
                        break

                    verdict = curator_verdict.get("verdict", "approve")
                    confidence = curator_verdict.get("confidence", 1.0)
                    print(
                        f"[queue-runner] Arbiter verdict: {verdict} (confidence={confidence:.2f})"
                    )
                    _tid = task.get("_discord_thread_id")
                    if _tid:
                        try:
                            import importlib.util as _ilu_cur
                            _curs = _ilu_cur.spec_from_file_location(
                                "discord_notify", Path(__file__).parent / "discord_notify.py"
                            )
                            _cur = _ilu_cur.module_from_spec(_curs)
                            _curs.loader.exec_module(_cur)
                            _issues = curator_verdict.get("issues", [])
                            _cur_text = f"Verdict: **{verdict}** ({confidence:.2f})"
                            if _issues:
                                _cur_text += "\n" + "\n".join(f"• {i}" for i in _issues[:5])
                            _cur.post_to_thread(_tid, _cur_text, persona="arbiter")
                        except Exception:
                            pass

                    # Verify hallucination flags against filesystem
                    h_flags = curator_verdict.get("hallucination_flags", [])
                    if h_flags:
                        missing = verify_hallucination_flags(h_flags)
                        if missing:
                            print(f"[queue-runner] Hallucination: missing files {missing}")
                            curator_verdict.setdefault("issues", []).extend(
                                [f"File not found: {f}" for f in missing]
                            )
                            if verdict == "approve":
                                curator_verdict["verdict"] = "iterate"
                                curator_verdict["confidence"] = min(confidence, 0.6)
                                curator_verdict["iterate_prompt"] = (
                                    f"These file paths were referenced but don't exist on disk: "
                                    f"{missing}. Correct or remove them."
                                )
                                verdict = "iterate"

                    if verdict == "approve":
                        break  # Good to go

                    if verdict == "reject" or attempt >= CURATOR_MAX_RETRIES:
                        print(
                            f"[queue-runner] Output {'rejected' if verdict == 'reject' else 'still failing after retries'}: {title}"
                        )
                        break

                    # iterate — re-dispatch with arbiter's fix instructions
                    iterate_msg = curator_verdict.get("iterate_prompt", "Fix the issues identified.")
                    retry_failures = max(_local_failure_count(task), attempt + 1)
                    print(f"[queue-runner] Re-dispatching '{title}' with fix (local_failures={retry_failures}): {iterate_msg[:80]}...")
                    retry_message = build_queue_runner_message(
                        task,
                        prior_output=(
                            f"A quality check found problems with the previous output. "
                            f"Fix the following issues:\n{iterate_msg}"
                        ),
                    )
                    success, output = dispatch_lane(agent, retry_message, task=task, local_failures=retry_failures)
                    if not success:
                        print(f"[queue-runner] Re-dispatch failed: {output[:100]}")
                        curator_verdict["verdict"] = "reject"
                        break

            if infra_fail_reason:
                out_path, final_status = save_output(task, output, infra_fail_reason=infra_fail_reason)
            else:
                out_path, final_status = save_output(task, output, warden=review, arbiter=curator_verdict)

            # Post-dispatch verify gate — if arbiter approved, confirm the task's done-when
            # criterion is actually satisfied before marking ready-to-apply
            if final_status == "ready-to-apply":
                try:
                    verify = subprocess.run(
                        ["bash", str(REPO / "scripts" / "task-verify.sh"), title],
                        capture_output=True, timeout=30,
                    )
                    if verify.returncode == 1:
                        verify_msg = verify.stdout.decode().strip().split("\n")[-1]
                        print(
                            f"[queue-runner] VERIFY FAIL '{title}': {verify_msg}"
                            f" — downgrading to needs-review"
                        )
                        final_status = "needs-review"
                        if out_path.exists():
                            txt = out_path.read_text()
                            txt = txt.replace("Status: ready-to-apply", "Status: needs-review", 1)
                            txt += (
                                f"\n---\n\n## Verify Gate\n\n"
                                f"task-verify.sh returned FAIL: {verify_msg}\n"
                                f"Status downgraded from ready-to-apply to needs-review.\n"
                            )
                            out_path.write_text(txt)
                    elif verify.returncode == 2:
                        verify_msg = verify.stdout.decode().strip().split("\n")[-1]
                        print(f"[queue-runner] WARN '{title}': verify requires manual check — {verify_msg}")
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    pass  # verify unavailable — keep ready-to-apply

            rel = out_path.relative_to(REPO)
            notes = []
            if review:
                notes.append("warden reviewed")
            if curator_verdict:
                v = curator_verdict.get("verdict", "unknown")
                c = curator_verdict.get("confidence", 0.0)
                notes.append(f"arbiter={v} ({c:.2f})")
            note_str = " (" + ", ".join(notes) + ")" if notes else ""
            if infra_fail_reason:
                task_note = f"Infra failure on {today}: {infra_fail_reason} — output at {rel}"
            else:
                task_note = f"Output saved to {rel} on {today}{note_str}"
            update_task_status(
                title,
                "in-progress",
                final_status,
                task_note,
            )
            print(f"[queue-runner] Done: {out_path.name} [{final_status}]")
        else:
            # Distinguish transient infra failures (timeout, connection) from genuine blocks
            # so _recover_parked_tasks() can auto-reopen them on the next run.
            _is_infra = (
                any(s.lower() in output.lower() for s in TIMEOUT_STRINGS)
                or "timed out" in output.lower()
                or "connection" in output.lower()
            )
            if _is_infra:
                update_task_status(
                    title, "in-progress", "infra-failed",
                    f"Infra failure on {today}: {output[:200]}"
                )
                print(f"[queue-runner] INFRA-FAIL: {title} — {output[:100]}")
            else:
                update_task_status(
                    title, "in-progress", "blocked", f"Lane failed 2x on {today}: {output[:200]}"
                )
                print(f"[queue-runner] BLOCKED: {title} — {output[:100]}")


def main():
    parser = argparse.ArgumentParser(description="Run queued OpenClaw lane work.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print dispatch mission/route preview for eligible task(s); do not execute lanes or mutate queue status.")
    parser.add_argument("--dry-run-limit", type=int, default=1,
                        help="Number of eligible tasks to preview in --dry-run mode (default: 1).")
    args = parser.parse_args()
    run(dry_run=args.dry_run, dry_run_limit=args.dry_run_limit)


if __name__ == "__main__":
    main()
