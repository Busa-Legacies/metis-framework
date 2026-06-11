#!/usr/bin/env python3
"""backfill-task-board-fields.py — one-shot migration for #100.

Lifts the board-only fields (area / agent / machine) into the governed task
store so Jay/state/OPEN_TASKS.md can become a rendered projection of
docs/process/state/tasks.json instead of a hand-maintained dual-write.

Source of truth, in priority order, per task:
  1. The matching row in the CURRENT OPEN_TASKS.md (authoritative — that is the
     hand-curated area/@agent/@machine we are lifting).
  2. task-domain.py keyword_lookup() for `area` when the task has no board row.
  3. The existing `owner` field for `machine` (normalized), `claude` default for
     `agent`.

Idempotent: only fills fields that are absent unless --force is given.
Run --dry-run first; it prints a per-task table and a coverage summary and
writes nothing.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(os.environ.get("REPO_ROOT") or os.environ.get("METIS_HOME") or (Path.home() / "metis-os"))
if not (ROOT / "docs/process/state/tasks.json").exists():
    ROOT = Path(__file__).resolve().parent.parent
TASKS_PATH = ROOT / "docs/process/state/tasks.json"
AREAS_PATH = ROOT / "docs/process/state/task-areas.json"
OPEN_TASKS = ROOT / "Jay/state/OPEN_TASKS.md"

import importlib.util as _ilu

_spec = _ilu.spec_from_file_location("task_domain", ROOT / "scripts" / "task-domain.py")
_task_domain = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(_task_domain)
keyword_lookup = _task_domain.keyword_lookup

VALID_AGENTS = {"forge", "scout", "shield", "echo", "claude", "codex", "hermes", "curator"}
VALID_MACHINES = {"antfox", "jarry", "either"}
# user 'abusa' == the Jarry machine; collapse to the machine name.
MACHINE_ALIASES = {"abusa": "jarry", "anthonys-macbook-pro": "jarry", "antfox-macbook": "antfox"}


def load_areas():
    doc = json.loads(AREAS_PATH.read_text())
    return {a["name"] for a in doc["areas"]}


def parse_board_rows():
    """taskId(without #) -> {area, agent, machine} from current OPEN_TASKS.md."""
    rows = {}
    if not OPEN_TASKS.exists():
        return rows
    area = None
    for line in OPEN_TASKS.read_text().splitlines():
        m = re.match(r"^## (.+?)\s*\|", line)
        if m:
            area = m.group(1).strip()
            continue
        rm = re.search(r"\*\*#?(\d+)\b", line)
        if not rm or not area:
            continue
        tid = rm.group(1)
        ag = re.search(r"@agent:(\S+)", line)
        mc = re.search(r"@machine:(\S+)", line)
        rows[tid] = {
            "area": area,
            "agent": ag.group(1) if ag else None,
            "machine": mc.group(1) if mc else None,
        }
    return rows


def norm_machine(value):
    if not value:
        return None
    v = str(value).strip().lower()
    v = MACHINE_ALIASES.get(v, v)
    return v if v in VALID_MACHINES else None


def norm_agent(value):
    if not value:
        return None
    v = str(value).strip().lower()
    return v if v in VALID_AGENTS else None


def resolve_area(task, board, canonical_areas):
    tid = str(task["taskId"]).lstrip("#")
    cand = board.get(tid, {}).get("area")
    if cand in canonical_areas:
        return cand
    # board row sat under a non-area header (Resolved / Self-Review) or no row.
    kw = keyword_lookup(task.get("title", ""))
    if kw in canonical_areas:
        return kw
    return "Uncategorized"


def resolve_machine(task, board):
    tid = str(task["taskId"]).lstrip("#")
    return (
        norm_machine(board.get(tid, {}).get("machine"))
        or norm_machine(task.get("owner"))
        or "either"
    )


def resolve_agent(task, board):
    tid = str(task["taskId"]).lstrip("#")
    return (
        norm_agent(board.get(tid, {}).get("agent"))
        or norm_agent(task.get("owner"))  # owner is sometimes a lane name (claude)
        or "claude"
    )


def main():
    ap = argparse.ArgumentParser(description="Backfill area/agent/machine into tasks.json")
    ap.add_argument("--dry-run", action="store_true", help="print plan, write nothing")
    ap.add_argument("--force", action="store_true", help="overwrite fields even if already present")
    args = ap.parse_args()

    canonical_areas = load_areas()
    board = parse_board_rows()
    doc = json.loads(TASKS_PATH.read_text())
    tasks = doc["tasks"]

    changes = []
    for t in tasks:
        tid = str(t["taskId"]).lstrip("#")
        want = {
            "area": resolve_area(t, board, canonical_areas),
            "agent": resolve_agent(t, board),
            "machine": resolve_machine(t, board),
        }
        for field, value in want.items():
            if args.force or not t.get(field):
                if t.get(field) != value:
                    changes.append((t["taskId"], field, t.get(field), value, tid in board))
                t[field] = value

    # Report
    src = lambda from_board: "board" if from_board else "infer"
    print(f"{'task':<8} {'field':<8} {'old':<14} {'new':<26} src")
    print("-" * 70)
    for taskid, field, old, new, from_board in changes:
        print(f"{taskid:<8} {field:<8} {str(old):<14} {str(new):<26} {src(from_board)}")
    print("-" * 70)
    print(f"{len(changes)} field-writes across {len({c[0] for c in changes})} tasks "
          f"({len(tasks)} total). board ground-truth rows: {len(board)}")
    uncat = [t['taskId'] for t in tasks if t.get('area') == 'Uncategorized']
    if uncat:
        print(f"Uncategorized ({len(uncat)}): {', '.join(map(str, uncat))}")

    if args.dry_run:
        print("\n[dry-run] no changes written.")
        return

    doc["updatedAt"] = __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    TASKS_PATH.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print(f"\nWrote {TASKS_PATH}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
