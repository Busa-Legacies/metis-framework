# Offline Autopilot Protocol

**Purpose:** Define how Ant issues a time-boxed "work while I'm offline" request and how the agent should select, execute, and report on work with **no human present to approve, clarify, or course-correct**.

This is the operating layer on top of `claude-code-autonomous-execution.md`. That doc covers the *permission mechanics* (which flag lets a session run unattended). This doc covers the *judgement* — what work is safe to pick up alone, what to never touch, and what must be waiting when Ant comes back.

_Adopted: 2026-06-06 (first run: the "hour-long flight" test case)_

---

## When this applies

Any request that hands the agent a block of unattended time. Recognise it from phrasing like:

- "I'm about to hop on a flight — make as much progress as you can."
- "Offline for the next 2 hours, work the board."
- "Run autopilot until ~3pm."
- "/autopilot 90m"

The defining feature: **Ant will not see prompts, questions, or approvals until the window closes.** So anything that would normally pause for input cannot be started — it must be deferred, not guessed.

---

## The invocation contract

Ant states (or the `/autopilot` command captures):

| Field | Example | Default if unstated |
|-------|---------|--------------------|
| **Window** | "~1 hour", "until 3pm" | Treat as ~60 min; checkpoint early |
| **Scope hint** | "the board", "dashboard tasks", "anything" | Whole governed board, P-order |
| **Spend ceiling** | "keep it cheap" | Normal session budget; no paid-API fan-out without it being the task |

The agent confirms nothing further — that's the point. It selects work itself using the independence test below.

---

## The independence test

A task is **autopilot-eligible** only if every answer is yes:

1. **Self-contained** — it can be finished (or moved to a clean, honest checkpoint) without an answer from Ant.
2. **No external publish** — it does not send anything outward that can't be unwound: no Discord/email/social posts, no PR *merges*, no ClickUp/Notion writes that others act on, no live-trading flips. (Drafting these for review is fine; *sending* is not.)
3. **No human-gated input** — it isn't blocked on a secret, credential, API key, or an Ant-only decision (`@status:blocked`, "Ant-present", "needs Ant", or a `nextDecisionPoint` that is a question for Ant).
4. **Machine-available** — it can actually run in the current environment. A fresh web/remote clone cannot touch <<MACHINE_1_ID>>/<<MACHINE_2_ID>> LaunchAgents, Ollama, the live dashboard process, or `personal.db`. `@machine:antfox` live-verify steps are **out of reach** from a remote clone — code can land, but mark it `needs_verification`, never `done`.
5. **Reversible** — the work lands on a feature branch as commits, not on `main` and not as a destructive operation.

If a task fails the test, **skip it and record why** — do not improvise around the gate.

### Quick routing

```
Picking the next autopilot task?
│
├── Needs an Ant answer / secret / approval?      → SKIP (note it in the report)
├── Sends something outward irreversibly?          → SKIP (draft only, never send)
├── Needs <<MACHINE_1_ID>>/<<MACHINE_2_ID>>/Ollama/live dashboard/antfox?  → code only if possible →
│                                                     land as needs_verification
├── Self-contained code or doc on a branch?         → DO IT
└── Nothing eligible left?                           → stop early, report honestly
```

---

## Hard guardrails (never, even mid-task)

- **Never push to `main`** or any branch other than the session's designated feature branch.
- **Never merge a PR** or mark another person's tracked item done.
- **Never flip the trading bot to live**, change money-safety gates, or touch anything tagged money-safety/`math_review_attested`.
- **Never delete or overwrite** something you did not create this session without surfacing it first — and there's no one to surface to, so: don't.
- **Never fabricate verification.** If a step needs a live machine you can't reach, the state is `needs_verification` with the verification method recorded — not `done`.
- **Never burn the window on one rabbit hole.** If a task balloons past its slice, checkpoint what works, leave a resumable note, move on.

---

## Execution loop

1. **Read state first** — `workspace/state/OPEN_TASKS.md`, `workspace/memory/working-context.md`, and the governed `docs/process/state/tasks.json`. Know what's in flight before adding to it.
2. **Build a shortlist** — run every candidate through the independence test. Prefer well-specified, verifiable tasks (clear `summary`, `mainFiles`, owner `either`) over vague ones.
3. **Work in small, committed slices** — one logical change per commit, descriptive message, governed-state updated honestly (`update-tier1-state.py` → `render-tier1-state.py write`).
4. **Verify what you can** — `py_compile`, `node --check`, unit tests, smoke scripts. Whatever the environment allows. Record what you *couldn't* verify and why.
5. **Checkpoint before the window closes** — commit and **push** with time to spare. Unpushed work in an ephemeral container is lost work. Open a **draft PR per task** (see Confirmed defaults) so each can be reviewed and merged independently.
6. **Stop early if dry** — when nothing eligible remains, stop. Padding with low-value busywork is worse than a short honest report.

---

## The return report

The deliverable is not just the commits — it's a report Ant can read in 60 seconds on landing:

- **Shipped** — what's done and verified, with task IDs.
- **Landed, needs your eyes** — `needs_verification` items and exactly what to check (the live step that needed a machine, the PR to review).
- **Skipped & why** — eligible-looking tasks that failed the independence test, so Ant can unblock them (supply a key, make a call, run a live verify).
- **Branch / PR** — where the work lives.

Keep it scannable. Ant just got off a plane.

---

## How to invoke

- **Conversationally:** just say it — "I'm offline for an hour, work the board." The agent recognises the pattern and runs this protocol.
- **As a command:** `/autopilot [window] [scope]` — e.g. `/autopilot 90m dashboard`. See `.claude/commands/autopilot.md`.

---

## Confirmed defaults

Settled with Ant after the first run (2026-06-06):

- **Verification bar — conservative (confirmed).** Only mark `done` what can be verified in-environment. Anything needing a machine the session can't reach (`@machine:antfox`, the live dashboard, Ollama) lands at `needs_verification` with the verify steps recorded. Do not stretch to `done` on faith.
- **PR shape — one draft PR per task.** Each eligible task gets its own draft PR so Ant can review and merge them independently, rather than one bundled batch PR. (The 2026-06-06 run predates this and bundled four tasks into PR #18; splitting it retroactively would mean redoing interleaved governed-state commits — attended-grade git surgery — so it was left intact as the record of that run.)

## Related docs

- `docs/process/claude-code-autonomous-execution.md` — permission-mode mechanics (`ccc-auto`, `claude-task`)
- `docs/process/task-state-contract.md` — honest state transitions; why `needs_verification` ≠ `done`
- `docs/process/agent-operating-loop.md` — the general work loop this specialises
- `docs/process/follow-through-wording-rule.md` — report faithfully; no done-claims without evidence
