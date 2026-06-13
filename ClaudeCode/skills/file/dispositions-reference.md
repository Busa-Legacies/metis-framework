# File Dispositions Reference

## Disposition table

| Disposition | Meaning | Action in Step 5 |
|---|---|---|
| **KEEP** | Correct home, live, answers a recurring question | None (confirm it's indexed → INDEX if not) |
| **RELOCATE** | Misfiled but still useful — wrong home, right value | `git mv` to its type's home, fix inbound links |
| **RETIRE** | Pure-history one-off (dated review/log/superseded plan) — git history is its archive | `git rm` **after** the link gate clears |
| **DEDUP** | Superseded by / overlaps another file | Merge useful content into the survivor, then RETIRE this one |
| **INDEX** | Lives correctly but is un-indexed | Add to the relevant index only |

## Disposition heuristics

**RETIRE signals** (from the standard):
- Dated artifacts: `*-review-YYYY-MM-DD*`, `*-manual-*`, `superseded-*`
- Numbered-run logs: `audit-run-01.md`, `migration-notes-june.md`
- "What we did on this date" — that's a daily-log/git-history concern, not an in-tree doc concern
- A doc earns its place only if it answers a question someone will ask *again*

**KEEP signals:**
- It's the current, authoritative version of a standard or protocol
- Other live docs reference it (check link gate before discarding these references)
- It answers a recurring operational question

**RELOCATE signals:**
- File type says it should live elsewhere per the filing standard
  - e.g., a `PLAN-*.md` in `docs/process/` should be in `docs/plans/`
  - e.g., a one-off script in `docs/` should be in `scripts/`

**DEDUP signals:**
- Two files with overlapping titles and >50% content overlap
- One file is a clear revision/extension of another (keep the newer/better one)

## DOC-TAXONOMY types (from docs/DOC-TAXONOMY.md)
- **concept** — explains how something works
- **reference** — authoritative values/formats/schemas to look up
- **framework** — process/protocol to follow
- **research** — findings from a specific investigation (typically time-bounded → RETIRE candidate)
- **index** — lists and pointers to other docs

## Filing homes (from docs/repo-structure-filing-standard.md)
- Live process standards → `docs/process/`
- Build plans → `docs/plans/`
- Architecture decisions → `docs/process/decisions/`
- Scripts and tooling → `scripts/`
- Ephemeral session artifacts → `scratch/` (git-ignored)
- Daily logs → `<<MACHINE_1_ID>>/memory/YYYY-MM-DD.md`
