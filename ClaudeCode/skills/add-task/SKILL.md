---
name: Add Task
slug: add-task
version: 1.0.0
description: "Create a new governed task in tasks.json and project it to the board. Task description: $ARGUMENTS"
---

Tasks are **born governed** (#098): `docs/process/state/tasks.json` is the single source of truth. `task-queue.md` is a rendered projection — never hand-edit its governed section. Every task carries three mandatory documentation fields: **what**, **why**, and **how**.

## Pre-flight
If `$ARGUMENTS` is empty: `Usage: /add-task <task description>`. Stop.

## Step 1 — Dedup check (never skip)
Confirm this task isn't already owned or done:
```bash
python3 scripts/free-work.py
```
Also grep `docs/process/task-queue.md` + `workspace/state/OPEN_TASKS.md` for the label/area.

- **CLAIMED / WIP** (active lease) → stop; tell the user another session owns it
- **queued** → stop; point them at the existing ID instead of adding a duplicate
- **done** (`[x]` / completed) → ask whether to reopen rather than creating a duplicate

Only proceed if no live match exists.

## Step 2 — Assign an ID (atomic — #095)
```bash
python3 scripts/agent-work.py alloc-id
```
Prints zero-padded `NNN` (use as `#NNN`), bumps `task-counter.json` under exclusive lock, and mirrors the human-readable counter in `task-naming-convention.md` — atomically. Use `alloc-id --peek` to preview without consuming. **Never hand-edit the counter. Never reuse an ID.**

## Step 3 — Gather required fields
See `task-fields-reference.md` in this skill directory for the exact gather prompt and all field definitions.

**What, Why, and How are always required — no exceptions.** If you can't answer them, don't write the task yet. If `$ARGUMENTS` already contains enough context to infer fields, pre-fill them and ask only about what's ambiguous.

## Step 4 — Create the governed task
See `task-fields-reference.md` for the exact JSON patch template.

```bash
python3 scripts/update-tier1-state.py create-task --actor claude --patch '<json>'
```

The helper validates the shape and rejects a missing `summary`/`why`/`how`. Preview with `--check` (validates + prints, no write) before the real run if unsure.

Then render the projection so `task-queue.md` reflects the new task:
```bash
python3 scripts/render-tier1-state.py write
```
Do NOT hand-write the `## Inbox` / `## Queued` blocks — `render-tier1-state.py` owns the governed section between `<!-- GOVERNED:START -->` / `<!-- GOVERNED:END -->` anchors.

## Step 5 — Mirror to the dashboard board
`workspace/state/OPEN_TASKS.md` is the dashboard board — a projection, not a second source of truth. Append:
```
- [P?] [ ] **#NNN slug** — brief context note @agent:X @machine:Y
```
Find the target section by `## <area>` header; add one if none fits.

## Step 6 — Confirm
```
✓ Task created (governed):

ID:       #NNN
Slug:     slug
Priority: P? · Owner: Y · State: queued
Canonical: docs/process/state/tasks.json
Projection: docs/process/task-queue.md (rendered)
Board:     workspace/state/OPEN_TASKS.md
```

Do NOT commit — the auto-sync daemon will pick it up, or the user can commit at their next /checkpoint.
