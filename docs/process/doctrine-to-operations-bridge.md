# Doctrine-to-Operations Bridge

Last updated: 2026-06-06

Purpose:
- define how the doctrine stack governs active operational surfaces
- reduce drift between shared doctrine, <<MACHINE_2_ID>>-specific operating doctrine, governed state, and human-readable process surfaces
- make it explicit which docs are authoritative for which operational behaviors

This document is intentionally narrow.
It is not another doctrine family member.
It is the bridge that says how the existing doctrine must show up in real operating surfaces.

## Why this exists

The doctrine stack is now strong enough that the main remaining risk is not weak doctrine.
The main risk is partial adoption.

That looks like:
- strong doctrine docs
- decent task/live state
- decent queue/live projections
- but unclear expectations for exactly how those operational surfaces must comply

This bridge exists so the doctrine layer becomes operationally binding rather than merely well-written.

## Canonical doctrine sources

The following docs are the main doctrinal sources for operational behavior.

### Apex (read first)
- **`docs/process/decision-doctrine.md`** — the act-vs-ask constitution. Overrides any "when in doubt, ask" instinct. Governs all agents, all sessions.

### Shared doctrine
- `docs/process/agent-operational-doctrine-shared.md`
- `docs/process/agent-operating-loop.md`
- `docs/process/task-state-contract.md`

### <<MACHINE_2_ID>>-specific doctrine
- `docs/process/<<MACHINE_2_ID>>-operating-model.md`
- `docs/process/<<MACHINE_2_ID>>-anti-drift-contract.md`
- `docs/process/<<MACHINE_2_ID>>-execution-evidence-gate.md`
- `docs/process/<<MACHINE_2_ID>>-task-lifecycle-protocol.md`
- `docs/process/<<MACHINE_2_ID>>-session-continuity-and-rollover.md`
- `docs/process/<<MACHINE_2_ID>>-timeout-and-blocked-state-policy.md`
- `docs/process/<<MACHINE_2_ID>>-memory-architecture-v2.md`
- `docs/process/<<MACHINE_2_ID>>-recall-protocol.md`

### Supporting Tier 1 / governed-state specs
- `docs/process/tier1-governed-state-model.md`
- `docs/process/tier1-state-files-spec.md`
- `docs/process/tier1-update-contract.md`

## Operational surfaces governed by this bridge

This bridge applies directly to:
- `docs/process/state/tasks.json`
- `docs/process/state/live-focus.json`
- `docs/process/task-queue.md`
- `docs/process/live-status.md`
- `workspace/AGENTS.md`
- `workspace/SOUL.md`

It also informs, but does not fully control by itself:
- `docs/process/orchestration-model.md`
- `docs/process/discord-coordination-model.md`
- `docs/process/multi-agent-collaboration-model.md`

## Core rule

> If doctrine and an operational surface disagree, the surface should be corrected or explicitly justified.

That does not mean every wording difference is a bug.
It means meaningful semantic differences should not drift silently.

## Minimum compliance rules

### 1. Task surfaces must preserve the task-state contract

The governed task layer and its markdown projection should preserve meaningful task truth, including:
- owner
- status
- current step
- expected artifact
- verification method
- blocker or none
- next action
- durable targets
- updated_at

If an operational surface cannot express all of these verbatim, it should still preserve their meaning clearly.

### 2. Live-focus surfaces must preserve truthful current state

The governed live-focus layer and its projection should preserve:
- what is actually being worked on now
- whether the system is blocked or waiting on something real
- what the next material moves are
- which active task IDs currently justify the focus state

Live-focus surfaces should not become optimistic narrative summaries detached from governed state.

### 3. Completion claims must obey the evidence gate

No operational surface should imply `done` if the evidence gate would still require:
- `execution_finished`
- `needs_verification`
- `blocked`
- `failed`

In other words:
- execution lane completion is not enough
- human-readable summaries must not outrun verification state

### 4. Lifecycle semantics must stay consistent across surfaces

Statuses such as:
- `in_progress`
- `execution_finished`
- `needs_verification`
- `waiting`
- `blocked`
- `failed`
- `done`

should mean the same thing across:
- doctrine docs
- governed state
- queue/live projections
- agent-local operating docs

A surface may be simpler than another, but it should not redefine the lifecycle semantics casually.

### 5. Continuity must survive interruption

If work matters enough to continue later, at least one durable operational surface must preserve enough continuity to resume honestly.

That means at minimum preserving:
- owner
- status
- current step
- expected artifact
- verification method
- blocker or none
- next action

If that payload is missing, the work is not operationally durable enough.

### 6. Recall should prefer the right durable layer first

When operational surfaces answer questions about current work, prior decisions, or distinctions, they should align with the recall protocol:
- task/workstream truth from task/live/governed state first
- project/process truth from docs/process
- memory search for prior work/decisions/preferences
- transcript history only as fallback

### 7. Peer-agent inheritance must preserve independence without doctrine drift

Agent-local docs such as `workspace/AGENTS.md` and `workspace/SOUL.md` may differ in voice, emphasis, and lane ownership.

But they should still preserve:
- explicit ownership
- no fake shared memory
- evidence-aware completion
- continuity/handoff discipline
- ability to operate independently, with peers, or in broader multi-agent work without identity blur

## Practical compliance checks

### Check A — Task-state compliance
When reviewing `tasks.json` or `task-queue.md`, ask:
- is the current step explicit?
- is the expected artifact explicit?
- is the verification method explicit?
- is blocker-or-none explicit?
- is next action explicit?

### Check B — Live-focus compliance
When reviewing `live-focus.json` or `live-status.md`, ask:
- does the focus summary match real active work?
- does blocker/waiting state match reality?
- do the next steps reflect actual possible moves rather than vague continuation language?
- are the active task IDs still the right drivers of the focus state?

### Check C — Completion-truth compliance
When reviewing any completion claim, ask:
- is the work actually `done`?
- or is it still `execution_finished` / `needs_verification`?
- what evidence or check supports closure?

### Check D — Continuity compliance
When a task is interrupted, delegated, or waiting, ask:
- can someone resume from durable state alone?
- or would they have to reconstruct from chat memory?

### Check E — Peer-agent compliance
When reviewing `<<MACHINE_1_ID>>/` or future peer-agent docs, ask:
- does the peer inherit doctrine without losing independence?
- does the peer remain interoperable without collapsing into a merged identity?

## What this bridge does not require

This bridge does **not** require:
- identical prose across all surfaces
- every surface to expose every field with the same formatting
- immediate runtime enforcement of every rule

It does require:
- semantic consistency
- explicit correction when a meaningful mismatch appears
- preference for state-first updates where governed state exists

## Recommended correction order when drift appears

When a mismatch is found:
1. identify which doctrine rule is being violated
2. identify which operational surface is lagging
3. correct governed state first when governed state exists
4. regenerate or reconcile projections second
5. only then decide whether a doctrine doc itself actually needs revision

This order matters because it reduces accidental markdown-first drift.

## Success criteria

This bridge is working when:
- doctrine no longer feels separate from real task/live operation
- task/live surfaces become more consistent with lifecycle/evidence/continuity rules
- peer-agent inheritance stays compatible without identity blur
- drift is caught as a surface-compliance issue before it becomes a broader doctrine problem

## Decision summary

The doctrine family is now strong enough.
What matters next is operational compliance.

This bridge makes the expectation explicit:
- doctrine is authoritative for semantics
- governed state is authoritative for active operational truth where available
- markdown is projection unless explicitly declared otherwise
- agent-local docs may vary in personality, but not in core operational honesty
