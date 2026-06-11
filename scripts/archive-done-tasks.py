#!/usr/bin/env python3
"""Archive terminal tasks OUT of the hot tasks.json into tasks-archive.json (#262-era token lever).

WHY: tasks.json carries every terminal (done/dropped/…) task inline forever — 158 of 204 tasks,
~4500 of its ~6300 lines. That file is read repeatedly every session, so the dead weight is a real
token cost. The existing archive-tasks.py only trims the markdown *views*; it deliberately never
touches the governed tasks.json. This does the governed half safely.

THE MERGE-SAFE TRICK: tasks.json is union-merged by taskId (scripts/merge-taskstate.py), so naively
deleting a done task doesn't converge — another machine that still holds it re-adds it on the next
merge. So we leave a TOMBSTONE: the archived task *objects* move to tasks-archive.json, but their ids
are recorded in tasks.json's top-level `archivedIds` list. The merge driver unions `archivedIds` and
EXCLUDES those ids from the active `tasks[]` — so the archive converges across machines deterministically.
No task data is ever deleted; the archive is union-merged and never pruned. Worst case on a merge race
is a just-archived task transiently reappearing in active until the next archive run — never data loss.

SAFETY GUARDS:
  - Only archives TERMINAL-state tasks.
  - Never archives a task still referenced as a prerequisite/blocker/dependency by a NON-terminal task
    (keeps dependency resolution intact).
  - Default is a DRY RUN (prints the plan). Pass --apply to write.
  - Idempotent: a second run finds nothing to archive.
"""
from __future__ import annotations
import argparse, json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TASKS = ROOT / "docs/process/state/tasks.json"
ARCHIVE = ROOT / "docs/process/state/tasks-archive.json"
TERMINAL = {"done", "dropped", "moot", "cancelled", "rejected", "archived"}
# Fields on a task that may name another task it depends on.
DEP_FIELDS = ("prerequisites", "blockedBy", "dependsOn", "blocks", "prereqs")


def _referenced_by_open(tasks):
    """Ids that a non-terminal task still points at — must stay resolvable, so don't archive them."""
    keep = set()
    for t in tasks:
        if t.get("state") in TERMINAL:
            continue
        for f in DEP_FIELDS:
            v = t.get(f)
            if isinstance(v, list):
                keep.update(str(x) for x in v)
            elif isinstance(v, str) and v.strip():
                keep.add(v.strip())
    return keep


def plan(doc):
    tasks = doc.get("tasks", [])
    already = set(doc.get("archivedIds", []))
    keep_refs = _referenced_by_open(tasks)
    to_archive, kept_refs = [], []
    for t in tasks:
        tid = t.get("taskId")
        if t.get("state") not in TERMINAL:
            continue
        if tid in keep_refs:
            kept_refs.append(tid)
            continue
        to_archive.append(t)
    return to_archive, kept_refs, already


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    args = ap.parse_args(argv)

    doc = json.loads(TASKS.read_text())
    to_archive, kept_refs, already = plan(doc)

    if not to_archive:
        print("✓ archive-done-tasks: nothing to archive (active tasks.json holds no un-referenced "
              f"terminal tasks). archivedIds tombstones: {len(already)}.")
        return 0

    active_before = len(doc.get("tasks", []))
    print(f"Would archive {len(to_archive)} terminal task(s) out of {active_before} "
          f"({active_before - len(to_archive)} stay active).")
    if kept_refs:
        print(f"  Keeping {len(kept_refs)} terminal task(s) still referenced by open work: "
              f"{', '.join(sorted(kept_refs)[:10])}{' …' if len(kept_refs) > 10 else ''}")
    if not args.apply:
        sample = ", ".join(t.get("taskId", "?") for t in to_archive[:12])
        print(f"  e.g. {sample}{' …' if len(to_archive) > 12 else ''}")
        print("  (dry run — re-run with --apply to write)")
        return 0

    # --- apply: move objects to the archive, leave tombstone ids in tasks.json ---
    arch_ids = {t["taskId"] for t in to_archive}
    archive_doc = json.loads(ARCHIVE.read_text()) if ARCHIVE.exists() else {"version": 1, "tasks": []}
    existing_arch = {t["taskId"] for t in archive_doc.get("tasks", [])}
    archive_doc.setdefault("tasks", [])
    for t in to_archive:
        if t["taskId"] not in existing_arch:  # union, never dup
            archive_doc["tasks"].append(t)

    doc["tasks"] = [t for t in doc["tasks"] if t.get("taskId") not in arch_ids]
    doc["archivedIds"] = sorted(set(doc.get("archivedIds", [])) | arch_ids)

    ARCHIVE.write_text(json.dumps(archive_doc, indent=2, ensure_ascii=False) + "\n")
    TASKS.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print(f"✓ archived {len(to_archive)} task(s) -> {ARCHIVE.name}; active tasks.json now holds "
          f"{len(doc['tasks'])} (tombstones: {len(doc['archivedIds'])}).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
