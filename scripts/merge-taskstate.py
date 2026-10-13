#!/usr/bin/env python3
"""Git merge driver for governed task-state JSON (tasks.json + task-counter.json).

Registered in .git/config as merge "taskstate" and mapped in .gitattributes.
Git invokes it as:  merge-taskstate.py %O %A %B %P
  %O = base (common ancestor), %A = ours (also the OUTPUT path), %B = theirs, %P = path.

Resolution is deterministic so cross-machine auto-sync never stalls:
  - tasks.json: union tasks[] by taskId; for a shared id, keep the higher `revision`
    (tie -> newer `updatedAt` parsed as a real datetime; final tie -> theirs/incoming).
    Top-level `version` = max, `updatedAt` = newer.
  - task-counter.json: `lastAssigned` = max(both counters AND the max task id already
    present in the sibling tasks.json across both merge sides) so an allocated id is
    never re-issued AND the counter can never merge to below an id that already exists.
    `updatedAt` = newer. (Before 2026-07-31 this maxed only the two counter values; when
    both counter files lagged their own task ids — accumulated cross-machine drift — the
    merge preserved the lag and the next create-task minted a colliding id: reconcile I6.)

Exits 0 (resolved) on success. Exits 1 only if neither side is parseable JSON, so a
genuinely corrupt file surfaces instead of being silently overwritten.
"""
import json
import os
import re
import subprocess
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


_COMPLETED_TERMINAL = {"done", "archived"}


def _pick_task(a, b):
    if a is None:
        return b
    if b is None:
        return a
    # #887: completed-terminal precedence. A task that reached done/archived on one side must
    # never be reverted to a non-terminal state by the other side — even if that side carries a
    # higher revision (a heartbeat re-stamp, a projection re-render, or a stale in-flight edit
    # can bump revision without changing state). Without this, a concurrent non-terminal bump
    # silently overwrote a real completion (done -> queued). Terminal-vs-terminal still falls
    # through to the normal revision/updatedAt resolution below.
    a_done = a.get("state") in _COMPLETED_TERMINAL
    b_done = b.get("state") in _COMPLETED_TERMINAL
    if a_done != b_done:
        return a if a_done else b
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


def _idnum(tid):
    m = re.fullmatch(r"#(\d+)", str(tid))
    return int(m.group(1)) if m else float("inf")


def _converge_duplicate_tasks(tasks):
    """Same-task convergence (#1274): entries sharing an exact (createdAt, title) but
    sitting at DIFFERENT taskIds are clones of ONE logical task that diverged across
    clones (the 2026-07-28 storm minted 12-18 copies of each). union-by-taskId — the
    only dedup _merge_tasks had — never re-converges them, so they accumulate on every
    merge (~140 phantom tasks board-wide). This is the INVERSE of the _is_id_collision
    case (same id / different task); here it's the same task at different ids.

    Fold each divergent-id cluster onto its LOWEST numeric id, unioning state via
    _pick_task (keep the most-progressed copy — terminal/revision/updatedAt), and record
    the folded ids in `dedupedFrom` so nothing vanishes untraceably.

    Conservative by construction: createdAt is stamped once at create and immutable
    (#285), so an identical (createdAt, title) pair cannot be two genuinely distinct
    tasks. Groups missing either field, or already at a single id, are left untouched —
    so a normal merge is a no-op (same list object returned)."""
    groups = {}
    for t in tasks:
        ca, title = t.get("createdAt"), t.get("title")
        if ca and title:
            groups.setdefault((ca, title), []).append(t)
    if not any(len({m["taskId"] for m in v}) > 1 for v in groups.values()):
        return tasks  # fast path — no divergent-id clusters, don't touch the list

    winners = {}   # canonical id -> merged task
    drop = set()   # ids folded away
    for members in groups.values():
        ids = {m["taskId"] for m in members}
        if len(ids) <= 1:
            continue
        canonical = min(ids, key=_idnum)
        merged = None
        folded_prior = []
        for m in members:
            merged = m if merged is None else _pick_task(merged, m)
            folded_prior += m.get("dedupedFrom", []) or []
        merged = dict(merged)
        merged["taskId"] = canonical
        merged["dedupedFrom"] = sorted(
            {i for i in ids if i != canonical} | set(folded_prior), key=_idnum)
        winners[canonical] = merged
        drop |= {i for i in ids if i != canonical}

    out, emitted = [], set()
    for t in tasks:
        tid = t["taskId"]
        if tid in drop:
            sys.stderr.write(
                f"[taskstate-merge] same-task dedup: folded {tid} into its lowest-id "
                f"twin (shared createdAt+title; #1274 — no work dropped, see dedupedFrom)\n")
            continue
        if tid in winners:
            if tid not in emitted:
                out.append(winners[tid])
                emitted.add(tid)
        else:
            out.append(t)
    return out


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
    # #909: the renumber target must clear BOTH sides' active ids AND every archived
    # tombstone — archivedIds never shrinks, so reusing a tombstoned number would
    # resurrect a retired id and could re-collide if that task ever un-archives.
    existing_ids = set(oi) | set(ti) | archived
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
    out["tasks"] = _converge_duplicate_tasks(primary + renumbered)
    if archived:
        out["archivedIds"] = sorted(archived)
    out["version"] = max((ours or {}).get("version", 1), (theirs or {}).get("version", 1))
    out["updatedAt"] = _newer_updatedat(ours or {}, theirs or {}).get("updatedAt", "")
    return out


def _max_task_id(obj):
    """Max numeric taskId in a tasks.json dict, counting archived tombstones too — a
    retired id must never be re-issued either. Returns 0 for an empty/None doc."""
    best = 0
    if not obj:
        return best
    for t in obj.get("tasks", []) or []:
        m = re.fullmatch(r"#(\d+)", str((t or {}).get("taskId", "")))
        if m:
            best = max(best, int(m.group(1)))
    for a in obj.get("archivedIds", []) or []:
        m = re.fullmatch(r"#(\d+)", str(a))
        if m:
            best = max(best, int(m.group(1)))
    return best


def _sibling_tasks_max(counter_repo_path):
    """Best-effort max task id from the sibling tasks.json across BOTH merge sides, so the
    counter can never merge to below an id that already exists (root cause of the
    2026-07-31 I6 regression: both counter files lagged their own task ids and
    max(counter, counter) preserved the lag). The driver runs from the repo root during a
    merge, so read the two conflict stages of the sibling tasks.json — :2: (ours) and :3:
    (theirs) — plus the working-tree copy, and take the max. Any source that is absent or
    unreadable is skipped; on total failure this returns 0 so the driver falls back to the
    old max(counter) behaviour rather than ever crashing a merge. (Residual: a
    collision-renumber in _merge_tasks can mint max+1 that this pre-merge read does not
    see; reconcile I6 detection + a counter self-heal cover that rarer tail.)"""
    if not counter_repo_path:
        return 0
    tasks_rel = os.path.join(os.path.dirname(counter_repo_path), "tasks.json")
    best = 0
    for stage in ("2", "3"):
        try:
            r = subprocess.run(["git", "show", f":{stage}:{tasks_rel}"],
                               capture_output=True, text=True, timeout=15)
            if r.returncode == 0 and r.stdout.strip():
                best = max(best, _max_task_id(json.loads(r.stdout)))
        except Exception:
            pass
    try:
        best = max(best, _max_task_id(_load(tasks_rel)))
    except Exception:
        pass
    return best


def _merge_counter(ours, theirs, tasks_max=0):
    out = dict(_newer_updatedat(ours or {}, theirs or {}))
    # max of BOTH counters AND the max id already present in tasks.json: a merge must
    # never lower the counter below an already-allocated id, or the next create-task
    # mints a colliding id (reconcile I6). tasks_max=0 preserves the old behaviour.
    out["lastAssigned"] = max(
        (ours or {}).get("lastAssigned", 0),
        (theirs or {}).get("lastAssigned", 0),
        tasks_max,
    )
    return out


def main():
    ours_path, theirs_path = sys.argv[2], sys.argv[3]
    repo_path = sys.argv[4] if len(sys.argv) > 4 else ""   # %P — repo-relative path
    ours, theirs = _load(ours_path), _load(theirs_path)
    if ours is None and theirs is None:
        return 1
    if (ours or theirs or {}).get("tasks") is not None or "tasks" in (ours or theirs or {}):
        merged = _merge_tasks(ours, theirs)
    else:
        merged = _merge_counter(ours, theirs, _sibling_tasks_max(repo_path))
    # Match the governed writer byte-for-byte (tier1_state_io.dump_json: raw UTF-8). The default
    # ensure_ascii=True escaped every em dash/arrow, so each cross-machine merge flipped ~3,100
    # lines of tasks.json to \uXXXX and the next governed write flipped them back (#8483).
    with open(ours_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(merged, indent=2, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
