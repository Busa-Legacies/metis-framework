---
name: Build
slug: build
version: 1.0.0
description: "Research-first build gate — scout best practices first, then route to smith for implementation. Enforces the plan gate for non-trivial work."
argument-hint: "[feature]"
---

TRIGGER when: building any non-trivial feature, integration, config change, or refactor.
DO NOT trigger for: mechanical one-file edits (just route to smith directly).

## Pre-flight
If `$ARGUMENTS` is empty, stop: `Usage: /build <feature or task description>`.

## Step 0 — Plan gate (non-trivial work)
Check for an approved plan first:
```bash
ls docs/plans/PLAN-*.md 2>/dev/null | xargs grep -l "Status:.*approved" 2>/dev/null
```
- **Approved plan matches this task** → read it; its Approach + Steps drive the smith prompt in Step 3. Skip the redundant scout pass. **Premortem check:** if this task qualifies under `docs/process/premortem-standard.md` (tier≥T1, blast-radius, or a buildout/migration/integration), the plan must contain a filled `## Premortem` block — if it's missing, treat the plan as not-yet-approved and add the premortem before building.
- **No approved plan + feature/integration/non-trivial refactor** → STOP; recommend `/plan <task>` first (the #065 "guessed the stack, build failed" guard). For **qualifying big work**, the scout pass in Step 2 runs as a **premortem pass** ("assume it shipped and failed — what killed it?") whose output fills the `## Premortem` block. Proceed without a plan only if the user explicitly says to.
- **Mechanical edits** → skip this gate entirely.

## Step 1 — Classify the task
- **Mechanical edit** (rename, format, add a flag, one-line fix) → print `→ Routing directly to smith (mechanical task)` and jump to Step 3.
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

Ask: `Proceed to smith with this approach? (yes / adjust / skip smith)`. Wait for the answer. If **adjust**, take direction and refine the smith prompt. If **skip smith**, stop — the research was the output.

**Unattended mode** (autopilot, `dontAsk`, or `OPENCLAW_UNATTENDED=1`): the question above auto-proceeds, so the scout artifact must be verified by the arbiter instead of a human before smith consumes it (#5460). Save the scout output to a file and run:
```bash
python3 scripts/hop-verify.py --stage scout --goal "<the research question>" --artifact /tmp/scout-out.md --hop-id "<task id>:scout"
```
- exit `0` → proceed to Step 3.
- exit `2` → re-run scout ONCE with the printed `ITERATE_PROMPT` appended, re-verify; a second `2` stops the chain.
- exit `3` (reject) or `4` (arbiter unreachable, fail-closed) → stop; report the artifact + verdict. Never build on an unverified intermediate.
The same gate applies to any fork→fork handoff in unattended work: `--stage fork --artifact <the on-disk output the next fork would read>`.

## Step 3 — Smith implementation
Construct a precise smith prompt incorporating `$ARGUMENTS` + the recommended approach + relevant constraints/file paths:
```bash
openclaw agent --agent smith --message "<implementation prompt>" --json --timeout 180 --thinking off \
  | python3 -c "
import json, sys
raw = sys.stdin.read(); start = raw.find('{')
if start == -1: print('ERROR: no JSON'); sys.exit(1)
try:
    d = json.loads(raw[start:]); print(d['result']['payloads'][0]['text'])
except Exception as e: print(f'ERROR: {e}')
"
```
Show output under `**smith →**`.

## Step 4 — Apply decision
- **File content or code** → ask `Apply this? (yes / no / specify path)` before touching any files.
- **Plan or prose** → ask `Proceed with this?` before acting.
- **Error** → report clearly; suggest `/jay-health` to diagnose.

## Notes
- Run scout and smith **sequentially** — never in parallel (single Ollama model).
- Large context: write a handoff file first: `cat <files> > ~/metis-os/workspace/HANDOFF-$(date +%Y%m%d).md` and reference the path in the message.
