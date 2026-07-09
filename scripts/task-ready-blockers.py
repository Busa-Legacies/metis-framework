#!/usr/bin/env python3
"""task-ready-blockers.py — Extract canonical blocked-by prerequisites for a task.

Usage:
    python3 scripts/task-ready-blockers.py <exact-task-title-or-#NNN>
    python3 scripts/task-ready-blockers.py <queue-file> <exact-task-title-or-#NNN>
    python3 scripts/task-ready-blockers.py --status <exact-task-title-or-#NNN>
    python3 scripts/task-ready-blockers.py --status <queue-file> <exact-task-title-or-#NNN>
    python3 scripts/task-ready-blockers.py --pending-only <exact-task-title-or-#NNN>

The optional queue-file argument is accepted only for backward-compatible CLI
shape. Prerequisites are resolved only from docs/process/state/tasks.json via
scripts/lib/task_state.py. This avoids projection lag and fuzzy task matching.

Default output prints one prerequisite per line (e.g. "#065"), or nothing if
none. `--status` prints "<taskId>\t<done|not-done>" per prerequisite using the
canonical JSON state. `--pending-only` prints only prerequisites that are not
done in tasks.json. If the task argument is missing, the task id/title does not
resolve canonically, or the canonical store cannot be read, the script exits 3
after printing an error to stderr.
"""
from __future__ import annotations

import os
import pathlib
import sys

_MODE_FLAGS = {"--status", "--pending-only"}


def _looks_like_queue_file(arg: str) -> bool:
    path = pathlib.PurePath(arg)
    return path.suffix.lower() == ".md" or "/" in arg


def _parse_args(argv: list[str]) -> tuple[str, str | None]:
    mode = "plain"
    args = list(argv)

    if args and args[0] == "--":
        args.pop(0)
    elif len(args) > 1 and args[0] in _MODE_FLAGS:
        mode = args.pop(0)

    if not args:
        return mode, None

    if len(args) >= 2 and _looks_like_queue_file(args[0]):
        task_parts = args[1:]
    else:
        task_parts = args

    task_query = " ".join(task_parts).strip()
    return mode, task_query or None


def main(argv: list[str]) -> int:
    mode, task_query = _parse_args(argv)
    if not task_query:
        print("task-ready-blockers: missing task argument", file=sys.stderr)
        return 3

    repo_root = os.environ.get("REPO_ROOT")
    if not repo_root:
        repo_root = str(pathlib.Path(__file__).resolve().parents[1])

    sys.path.insert(0, str(pathlib.Path(repo_root) / "scripts"))
    from lib import task_state  # noqa: E402

    try:
        tasks = task_state.snapshot()
        task_id = task_state.resolve(task_query, tasks)
        if not task_id:
            print(
                f"task-ready-blockers: no canonical task entry found for exact id/title '{task_query}'",
                file=sys.stderr,
            )
            return 3

        prerequisite_statuses = task_state.prerequisite_statuses(task_id, tasks)

        if mode == "--pending-only":
            for blocker, is_done in prerequisite_statuses:
                if not is_done:
                    print(blocker)
            return 0

        if mode == "--status":
            for blocker, is_done in prerequisite_statuses:
                state = "done" if is_done else "not-done"
                print(f"{blocker}\t{state}")
            return 0

        for blocker, _is_done in prerequisite_statuses:
            print(blocker)
        return 0
    except task_state.TaskStateReadError as exc:
        print(f"task-ready-blockers: canonical task state unreadable: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))