---
name: Build
slug: build
version: 1.0.0
description: Research-first build gate — scout best practices first, then route to forge for implementation. Enforces the plan gate for non-trivial work. Feature: $ARGUMENTS
---

TRIGGER when: building any non-trivial feature, integration, config change, or refactor.
DO NOT trigger for: mechanical one-file edits (just route to forge directly).

## Pre-flight
If `$ARGUMENTS` is empty, stop: `Usage: /build <feature or task description>`.

## Step 0 — Plan gate (non-trivial work)
Check for an approved plan first:
```bash
ls docs/plans/PLAN-*.md 2>/dev/null | xargs grep -l "Status:.*approved" 2>/dev/null
```
- **Approved plan matches this task** → read it; its Approach + Steps drive the forge prompt in Step 3. Skip the redundant scout pass.
- **No approved plan + feature/integration/non-trivial refactor** → STOP; recommend `/plan <task>` first (the #065 "guessed the stack, build failed" guard). Proceed without a plan only if the user explicitly says to.
- **Mechanical edits** → skip this gate entirely.

## Step 1 — Classify the task
- **Mechanical edit** (rename, format, add a flag, one-line fix) → print `→ Routing directly to forge (mechanical task)` and jump to Step 3.
- **Non-trivial** (new feature, integration, config change, refactor, anything where approach matters) → run scout first. Unless Step 0 already supplied an approved plan — in that case, go to Step 3.

## Step 2 — Scout research pass
Frame a targeted research question (approach, patterns, library choices, gotchas — not implementation detail):
```bash
openclaw agent --agent scout --message "<research question from $ARGUMENTS>" --json --timeout 180 --thinking off \
  | python3 -c "
import json, sys
raw = sys.stdin.read(); start = raw.find('{')
if start == -1: print('ERROR: no JSON'); sys.exit(1)
try:
    d = json.loads(raw[start:]); print(d['result']['payloads'][0]['text'])
except Exception as e: print(f'ERROR: {e}')
"
```
Show findings under `**scout →**`.

Pause and present a short decision summary:
- Key findings (1-3 bullets)
- Recommended approach based on findings
- Significant tradeoffs or gotchas

Ask: `Proceed to forge with this approach? (yes / adjust / skip forge)`. Wait for the answer. If **adjust**, take direction and refine the forge prompt. If **skip forge**, stop — the research was the output.

## Step 3 — Forge implementation
Construct a precise forge prompt incorporating `$ARGUMENTS` + the recommended approach + relevant constraints/file paths:
```bash
openclaw agent --agent forge --message "<implementation prompt>" --json --timeout 180 --thinking off \
  | python3 -c "
import json, sys
raw = sys.stdin.read(); start = raw.find('{')
if start == -1: print('ERROR: no JSON'); sys.exit(1)
try:
    d = json.loads(raw[start:]); print(d['result']['payloads'][0]['text'])
except Exception as e: print(f'ERROR: {e}')
"
```
Show output under `**forge →**`.

## Step 4 — Apply decision
- **File content or code** → ask `Apply this? (yes / no / specify path)` before touching any files.
- **Plan or prose** → ask `Proceed with this?` before acting.
- **Error** → report clearly; suggest `/jay-health` to diagnose.

## Notes
- Run scout and forge **sequentially** — never in parallel (single Ollama model).
- Large context: write a handoff file first: `cat <files> > ~/metis-os/Jay/HANDOFF-$(date +%Y%m%d).md` and reference the path in the message.
