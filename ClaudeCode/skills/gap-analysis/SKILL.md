---
name: gap-analysis
slug: gap-analysis
version: 1.0.0
description: "Read goals + task board, identify uncovered work, present a scored gap table, and mint tasks on approval (origin=collab)."
---

## Steps

### 1. Pre-flight — read sources

```bash
# Live task board state
python3 scripts/free-work.py 2>/dev/null

# Mechanical coverage gaps from strategy docs
python3 scripts/coverage-lint.py --json 2>/dev/null

# Goals and projects (goal priority + doneWhen)
cat docs/process/goals.md
cat docs/process/state/projects.json | python3 -c "
import json,sys
for p in json.load(sys.stdin)['projects']:
    print(p['slug'], '|', p.get('priority','?'), '|', p.get('doneWhen','')[:80])
"
```

Read `workspace/memory/working-context.md` for open threads that may already address a gap.

### 2. Compute gaps — two passes

**Pass A — mechanical:** parse `coverage-lint.py --json` output. Each `"gaps"` entry is a declared-but-unminted gap from a strategy doc. These are the highest-confidence gaps (an author already wrote them down).

**Pass B — judgment:** for each goal in `goals.md` and each project in `projects.json` with non-`done` status, ask: does at least one open or in-progress task directly advance the `doneWhen` criterion? If not, flag as a judgment gap with the goal/project ID.

### 3. Score gaps

Rank each gap by:
- **Goal priority** (G1/P1 > G2/P2 > G3/P3 system goals)
- **Leverage** (does this unblock other work or is it a leaf?)
- **Agent-executability** (can the agent do it now, or is it human-gated?)

Log the full suggestion list to the task queue immediately without pausing — per standing pref (`feedback_log_suggestions_always`). Even gaps that won't be minted this session should be visible.

### 4. Present — decide-and-present

Emit one table:

```
| # | Slug (proposed)             | Goal | Priority | Origin | Agent-runnable? |
|---|-----------------------------|------|----------|--------|-----------------|
| 1 | queue-runner-v1             | G1   | P1       | gap/goals.md | yes |
| 2 | example-grant-tracker   | G3   | P2       | NavoreMarket/Example-Ops:director-workspace/strategy/README.md | yes |
...
```

Then ask **one** approval question (the only pause point):
> "Mint all / mint [1,3,5] / none?"

Do NOT auto-mint. Bulk minting crosses the confirm threshold.

### 5. Mint on approval

For each approved gap:
1. `python3 scripts/agent-work.py alloc-id` → get `#NNN`
2. `python3 scripts/update-tier1-state.py create-task --actor claude --patch '{...}'`
   - Set `"origin": "collab"` (agent proposed, Ant approved)
   - Set `"originRef": "gap-analysis <YYYY-MM-DD> <source-doc>"` for strategy-doc gaps; `"gap-analysis <YYYY-MM-DD> <goal-id>"` for judgment gaps
3. `python3 scripts/render-tier1-state.py write`

### 6. Update strategy docs

For each newly minted task that came from a `- [ ]` declared gap line, note the flip:
```
  • docs/consulting/consulting-business-framework.md line XX:
    - [ ] consulting-tax-assistant  →  - [#NNN] consulting-tax-assistant
```
Present the diff to Ant (don't silently rewrite unless Ant says go).

### 7. Confirm

```
✓ gap-analysis — banked
- Minted: #NNN <slug>, #NNN <slug>, ...
- Covered goals: G1 (queue-runner), G3 (example-grant)
- Tracked gaps remaining: N (see strategy docs)
- Next: claim #NNN <highest-priority minted task>
```

## Notes

- **Governing standard:** `docs/process/gap-analysis-standard.md` — defines the three tiers
  (T1 operational audit · T2 strategic · T3 portfolio), cadence, file naming, and the
  **parallel-run reconciliation gate**. This skill automates the per-run mechanics; that doc
  governs *which* tier, *when*, and how concurrent runs merge.
- **Parallel runs don't mint alone.** If another analysis (e.g. codex) is live, open with a
  coverage map, dedup candidates by slug *and intent*, and do a single merged mint — never two
  independent mints. See §5 of the standard.
- **origin=collab** on every minted task — agent proposed from gap analysis, Ant approved the mint.
- If a **future scheduled run** auto-mints without Ant approval, those tasks get `origin=system`.
- **Warn-only gaps** (WARN lines from coverage-lint) are informational — they count toward the table but are not FAILs and do not block close.
- Degrade gracefully: if coverage-lint.py fails, skip Pass A and run Pass B (judgment only); note the degradation.
- Run `/gap-analysis` at the start of any strategic planning session or whenever the working-context `## Next action` says "claim next free task from free-work.py" and the board looks thin.
