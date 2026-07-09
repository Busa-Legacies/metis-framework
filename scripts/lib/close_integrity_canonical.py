#!/usr/bin/env python3
"""Canonical close-integrity checks (#352).

The close gate's id-counter / task-fields / task-body checks read CANONICAL state
(`docs/process/state/tasks.json` + `task-counter.json`) via `task_state`, never
the `task-queue.md` / `OPEN_TASKS.md` / `task-naming-convention.md` projections
(which lag, are render-owned, and silently mis-map under fuzzy regex). The
2026-06-13 source-of-truth audit found ~10 gates parsing projections; this moves
close-integrity's three onto the canonical store. See `scripts/lib/task_state.py`.

CLI (called by close-integrity-check.sh):
    close_integrity_canonical.py id-counter   # one failure per line; empty = PASS
    close_integrity_canonical.py fields        # ditto
    close_integrity_canonical.py body          # ditto
    close_integrity_canonical.py --selftest    # exit 0 PASS / 1 FAIL (fixture gate)

The check subcommands always exit 0 — the caller (the close gate) decides PASS/FAIL
on whether any line was printed, matching the existing `[ -z "$out" ]` contract.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import task_state  # noqa: E402  (sibling module in scripts/lib/)

# Non-terminal states that a session is accountable for documenting. inbox is
# excluded (not yet groomed); done is terminal. Mirrors the spirit of the old
# status:(open|queued|in-progress|...) filter, but from canonical state.
OPEN_STATES = {
    "queued", "accepted", "in_progress", "execution_finished",
    "needs_verification", "waiting", "blocked", "failed",
}

# Required on every OPEN task. Split to mirror the old gate's two checks:
#   fields  -> board/identity (was goal+project on the fields line; goal is
#              project-derived, so canonical = project + area). `origin` is NOT
#              required here: it is a newer board field that legacy/migrated tasks
#              legitimately lack, so gating on it would cry wolf every close.
#   body    -> documentation trio (was Why+Plan)
FIELD_KEYS = ("project", "area")
BODY_KEYS = ("summary", "why", "how")


def _numeric(task_id):
    s = str(task_id or "").lstrip("#")
    return int(s) if s.isdigit() else None


def _nonempty(v) -> bool:
    return bool(v is not None and str(v).strip())


# ---- pure check functions (data in -> failure strings out; unit-testable) ----
def id_counter_failures(active_ids, archived_ids, counter):
    """active_ids/archived_ids: lists of ints. counter: int (lastAssigned).

    FAIL when the highest known id exceeds the counter (a real regression — the
    counter must have been hand-edited or a state file reverted), when two ACTIVE
    tasks share an id (the concurrent-alloc race), or when an active id collides
    with an archived id (id reused after archive)."""
    active = [i for i in active_ids if i is not None]
    archived = {i for i in archived_ids if i is not None}
    if not active and not archived:
        return []
    msgs = []
    highest = max(active + list(archived)) if (active or archived) else 0
    if counter is None:
        return ["task-counter.json missing/unreadable lastAssigned — id allocation is unsafe"]
    if highest > counter:
        msgs.append(
            f"counter says #{counter} but highest task id is #{highest} — counter "
            "regressed; alloc-id reads task-counter.json (canonical)"
        )
    active_dupes = sorted({i for i in active if active.count(i) > 1})
    if active_dupes:
        msgs.append(
            f"duplicate IDs among active tasks: {active_dupes} — concurrent-alloc race "
            "(two sessions read the same next-id); renumber the later task via "
            "update-tier1-state.py correct-state, do not blind-close"
        )
    reused = sorted(set(active) & archived)
    if reused:
        msgs.append(
            f"active task IDs collide with archived IDs: {reused} — an id was reused "
            "after archive; renumber the active task to a fresh alloc-id"
        )
    return msgs


def field_failures(tasks):
    out = []
    for t in tasks:
        if t.get("state") not in OPEN_STATES:
            continue
        missing = [k for k in FIELD_KEYS if not _nonempty(t.get(k))]
        if missing:
            out.append(f"{t.get('taskId')}: missing {', '.join(missing)} (canonical tasks.json)")
    return out


def body_failures(tasks):
    out = []
    for t in tasks:
        if t.get("state") not in OPEN_STATES:
            continue
        missing = [k for k in BODY_KEYS if not _nonempty(t.get(k))]
        if missing:
            out.append(f"{t.get('taskId')}: missing {', '.join(missing)} (canonical tasks.json)")
    return out


# ---- canonical loaders (read the real store) -------------------------------
def _repo_root():
    return task_state._repo_root()


def _load_counter():
    path = os.path.join(_repo_root(), "docs/process/state/task-counter.json")
    try:
        with open(path) as f:
            return int(json.load(f).get("lastAssigned"))
    except Exception:
        return None


def _archived_ids():
    root = _repo_root()
    ids = []
    try:
        with open(os.path.join(root, "docs/process/state/tasks.json")) as f:
            doc = json.load(f)
        ids += [_numeric(x) for x in (doc.get("archivedIds") or [])]
    except Exception:
        pass
    try:
        with open(os.path.join(root, "docs/process/state/tasks-archive.json")) as f:
            arch = json.load(f)
        arch_tasks = arch if isinstance(arch, list) else arch.get("tasks", [])
        ids += [_numeric(t.get("taskId")) for t in arch_tasks]
    except Exception:
        pass
    return [i for i in ids if i is not None]


def run(check):
    tasks = task_state.snapshot()
    if check == "id-counter":
        active_ids = [_numeric(t.get("taskId")) for t in tasks]
        return id_counter_failures(active_ids, _archived_ids(), _load_counter())
    if check == "fields":
        return field_failures(tasks)
    if check == "body":
        return body_failures(tasks)
    raise SystemExit(f"unknown check: {check}")


# ---- selftest: clean fixture PASSes, every dirty fixture FAILs --------------
def selftest():
    ok = True

    def expect(label, cond):
        nonlocal ok
        print(("  ok   " if cond else "  FAIL ") + label)
        ok = ok and cond

    def task(tid, state="queued", **kw):
        base = {"taskId": tid, "state": state, "project": "ops", "area": "ops",
                "origin": "ant", "summary": "s", "why": "w", "how": "h"}
        base.update(kw)
        return base

    clean = [task("#100"), task("#101", state="done", project="")]  # done is exempt
    expect("clean: id-counter empty", id_counter_failures([100, 101], [50], 101) == [])
    expect("clean: fields empty", field_failures(clean) == [])
    expect("clean: body empty", body_failures(clean) == [])

    expect("dirty: counter regression flagged",
           id_counter_failures([103], [], 102) != [])
    expect("dirty: active dup-id flagged",
           id_counter_failures([101, 101], [], 200) != [])
    expect("dirty: active∩archived reuse flagged",
           id_counter_failures([51], [51], 200) != [])
    expect("dirty: missing field flagged",
           field_failures([task("#101", project="")]) != [])
    expect("dirty: missing body flagged",
           body_failures([task("#101", why="")]) != [])
    # false-PASS resistance: an OPEN task with no documentation MUST fail.
    naked = {"taskId": "#102", "state": "in_progress"}
    expect("dirty: un-banked/naked open task fails fields+body",
           field_failures([naked]) and body_failures([naked]))

    print("selftest: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def main(argv):
    if not argv:
        raise SystemExit("usage: close_integrity_canonical.py {id-counter|fields|body|--selftest}")
    if argv[0] == "--selftest":
        return selftest()
    for line in run(argv[0]):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
