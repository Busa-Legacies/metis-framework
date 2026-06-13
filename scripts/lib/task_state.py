"""task_state.py — the one canonical task-state resolver (#348 Stage 0).

Every gate that needs "what is the current state of task X" must read it HERE,
from docs/process/state/tasks.json (the single source of truth) — never from the
task-queue.md / OPEN_TASKS.md / projects.md projections (which lag and are
render-owned), and never via fuzzy substring matching (which silently mis-maps,
e.g. "#31" onto "#313", or a partial slug onto the wrong task).

The 2026-06-13 audit found ~10 gates resolving current task state from the
markdown projection or fuzzy heuristics, producing wrong PASS/FAIL/BLOCK/DISPATCH
verdicts. This is the foundation that the consumer refactors (task-ready,
task-domain, board-done, close-integrity) build on — those are staged follow-on
tasks minted once this lands.

API (all read-only; each accepts a taskId, a bare/leading id token, or an exact
title, and returns None / [] for anything that doesn't resolve):

    resolve(label_or_id) -> "#NNN" | None   exact taskId first, then exact title;
                                             NO fuzzy substring match
    state(id)            -> str  | None      canonical state string
    is_done(id)          -> bool             True iff canonical state == "done"
    doneWhen(id)         -> dict | None       the doneWhen object, if any
    fields(id)           -> dict | None       a copy of the full task record
    blockers(id)         -> list[str]        prerequisite taskIds (#NNN) declared
                                             in the canonical blockerOrNone field

Path resolution honours REPO_ROOT > METIS_HOME > self-locate so a sandboxed
caller pinned via REPO_ROOT reads the CANONICAL store rather than its sandbox
copy (feedback_repo_root_env_split_brain). tasks.json is re-read on every call,
so a projection lagging behind the JSON never masks the true state.
"""
from __future__ import annotations

import json
import os
import re

_DONE_STATES = {"done"}

# A label is treated as an id reference only when it is a bare id or an id
# followed by a word boundary ("#347", "347", "#347 — slug"). This deliberately
# refuses to treat "#31" as matching "#313" and refuses "#347x".
_LEADING_ID_RE = re.compile(r"^#?(\d+)(?:\b|$)")
_ID_IN_TEXT_RE = re.compile(r"#(\d+)")


def _repo_root() -> str:
    return (
        os.environ.get("REPO_ROOT")
        or os.environ.get("METIS_HOME")
        or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    )


def _tasks_json_path() -> str:
    return os.path.join(_repo_root(), "docs/process/state/tasks.json")


def _load() -> list:
    """Return the canonical task list, or [] on any read/parse error (fail open
    so a transiently-unreadable store can't wedge every gate that calls in)."""
    try:
        with open(_tasks_json_path()) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    if isinstance(data, dict):
        return data.get("tasks", []) or []
    return data if isinstance(data, list) else []


def resolve(label_or_id, tasks=None):
    """Map a label or id to a canonical taskId. Exact id first, then exact title.
    Returns None if nothing resolves exactly — never a fuzzy/substring guess."""
    if tasks is None:
        tasks = _load()
    if not label_or_id:
        return None
    s = str(label_or_id).strip()
    if not s:
        return None
    # 1) exact taskId, via a leading/bare id token
    m = _LEADING_ID_RE.match(s)
    if m:
        cand = f"#{m.group(1)}"
        for t in tasks:
            if t.get("taskId") == cand:
                return cand
    # 2) exact title (full-string equality — substrings do NOT resolve)
    for t in tasks:
        if t.get("title") == s:
            return t.get("taskId")
    return None


def _record(label_or_id, tasks):
    tid = resolve(label_or_id, tasks)
    if tid is None:
        return None
    for t in tasks:
        if t.get("taskId") == tid:
            return t
    return None


def fields(id, tasks=None):
    """A copy of the full canonical task record, or None."""
    tasks = _load() if tasks is None else tasks
    rec = _record(id, tasks)
    return dict(rec) if rec else None


def state(id, tasks=None):
    """Canonical state string, or None if the task doesn't resolve."""
    tasks = _load() if tasks is None else tasks
    rec = _record(id, tasks)
    return rec.get("state") if rec else None


def is_done(id, tasks=None):
    """True iff the task's canonical state is terminal-done."""
    return state(id, tasks) in _DONE_STATES


def doneWhen(id, tasks=None):
    """The task's doneWhen object, or None."""
    tasks = _load() if tasks is None else tasks
    rec = _record(id, tasks)
    return rec.get("doneWhen") if rec else None


def blockers(id, tasks=None):
    """Prerequisite taskIds (#NNN) declared in the canonical blockerOrNone field.
    'none'/empty -> []. Order-preserving, de-duped. (Matches the queue-runner
    prereq gate's parse, #347.)"""
    tasks = _load() if tasks is None else tasks
    rec = _record(id, tasks)
    if not rec:
        return []
    bo = rec.get("blockerOrNone")
    if not bo or str(bo).strip().lower() in ("none", ""):
        return []
    out = []
    for n in _ID_IN_TEXT_RE.findall(str(bo)):
        tid = f"#{n}"
        if tid not in out:
            out.append(tid)
    return out
