# Workbench Mission/Evidence Ledger Build — Claude (Forge) — 2026-05-09 CT

## 1. Scope of this slice

Begin the CEO/product-management cockpit buildout with the smallest safe,
fully reversible increment. From the spec
`WORKBENCH_CEO_PRODUCT_MANAGEMENT_FLOW_SPEC_CLAUDE_20260509.md` §8 Wave A,
implement only step **A2 — Evidence Ledger persistence** and only its
backend persistence layer. No UI surface, no assistant tools, no cockpit
joins, no API routes, no modifications to existing files.

Why this slice first: it is the substrate every other CEO surface depends
on — Workspace Review Strip joins it (A3), state machine reads it (B2),
commit packet card is gated on it (D1/D2), `summarize_portfolio` quotes
it (C1), watchdog "needs review" inference uses it (C2). Until the
ledger exists, those slices have no source of truth to read from.

Reversibility: two new files only; deletion fully reverts the change.
No existing module or test was edited.

## 2. Files changed

| File | Status | Purpose |
| --- | --- | --- |
| `lib/evidence-ledger.ts` | new | Pure persistence layer — atomic per-workspace JSON store with same-dir rename writes (mirrors `lib/dispatch-runs.ts:104-119`). Public API: `appendEvidence`, `listEvidence`, `getEvidence`, `evidenceCounts`, `hasRequiredEvidenceForDone`, `EVIDENCE_KINDS`. |
| `tests/evidence-ledger.test.ts` | new | `node --test` unit tests covering atomic write, restart re-read, idempotent id, kind validation, summary/workspaceId validation, filter projection, count rollup, done-gate rule, and filename sanitization. |

No edits to: `lib/dispatch-runs.ts`, `lib/cockpit-summary.ts`,
`lib/types.ts`, `app/**`, `server/**`, `components/**`,
`tests/cockpit-continuity.test.ts`, `package.json`, `eslint.config.mjs`,
`tsconfig.json`. `data/evidence-ledger/` directory is created lazily on
first append; an empty repo will not see it appear until a tool writes a
row.

## 3. Design notes (why this shape)

- **Storage layout.** `data/evidence-ledger/<workspaceId>.json` with
  shape `{ rows: EvidenceRow[] }`, newest-first. Identical layout
  rationale as `lib/dispatch-runs.ts` so a future cockpit join can use
  the same read pattern. Path overridable via
  `AW_EVIDENCE_LEDGER_DIR` for tests, matching `AW_DISPATCH_RUNS_DIR`
  / `AW_COCKPIT_STATE_DIR` conventions.
- **Atomic write.** `writeJsonAtomic` writes a unique `.tmp` sibling
  then `renameSync`. Same-dir rename guarantees atomicity on the same
  volume; tmp leftovers are best-effort cleaned in `finally`.
- **Evidence kinds.** Spec §6.4 names five (`report`, `test`, `diff`,
  `review`, `manual_override`); §6.7 adds `commit_approval` and
  `push_approval`. All seven are exported as a frozen tuple
  `EVIDENCE_KINDS` so the assistant tool layer can validate against
  the same source of truth when it lands in a later slice.
- **Idempotency.** If a caller supplies `id`, a second call with the
  same id is a duplicate (returns the prior row, bumps `updatedAt`).
  If `id` is omitted, it is derived from a stable hash of the row
  content + `createdAt`, so two rapid calls with identical content but
  no explicit id will produce distinct ids (correct: caller didn't ask
  for idempotency).
- **Validation at the boundary.** `appendEvidence` rejects on missing
  `workspaceId`, empty `summary`, or unknown `kind`. Read paths
  silently drop malformed stored rows so a hand-edited or partially
  written file cannot crash the cockpit summary. This matches the
  resilience posture of `lib/dispatch-runs.ts:97-102`.
- **Done-gate helper.** `hasRequiredEvidenceForDone(ws, taskId)`
  encodes spec §6.5 / AC4.4: `≥1 report` AND (`≥1 review` OR
  `≥1 manual_override`). The gate stays in the persistence module so
  every callsite enforces the same rule; the upcoming
  `mark_task_done` tool (Wave B2) will import this directly instead
  of re-implementing it.
- **Filename sanitization.** Workspace ids are restricted to
  `[a-zA-Z0-9_.-]` with `_` substitution; empty → `global`. Same rule
  as `lib/dispatch-runs.ts:90-93`. Prevents path traversal from a
  malformed workspace id.

## 4. Tests

Test file: `tests/evidence-ledger.test.ts`, eight cases:

1. Persists rows under the expected path with no `.tmp` leftovers.
2. Survives a re-read (restart simulation via fresh `listEvidence`
   call hitting disk).
3. Idempotent on supplied `id` (`duplicate: true` second time, single
   row on disk).
4. Rejects an unknown `kind`.
5. Rejects empty summary and empty workspaceId.
6. Filters by `missionId` / `laneId` / `taskId` / `agentId` / `kind`.
7. `evidenceCounts` rolls up by kind for a filter scope.
8. `hasRequiredEvidenceForDone` enforces the report + (review |
   manual_override) rule and rejects review-only.
9. Filename sanitization: `../weird/ws id` resolves to a safe `_`
   substituted filename inside the temp dir.

### Test runs done

**None executed in this session.** Running `npm test`,
`npx tsx --test tests/evidence-ledger.test.ts`, and
`npm test -- tests/evidence-ledger.test.ts` each required harness
permission approval that this Forge slice does not have. The tests are
written to the same shape as `tests/cockpit-continuity.test.ts` (which
the existing harness runs) and use only `node:test`, `node:assert`,
`node:fs`, `node:os`, `node:path` — no new deps, no fixture files. They
are expected to pass when run by Shield in the next lane.

Recommended single-command invocation for the next lane:

```
npx tsx --test tests/evidence-ledger.test.ts
```

If Shield wants to confirm no regression in the existing suite:

```
npm test
```

## 5. What this slice does NOT do (deferred)

- **No assistant tools.** `attach_task_evidence`,
  `record_review_verdict`, `record_test_run`, `record_diff_snapshot`,
  `record_manual_override` are not registered in
  `lib/tool-routing.ts` or `app/api/assistant/route.ts` yet. The
  helpers they will call (`appendEvidence`, etc.) are now ready.
- **No cockpit join.** `lib/cockpit-summary.ts` does not yet read the
  ledger. Workspace Review Strip (A3) is the natural place to wire it
  in; doing it here would force edits to a heavily-tested module and
  break the "two files only" reversibility goal.
- **No API route.** No `app/api/evidence/...` endpoint. The Workspace
  Review Strip will likely call into the helper from the same server
  process; a separate REST route is unnecessary for now.
- **No state-machine integration.** `Task.status` in `lib/types.ts`
  remains `'todo' | 'building' | 'review' | 'done'`. Adding
  `ready_to_commit` and `blocked` is Wave B2 and requires UI work in
  `components/TasksPanel.tsx`.
- **No mission packet model.** The fields `missionId` and `laneId` on
  `EvidenceRow` are optional and forward-compatible; `lib/mission-packets.ts`
  (Wave B1) is still to be authored.

## 6. Next builder lane (recommendation)

The next-best slice is **A3 — Workspace Review Strip backend join**, NOT
A1 (sync-status) and NOT B1 (mission packets). Reasoning:

- A3 is the smallest visible payoff that consumes A2: the strip can
  show `evidenceCount` and `unreadReports` per workspace today, even
  before sync-status lands.
- A3 only reads from the ledger; no schema change needed.
- A1 (sync-status endpoint) requires shelling out to `git` and adding
  a new server route — bigger blast radius and not a blocker for the
  cockpit visible payoff.
- B1 (mission packets) requires assistant-side prompt changes and
  drawer UI; better suited to a dedicated lane after the read surfaces
  exist.

Concrete next-lane scope (Forge or Codex):

1. Add a `joinEvidenceCounts(workspaces)` helper in `lib/cockpit-summary.ts`
   calling `evidenceCounts(workspaceId)` per workspace.
2. Surface it on `CockpitSummaryResponse` as
   `workspaceMatrix[ws].evidence: { total, byKind }`.
3. Extend `tests/cockpit-continuity.test.ts` (or a new
   `tests/cockpit-evidence-join.test.ts`) with a fixture that writes a
   row via `appendEvidence` under a temp dir + temp ledger dir, then
   asserts the matrix carries the count.
4. Wire the strip tile in `components/Workbench.tsx` to read
   `workspaceMatrix[ws].evidence.total` and show
   "evidence: N" beside the existing chips. Pure read; no UI gate
   removed.

Estimated lane budget: 60–90 minutes Forge + 30 minutes Shield review.
Reversibility remains high: one helper add in `cockpit-summary`, one
field on the response, one tile change in `Workbench.tsx`.

## 7. Open items for Nick

- **Evidence retention policy.** Spec §10 default proposes 30-day
  full retention then per-lane summary collapse. Nothing in this slice
  expires or compacts rows — the ledger grows monotonically per
  workspace until a future `compactEvidence` lane lands. Confirm the
  30-day default is acceptable before any compaction is built.
- **Per-task uniqueness.** Today the same payload appended twice
  without an explicit `id` becomes two rows (because `createdAt` is
  part of the derived id). If the assistant should de-dupe identical
  test runs within a short window, the dedupe knob belongs at the
  tool-call layer, not at the ledger.
- **Confidentiality.** `payload` is opaque `Record<string, unknown>`
  and is written verbatim. Tools that capture command output (e.g.
  `record_test_run`) MUST scrub secrets before calling
  `appendEvidence`; the ledger does not redact.

## 8. Verification

- Two new files only:
  - `lib/evidence-ledger.ts`
  - `tests/evidence-ledger.test.ts`
- One new artifact: this report
  (`WORKBENCH_MISSION_EVIDENCE_LEDGER_BUILD_CLAUDE_20260509.md`).
- No edits to existing source modules, configs, or tests.
- No push, no deploy, no install, no external send.
- Working directory: `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`
  throughout.
- Reverse this slice with: `rm lib/evidence-ledger.ts tests/evidence-ledger.test.ts WORKBENCH_MISSION_EVIDENCE_LEDGER_BUILD_CLAUDE_20260509.md`
  (no other state to clean; `data/evidence-ledger/` is created only on
  first real append and is safe to leave or `trash`).
