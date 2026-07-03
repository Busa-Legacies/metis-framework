#!/usr/bin/env python3
"""task-ready-blockers.py — Extract blocked-by prerequisites for a task.

Checks both:
  - "Blocked by: #NNN" field lines
  - @blocked-by:#NNN inline tags

Usage: python3 scripts/task-ready-blockers.py <queue-file> <task-label>
Prints one prerequisite per line (e.g. "#065"), or nothing if none.
"""
import re, sys, pathlib

if len(sys.argv) < 3:
    sys.exit(0)

queue = pathlib.Path(sys.argv[1])
task_query = re.sub(r"^#\d+\s*", "", sys.argv[2].lower().strip())

if not queue.exists():
    sys.exit(0)

found_task = False
blockers = []

with open(queue) as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    m = re.search(r"\*\*([^*]+)\*\*", line)
    if m and not found_task:
        label = re.sub(r"^#\d+\s*`?", "", m.group(1).strip().lower().rstrip("`"))
        if task_query in label or label in task_query:
            found_task = True
        continue

    if found_task:
        if re.match(r"^- \*\*", line) and i > 0:
            break
        # "Blocked by: #NNN" field
        fm = re.match(r"\s+- \*\*Blocked by:\*\* (.+)", line)
        if fm:
            blockers.extend(re.findall(r"#\d+", fm.group(1)))
        # @blocked-by:#NNN inline tag
        for tag in re.findall(r"@blocked-by:(#\d+)", line):
            if tag not in blockers:
                blockers.append(tag)

for b in blockers:
    print(b)
