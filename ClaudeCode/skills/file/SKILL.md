---
name: File
slug: file
version: 1.0.0
description: "Triage, dedup, relocate, and retire files across a repo surface — link-aware. Keeps the tree aligned with docs/repo-structure-filing-standard.md. Surface to audit (optional): $ARGUMENTS"
---

TRIGGER when: a directory has sprawled, a file feels misfiled, running the #107 repo-wide alignment audit, or after a burst of doc creation that left things un-indexed.
DO NOT trigger for: a single obvious move you can do in one edit, or anything outside the repo tree.

Read first — these are authoritative and this skill is their executor:
- `docs/repo-structure-filing-standard.md` — top-level map, "where does a new X go?", the Retirement rule
- `docs/DOC-TAXONOMY.md` + `docs/DOC-STANDARDS.md` — how `docs/` content is classified and indexed

## Scope
`$ARGUMENTS` names the surface to audit. Default to the highest-sprawl surface if omitted. Do **one surface per run**. Priority order: `docs/process/` → `scripts/` → root files → `docs/` → `ClaudeCode/` → `<<MACHINE_1_ID>>/`,`<<MACHINE_2_ID>>/` → `projects/`.

## Step 1 — Inventory the surface
List every file in the target surface with a one-line read of its purpose (first heading / first line). For `docs/`, note its DOC-TAXONOMY type.

## Step 2 — Classify each file
See `dispositions-reference.md` in this skill directory for the full disposition table and heuristics.

Assign exactly one disposition per file: **KEEP / RELOCATE / RETIRE / DEDUP / INDEX**.

## Step 3 — Link-aware gate (the safety core — never skip)
For **every** RETIRE / RELOCATE / DEDUP candidate, find inbound references before touching it:
```bash
grep -rn "candidate-file-name" docs/ ClaudeCode/ scripts/ *.md <<MACHINE_1_ID>>/ <<MACHINE_2_ID>>/ 2>/dev/null
```
Classify each inbound reference by the disposition of the referencing file:
- Referenced **only by other RETIRE/DEDUP candidates** → safe; the link dies with both ends.
- Referenced by a **KEEP / RELOCATE / out-of-scope** file → **BLOCKER**. You may not `git rm` it until that link is repaired.

Output per-candidate: `RETIRE file.md — 0 inbound · SAFE` or `RETIRE file.md — 3 inbound (2 KEEP) · BLOCKED → rewrite refs in a.md,b.md first`.

## Step 4 — Reconciliation report (dry-run, NO mutation)
Print the full plan before changing anything:
```
FILE AUDIT — <surface> (<N> files)

KEEP        <n>   (✓ indexed: <k> · ⚠ needs INDEX: <n-k>)
RELOCATE    <n>   <file> → <new home>     [link: SAFE | BLOCKED]
RETIRE      <n>   <file>                  [link: SAFE | BLOCKED]
DEDUP       <n>   <file> ⊃ merge into <survivor>, then retire
INDEX       <n>   <file> → add to <index>

⛔ BLOCKED — must fix inbound refs first:
  - <file>  ← referenced by <KEEP-doc> (rewrite to <target>)

Net: <retire> deletions, <relocate> moves, <index> index updates.
No changes made yet. Proceed? (all / safe-only / no)
```

`safe-only` executes only SAFE items; BLOCKED ones deferred. **Wait for explicit confirmation** — destructive `git rm`/`git mv` never run without it.

## Step 5 — Execute (only after confirmation)
In dependency order:
1. **Rewrite inbound refs** for BLOCKED items being cleared this run.
2. **DEDUP merges** — copy useful content into the survivor first.
3. **RELOCATE** — `git mv <old> <new-home>`; refs from step 1 already point at `<new>`.
4. **RETIRE** — `git rm <file>` for every now-SAFE candidate.
5. **INDEX** — update `docs/DOC-INDEX.yaml` / `DOCS-BACKLOG.md` / `MEMORY.md` for KEEP-needs-index and anything moved.

Re-run Step 3's grep on retired basenames to assert **zero** surviving inbound references. If any remain, fix before finishing.

## Step 6 — Report, don't commit
`✓ <surface>: <retired> retired · <moved> relocated · <indexed> indexed · 0 dangling refs.`

Leave the commit to the next `/checkpoint`.

## Guardrails
- **One surface per run.** Whole-tree passes are unreviewable.
- **Never `git rm` a link-BLOCKED file.** The gate is the whole point.
- **`scratch/` is exempt** — git-ignored ephemeral work, not a filing target.
- **When unsure between RETIRE and KEEP, KEEP.** Deletion is irreversible; a stale-but-harmless doc costs less than a lost one.
