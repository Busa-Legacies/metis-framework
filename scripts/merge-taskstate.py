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
import re
import sys
from datetime import datetime, timezone


def _load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _ts(v):
    """Defensive timestamp parse (#269): accept Z-suffix and naive variants.

    fromisoformat on older interpreters rejects a trailing Z, and a naive
    datetime compared against an aware one raises TypeError mid-merge — both
    would crash the driver on legitimate timestamp variants. Normalize Z to
    +00:00 and assume UTC for naive values so every parsed pair is comparable.
    """
    s = (v or {}).get("updatedAt", "") or ""
    if not isinstance(s, str):
        return None
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    try:
        t = datetime.fromisoformat(s)
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


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


def _is_id_collision(a, b):
    """True when two tasks share a taskId but are DIFFERENT tasks — i.e. two
    concurrent sessions allocated the same id from diverged counters. Discriminate
    by createdAt (stamped once at create, immutable per #285): same id + different
    createdAt = collision. Conservative: if either createdAt is missing we can't be
    sure, so treat as the same task (normal revision merge) and never renumber."""
    ca, cb = a.get("createdAt"), b.get("createdAt")
    return bool(ca) and bool(cb) and ca != cb


def _next_free_id(existing):
    nums = [int(t[1:]) for t in existing if re.fullmatch(r"#\d+", str(t))]
    return f"#{(max(nums) + 1) if nums else 1}"


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
    # Task-id collision guard (#469): two concurrent sessions can allocate the SAME id
    # for DIFFERENT tasks (diverged counters). Without this, _pick_task silently keeps
    # one and the other is lost. Instead: keep the earlier-created task at the id, and
    # PRESERVE the later one by renumbering it to a fresh id (never silently drop work).
    existing_ids = set(oi) | set(ti)
    primary, renumbered = [], []
    for tid in order:
        if tid in archived:
            continue
        a, b = oi.get(tid), ti.get(tid)
        if a is not None and b is not None and _is_id_collision(a, b):
            keep, move = (a, b) if a.get("createdAt", "") <= b.get("createdAt", "") else (b, a)
            new_id = _next_free_id(existing_ids)
            existing_ids.add(new_id)
            moved = dict(move)
            moved["taskId"] = new_id
            moved["idCollisionRenumberedFrom"] = tid
            renumbered.append(moved)
            primary.append(keep)
            sys.stderr.write(
                f"[taskstate-merge] id collision on {tid}: two distinct tasks — kept "
                f"{keep.get('title','')[:40]!r} at {tid}, renumbered {move.get('title','')[:40]!r} "
                f"-> {new_id} (no work dropped; #469)\n")
        else:
            primary.append(_pick_task(a, b))
    out["tasks"] = primary + renumbered
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
