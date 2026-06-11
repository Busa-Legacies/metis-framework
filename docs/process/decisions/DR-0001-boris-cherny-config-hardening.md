# DR-0001: Harden Claude Code config from Boris Cherny research

- **Status:** Accepted
- **Date:** 2026-06-01
- **Supersedes:** —
- **Superseded-by:** —

## Context

A research/study pass on Boris Cherny's Claude Code best-practices guidance surfaced four
concrete weaknesses in our then-current Claude Code configuration:

1. **State loss on compaction** — when Claude Code compacts a long session's context window,
   task state in `working-context.md` was not re-injected, so the agent could lose its place
   mid-session.
2. **No auto-format loop** — edits weren't formatted automatically, leaving a manual gap.
3. **Premature compaction** — `autoCompactWindow` was 150k, compacting more often than needed.
4. **API-dependent suggestions** — guidance kept proposing Anthropic-API-backed automations
   (GitHub Actions, webhooks), which conflict with this system's free-local-Ollama model.

This work was committed with good messages (`77d0b67`, `b33b8a6`) but **no durable record tied
the why to the what** — which is exactly the gap that later motivated [DR-0002](DR-0002-decision-record-standard.md).
This DR is the retroactive record, authored 2026-06-02.

## Decision

Harden the Claude Code config along Cherny's principles: keep state durable across compaction,
tighten feedback loops, compact less aggressively, and codify the free-local-only rule.

## Changes

- Added **PostCompact hook** `claude-post-compact.sh` — re-injects `working-context.md` after a
  compaction so task state survives.
- Added **PostToolUse format hook** `claude-format.sh` — auto-formats files after edits.
- Raised **`autoCompactWindow` 150000 → 400000** in `settings.shared.json`.
- Raised **lane timeout 180 → 300s** across `CLAUDE.md` (covers cold KV-cache reloads on large
  sessions).
- Added **"Never suggest Anthropic API for automation"** rule to `feedback_jay_routing.md`.

Pinned commits:
- 77d0b67 checkpoint: harden Claude Code config from Boris Cherny research
- b33b8a6 checkpoint: Boris Cherny session complete + no-API-key rule saved to memory
- `77d0b67` checkpoint: harden Claude Code config from Boris Cherny research
- `b33b8a6` checkpoint: Boris Cherny session complete + no-API-key rule saved to memory

## Consequences

- Long sessions are robust against context compaction — a foundational reliability gain that
  later changes (e.g. the auto-checkpoint loop) build on.
- The free-local-Ollama constraint is now an explicit, recorded rule rather than tribal knowledge.
- **Meta-consequence:** this milestone leaving a trace in `git` but not in the recall path is
  what exposed the need for a Decision Record standard — see [DR-0002](DR-0002-decision-record-standard.md).
