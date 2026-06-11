#!/usr/bin/env python3
"""Git merge driver for governed task-state JSON (tasks.json + task-counter.json).

Registered in .git/config as merge "taskstate" and mapped in .gitattributes.
Git invokes it as:  merge-taskstate.py %O %A %B %P
  %O = base (common ancestor), %A = ours (also the OUTPUT path), %B = theirs, %P = path.

Resolution is deterministic so cross-machine auto-sync never stalls:
  - tasks.json: union tasks[] by taskId; for a shared id, keep the higher `revision`
    (tie -> newer `updatedAt` parsed as a real datetime; final tie -> theirs/incoming).
    Top-level `version` = max, `updatedAt` = newer.
  - task-counter.json: `lastAssigned` = max(both) so an allocated id is never re-issued;
    `updatedAt` = newer.

Exits 0 (resolved) on success. Exits 1 only if neither side is parseable JSON, so a
genuinely corrupt file surfaces instead of being silently overwritten.
"""
import json
import sys
from datetime import datetime


def _load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _ts(v):
    s = (v or {}).get("updatedAt", "") or ""
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _newer_updatedat(a, b):
    """Return the dict whose updatedAt is later; prefer b (incoming) on a tie."""
    ta, tb = _ts(a), _ts(b)
    if ta is not None and tb is not None:
        return a if ta > tb else b
    sa = (a or {}).get("updatedAt", "")
    sb = (b or {}).get("updatedAt", "")
    return a if sa > sb else b


def _pick_task(a, b):
    if a is None:
        return b
    if b is None:
        return a
    ra, rb = a.get("revision", 0), b.get("revision", 0)
    if ra != rb:
        return a if ra > rb else b
    return _newer_updatedat(a, b)


def _merge_tasks(ours, theirs):
    out = dict(ours or theirs or {})
    oi = {t["taskId"]: t for t in (ours or {}).get("tasks", [])}
    ti = {t["taskId"]: t for t in (theirs or {}).get("tasks", [])}
    order = list(oi)
    order += [tid for tid in ti if tid not in oi]
    # Archive tombstones: a task archived on EITHER side is excluded from the active union, so
    # archiving converges across machines even though tasks[] is unioned by id (see
    # scripts/archive-done-tasks.py). archivedIds itself is unioned and never shrinks.
    archived = set((ours or {}).get("archivedIds", [])) | set((theirs or {}).get("archivedIds", []))
    out["tasks"] = [_pick_task(oi.get(tid), ti.get(tid)) for tid in order if tid not in archived]
    if archived:
        out["archivedIds"] = sorted(archived)
    out["version"] = max((ours or {}).get("version", 1), (theirs or {}).get("version", 1))
    out["updatedAt"] = _newer_updatedat(ours or {}, theirs or {}).get("updatedAt", "")
    return out


def _merge_counter(ours, theirs):
    out = dict(_newer_updatedat(ours or {}, theirs or {}))
    out["lastAssigned"] = max(
        (ours or {}).get("lastAssigned", 0),
        (theirs or {}).get("lastAssigned", 0),
    )
    return out


def main():
    ours_path, theirs_path = sys.argv[2], sys.argv[3]
    ours, theirs = _load(ours_path), _load(theirs_path)
    if ours is None and theirs is None:
        return 1
    if (ours or theirs or {}).get("tasks") is not None or "tasks" in (ours or theirs or {}):
        merged = _merge_tasks(ours, theirs)
    else:
        merged = _merge_counter(ours, theirs)
    with open(ours_path, "w") as f:
        json.dump(merged, f, indent=2)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
