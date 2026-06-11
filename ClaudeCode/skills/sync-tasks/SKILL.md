---
name: Sync Tasks
slug: sync-tasks
version: 1.0.0
description: "Reconcile drift between task-queue.md and OPEN_TASKS.md — mark done items complete, surface orphans and missing entries."
---

## What this fixes
OPEN_TASKS.md and task-queue.md drift apart over time: tasks get marked done in one but not the other, or disappear from the queue without being closed on the board.

## Step 1 — Read both files
```bash
cat ~/metis-os/docs/process/task-queue.md
cat ~/metis-os/Jay/state/OPEN_TASKS.md
```

## Step 2 — Find done-in-queue, open-on-board
Scan task-queue.md for entries with `status:done` or `✅ DONE` / `✓ DONE`. Use **line-by-line matching** — a line must contain both the task label AND a DONE marker on the same line. Do NOT use a multi-line/DOTALL regex (causes false positives).

```python
import re
queue = open("...task-queue.md").read()
board = open("...OPEN_TASKS.md").read()

done_line = re.compile(r'\*\*(?:T-[A-Z]+-\d+\s*[—–-]\s*)?(.+?)\*\*.*?[✅✓]\s*DONE')
done_labels = set()
for line in queue.splitlines():
    m = done_line.search(line)
    if m:
        done_labels.add(m.group(1).strip().lower())
```

For each match found with `[ ]` (open) in OPEN_TASKS.md: change `[ ]` → `[x]`.

## Step 3 — Find open-in-queue entries missing from board
Scan task-queue.md for `status:open` / `status:queued` / `status:in-progress` entries. Check if each has a corresponding entry in OPEN_TASKS.md. Report missing ones — do NOT auto-add (may be intentionally absent), just list them.

## Step 4 — Find board entries with no queue record
Scan OPEN_TASKS.md for `[ ]` entries with no corresponding task-queue.md entry. List them for the user to decide whether to add to the queue.

## Step 5 — Report and apply
Print summary before changes:
```
TASK SYNC REPORT

✓ Fixed ([ ] → [x] in OPEN_TASKS.md):
  - #NNN slug

⚠ In queue (queued) but missing from board:
  - #NNN slug  (not auto-added)

⚠ On board but not in queue:
  - "label"  (no action taken)

No changes yet. Apply fixes to OPEN_TASKS.md? (yes/no)
```

Wait for confirmation before writing. After applying: `✓ OPEN_TASKS.md updated — <N> items closed.`

Do NOT commit — leave that to the next `/checkpoint`.
