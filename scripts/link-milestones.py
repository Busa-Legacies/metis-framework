#!/usr/bin/env python3
"""Derive milestone <-> task links from the task store (#246).

The task is the SOURCE OF TRUTH: a task carries `project` + `milestone` (e.g. "M5").
This script projects that into `docs/process/state/projects.json` so each milestone's
`taskIds` and `fill` (done-ratio) reflect reality, instead of being hand-maintained.

Bidirectional consistency, one-way derivation:
  task.project + task.milestone  ──derive──▶  milestone.taskIds + milestone.fill

Usage:
  link-milestones.py            # write derived taskIds + fill into projects.json
  link-milestones.py --check    # report what would change, write nothing
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TASKS = ROOT / "docs/process/state/tasks.json"
PROJECTS = ROOT / "docs/process/state/projects.json"


def _listify(blob, key):
    v = blob.get(key, blob) if isinstance(blob, dict) else blob
    return list(v.values()) if isinstance(v, dict) else v


def main():
    check = "--check" in sys.argv
    tasks = _listify(json.loads(TASKS.read_text()), "tasks")
    pdoc = json.loads(PROJECTS.read_text())
    projects = _listify(pdoc, "projects")

    # index tasks by (project, milestone)
    by_pm = {}
    for t in tasks:
        proj, ms = t.get("project"), t.get("milestone")
        if proj and ms:
            by_pm.setdefault((proj, ms), []).append(t)

    changes = []
    for p in projects:
        slug = p.get("slug")
        for m in p.get("milestones", []):
            mid = m.get("id")
            members = by_pm.get((slug, mid), [])
            if not members:
                # No task carries this (project, milestone) yet — leave the
                # milestone's hand-curated taskIds/fill untouched (unmigrated).
                continue
            new_ids = sorted((t["taskId"] for t in members), key=lambda x: int(x.lstrip("#")))
            total = len(members)
            done = sum(1 for t in members if t.get("state") == "done")
            new_fill = round(done / total, 3) if total else m.get("fill", 0.0)
            old_ids, old_fill = m.get("taskIds", []), m.get("fill", 0.0)
            if new_ids != old_ids or new_fill != old_fill:
                changes.append(f"{slug}/{mid}: taskIds {old_ids}->{new_ids}, fill {old_fill}->{new_fill} ({done}/{total} done)")
                m["taskIds"] = new_ids
                m["fill"] = new_fill

    if not changes:
        print("milestones already in sync — no changes")
        return
    print(("WOULD CHANGE" if check else "UPDATED") + f" {len(changes)} milestone(s):")
    for c in changes:
        print("  " + c)
    if not check:
        PROJECTS.write_text(json.dumps(pdoc, indent=2) + "\n")
        print(f"wrote {PROJECTS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
