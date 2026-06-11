# DR-0004: Audited correct-state escape hatch for the forward-only task DAG

- **Status:** Accepted
- **Date:** 2026-06-04
- **Supersedes:** —
- **Superseded-by:** —

## Context

The governed task store (`docs/process/state/tasks.json`, see DR on the #098 born-governed
migration) enforces a **forward-only** state machine in `scripts/update-tier1-state.py`
(`ALLOWED_STATE_TRANSITIONS`). That graph is correct for *workflow progress* — it lets a task's
state be a trustworthy signal of real work and makes regressions visible.

But it conflates two different event classes. Class 1 is workflow progress
(`queued→in_progress→…→done`). Class 2 is **data correction** — a task mis-created or migrated
into a state its content contradicts. The #098 migration imported 57 tasks and several landed
wrong: #067 in `needs_verification` with nothing built, #078 in `blocked` with no blocker ever
recorded. The forward-only graph has no rewind edges, so these were *uncorrectable*: #067/#078
could not reach `queued` at all, and closing the stale monitor task #005 required walking
`waiting→in_progress→execution_finished→needs_verification→done` — **5 hops to close a task
whose only event was that its observation window elapsed.** Disguising a correction as workflow
progress also corrupts the very history the forward-only invariant exists to protect.

## Decision

Add a separate, audited `correct-state` subcommand to `update-tier1-state.py` that sets a task's
state **bypassing `ALLOWED_STATE_TRANSITIONS`** but only under guard rails:

- `--reason` is **required and non-empty** — a correction must say why it is a correction.
- Every override appends an entry to a `stateCorrections[]` array on the task
  (`{from, to, reason, actor, at}`), so the bypass is explicit and auditable, never silent.
- Shape validation and the done-gate **still apply** — a correction cannot fake a completion
  (you still can't reach `done` except from `needs_verification`).
- It is a *distinct verb* from `task-update`, so normal workflow code can never accidentally
  rewind a task; the bypass is opt-in and visible at the call site.

Workflow progress continues to go through `task-update` and the forward-only DAG, unchanged.

## Alternatives considered

- **B — Add reverse edges to the transition graph.** Simplest (no new command), but it destroys
  the invariant: `queued` would then mean "fresh" *or* "rewound", and you lose the ability to
  distinguish progress from regression. Rejected — it throws away the value the DAG buys.
- **C — A separate `fix-task-state.py` admin script.** Functionally equivalent to the chosen
  approach but as a second file/entry point. Rejected in favor of keeping all governed-state
  mutation in one helper with one concurrency/validation path; `correct-state` lives beside
  `task-update` and reuses its shape + done-gate checks.

## Changes

- See `git log --grep=DR-0004` for the implementing commits.
- Files: `scripts/update-tier1-state.py` (new `correct-state` subcommand + `correct_state()` +
  `stateCorrections` mutable field), `docs/process/state/tasks.json` (#067/#078 corrected
  `→queued` with audit entries).

## Consequences

- Migration/fat-finger mislabels are now fixable in one audited step instead of being permanent
  or requiring dishonest hop-walks.
- The forward-only DAG keeps its meaning: any state reached via `task-update` is genuine
  progress. A state set by correction is recorded as such in `stateCorrections[]`.
- New discipline required: `correct-state` is an escape hatch. It must be used only for genuine
  data corrections, always with a real `--reason`. If it starts being used to skip workflow,
  the audit array is where that abuse will show up — review it, don't widen the hatch.
- `done` remains protected — `correct-state` honors the done-gate, so it cannot be used to mark
  work complete without passing through verification.
