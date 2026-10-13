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
TASKS_ARCHIVE = ROOT / "docs/process/state/tasks-archive.json"
PROJECTS = ROOT / "docs/process/state/projects.json"


def _listify(blob, key):
    v = blob.get(key, blob) if isinstance(blob, dict) else blob
    return list(v.values()) if isinstance(v, dict) else v


def _archived_tasks():
    """Archived task records (archive-done-tasks.py moves them out of tasks.json
    but they keep their project/milestone/state). Milestone fill must count them
    (#281): archiving a done task must NOT make its milestone look less complete."""
    if not TASKS_ARCHIVE.exists():
        return []
    try:
        return _listify(json.loads(TASKS_ARCHIVE.read_text()), "tasks")
    except (ValueError, OSError):
        return []


def main():
    check = "--check" in sys.argv
    tasks = _listify(json.loads(TASKS.read_text()), "tasks")
    pdoc = json.loads(PROJECTS.read_text())
    projects = _listify(pdoc, "projects")

    # Index tasks by (project, milestone) over the UNION of active + archived
    # tasks (#281). Building only from tasks.json can't tell a never-linked
    # milestone (leave untouched) from one whose tasks were all archived (must
    # recompute) — so a fully-archived milestone would freeze at a stale fill.
    # Dedup by taskId so a task present in both stores is counted once (active wins).
    by_pm = {}
    seen_ids = set()
    for t in list(tasks) + _archived_tasks():
        tid = t.get("taskId")
        if tid in seen_ids:
            continue
        seen_ids.add(tid)
        proj, ms = t.get("project"), t.get("milestone")
        if proj and ms:
            by_pm.setdefault((proj, ms), []).append(t)

    changes = []
    just_completed = []  # (slug, milestone title) that reached fill 1.0 this run
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
                # A milestone reaching fill 1.0 (every member task done) JUST completed —
                # emit a 🎯 progress event to its Discord project channel. Guarded to the
                # transition (old<1.0 → new==1.0) so a re-run never re-fires; best-effort.
                if not check and total and new_fill >= 1.0 and (old_fill or 0.0) < 1.0:
                    just_completed.append((slug, m.get("title") or mid))
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
        try:
            shown = PROJECTS.relative_to(ROOT)
        except ValueError:
            shown = PROJECTS
        print(f"wrote {shown}")
        # Announce any milestone that just completed (fill→1.0) as a Discord 🎯 event.
        # Best-effort + fail-soft: milestone reconciliation must never break on a
        # Discord/import hiccup (comms surface, docs/process/discord-comms-architecture.md).
        for slug, title in just_completed:
            try:
                sys.path.insert(0, str(ROOT / "scripts"))
                import discord_notify
                discord_notify.post_milestone(slug, title)
                print(f"  🎯 milestone complete → Discord: {slug}/{title}")
            except Exception:  # noqa: BLE001 — progress posting is best-effort
                pass


if __name__ == "__main__":
    main()
