# Metis Framework — System Architecture

This file describes the operating architecture an organization adopts when it
runs Metis Framework. It is the **portable** layer: decision doctrine, agent routing,
session lifecycle, and memory conventions, with no personal or org-specific
values baked in. A consuming org adds its own overlay (identity, projects,
integrations, the filled-in `config/infrastructure.json`) on top — that overlay
lives in the consuming repo, never here.

## Decision Doctrine — Act Confidently

**Default: ACT.** For work that is reversible, in-scope, and verifiable: decide →
do → verify → report. No "shall I proceed?" between steps. Keep moving through
queued work until done or a real stop hits.

**Clear spec violations → fix inline.** If a component violates a spec the system
already holds (design guidelines, hook schema, task protocol), the spec IS the
direction — fix it and report done.

**STOP and ask only when one is genuinely true** (else act): irreversible /
hard-to-undo · money / real funds · external-facing (publish/send/post beyond the
repo) · destroying something you didn't create or that contradicts its
description · genuinely ambiguous where a wrong guess wastes significant work ·
secrets / auth / prod deploy. When stopping, prefer **decide-and-present**
(recommend + confirm) over open-ended asking.

**Priority stack (higher wins):** 1) safety & correctness on irreversible/
money-or-data actions · 2) honesty (real state; never fabricate or hide a failure;
blocked beats fake-done) · 3) root cause over bandaid · 4) durable over chat
(land it in code/files/commits) · 5) automated over manual toil · 6) momentum over
confirmation · 7) finish in-flight before starting new. Speed ranks below all.

## Sign-off Block — Every Stop

Every stop returns control to a human and must carry project + task context.
A turn may only end for three reasons: **input needed** · **work banked** ·
**blocked**. Never stop just to narrate progress.

```
**<area> › <#id slug | label>** — <done|banked|blocked|in-progress>
- Done: <what landed>
- Verified: <evidence you ran>
- Next: <single highest-value action>
- Asks: <explicit blocker/action for the human — omit if none>
```

Full spec: `docs/process/session-output-standard.md`.

## Agent Routing — Lanes (concept)

Work is dispatched to **lanes** by role, independent of which model/engine backs
them. The canonical roles:

| Role | Use for |
|---|---|
| smith | code generation, drafts, config, boilerplate, tests, docs |
| scout | research, doc reading, summarization, spec drafting, pattern search |
| warden | code review, QA, security audit, pre-commit check |
| scribe | memory writes, working-context updates, daily logs |
| steward | task decomposition → queue-ready sub-tasks |
| arbiter | automated quality gate (approve/iterate/reject) |

A task = **role** × **engine** (which model, at what cost/latency). Pick the
cheapest engine that will succeed; escalate only when correctness justifies cost.
The lane *names and engine bindings* an org actually runs are declared in
`config/infrastructure.json` (`agents`), and the dispatch wiring lives in the
consuming repo — core defines the **pattern**, not a specific host.

Research-first gate: for any buildout or non-mechanical work, route to `scout`
for a research pass (best practices, patterns, library choices) BEFORE generating.

## Model Routing

Declare a **primary** model (high-judgment orchestration/decisions) and an
**execution** model (mechanical edits, searches, boilerplate) in
`config/infrastructure.json` (`model`). Spawn mechanical subagents on the
execution tier; keep the orchestration loop on the primary tier. Local/free
inference lanes, where available, should absorb heavy generation.

## Session Lifecycle

- **Start** — orient: read forward state, cross-check against recent commits,
  surface ranked free work, claim atomically (collision-free across sessions).
- **Checkpoint** — bank a completed unit mid-session: commit with intent, refresh
  forward state, keep working. Non-terminating.
- **End** — full close: commit + push, working-context ops (operations, not
  snapshots), reflect + route lessons, daily log, task dedup, handoff, integrity
  check, sign-off.

Tasks are governed through a **forward-only state DAG** (`scripts/update-tier1-state.py`);
data corrections use the audited `correct-state` escape hatch, never DAG
hop-walking. Parallel sessions coordinate via **leases + fencing tokens**
(`scripts/agent-work.py`); a lease on a non-terminal task means active sibling
work. The board (`task-queue.md`, `OPEN_TASKS.md`) is a *projection* of the
canonical `tasks.json` — render, don't hand-edit.

## Memory Conventions

Memory files use YAML frontmatter (`name`, `description`, `metadata.type` of
user|feedback|project|reference, `tags`, `updated`). One fact per file. The
`MEMORY.md` index carries one line per memory (title — hook — tags), capped.
Raw session logs go to dated daily-log files, not the index. Lessons that should
change behavior are routed UP to the governing skill/doc (see
`docs/process/correction-protocol.md`), with the memory entry a short breadcrumb.

## Tiered Context

Context loads just-in-time: a small always-on kernel + path-scoped rules that
activate only when relevant files are touched + an on-demand router that pulls
deeper docs when needed. Keep the always-on surface within budget; see
`docs/process/tiered-context-architecture.md`.

## The overlay boundary

What an org adds on top of core, in its own repo (never committed here):
identity (who the human is, what the agent is called), the project/goal list,
real integration IDs and credentials, machine-specific LaunchAgents, and the
filled-in `config/infrastructure.json`. The split rationale is in `SPLIT.md`.
