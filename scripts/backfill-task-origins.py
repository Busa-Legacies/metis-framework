#!/usr/bin/env python3
"""One-shot git-archaeology origin backfill for tasks.json.

Walks git log of tasks.json (and predecessor task files), finds the commit
that introduced each taskId, classifies it as ant|agent|collab|system based
on commit message + task why/title heuristics, then applies via
update-tier1-state.py task-update --backfill for evidence-backed rows.

Safe to re-run: skips tasks that already have an origin field.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TASKS_PATH = REPO / "docs/process/state/tasks.json"

# ── Origin classification heuristics ─────────────────────────────────────────

# Keywords in commit subject / task why / task title that signal the origin
SYSTEM_PATTERNS = [
    r"\bself.?review\b",
    r"\bcurator\b",
    r"\bintegrity.?check\b",
    r"\bgap.?analysis\b",
    r"\bauto(mated)?[\s\-]?(review|check|scan|lint|report)\b",
    r"\bheartbeat\b",
    r"\bclose[sd]?\s+#\d+",       # closure commits
    r"\bmark\s+done\b",
    r"\barchive\b",
    r"\breadme\b",
    r"\bdocument(ation)?\b",
    r"\bchore\b",
    r"\bweekly.?ops\b",
    r"\blocal.?model\b",
]
ANT_PATTERNS = [
    r"\bant\s+(asked|request|wants|says|confirm|need)\b",
    r"\bper\s+ant\b",
    r"\bant.?gated\b",
    r"\bhuman.?gated\b",
    r"\bant\s+(?:must|only|to)\b",
    r"\bant.?present\b",
    r"\b(ant|user)\s+request\b",
    r"\bant\s+explicit\b",
]
COLLAB_PATTERNS = [
    r"\bstrategic\b",
    r"\broadmap\b",
    r"\bgap\b",
    r"\bpropose[sd]?\b",
    r"\bsuggested?\b",
    r"\bplanned?\b",
    r"\bscoped?\b",
]
AGENT_PATTERNS = [
    r"\bauto.?logged?\b",
    r"\bagent.?initiative\b",
    r"\bfollow.?up\b",
    r"\bqueue[sd]?\s+(follow|improvement|suggestion)\b",
    r"\bqueued\s+as\b",
    r"\bproactive\b",
]


def _matches(patterns, text: str) -> bool:
    t = text.lower()
    return any(re.search(p, t) for p in patterns)


def classify(commit_msg: str, task: dict) -> tuple[str | None, str]:
    """Return (origin, evidence) or (None, reason_left_absent)."""
    corpus = " ".join([
        commit_msg,
        task.get("why", ""),
        task.get("title", ""),
        task.get("summary", ""),
    ])

    # #216 and #196-#215 are known provenance — stamp directly
    tid = task.get("taskId", "")
    num_match = re.match(r"#(\d+)$", tid)
    num = int(num_match.group(1)) if num_match else 0
    if num == 216:
        return "ant", "minted as first origin-bearing task per ant chat 2026-06-07"
    if 196 <= num <= 215:
        return "collab", "gap-analysis 2026-06-07 — agent proposed, Ant approved direction"

    # System-generated or purely mechanical work
    if _matches(SYSTEM_PATTERNS, corpus):
        return "system", f"system-pattern match in: {commit_msg[:80]!r}"

    # Explicitly Ant-gated / Ant-requested
    if _matches(ANT_PATTERNS, corpus):
        return "ant", f"ant-pattern match in: {commit_msg[:80]!r}"

    # Agent-autonomous follow-up
    if _matches(AGENT_PATTERNS, corpus):
        return "agent", f"agent-pattern match in: {commit_msg[:80]!r}"

    # Strategic / roadmap / scoping work (agent proposed, Ant direction gave approval)
    if _matches(COLLAB_PATTERNS, corpus):
        return "collab", f"collab-pattern match in: {commit_msg[:80]!r}"

    return None, f"no strong signal — corpus: {corpus[:120]!r}"


# ── Git archaeology ────────────────────────────────────────────────────────────

def git(*args) -> str:
    result = subprocess.run(
        ["git", "-C", str(REPO)] + list(args),
        capture_output=True, text=True
    )
    return result.stdout


def get_introducing_commit(task_id: str) -> str:
    """Find the git commit that first introduced task_id to tasks.json."""
    escaped = re.escape(task_id)
    log = git("log", "--all", "--pretty=format:%H %s", "-S", task_id,
              "--", "docs/process/state/tasks.json")
    lines = [l.strip() for l in log.splitlines() if l.strip()]
    if not lines:
        # Fallback: try OPEN_TASKS.md or task-queue.md
        log2 = git("log", "--all", "--pretty=format:%H %s", "-S", task_id,
                   "--", "Jay/state/OPEN_TASKS.md",
                   "docs/process/task-queue.md")
        lines = [l.strip() for l in log2.splitlines() if l.strip()]
    # Return the earliest (last in log) commit message, or empty
    return lines[-1].split(" ", 1)[1] if lines else ""


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    dry_run = "--dry-run" in sys.argv
    verbose = "--verbose" in sys.argv or "-v" in sys.argv

    doc = json.loads(TASKS_PATH.read_text())
    tasks = doc.get("tasks", [])

    stamped, skipped_present, left_absent = [], [], []
    ambiguous_list = []

    print(f"Processing {len(tasks)} tasks…\n")

    for task in tasks:
        tid = task.get("taskId", "?")
        if task.get("origin"):
            skipped_present.append(tid)
            if verbose:
                print(f"  SKIP {tid} — already has origin={task['origin']!r}")
            continue

        commit_msg = get_introducing_commit(tid)
        origin, evidence = classify(commit_msg, task)

        if origin is None:
            left_absent.append(tid)
            ambiguous_list.append((tid, evidence))
            if verbose:
                print(f"  SKIP {tid} — ambiguous: {evidence[:80]}")
            continue

        # Build originRef
        num_match = re.match(r"#(\d+)$", tid)
        num = int(num_match.group(1)) if num_match else 0
        if 196 <= num <= 215:
            origin_ref = "gap-analysis 2026-06-07 docs/process/goals.md"
        elif num == 216:
            origin_ref = "chat 2026-06-07 — systematize gap-analysis"
        else:
            origin_ref = commit_msg[:100] if commit_msg else "git-archaeology 2026-06-07"

        stamped.append((tid, origin, origin_ref, evidence))
        print(f"  {origin:8s} {tid:6s}  {evidence[:70]}")

    print(f"\n── Summary ─────────────────────────")
    print(f"  Already had origin:  {len(skipped_present)}")
    print(f"  Will stamp:          {len(stamped)}")
    print(f"  Left absent:         {len(left_absent)}")
    if ambiguous_list:
        print(f"\n── Ambiguous (left absent, Ant to hand-classify) ──────────────")
        for tid, reason in ambiguous_list:
            print(f"  {tid:6s}  {reason[:80]}")

    if dry_run:
        print("\n[dry-run] no writes made")
        return

    # Apply via update-tier1-state.py
    applied = 0
    errors = []
    for tid, origin, origin_ref, _ in stamped:
        task = next((t for t in tasks if t.get("taskId") == tid), None)
        if task is None:
            continue
        rev = task.get("revision", 1)
        patch = json.dumps({"origin": origin, "originRef": origin_ref})
        result = subprocess.run(
            ["python3", str(REPO / "scripts/update-tier1-state.py"),
             "task-update", "--actor", "claude",
             "--task-id", tid,
             "--expected-revision", str(rev),
             "--patch", patch],
            capture_output=True, text=True, cwd=str(REPO)
        )
        if result.returncode != 0:
            errors.append((tid, result.stderr.strip()))
        else:
            applied += 1

    print(f"\nApplied {applied}/{len(stamped)} stamps.")
    if errors:
        print("Errors:")
        for tid, err in errors:
            print(f"  {tid}: {err}")
    else:
        print("All stamps applied cleanly.")


if __name__ == "__main__":
    main()
