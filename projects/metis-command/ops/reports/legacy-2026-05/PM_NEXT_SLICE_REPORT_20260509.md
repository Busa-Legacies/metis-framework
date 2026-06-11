# PM Next-Slice Report — Cockpit→Rollup Adapter — 2026-05-09 CT

## Slice shipped

**Cockpit-summary → PortfolioRollup adapter** (suggested next slice #1
from `PM_HANDOFF_20260509.md`).

A pure function `convertCockpitToRollup(summary, options?)` that maps the
operational `CockpitSummaryResponse` produced by `buildCockpitSummary`
into the downstream `PortfolioRollup` shape consumed by the
Telegram-safe renderer (`lib/portfolio-render.ts`). This unblocks the
renderer for real cockpit-summary fixtures without changing the renderer
or the cockpit summary builder.

## Branch + commit

- Branch: `slice/cockpit-rollup-adapter` (forked from `3dcabe6`).
- Commit: `e175101 feat(ceo-flow): cockpit→rollup adapter for portfolio renderer`.
- Pushed to `origin/slice/cockpit-rollup-adapter`. **No push to `main`.**

## Files added

```
lib/cockpit-to-rollup.ts        |  86 ++++++++++
tests/cockpit-to-rollup.test.ts | 338 ++++++++++++++++++++++++++++++++++++++++
2 files changed, 424 insertions(+)
```

No other source files modified. No deps installed.

## Adapter behavior (mapping decisions)

| PortfolioRollup field        | Source                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| `generatedAt`                | `summary.generatedAt`                                                      |
| `workspaces[].workspaceId`   | `workspace.workspaceId`                                                    |
| `workspaces[].name`          | `workspace.workspaceName`                                                  |
| `workspaces[].sync`          | `options.syncByWorkspace[id]` if provided, else `{inRepo:true, branch:null, all 0}` (renders "clean") |
| `workspaces[].inFlightAgents`| `workspace.agents.running`                                                 |
| `workspaces[].lastShipped`   | latest `updatedAt` among `recentRuns` with `status === 'succeeded'`        |
| `workspaces[].nextAction`    | highest-severity `nextActions[]` for that workspace, `reason` field        |
| `evidenceCounts.reportsUnread`  | `reports.filter(unread).length`                                         |
| `evidenceCounts.reviewsOpen`    | `readiness.reviewReadyAgentIds.length`                                  |
| `evidenceCounts.manualOverrides`| `readiness.acknowledgedAgentIds.length`                                 |

Sync state is intentionally a placeholder — the future Sync-Status read
endpoint (Wave A1, suggested slice #3) will populate
`syncByWorkspace`. Until then, the renderer surfaces "clean" rather than
fabricating ahead/behind data.

## Tests

`tests/cockpit-to-rollup.test.ts` — 6 cases, all P0:

1. **Empty** — summary with zero workspaces produces an empty rollup;
   renderer outputs `"No workspaces tracked."`.
2. **All-clean** — single workspace with no agents, runs, reports, or
   actions → rollup with all defaults; renderer outputs the
   "clean / nothing pending" line.
3. **Mixed-state** — two workspaces (Workbench: review-ready agent,
   ack'd agent, unread report, two succeeded runs; REOS: blocked agent,
   one running). Verifies highest-severity next-action selection
   (severity 3 `investigate` wins over `review`+`read_report`),
   evidence counts, `lastShipped` from the latest succeeded run, and
   ordering through the renderer (REOS first because it has the
   actionable next-action, alpha tie-break second).
4. **In-flight + stale-running** — one workspace with two running
   agents and a `wake` next-action; renderer surfaces idle duration in
   the `Next:` clause.
5. **`syncByWorkspace` override** — caller-supplied sync flows through
   to the renderer (`branch slice/cockpit-rollup-adapter, 1 ahead, 0
   behind, 2 dirty, ...`).
6. **Determinism** — `JSON.stringify` of two consecutive conversions of
   the same input is byte-equal (round-trip determinism contract that
   T-TGCKPT-4 imposes on the renderer extends to the adapter).

All cases that produce strings call `assertTelegramSafe` on the
renderer output, so the slice extends the T-TGCKPT-3 regression set to
cockpit-shaped inputs.

## Verification

- `npm run typecheck` → exit 0.
- `npm test` → **84 pass / 0 fail / 1 skip** (the skip is the
  pre-existing `originWorkspaceId` cockpit-summary case from before
  this slice). Previous baseline was 78 pass / 0 fail / 1 skip.
  Net: **+6 new passing tests, 0 regressions.**

## Spec coverage map (this slice)

| Spec / QA anchor | This slice closes |
| ---------------- | ----------------- |
| Suggested next slice #1 from `PM_HANDOFF_20260509.md` | adapter shipped       |
| AC2.1 (cockpit summary feeds Telegram answer)         | data path now exists  |
| T-TGCKPT-3 regression coverage on real cockpit shapes | tests assertTelegramSafe on adapter output |
| T-TGCKPT-4 (deterministic checkpoint)                 | adapter round-trip is byte-equal           |
| Wave C1 substrate (`summarize_portfolio` tool)        | feeder function in place; tool wrapper still TODO |

## What this slice does NOT do (explicit non-coverage)

- No `summarize_portfolio` assistant tool wrapper yet (Wave C1).
- No Sync-Status endpoint (`syncByWorkspace` is caller-supplied).
- No UI surface — the Workspace Review Strip is still unaddressed.
- No mission packet, no commit packet, no state-machine changes.
- No modification to `lib/cockpit-summary.ts` or `lib/portfolio-render.ts`.

## Constraints honored

- No `npm install` of new dependencies.
- No push to `main`. Push went to `origin/slice/cockpit-rollup-adapter`.
- No deploy, no external send, no agent dispatch.
- All work confined to
  `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench/`.

## Suggested next slice (Shield to pick)

1. **`summarize_portfolio` assistant tool wrapper** (Wave C1). Now that
   both halves of the rendering pipeline exist (this adapter +
   `renderPortfolioForTelegram`), the tool wrapper is the smallest
   remaining slice that surfaces it on the chat surface — needs route
   plumbing in `app/api/assistant/route.ts` and `lib/tool-routing.ts`.
2. **Sync-Status read endpoint** (Wave A1). Pure-read git-shell wrap;
   would feed `convertCockpitToRollup`'s `syncByWorkspace` option with
   real data. Acceptance: `T-GATE-12`.
3. **Workspace Review Strip UI** (§6.1, AC1.x). Larger surface; needs
   render fixtures and DOM assertions.

## Evidence index

- `lib/cockpit-to-rollup.ts` — adapter implementation.
- `tests/cockpit-to-rollup.test.ts` — 6 P0 test cases.
- Git: branch `slice/cockpit-rollup-adapter` at SHA `e175101`,
  remote `origin/slice/cockpit-rollup-adapter`.
- Baseline test count: 78 → **84 pass** (+6 new, 1 skip pre-existing).
