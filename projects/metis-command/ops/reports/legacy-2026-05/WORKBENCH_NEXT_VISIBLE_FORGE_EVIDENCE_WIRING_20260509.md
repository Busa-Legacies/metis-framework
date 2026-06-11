# Workbench Next Visible Forge Evidence Wiring — 2026-05-09 16:51 CT

## Status

**PARTIAL — implementation appears already wired; verification/edit was blocked by Claude pane permissions.**

This artifact was written by Jarvis from the visible one-shot Claude pane output because the pane ran in a mode where file tools were denied.

## Findings

The evidence stack from the prior session appears wired end-to-end:

| Layer | File | Status |
|---|---|---|
| Persistence | `lib/evidence-ledger.ts` | Complete |
| Cockpit join | `lib/cockpit-summary.ts` | `CockpitWorkspace.evidence`, `CockpitTotals.evidenceTotal`, join around line 412 |
| UI state | `lib/cockpit-ui-state.ts` | `CockpitWorkspaceMatrixRow.evidenceTotal` present around line 73 |
| API route | `app/api/assistant/route.ts` | Calls `evidenceCounts()` per workspace and passes into `buildCockpitSummary` around lines 143–158 |
| Cockpit test | `tests/cockpit-continuity.test.ts` | Matrix row `evidenceTotal` asserted around lines 195–196 |
| Ledger tests | `tests/evidence-ledger.test.ts` | 9 cases written, but pane could not run them |

## Remaining gaps

1. Add a totals assertion in `tests/cockpit-continuity.test.ts` after the existing `ws2Row` evidence assertion:

```ts
assert.equal(summary.totals.evidenceTotal, 5)
```

2. Run the focused ledger test:

```bash
npx tsx --test tests/evidence-ledger.test.ts
```

Expected from pane: 9 pass.

## Blocker

Claude one-shot pane launched with `--permission-mode dontAsk`, but in `-p` mode Claude reported all file tools were denied: Bash, Edit, and Write. It could inspect/summarize but could not write the artifact or run tests.

## Next lane

A3 — Workspace Review Strip: wire `evidence.total` into the `WorkspaceReviewStrip` tile in `components/Workbench.tsx`, reading `workspaceMatrix[ws].evidenceTotal`.
