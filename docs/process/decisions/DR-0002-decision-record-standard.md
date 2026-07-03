# DR-0002: Adopt a Decision Record standard for system milestones

- **Status:** Accepted
- **Date:** 2026-06-02
- **Supersedes:** —
- **Superseded-by:** —
## Context

Git reliably captures *what changed* (diffs + intentional commit messages under the
snapshot-vs-history contract). It does **not** capture *why* a cluster of changes happened — the
research or decision behind them. That rationale lived only in a session's live context and was
lost at session end.

The trigger was concrete: a session asked "what did we learn from the Boris Cherny research?"
and the natural recall path (working-context → memory files → RAG grep) returned nothing — the
answer existed only as commit diffs (`77d0b67`, `b33b8a6`), discoverable solely by `git log`
archaeology. The root cause was not "no standard exists" but that the close protocol's memory
step (step 10) is *discretionary*, and a milestone's rationale fell through the discretionary
gap while its diffs sailed into history. See [DR-0001](DR-0001-boris-cherny-config-hardening.md).

Scout research confirmed the established remedy (ADR / MADR, Keep a Changelog) and, critically,
the #1 anti-pattern: **decision logs die when they're a separate ritual detached from the
workflow.** The fix must be low-friction and captured at the point of decision.

## Decision

Adopt a lightweight, ADR-derived **Decision Record (DR)** standard:

- Numbered, immutable markdown records in a self-contained folder `docs/process/decisions/`
  (auto-indexed by RAG under `shared` → discoverable by all agents).
- The **DR-NNNN ID is the bidirectional join key** between rationale and code (`git log
  --grep=DR-NNNN`), robust to rebases — no fragile SHA-stamping required.
- Creation is **folded into `/checkpoint` and `/end`** (the only intentional-history authors),
  never a standalone ritual, with a **narrow trigger** so DRs stay signal, not noise.
- A **zero-LLM Stop-hook heuristic** detects milestone-shaped commit clusters and rides the
  existing checkpoint nudge — thorough coverage at ~zero marginal compute.

## Alternatives considered

- **Protocol-only (no tooling):** rejected — relies on the same discretionary discipline that
  already failed once.
- **Store in `ClaudeCode/memory/` only:** rejected — Claude-Code-siloed, but most milestones are
  cross-agent; re-creates the siloing problem the memory-surface-map warns against.
- **A DR per commit / verbose changelog:** rejected — guarantees rot via noise. The trigger is
  deliberately narrow (a handful per month).

## Changes

- New folder `docs/process/decisions/` with `STANDARD.md`, `TEMPLATE.md`, `README.md` (index).
- New helper `scripts/decision-record.py` (`new` / `list` / `link` / `index`).
- Stop hook `hook-alerts.sh`: zero-LLM milestone heuristic → `milestone-pending` marker.
- UserPromptSubmit hook `hook-prompt-guard.sh`: rides the checkpoint nudge with a DR prompt.
- `~/.claude/CLAUDE.md` (`ClaudeCode/CLAUDE.md`): DR step added to `/checkpoint` and `/end`.
- `/checkpoint` and `/end` skill files updated with the DR step.
- See `git log --grep=DR-0002` for the implementing commits.

Pinned commits:
- `5c74116` feat(decisions): Decision Record standard for system milestones (DR-0002)
- `83fe6ca` chore: decision-record infrastructure + project_decision_records memory

## Consequences

- System milestones now leave a durable, recall-surfaced record tying *why* to *what* — the
  failure mode that produced DR-0001 cannot silently recur.
- A small recurring obligation at checkpoint/end time, bounded by the narrow trigger.
- DRs are immutable: revisiting a decision means a new DR that `Supersedes` the old one, so the
  reasoning history accretes rather than being overwritten.
- This standard is itself the first thing a new agent should read to understand how the system
  records its own evolution.
