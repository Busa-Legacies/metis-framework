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

API (all read-only; each accepts a taskId, a bare id token, or an exact
title, and returns None / [] for anything that doesn't resolve):

    snapshot()                -> list[dict]              fresh canonical task list
    resolve(label_or_id)      -> "#NNN" | None           exact taskId first, then
                                                        exact title; NO fuzzy match
    state(id)                 -> str | None              canonical state string
    is_done(id)               -> bool                    True iff canonical state
                                                        == "done"
    doneWhen(id)              -> dict | None             the doneWhen object, if any
    fields(id)                -> dict | None             a copy of the full task record
    blockers(id)              -> list[str]               prerequisite taskIds (#NNN)
                                                        declared in blockerOrNone;
                                                        unresolved ids are preserved
    prerequisite_statuses(id) -> list[tuple[str, bool]] canonical blocker state pairs

Board-sync helpers (still canonical/read-only at the source; they only transform
the caller's markdown text):

    resolve_board_row(row)    -> "#NNN" | None           strict row -> taskId
    sync_checkbox(line, done) -> str                     replace only the checkbox,
                                                        preserving trailing newlines
    sync_board_line(line)     -> str                     canonicalize one board row
    sync_board_lines(lines)   -> list[str]               canonicalize many rows
    sync_board_text(text)     -> str                     canonicalize a full document

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


class TaskStateReadError(RuntimeError):
    """The canonical task store could not be read or parsed."""


# Resolve ids only when the whole query is an id token ("#347" or "347").
# This deliberately rejects fuzzy forms like "#31x" while still allowing
# exact titled labels that start with a canonical id token.
_EXACT_ID_RE = re.compile(r"^#?(\d+)$")
_LEADING_ID_RE = re.compile(r"^#?(\d+)(?=\s+[-–—:])")
_ID_IN_TEXT_RE = re.compile(r"(?<![A-Za-z0-9_])#(\d+)(?![A-Za-z0-9_])")
_CANONICAL_ID_RE = re.compile(r"^#(\d+)$")
_CHECKBOX_LINE_RE = re.compile(r"^(\s*[-*]\s+\[)([ xX])(\]\s+)(.*)$")
_ID_PREFIX_TITLE_RE = re.compile(r"^#\d+\s*[-:]\s*(.+?)\s*$")


def _repo_root() -> str:
    return (
        os.environ.get("REPO_ROOT")
        or os.environ.get("METIS_HOME")
        or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    )


def _tasks_json_path() -> str:
    return os.path.join(_repo_root(), "docs/process/state/tasks.json")


def _unexpected_structure_error() -> TaskStateReadError:
    path = _tasks_json_path()
    return TaskStateReadError(
        f"unexpected top-level JSON structure in {path}; expected a top-level list "
        "or an object with a 'tasks' list"
    )


def _load() -> list:
    """Return the canonical task list.

    Missing tasks.json returns an empty list so callers do not fall back to stale
    projections; malformed/unreadable tasks.json still raises TaskStateReadError.
    """
    try:
        with open(_tasks_json_path()) as f:
            data = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        raise TaskStateReadError(str(exc)) from exc

    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        if "tasks" not in data:
            raise _unexpected_structure_error()
        tasks = data["tasks"]
        if not isinstance(tasks, list):
            raise _unexpected_structure_error()
        return tasks

    raise _unexpected_structure_error()


def _task_numeric_id(task_id):
    if not task_id:
        return None
    m = _CANONICAL_ID_RE.match(str(task_id).strip())
    if not m:
        return None
    return int(m.group(1))


def _split_trailing_newline(text):
    if text.endswith("\r\n"):
        return text[:-2], "\r\n"
    if text.endswith("\n"):
        return text[:-1], "\n"
    return text, ""


def _find_task_by_task_id(task_id, tasks):
    for task in tasks:
        if task.get("taskId") == task_id:
            return task
    return None


def snapshot():
    """Fresh canonical task snapshot for callers that want one consistent read."""
    return _load()


def resolve(label_or_id, tasks=None):
    """Map a label or id to a canonical taskId.

    Resolution is intentionally strict:
      1) exact taskId ("#347" or "347")
      2) leading canonical taskId token in a titled label ("#347 — title" or "347 - title")
      3) exact title only (full-string equality)

    Returns None if nothing resolves exactly — never a fuzzy/substring guess.
    """
    if tasks is None:
        tasks = _load()
    if not label_or_id:
        return None
    s = str(label_or_id).strip()
    if not s:
        return None

    m = _EXACT_ID_RE.match(s)
    if m:
        digits = int(m.group(1))
        exact = f"#{m.group(1)}"
        exact_task = _find_task_by_task_id(exact, tasks)
        if exact_task is not None:
            return exact
        for task in tasks:
            task_id = task.get("taskId")
            if _task_numeric_id(task_id) == digits:
                return task_id

    m = _LEADING_ID_RE.match(s)
    if m:
        exact = f"#{m.group(1)}"
        exact_task = _find_task_by_task_id(exact, tasks)
        if exact_task is not None:
            return exact

    for task in tasks:
        if task.get("title") == s:
            return task.get("taskId")
    return None


def _record(label_or_id, tasks):
    tid = resolve(label_or_id, tasks)
    if tid is None:
        return None
    return _find_task_by_task_id(tid, tasks)


def _board_row_candidates(row_text):
    raw = str(row_text).strip()
    if not raw:
        return []

    candidates = []
    seen = set()

    def add(value):
        if value is None:
            return
        s = str(value).strip()
        if not s or s in seen:
            return
        seen.add(s)
        candidates.append(s)

    add(raw)

    id_matches = _ID_IN_TEXT_RE.findall(raw)
    if len(id_matches) == 1:
        add(f"#{id_matches[0]}")

    title_match = _ID_PREFIX_TITLE_RE.match(raw)
    if title_match:
        add(title_match.group(1))

    return candidates


def resolve_board_row(row, tasks=None):
    """Resolve a markdown board row to a canonical taskId, or None.

    This is intentionally strict. We try only exact candidates derived from the
    row text: the full label, a single standalone #NNN token if present, and the
    title segment of "#NNN - exact title" / "#NNN: exact title". No fuzzy match.
    """
    tasks = _load() if tasks is None else tasks

    body, _newline = _split_trailing_newline(str(row))
    match = _CHECKBOX_LINE_RE.match(body)
    candidate_text = match.group(4) if match else body

    for candidate in _board_row_candidates(candidate_text):
        tid = resolve(candidate, tasks)
        if tid is not None:
            return tid
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

    'none'/empty -> []. Order-preserving, de-duped. If blockerOrNone names a
    #NNN that is not present in tasks.json, the canonical-looking id token is
    still returned so readiness gates treat it as unresolved/not-done instead of
    silently dropping the dependency. (Matches the queue-runner prereq gate's
    parse, #347.)
    """
    tasks = _load() if tasks is None else tasks
    rec = _record(id, tasks)
    if not rec:
        return []
    bo = rec.get("blockerOrNone")
    if not bo or str(bo).strip().lower() in ("none", ""):
        return []
    out = []
    for n in _ID_IN_TEXT_RE.findall(str(bo)):
        tid = resolve(n, tasks) or f"#{n}"
        if tid not in out:
            out.append(tid)
    return out


def prerequisite_statuses(id, tasks=None):
    """Return canonical prerequisite done-state pairs for a task.

    Each item is (<blockerTaskId>, <isDone>). This intentionally reads blocker
    membership and blocker completion from tasks.json so stale markdown
    projections cannot flip a ready/not-ready decision.
    """
    tasks = _load() if tasks is None else tasks
    prereqs = blockers(id, tasks)
    return [(blocker, is_done(blocker, tasks)) for blocker in prereqs]


def sync_checkbox(line, done):
    """Return a markdown task line with its checkbox synced to `done`.

    Only the checkbox token is rewritten. Any trailing newline is preserved
    exactly so document-level callers do not accidentally collapse lines.
    """
    body, newline = _split_trailing_newline(str(line))
    match = _CHECKBOX_LINE_RE.match(body)
    if not match:
        return str(line)
    checked = "x" if done else " "
    synced = f"{match.group(1)}{checked}{match.group(3)}{match.group(4)}"
    return synced + newline


def sync_board_line(line, tasks=None):
    """Sync one markdown board row from canonical tasks.json state.

    Resolved rows are rewritten from canonical done/open state. Unresolved rows
    are left untouched so free-text notes or non-task bullets survive as-is.
    """
    tasks = _load() if tasks is None else tasks
    tid = resolve_board_row(line, tasks)
    if tid is None:
        return str(line)
    return sync_checkbox(line, is_done(tid, tasks))


def sync_board_lines(lines, tasks=None):
    """Sync an iterable of markdown lines from canonical tasks.json state."""
    tasks = _load() if tasks is None else tasks
    return [sync_board_line(line, tasks) for line in lines]


def sync_board_text(text, tasks=None):
    """Sync a markdown board document from canonical tasks.json state."""
    tasks = _load() if tasks is None else tasks
    lines = str(text).splitlines(keepends=True)
    return "".join(sync_board_lines(lines, tasks))
