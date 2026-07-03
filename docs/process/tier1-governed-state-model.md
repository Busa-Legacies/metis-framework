# Tier 1 Governed State Model

Last updated: 2026-04-14 12:09 PDT

Purpose:
- define the minimal governed state needed to prevent drift between `task-queue.md`, `live-status.md`, and the richer doctrine-aware task semantics now active in this workspace
- replace convention-only coordination with a small enforceable state layer
- make Tier 1 governed state compatible with the newer ownership, lifecycle, evidence, continuity, and anti-drift expectations

## Problem

`task-queue.md` and `live-status.md` are human-readable markdown projections.
Even when those projections are useful, drift is likely if the richer operational truth still depends on free-edit markdown or chat-first updates.

The newer doctrine stack also raises the bar for what task/live state must preserve:
- ownership clarity
- current step
- expected artifact
- verification method
- blocker or none
- next action
- continuity across interruption and handoff

## Architectural direction

Treat Tier 1 state as governed objects.
Treat markdown files as projections of that governed state.

## Minimal governed objects

### 1. Task object

One object per task.

Required fields:
- `taskId`
- `title`
- `priority`
- `state` (`inbox|queued|accepted|in_progress|execution_finished|needs_verification|waiting|blocked|failed|done`)
- `owner`
- `summary`
- `currentStep`
- `expectedArtifact`
- `verificationMethod`
- `blockerOrNone`
- `nextAction`
- `mainFiles[]`
- `nextDecisionPoint` (optional)
- `verificationState` (optional; recommended at `execution_finished`/`needs_verification`/`done`) — sub-process state for verification: `not_started` / `pending` / `passed` / `failed`
- `evidenceRefs` (optional; required at `execution_finished`/`done`) — array of file paths, commands, or artifact descriptions that substantiate a completion claim
- `handoffContext` (optional; required on owner changes or when entering `waiting`/`blocked` with accumulated context) — one-to-three sentence summary for the next owner
- `delegation` (optional) — structured delegation metadata when bounded sub-execution is active or has just returned; see `docs/process/task-state-contract.md` for recommended fields
- `updatedAt`
- `updatedBy`
- `revision`

### 2. Live focus object

One object for the current high-level session/project focus.

Required fields:
- `focusSummary`
- `mode` (`active|paused|waiting|blocked`)
- `waitingOnAnt` (boolean)
- `blockerSummary` (optional)
- `nextSteps[]`
- `derivedFromTaskIds[]`
- `updatedAt`
- `updatedBy`
- `revision`

### 3. Optional event object

Used for history and reconciliation.

Required fields:
- `eventId`
- `eventType`
- `objectType`
- `objectId`
- `actor`
- `timestamp`
- `payload`
- `expectedRevision` (optional)

## Minimal storage model

A small first implementation could use:
- `docs/process/state/tasks.json`
- `docs/process/state/live-focus.json`
- optional later: `docs/process/state/events.jsonl`

This is enough to govern Tier 1 without building the whole collaboration platform at once.

The key is that Tier 1 no longer only prevents basic markdown drift.
It also becomes the first durable layer where richer doctrine-aware operational semantics can actually live.

## Projection targets

These markdown files become projections, not primary state surfaces:
- `docs/process/task-queue.md`
- `docs/process/live-status.md`

## Key rule

> Agents should not freely author Tier 1 operational truth in markdown when the same truth can be governed in structured state.

Instead:
- update governed state
- regenerate or reconcile projections from that state
- treat markdown as human-readable projection, not the most authoritative live source when structured state exists

## First implementation scope

Only govern:
1. task state
2. task ownership
3. current step / expected artifact / verification method / blocker / next action for meaningful active work
4. current focus summary
5. blocker/waiting summary
6. immediate next-step list
7. enough task semantics to support honest handoff, verification, and resumability

That is the smallest useful slice that reduces current drift while aligning Tier 1 with the newer shared doctrine, evidence, lifecycle, continuity, and anti-drift model.
