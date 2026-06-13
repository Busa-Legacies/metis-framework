# Gap-Analysis Standard — Forward-Looking Process

Status: active
Created: 2026-06-11
Owner: claude + codex (shared process)

The canonical process for assessing the OS and turning gaps into governed work. It replaces
ad-hoc "let's do a review" with three named tiers, a fixed cadence, and — critically — a
**reconciliation gate** for when more than one analysis runs at once (which is now normal:
claude and codex both assess).

The executable companion is the **`gap-analysis` skill** (`ClaudeCode/skills/gap-analysis/SKILL.md`),
which automates the per-run mechanics (pre-flight reads → scored table → mint on approval). This
doc is the *governing standard*: which tier, when, who, where it's written, and how parallel runs
merge.

---

## 1. Three tiers (altitude)

| Tier | Name | Question it answers | Cadence | Output |
|---|---|---|---|---|
| **T1** | Operational audit | "What's broken / unsafe / fragile *right now*?" | ~weekly, or before any open-sourcing / deploy | `docs/process/audits/system-audit-<date>.md` |
| **T2** | Strategic gap analysis | "Is this domain heading where it should, and what's the phased path?" | at milestone boundaries, or when a domain stalls | `docs/plans/PLAN-<domain>-forward-gap-analysis.md` |
| **T3** | Portfolio review | "Across **all** goals, where is effort vs. where should it be?" | monthly / quarterly, or after a big shift | `docs/plans/PLAN-full-os-forward-gap-analysis.md` |

Rule of thumb: **T1 finds fires, T2 plans a domain, T3 re-allocates the whole portfolio.** A finding
can promote upward (a recurring T1 fragility becomes a T2 gap; a starved goal in T3 spawns a T2).

## 2. What each tier produces

**T1 — Operational audit.** Severity-tiered (P0–P3), file:line evidence or a verification note per
finding, grouped by severity not by system. Ends with a recommended sequence and a disposition
block (fixed-inline vs. minted). Generated/assisted by `scripts/system-audit.sh`.

**T2 — Strategic gap analysis.** Canonical section order:
`North Star → Current State (with task counts) → Gaps (A…N: symptom / target) → phased Roadmap
(Phase 1…N with milestones + task candidates) → Project/Milestone structure → Next Moves
(immediate / autonomous / needs-Ant) → Decision Summary`.

**T3 — Portfolio review.** `Direction (maturity arc / working-model evolution / capability bets)
→ Coverage map (anti-collision) → portfolio evidence grouped by goal → decision table → decision
summary`. Always opens with the **coverage map** so it doesn't re-litigate T1/T2 work.

**T3 altitude rule (learned 2026-06-11):** a T3 is about **future direction and how the
way-of-working should evolve** — the maturity stage the OS is in, the shifts in the human↔agent
working model, the capability bets for the next horizon. Current blockers and task states are
*supporting evidence*, never the headline. **If a T3 draft reads like a status report or blocker
triage, it's at the wrong altitude — that's T1/T2 material.** Litmus: every top-level section
should still be true and useful if every currently-blocked task unblocked tomorrow.

## 3. Scoring (all tiers)

Rank every gap by three axes (from the gap-analysis skill):

- **Campaign priority** — G/P1 > G/P2 > G/P3 (map the gap to an active campaign in
  `docs/process/goals.md`, and to a life domain in `docs/process/taxonomy.yaml`).
- **Leverage** — does closing it unblock other work, or is it a leaf?
- **Agent-executability** — can an agent run it now, or is it human-gated (decision/money/auth)?

Decision-type gaps (Ant must choose) are always surfaced even though they aren't agent-runnable.

**Evidence over vibes:** claims about flow ("the board is stale", "we mint faster than we drain")
must be computed from state, not asserted. Where the schema can't answer (e.g. no `createdAt`),
say so explicitly — that measurement hole is itself a finding (see T3 2026-06-11, Gap 8).

## 4. The mint gate (decide-and-present) — and the prune pass

Never auto-mint from a strategic/portfolio run — bulk minting crosses the confirm threshold.

1. Present **one decision table**: `# | slug | gap | goal | priority | type | agent-runnable?`.
2. **Prune pass (mandatory for T3, recommended for T2):** an analysis that only *adds* tasks is
   half a process. Review the open board for tasks that are shipped-but-open, obsolete, or carry
   stale/broken metadata, and present a **prune-candidates table** alongside the mint table.
   **"Zero mints + N prunes" is a fully valid analysis outcome.**
3. Ask **one** approval question covering both: *mint all / a subset / none — and approve/deny the prunes*.
4. On approval, per gap: `agent-work.py alloc-id` → `update-tier1-state.py create-task` with
   `origin=collab` and `originRef="gap-analysis <date> <source>"` → `render-tier1-state.py write`.
   Prunes go through the governed close path with a `pruned: gap-analysis <date>` note.
5. Flip any `- [ ]` declared-gap lines in source docs to `- [#NNN]` (present the diff, don't silently rewrite).

A **scheduled/autonomous** run that mints without Ant present tags those tasks `origin=system`.

**Queue-health gate:** before proposing mints, check flow — if the queue is deep and drain is the
constraint (many queued, little in-progress movement), the right output is *fewer* mints, more
prunes, and effort pointed at execution throughput, not more declared work.

## 5. Parallel-run reconciliation gate  ← the new rule

More than one analysis now runs concurrently (e.g. claude T3 + codex T2). To prevent duplicate
tasks and contradictory roadmaps:

1. **Declare scope up front.** Each run states its tier + scope in the doc header and, if another
   run is known to be live, adds a one-line coordination note (as this session's T3 did).
2. **Coverage map before gaps.** Every run that isn't the only one live opens with a coverage map
   (who owns which layer). Owned layers are referenced, not re-analyzed.
3. **No independent minting.** When ≥2 analyses are live, **neither mints alone.** Produce both
   decision tables, then do a **single merged mint**: dedup candidates by slug *and by intent*
   (two differently-named tasks for the same work collapse to one), keep the clearest framing,
   `origin=collab`.
4. **One reconciler.** The session that surfaces the overlap drives the merge and posts the merged
   table for the single approval. The other run's candidates are folded in by reference.
5. **Conflicting roadmaps → escalate to Ant**, don't silently pick one.

## 6. Files & naming

- T1 → `docs/process/audits/system-audit-<YYYY-MM-DD>.md`
- T2 → `docs/plans/PLAN-<domain>-forward-gap-analysis.md`
- T3 → `docs/plans/PLAN-full-os-forward-gap-analysis.md` (single living file; date the revisions inside)
- Detailed evidence (optional) → `docs/plans/evidence/<slug>-<date>.md`

Each run appends a one-line pointer to `<<MACHINE_1_ID>>/memory/working-context.md` so the next session sees it.

## 7. When to run

- **T1:** weekly, or the moment something feels fragile / before exposing surface (deploy, open-source).
- **T2:** when a domain hits a milestone boundary or stalls (board shows a project flat for a week).
- **T3:** monthly, after a major shipped initiative, or when the board "looks thin" and the
  `gap-analysis` skill's start-of-session trigger fires.

The skill's standing trigger still applies: run `/gap-analysis` at the start of a strategic session
or when `working-context.md`'s next-action says "claim next free task" and the board looks thin.
