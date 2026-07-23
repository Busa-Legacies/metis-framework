---
name: Add Task
slug: add-task
version: 1.0.0
description: "Create a new governed task in tasks.json and project it to the board. Task description: $ARGUMENTS"
---

Tasks are **born governed** (#098): `docs/process/state/tasks.json` is the single source of truth. `task-queue.md` is a rendered projection; never hand-edit its governed section. Every task carries three mandatory documentation fields: **what**, **why**, and **how**.

## Pre-flight
If `$ARGUMENTS` is empty: `Usage: /add-task <task description>`. Stop.

## Step 1: Dedup check (never skip)
Confirm this task isn't already owned or done:
```bash
python3 scripts/free-work.py
```
Also grep `docs/process/task-queue.md` + `workspace/state/OPEN_TASKS.md` for the label/area.

- **CLAIMED / WIP** (active lease) → stop; tell the user another session owns it
- **queued** → stop; point them at the existing ID instead of adding a duplicate
- **done** (`[x]` / completed) → ask whether to reopen rather than creating a duplicate

Only proceed if no live match exists.

## Step 2: Assign an ID (atomic, #095)
```bash
python3 scripts/agent-work.py alloc-id
```
Prints zero-padded `NNN` (use as `#NNN`), bumps `task-counter.json` under exclusive lock, and mirrors the human-readable counter in `task-naming-convention.md`, atomically. Use `alloc-id --peek` to preview without consuming. **Never hand-edit the counter. Never reuse an ID.**

## Step 3: Gather required fields
See `task-fields-reference.md` in this skill directory for the exact gather prompt and all field definitions. For the **live** required-field list and every valid enum value (area, project, agent, machine, domain, state, doneWhen type) read straight from the canonical sources, run `python3 scripts/update-tier1-state.py schema`.

**What, Why, and How are always required, no exceptions.** If you can't answer them, don't write the task yet. If `$ARGUMENTS` already contains enough context to infer fields, pre-fill them and ask only about what's ambiguous.

## Step 4: Create the governed task
See `task-fields-reference.md` for the exact JSON patch template.

```bash
python3 scripts/update-tier1-state.py create-task --actor claude --patch '<json>'
```

The helper validates the shape and rejects a missing `summary`/`why`/`how`. Preview with `--check` (validates + prints, **no write, no commit**) before the real run if unsure.

**This one command now does everything atomically** (#447): it writes the canonical task, **renders every projection** (`task-queue.md`, `live-status.md`, `projects.md`, **and the `OPEN_TASKS.md` board**; all owned by `render-tier1-state.py` between the `<!-- GOVERNED:START -->` / `<!-- GOVERNED:END -->` anchors), then **commits the governed state under the auto-sync lock**. The commit is the long-term fix for the vanished-task bug: a task left uncommitted could be wiped by a daemon sync (reset/stash-pop/prune) before the next checkpoint; the `taskstate` merge driver only protects *committed* blobs. Pass `--no-commit` only when batching many creates that you'll commit once at the end.

## Step 5: (automatic) board + projections
No manual edit needed. The render in Step 4 regenerates the `OPEN_TASKS.md` governed block and `task-queue.md` from `tasks.json`; hand-edits between the GOVERNED anchors are overwritten. (Only non-governed prose, e.g. a header note, should ever be edited by hand.)

## Step 6: Confirm
```
✓ Task created (governed + committed):

ID:       #NNN
Slug:     slug
Priority: P? · Owner: Y · State: queued
Canonical:  docs/process/state/tasks.json
Projection: docs/process/task-queue.md + workspace/state/OPEN_TASKS.md (rendered)
Committed:  yes — durable under the sync lock (daemon pushes on its next tick)
```

The task is already committed and clobber-proof; no `/checkpoint` needed to bank it. (If you saw `NOTE: sync lock busy — commit deferred…`, the write still succeeded; the daemon will commit it within one tick.)
