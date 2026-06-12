# Sync merge boundary — what auto-resolves, what escalates

The auto-sync daemon (`scripts/openclaw-git-sync.sh`) reconciles divergent commits
on `main` across machines every few minutes. It is safe for *some* classes of
divergence and deliberately escalates others. This documents the boundary so we
keep code off the paths the daemon can't safely merge, and lean on the layers
that it can.

## The merge ladder (in order; each only runs if the prior left a conflict)

| Tier | Handles | Mechanism | On failure |
|---|---|---|---|
| **0 — fast-forward / disjoint** | commits touching *different* files | git 3-way merge | — |
| **1 — governed state** | `tasks.json`, `active-checkouts.json` | dedicated merge drivers: `taskstate` (revision-wins), `leasestate` (fenceCounter-wins) | drop to tier 2 |
| **2 — recurring conflicts** | same-shape hunks seen before | `rerere` replays the recorded resolution | drop to tier 3 |
| **3 — novel CODE conflict** | overlapping edits to the same lines of code/text | **AI merge resolver** (`ai-merge-resolver.py`) — see below | drop to tier 4 |
| **4 — fail-soft** | anything tiers 1–3 couldn't resolve | `git merge --abort`, restore tree, Discord alert | human |

Tiers 0–2 are deterministic and were hardened through the T-SYNC saga. Tier 3 is
the AI layer added so a genuine code conflict no longer dead-ends at a human who
can't review code. Tier 4 is the unchanged safety net.

## The hard rule

**Route code through branches/PRs; reserve auto-synced `main` for the governed
state files the drivers understand.** The deterministic drivers (tier 1) only
cover the two JSON state files. For *code*, git protects tree *integrity* (no
conflict markers committed) but not merge *correctness* — a divergent code chain
can produce a clean-but-wrong semantic mismerge. Tier 3 mitigates this, but the
cheapest correctness guarantee is to not create overlapping code edits on `main`
in the first place. When `main` is actively divergent, land code via the
worktree→origin pattern or a feature branch (see
`feedback_land_work_via_worktree_when_sync_stuck`).

## Tier 3 — the AI merge resolver

`scripts/ai-merge-resolver.py`, invoked by the daemon at the point tier 4 would
otherwise abort. It resolves the conflict the way the *author* would (the agent
that wrote both sides), then **proves** the result before the daemon pushes it.

**Safety contract — it can only ever improve on the tier-4 abort.** It stages
nothing until every gate passes; any failure or exception exits non-zero and the
daemon falls back to the abort. A bug in the resolver degrades to today's
behavior, never to a corrupt push.

**Four gates, all required:**
1. **No markers** — the resolved file contains no conflict markers.
2. **Blast radius** — the AI may only change text *inside* conflict regions;
   every non-conflicted line of the original must survive verbatim, in order.
   Verified mechanically (`blast_radius_ok`), not trusted.
3. **Intent review** — a second, independent AI pass adversarially confirms the
   resolution preserves *both* sides' intent (the author-review a human can't do
   here). Must return APPROVE.
4. **Mechanical** — changed files compile/parse (`compileall`, `node --check`,
   JSON parse) and the governance + self-heal self-tests pass.

**Eligibility:** code/text files only (`.py`, `.js/.ts`, `.sh`, `.md`, configs…).
Governed-state JSON is intentionally excluded — those have tier-1 drivers; if one
reaches tier 3 unresolved that's a driver gap for a human, not an AI guess.

**Visibility (Ant's loop-in):** on success the daemon pushes and fires a Discord
message naming the conflicted files, the resolution summary, and a one-command
revert. Ant doesn't review code up-front; the gate + the audit + the revert path
are the safety model (decision: 2026-06-11, "push to main + audit").

**Guards on the resolver itself:** `test-ai-merge-resolver.py` tests the pure
safety gates (conflict parsing, the blast-radius bound, extraction, marker
detection) with no AI — wired into CI so the bound can't silently regress.

## Adequacy summary

- Disjoint divergence → safe (tier 0).
- Governed state files → safe (tier 1 drivers + rerere).
- Recurring known conflicts → safe (tier 2).
- Novel code conflicts → tier 3 attempts an *verified* author-intent resolution;
  if it can't clear all four gates, tier 4 escalates. No unverified code is ever
  auto-pushed.
