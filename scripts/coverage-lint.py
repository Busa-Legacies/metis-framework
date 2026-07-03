#!/usr/bin/env python3
"""Strategy-doc task-coverage linter.

Reads docs/process/state/strategy-docs.json (the opt-in manifest) and for
each listed doc parses the '## Tasks' section.  Checks:
  #1 FAIL  — minted [#NNN] ref doesn't exist in tasks.json (dangling ref);
             ids in archivedIds are NOT dangling — they completed and were
             archived, and are treated as done (check #2 applies)
  #2 WARN  — minted [#NNN] is done but line still appears as unchecked
  #3 WARN  — '- [ ] desc' declared-but-unminted gap
  #4 WARN  — doc has no '## Tasks' section at all
  #5 WARN  — malformed task line (neither [ ] nor [#NNN])

CLI contract (mirrors gitignore-lint.sh):
  python3 scripts/coverage-lint.py [--quiet] [--json]

  --quiet : suppress PASS lines; FAIL/WARN always print; exit 0 clean / 1 on FAIL
  --json  : write JSON result to stdout instead of human-readable lines
            {"fails": [...], "warns": [...], "gaps": [...]}

Exit codes: 0 = no FAILs, 1 = at least one FAIL.
"""
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TASKS_PATH = REPO / "docs/process/state/tasks.json"
MANIFEST_PATH = REPO / "docs/process/state/strategy-docs.json"

QUIET = "--quiet" in sys.argv
JSON_OUT = "--json" in sys.argv

# ── Output helpers (mirror gitignore-lint.sh) ───────────────────────────────

FAILS: list[str] = []
WARNS: list[str] = []
GAPS: list[dict] = []   # {"doc": ..., "desc": ...}

PASS_COUNT = 0


def emit_pass(msg: str):
    global PASS_COUNT
    PASS_COUNT += 1
    if not QUIET and not JSON_OUT:
        print(f"  PASS  {msg}")


def emit_fail(msg: str):
    FAILS.append(msg)
    if not JSON_OUT:
        print(f"  FAIL  {msg}")


def emit_warn(msg: str, gap: dict | None = None):
    WARNS.append(msg)
    if gap:
        GAPS.append(gap)
    if not JSON_OUT:
        print(f"  WARN  {msg}")


# ── Task data ────────────────────────────────────────────────────────────────

def load_tasks() -> tuple[dict[str, dict], set[str]]:
    """Return ({taskId: task}, {archived taskId}) from tasks.json."""
    try:
        doc = json.loads(TASKS_PATH.read_text())
        tasks = {t["taskId"]: t for t in doc.get("tasks", [])}
        archived = {str(a) if str(a).startswith("#") else f"#{a}"
                    for a in doc.get("archivedIds", [])}
        return tasks, archived
    except (OSError, ValueError) as e:
        emit_fail(f"could not load tasks.json: {e}")
        return {}, set()


def load_manifest() -> list[str]:
    """Return list of doc paths from the manifest."""
    try:
        doc = json.loads(MANIFEST_PATH.read_text())
        return doc.get("docs", [])
    except (OSError, ValueError) as e:
        emit_fail(f"could not load strategy-docs.json: {e}")
        return []


# ── Per-doc parsing ──────────────────────────────────────────────────────────

MINTED_RE = re.compile(r"^\s*-\s+\[(?:x\s*)?\s*(#\d+)\]", re.IGNORECASE)
GAP_RE = re.compile(r"^\s*-\s+\[\s+\]\s+\S")   # '- [ ] <non-empty text>'
ANY_RE = re.compile(r"^\s*-\s+\[")              # any checkbox line


def parse_tasks_section(text: str) -> list[str]:
    """Return lines inside the '## Tasks' section (stops at next ## heading)."""
    in_section = False
    lines = []
    for line in text.splitlines():
        if re.match(r"^## Tasks\s*$", line):
            in_section = True
            continue
        if in_section:
            if re.match(r"^## ", line):
                break
            lines.append(line)
    return lines


def lint_doc(doc_path_str: str, tasks: dict[str, dict], archived: set[str]):
    doc_path = REPO / doc_path_str
    short = doc_path_str

    if not doc_path.exists():
        emit_fail(f"{short}: file not found")
        return

    text = doc_path.read_text()
    section_lines = parse_tasks_section(text)

    if not section_lines:
        emit_warn(f"{short}: no '## Tasks' section found")
        return

    emit_pass(f"{short}: has ## Tasks section")

    task_lines = [l for l in section_lines if l.strip()]
    if not task_lines:
        emit_warn(f"{short}: ## Tasks section is empty")
        return

    for line in task_lines:
        minted = MINTED_RE.search(line)
        gap = GAP_RE.search(line)
        any_cb = ANY_RE.search(line)

        if minted:
            task_id = minted.group(1)
            if task_id not in tasks:
                if task_id in archived:
                    # Archived = completed + swept; not dangling. Check #2 applies.
                    if not re.search(r"\[x", line, re.IGNORECASE):
                        emit_warn(f"{short}: {task_id} is archived (done) but line is not marked [x]")
                    else:
                        emit_pass(f"{short}: {task_id} archived+marked [x]")
                else:
                    # Check #1 — dangling ref
                    emit_fail(f"{short}: dangling task ref {task_id} (not in tasks.json)")
            else:
                task = tasks[task_id]
                if task.get("state") == "done":
                    # Check #2 — done but unchecked (line would have [x] if author marked it)
                    if not re.search(r"\[x", line, re.IGNORECASE):
                        emit_warn(f"{short}: {task_id} is done but line is not marked [x]")
                    else:
                        emit_pass(f"{short}: {task_id} done+marked [x]")
                else:
                    emit_pass(f"{short}: {task_id} exists ({task.get('state', '?')})")

        elif gap:
            desc = re.sub(r"^\s*-\s+\[\s+\]\s+", "", line).strip()
            emit_warn(
                f"{short}: tracked gap — '{desc[:60]}'",
                gap={"doc": short, "desc": desc},
            )

        elif any_cb:
            # Check #5 — malformed (has brackets but neither pattern matched)
            emit_warn(f"{short}: malformed task line: {line.strip()[:80]!r}")

        # Non-checkbox lines (comments, blank, headers within section) — skip silently


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    tasks, archived = load_tasks()
    doc_paths = load_manifest()

    if not doc_paths:
        if not JSON_OUT:
            print("  WARN  no strategy docs in manifest")
        sys.exit(0)

    for doc_path in doc_paths:
        lint_doc(doc_path, tasks, archived)

    if JSON_OUT:
        print(json.dumps({"fails": FAILS, "warns": WARNS, "gaps": GAPS}, indent=2))
    else:
        total = PASS_COUNT + len(FAILS) + len(WARNS)
        print(f"\n  {PASS_COUNT} passed, {len(FAILS)} failed, {len(WARNS)} warned"
              f" ({len(GAPS)} tracked gaps)")
        if GAPS:
            print(f"  GAPS  {len(GAPS)}")

    sys.exit(1 if FAILS else 0)


if __name__ == "__main__":
    main()
