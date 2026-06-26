# Task Writing Protocol

**Version:** 1.1 (2026-06-03)
**Applies to:** Any task written to `docs/process/task-queue.md` or `workspace/state/OPEN_TASKS.md`

---

## Why this exists

A task written mid-session carries context the next session will never have: the incident that triggered it, what you already ruled out, which files are load-bearing, what the first step actually is. Without a protocol, that context disappears at session close. The next session picks up a title and has to reconstruct everything from scratch — or ships the wrong thing.

This protocol is the minimum to make a task handoff-ready.

---

## When the body is required

**Always. No exceptions.**

Why/Plan/Main files are required on every task entry. There is no "trivial" escape hatch — if a task is genuinely self-describing in one line, it takes 30 seconds to write a one-sentence Why and Plan. The cost of skipping is a future session doing archaeology; the cost of writing is 30 seconds. `close-integrity-check.sh` will FAIL if a new open task is missing Why or Plan.

---

## Required body sections

```markdown
- **#NNN `slug`** — one-line description
  - type:T | area:A | priority:P | effort:E | agent:X | machine:Y | status:S
  - **Why:** What surfaced this. The concrete incident, friction point, or observation — not "it would be nice." Include date if it was a live event (e.g. "hit live 2026-06-02"). This is the most important section: it tells the next session why this matters and whether it's still worth doing.
  - **Plan:** What to do and — critically — what NOT to do or what was already tried. Not a full spec. One paragraph or a short bullet list. Include: approach direction, key constraints, which patterns/solutions to avoid and why.
  - **Main files:** Files that must change or that the task is primarily about.
```

### Optional sections (add when known)

```markdown
  - **Next action:** The single first concrete step. If you know it, write it — saves the next session its first 5 minutes of orientation.
  - **Blocked by:** `#NNN` — which task must land first.
  - **Done when:** What "done" looks like. A passing test, a service responding, a file existing with specific content.
  - **Verify:** A shell command (run from repo root) that exits 0 on success. This is what `scripts/task-verify.sh` runs automatically at checkpoint. Examples: `scripts/smoke-api-all.sh`, `python3 scripts/task-domain.py --concern "label" | grep -q infra`, `test -x scripts/foo.sh`. Omit if no single command captures it — fall back to `Done when:` for manual confirm.
    **Invocation rule:** call scripts by path (`scripts/foo.sh`), not `bash scripts/foo.sh` — the shebang determines the interpreter. Using an explicit interpreter overrides the shebang and breaks scripts that use interpreter-specific syntax (see T-VERIFY-01 / #058 postmortem).
```

---

## Template (copy-paste)

```markdown
- **#NNN `verb-noun-slug`** — one-line description
  - type:bug|feat|chore|infra|research|doc | area:A | priority:P1|P2|P3 | effort:XS|S|M|L | agent:claude|smith|scout | machine:<<MACHINE_1_ID>>|<<MACHINE_2_ID>>|either | status:open
  - **Why:** [What triggered this — incident, observation, friction point, date if live]
  - **Plan:** [Approach direction, constraints, what to avoid. Be specific enough that a fresh session can start without asking.]
  - **Main files:** `path/to/file.py`, `path/to/other.py`
  - **Next action:** [Optional: first concrete step]
  - **Done when:** [Optional: human-readable verification criterion]
  - **Verify:** [Optional: shell command from repo root that exits 0 on success]
```

---

## Field mapping to task-state-contract.md

The markdown body sections map directly to the governed schema in `tasks.json`:

| Body section | tasks.json field |
|---|---|
| One-line description | `summary` |
| Why | *(no exact field — goes in handoff_context / daily log)* |
| Plan | `nextAction` + `currentStep` seed |
| Main files | `mainFiles` |
| Done when | `expectedArtifact` + `verificationMethod` |

When a task is promoted to a governed entry, the body serves as the source material to fill those fields.

---

## Self-review → task pipeline

When the end protocol runs `scripts/self-review.py --latest`, its friction/miss signals that meet this bar become tasks:

- **Actionable:** can be expressed as a concrete change, not just an observation
- **Not already queued:** check `free-work.py` and `task-queue.md` first
- **Non-obvious:** if the fix is self-evident from the title, the task body can be minimal

Threshold question: "Would a fresh session know what to do from the title alone?" If no → write the body.

---

## Examples

### Good: live-incident task with full body

```markdown
- **#058 `commit-path-conflict-marker-guard`** — Stash-pop conflict markers committed + pushed to shared lease state
  - type:bug | area:infra | priority:P1 | effort:S | agent:claude | machine:<<MACHINE_1_ID>> | status:open
  - **Why:** (hit live 2026-06-02) during a /checkpoint, a manual `git stash pop` racing the live auto-sync daemon left `<<<<<<< / ======= / >>>>>>>` markers in `active-checkouts.json` — which then got committed (41fef7d) **and pushed to origin/main**, corrupting lease state until repaired under lock.
  - **Plan:** Add a conflict-marker guard covering all commit paths — a `pre-commit` hook (installed via bootstrap) or a check inside `git-lock.sh run` that greps staged content for the marker triplet and aborts. Reuse the regex from #023: `^\+(<<<<<<< |=======$|>>>>>>> )`. Do NOT just add it to the daemon's sync tick (that's #023/DONE) — the bug here entered through a manual checkout path.
  - **Main files:** `scripts/git-lock.sh`, `scripts/test-git-sync-guards.sh`, tracked `pre-commit` hook
  - **Next action:** Add a test to `test-git-sync-guards.sh` first, then implement the hook, then verify the test catches it.
  - **Done when:** `test-git-sync-guards.sh` passes with a new test that simulates a stash-pop-marker commit and confirms the guard blocks it.
```

### Bad: too sparse — context lost

```markdown
- **#058 `commit-path-conflict-marker-guard`** — Fix conflict markers getting committed
  - type:bug | area:infra | priority:P1 | effort:S | agent:claude | machine:<<MACHINE_1_ID>> | status:open
```

This forces the next session to archaeology: why does this happen? Where? What did we try? What's the right fix? That's the context that was in the session that opened this task.

---

## Script invocation conventions

These rules apply anywhere in the project: `Verify:` fields, `task-verify.sh` heuristics, CI, and inline `bash -c` calls.

**Rule 1 — call scripts by path, not by explicit interpreter.**
`scripts/foo.sh` (or `"$REPO/scripts/foo.sh"`) — not `bash scripts/foo.sh`. The shebang determines the interpreter. Overriding it silently breaks scripts that use interpreter-specific syntax and produces cryptic errors (e.g. `A: unbound variable` from `${0:A:h}` run under bash).

**Rule 2 — all project scripts use `#!/usr/bin/env bash` unless they strictly require zsh.**
Bash is available on all project machines (<<MACHINE_1_ID>> + <<MACHINE_2_ID>>); zsh is not guaranteed everywhere and makes scripts non-portable. If you write or edit a script: check the shebang. If it's `#!/bin/zsh` without a zsh-only reason, change it to `#!/usr/bin/env bash`.

**Rule 3 — update `task-domain.py` keywords when adding tasks in new categories.**
`task-verify.sh` uses `task-domain.py` to pick the right heuristic check. If your task slug doesn't map to a section (`python3 scripts/task-domain.py "your-slug"` returns `unknown`), add its keywords to the `KEYWORD_TO_SECTION` dict before closing the task.

*Root cause that codified these rules: T-VERIFY-01 (2026-06-03) — `task-verify.sh` called `bash scripts/test-git-sync-guards.sh`, crashing a zsh test harness with `A: unbound variable` before a single test ran.*

---

## All task-writing entry points

Tasks enter the system through multiple paths. The protocol applies to ALL of them.

### 1. `/add-task` or `/end` reflect & extract (covered)
The standard path — the protocol is prompted inline.

### 2. Lane / queue-runner output
When `steward` decomposes a task or `smith` suggests follow-ups as output, those entries must still satisfy this protocol before they're written to task-queue.md. Rule: **whoever applies the lane output is responsible for adding Why/Plan before committing**. The lane won't do it — it returns bare slugs. The apply step is the enforcement gate.

### 3. GitHub issues
Tasks created as GitHub issues (via `agent-checkout <issue>`) have their own format and bypass task-queue.md. When creating a GH issue that maps to this system:
- Put the Why in the issue body's first paragraph
- Put the Plan under a `## Approach` heading
- When the issue is promoted to a task-queue.md entry, copy those into the Why/Plan fields

`close-integrity-check.sh` doesn't scan GH issues — enforcement here is at the apply/promote step.

### 4. OPEN_TASKS.md direct entries
Writing directly to OPEN_TASKS.md (board view only, no task-queue.md backing entry) bypasses the check. Rule: **OPEN_TASKS.md is a projection, not the source**. Always create the task-queue.md entry first; the board entry is a one-liner summary. If you write a board entry without a queue entry, it must be promoted before the next `/end`.

### 5. Working-context open threads
Threads in `## Open threads` carry no Why/Plan and often get silently dropped at the next working-context rewrite. Rule: **any thread that survives 2 sessions must be promoted to a task-queue.md entry** with a full body. A thread is not a task — it's a reminder. If the work is real, give it a task entry. If it's not real enough for a task entry, remove it from threads.

---

## Relationship to other docs

- [`task-naming-convention.md`](task-naming-convention.md) — header format (#NNN, fields line, goal/project)
- [`projects.md`](projects.md) — project list; tasks must map to a project
- [`taxonomy.yaml`](taxonomy.yaml) — life-domain vocabulary; tasks must carry one primary domain
- [`goals.md`](goals.md) — active campaign list; tasks should map to a campaign or explain why they are evergreen/domain maintenance
- [`task-state-contract.md`](task-state-contract.md) — governed schema (tasks.json fields)
- [`task-pickup-and-lifecycle-standard.md`](task-pickup-and-lifecycle-standard.md) — claim/work/close cycle
- `~/.claude/CLAUDE.md` — end protocol step 5 (reflect & extract), step 7 (task dedup gate)
