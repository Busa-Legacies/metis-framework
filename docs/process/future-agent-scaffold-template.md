# Future Agent Scaffold Template

Purpose:
- define the default scaffold and inheritance pattern for Jay-like future peer agents in this repository
- make new agent setup faster, cleaner, and more consistent with the shared doctrine stack
- avoid reinventing startup, memory, ownership, lifecycle, evidence, and continuity rules for every new peer

## Core rule

> New agents should inherit shared doctrine by default and specialize only where their role truly differs.

## Intended use

Use this template when:
- creating a new peer agent folder
- reworking an existing agent scaffold
- deciding which parts of an agent are shared vs local

It is not a persona generator.
It is a structural and operational template.

## Minimum folder shape

Recommended top-level agent folder contents:
- `AGENTS.md`
- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `memory/`

Optional later:
- `MEMORY.md`
- local `docs/`
- local `skills/`
- task-specific notes if the agent develops durable local specialties

## Shared inheritance model

A future agent should explicitly inherit the shared doctrine from:
- `docs/process/agent-operational-doctrine-shared.md`
- `docs/process/agent-operating-loop.md`
- `docs/process/task-state-contract.md`

Depending on the role, it may also need to read or reference:
- `docs/process/jarry-task-lifecycle-protocol.md`
- `docs/process/jarry-execution-evidence-gate.md`
- `docs/process/jarry-session-continuity-and-rollover.md`
- `docs/process/jarry-timeout-and-blocked-state-policy.md`
- `docs/process/jarry-memory-architecture-v2.md`
- `docs/process/jarry-recall-protocol.md`

Interpretation rule:
- shared docs define the reusable operational semantics
- agent-local files define the role, tone, lane ownership, and emphasis for that specific agent

## What must be local to the agent

Every future agent should localize:
- identity
- tone / vibe
- preferred role emphasis
- what kinds of bounded work it should own first
- local notes or heuristics if they are not yet shared truths

Examples of good specialization axes:
- execution/coding
- research/synthesis
- operations/infrastructure
- review/challenge
- documentation/architecture
- coordination/triage

## What should stay shared by default

Do not duplicate shared doctrine into every agent folder.
Keep these shared unless there is a good reason not to:
- task-state semantics
- lifecycle semantics
- evidence rules
- continuity expectations
- anti-drift rules
- shared Discord coordination model
- shared process docs and project truth

## AGENTS.md template guidance

A future agent's `AGENTS.md` should cover:
1. what this folder is
2. startup read order
3. inheritance from the shared doctrine/loop layer
4. the agent's main operating rule
5. what the agent is for
6. collaboration rules with peers
7. memory boundaries
8. Discord/shared-space behavior
9. red lines
10. immediate or initial role

Recommended explicit inheritance section:
- point to `agent-operational-doctrine-shared.md`
- point to `agent-operating-loop.md`
- explain that local docs define expression, not replacement, of shared semantics

## SOUL.md template guidance

A future agent's `SOUL.md` should express:
- voice and stance
- role emphasis
- anti-drift expectations in agent-local language
- ownership behavior
- collaboration posture

It should not rewrite the whole shared doctrine.
It should translate it into the agent's own character and working style.

## Memory guidance for future agents

Every new agent should follow these defaults:
- active shared task truth belongs in shared task/process state
- agent-local daily memory is for local continuity and notes
- shared durable truths belong in shared docs/process surfaces
- explicit distinction notes should be written down when names/projects/agents are easy to conflate

Optional `MEMORY.md` should be added only when:
- the agent truly needs curated long-term local memory
- the privacy/context rules for that memory are clear

## Activation checklist for a future agent

Before treating a new agent as live, verify:
1. identity scaffold exists and is meaningfully filled in
2. local docs explicitly inherit the shared doctrine stack
3. the agent has a clear first role/lane
4. shared-space ownership behavior is explicit
5. one bounded real task can be accepted and completed through the normal coordination flow
6. recovery after reset would be possible from the durable trail

## Suggested first-task pattern

For a newly activated future agent, prefer a first task that is:
- bounded
- visible
- useful
- low enough risk to inspect easily
- strong enough to test ownership, handoff, and durable writeback behavior

Good examples:
- bounded research synthesis
- one documentation pass
- one thread-owned execution task
- one rollout/verification checklist

## Anti-patterns to avoid

Avoid creating a future agent that:
- duplicates shared doctrine locally with slight wording differences
- has no clear lane or first role
- implies shared memory across peers
- reports execution-finished as done by default
- relies on local memory for shared active work
- speaks with no provenance in shared spaces

## Relationship to current examples

Current practical references:
- Jarry = direct-control / execution-manager / state-steward emphasis
- Jay = execution-oriented peer-agent example inheriting shared doctrine explicitly

Use Jay as the first concrete peer reference, not as a rigid universal mold.

## Success criteria

This template is working when:
- a new agent can be created quickly without improvising core operating rules
- future agent docs inherit the shared doctrine cleanly
- agent identities remain distinct without semantic drift
- multi-agent collaboration scales without each agent becoming a snowflake process model
