---
name: Fix Bug
slug: fix
version: 1.0.0
description: "Fix a bug through a quality-controlled workflow — reproduce, find root cause, fix (never a band-aid), verify empirically, route the lesson. Bug: $ARGUMENTS"
---

TRIGGER when: something is broken/misbehaving, or a task is a bug fix.
DO NOT trigger for: a feature/buildout (use /plan→/build), a trivial typo (just fix it), or a flaky-tooling artifact you haven't confirmed is a real defect.

Bug-fixing is **inline Claude work** — it's the runtime-debugging exception to Jay-routing (needs live tool calls + session error context). You may dispatch a research sub-question to scout, but the debugging loop itself stays inline.

## Pre-flight
If `$ARGUMENTS` is empty: `Usage: /fix <what's broken — symptom, error, or #NNN>`.
If the bug maps to a governed task `#NNN`, note it — the lesson-routing in Step 6 may patch it.

## Step 1 — Reproduce first (non-negotiable)
Establish a deterministic trigger before changing anything:
- Run the exact failing command / path. Capture the error text, exit code, and wrong output verbatim — this is your before/after baseline.
- **Rule out flaky tooling before assuming a defect.** Garbled or truncated tool output is a transport fault, not data — re-run and confirm the failure is real and repeatable. Never debug a phantom or fabricate a cause from one noisy run.
- If genuinely unreproducible: say so, capture what you tried, and stop — do not "fix" by guessing. An unreproducible bug becomes a logged task with repro attempts, not a speculative patch.

## Step 2 — Investigate the root cause (trace every layer)
Trace the failure to its actual origin — not the first plausible-looking line:
- Read the actual code in the failure path; follow the data/control flow back from the symptom to the decision that's wrong.
- Ask "why" past the first answer: the symptom is usually downstream of the defect. Stop only when the next "why" leaves the code you control.
- Note every contributing layer — a partial fix on one layer leaves the bug alive on another.

## Step 3 — Diagnose out loud
Before editing, state the root cause explicitly: *"The bug is X, because Y; the symptom Z is downstream of it."* If you can't articulate the mechanism, you haven't found the root cause — return to Step 2. This sentence makes the fix reviewable and becomes the **why** in Step 6's log.

## Step 4 — Fix the root cause (no band-aids)
Apply the fix at the root, per the fix-quality spectrum:

> cheap/band-aid **(forbidden)** < inexpensive-but-effective *(acceptable when a full fix isn't warranted)* < full-and-complete **(the default aim)**

- **Never** present a symptom-suppressing fix as the solution. Don't even offer the cheap option in a list — surfacing "just silence it" as a lightweight alternative is itself the dodge.
- **Keep signals honest.** Exit codes, error states, and statuses must reflect what actually happened. Never make something *report* success it didn't achieve.
- Fix every layer Step 2 surfaced, not just the one nearest the symptom.

## Step 5 — Verify empirically (observe, don't assert)
Re-run the Step 1 reproduction and **watch it pass**. Claiming a fix works without observing it is not allowed.
- Confirm the original symptom is gone AND check for regressions in the surrounding behavior.
- Verify the **real outcome** — response bodies not just HTTP status, actual file contents not just exit 0, behavior in the app not just a green test.
- If a test exists or is cheap to add, add one that fails before / passes after — it locks the fix in.
- If verification is impossible in this environment (needs a device/browser you don't have), say so explicitly rather than implying success.

## Step 6 — Route the lesson (capture in the moment)
Apply the test: *"would this bite a future session?"* Route by reusability:

| Lesson type | Destination |
|---|---|
| Reusable technical gotcha | `ClaudeCode/memory/feedback_*.md` + MEMORY.md index line |
| Design-level decision | a Decision Record (`docs/process/decisions/`) |
| One-off but real | the commit message / Echo daily log |
| Trivial typo fixed instantly | nothing |

**Why in the moment:** a bug fixed before commit leaves NO git trace — the close roll-up structurally cannot surface it. Only you, now, can record it.

## Step 6.5 — Register a regression check (close the self-heal loop — non-optional)
A fix without a detector can silently come back. Apply the test: *"could a command tell me this bug is back?"*

- **Yes → register it now:** write a shell command that exits non-zero on the broken state you just fixed, then
  ```bash
  scripts/add-healthcheck.py <kebab-name> --cmd "<test>" --bug-ref "#NNN-or-commit" \
    --fail-detail "<what's wrong when it trips>" --action "<how to fix>"
  ```
  It test-runs the command, registers it in `docs/process/state/health-checks.json`, and the daily self-heal harness then catches any regression (→ worklist, or `--tier ant` to ping Ant). This is the governing-artifact destination for "this should be caught automatically" ([self-heal-protocol.md](../../docs/process/self-heal-protocol.md)).
- **No (not mechanically detectable) → record the gap so it isn't lost:** `scripts/add-healthcheck.py <name> --gap "why it can't be auto-detected"`.
- **Already covered** by an existing self-heal check → nothing to add.

Skip only for a trivial typo. A `feedback_*` memo records the lesson for a *future reader*; a self-heal check enforces it for a *future run* — most real bugs warrant both.

## Filing
`/fix` applies the fix inline — it does NOT commit. Leave the commit to `/checkpoint`, which stages the fix + any new `feedback_*`/DR under the sync lock. If the bug maps to a governed `#NNN`, update its state when done.
