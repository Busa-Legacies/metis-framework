---
name: Plan
slug: plan
version: 1.0.0
description: "Produce a durable, reviewable build plan (docs/plans/PLAN-<slug>.md): inspect the repo FIRST, scout best practices, write the ordered plan that /build gates on. Task: $ARGUMENTS"
---

TRIGGER when: starting any feature/integration/refactor/buildout big enough that jumping straight to code risks wrong assumptions (the #065 "guessed Jekyll, actual Astro" class of failure), or when `/build` refuses for lack of a plan.
DO NOT trigger for: a mechanical one-file edit, or pure research with no build to follow.

## Pre-flight
If `$ARGUMENTS` is empty, stop: `Usage: /plan <task description or #NNN>`.
Resolve a short kebab `<slug>` from the task title (and `#NNN` id if it maps to a governed task).

## Step 1: Inspect the repo FIRST (non-negotiable)
Before any planning, **read the actual code/config** the task touches. This is the step #065 skipped; do not infer the stack, framework, or current behavior from memory or naming:
- Glob/Read relevant files; identify the real framework, entry points, existing patterns.
- Note what already exists that the task should reuse or extend rather than rebuild.
- If the task names files/paths that don't exist, surface that now.

These findings become the **Current state** section of the plan. A plan written without this step is worthless.

## Step 2: Scout research pass
Frame a targeted research question (approach, patterns, library/API choices, gotchas; not implementation detail):
```bash
openclaw agent --agent scout --message "<research question from $ARGUMENTS + Step 1 findings>" --json --timeout 180 --thinking off \
  | python3 -c "
import json, sys
raw = sys.stdin.read(); start = raw.find('{')
if start == -1: print('ERROR: no JSON'); sys.exit(1)
try:
    d = json.loads(raw[start:]); print(d['result']['payloads'][0]['text'])
except Exception as e: print(f'ERROR: {e}')
"
```
Show findings under `**scout →**`. If scout errors, note it and proceed on best judgment; a plan can still be written, just flag the research gap.

## Step 3: Draft the plan artifact
Write `docs/plans/PLAN-<slug>.md` using the template in `plan-template.md` in this skill directory.

Keep each section tight; a plan is a decision record for a build, not an essay.

## Step 4: Review gate
Present the drafted plan inline and pause:
`Plan written to docs/plans/PLAN-<slug>.md. Approve as-is, adjust, or discard? (approve / adjust / discard)`

- **approve** → change `**Status:**` to `approved`. The plan is now the contract `/build` gates on.
- **adjust** → take direction, revise, re-present.
- **discard** → delete the draft; the research still stands in this session.

Do not generate or apply any implementation in this skill; `/plan` ends at an approved plan. Hand the actual build to `/build`.

## Step 5: Link it to the task
If the task is governed (`#NNN`), record the plan path so `/build` and future sessions find it:
```bash
python3 scripts/update-tier1-state.py task-update --task-id "#NNN" --expected-revision <r> \
  --actor "claude@<machine>" \
  --patch '{"mainFiles":[...,"docs/plans/PLAN-<slug>.md"],"verificationMethod":"<from plan Done-when>"}'
```

## Filing & lifecycle
- Plans live in `docs/plans/`, never loose in `docs/process/` (which is for live standards).
- Once the task is `done`, the plan is a superseded plan → RETIRE candidate for `/file`.
- Do not commit here; leave the commit to `/checkpoint`.
