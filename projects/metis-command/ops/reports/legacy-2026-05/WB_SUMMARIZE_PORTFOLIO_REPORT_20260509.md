# Workbench Slice #4 — `summarize_portfolio` assistant tool (Wave C1)

**Date:** 2026-05-09 CT
**Branch:** `slice/summarize-portfolio-tool` (off `origin/slice/cockpit-rollup-adapter`)
**Commit:** `e4c4bc6` — `feat(assistant): summarize_portfolio tool wires cockpit pipeline (Wave C1)`
**Status:** shipped, pushed, all checks green.

## What shipped

A new assistant tool, `summarize_portfolio`, that lets the chat brain
(OpenAI / Claude CLI / Codex CLI / OpenClaw Jarvis) emit a single
Telegram-safe portfolio rollup string in one tool call. It chains the
existing Wave-C primitives end-to-end:

```
buildCockpitSummary → convertCockpitToRollup → renderPortfolioForTelegram
```

### Tool signature

```
summarize_portfolio({ workspaceFilter?: string, actionableOnly?: boolean })
  → { text: string }
```

- `workspaceFilter` — optional id-or-name selector (resolves via
  `resolveWorkspaceSelector`). When provided, the rollup is narrowed to a
  single workspace; an unknown selector returns
  `{ error: "unknown workspace id/name: …" }` instead of throwing.
- `actionableOnly` — when `true`, quiet workspaces are dropped and the
  output falls back to the dedicated `"No workspaces with pending actions."`
  string when nothing is pending.
- Output is **text only**, by design. Callers that need the raw rollup or
  cockpit response should use `get_cockpit_summary`.

## Files changed

| File | Δ | Purpose |
|---|---|---|
| `lib/summarize-portfolio.ts` | new (+70) | Pure pipeline helper. No fs / network / PTY. |
| `lib/tool-routing.ts` | +11 | Adds `summarize_portfolio` to `ToolName`, name list, and `validateToolCall` schema (workspaceFilter non-empty string when provided; actionableOnly boolean when provided). |
| `app/api/assistant/route.ts` | +33 | Adds tool description, OpenAI function schema, fetcher wrapper (`summarizePortfolioTool`), and routing in `execToolRaw` + the workspace-less-tool whitelist in `execTool`. |
| `tests/summarize-portfolio-tool.test.ts` | new (+193) | 11 cases (7 pipeline + 4 validator). |

Total: **4 files, 305 insertions, 2 deletions.**

## Verification

```
$ npm run typecheck
> tsc --noEmit
(no errors)

$ npm test
ℹ tests 115
ℹ pass 114
ℹ fail 0
ℹ skipped 1   (pre-existing skip in cockpit-summary fan-out)
ℹ duration_ms 3078.50
```

The new file `tests/summarize-portfolio-tool.test.ts` adds 11 tests, all
passing:

**`summarizePortfolio` pipeline (7):**
- empty portfolio → `"No workspaces tracked."`
- two-workspace portfolio: actionable workspace sorts ahead of quiet one
  (uses `lastOutputAt` to keep the running agent below the 10 min stale
  threshold so the assertion is deterministic vs. wall-clock)
- `actionableOnly: true` drops quiet workspaces
- `actionableOnly: true` with nothing pending → `"No workspaces with pending actions."`
- `workspaceFilter: 'REOS'` narrows to one line
- `workspaceFilter: 'does-not-exist'` returns `{ error }` envelope, no throw
- byte-equal determinism for the same input

**`validateToolCall('summarize_portfolio', …)` (4):**
- empty args object accepted
- both fields accepted together
- whitespace-only `workspaceFilter` rejected with a clear message
- non-boolean `actionableOnly` rejected

Each pipeline test runs inside `withTempDispatchStore` (sets
`AW_DISPATCH_RUNS_DIR` to a fresh tmpdir) so the dispatch-runs persistence
layer can't leak real run history into the assertions.

## Wiring evidence (route.ts)

The tool is reachable from every assistant brain path because:

1. **`toolDescriptions`** advertises it to the CLI-brain action-block path.
2. **`openAITools`** includes a `function` entry so OpenAI can call it via
   native tool-calling.
3. **`execToolRaw`** dispatches `case 'summarize_portfolio'` to the
   fetcher.
4. **`execTool`** lists `summarize_portfolio` in the workspace-less
   whitelist (alongside `list_workspaces`, `get_cockpit_summary`, etc.) so
   it doesn't require an active workspace and isn't recorded as a
   per-workspace dispatch action — it's read-only.

## Collision avoidance

- Branched off `origin/slice/cockpit-rollup-adapter`, so
  `lib/cockpit-to-rollup.ts` + `tests/cockpit-to-rollup.test.ts` are
  available unmodified.
- **Did not touch** `lib/risk-tier.ts`, `lib/effort-level.ts`, or the
  `server/pty-server.ts` spawn handler.
- The working tree contained stranded uncommitted changes to
  `server/pty-server.ts` and untracked `lib/effort-level.ts` /
  `tests/effort-level.test.ts` from the parallel `slice/effort-selector`
  work. They were **left in place** and **not staged** — the commit only
  contains my four files. Verified via `git diff --cached --stat`:
  ```
  app/api/assistant/route.ts             |  33 ++-
  lib/summarize-portfolio.ts             |  70 +++
  lib/tool-routing.ts                    |  11 +
  tests/summarize-portfolio-tool.test.ts | 193 +++++++++
  ```

## Cost

Single Forge slice, well under the $1.50 cap.

## Next-up suggestions (not in this slice)

- Hook `summarize_portfolio` into the assistant chat UI as a one-click
  "portfolio status" affordance (cockpit-rollup-adapter wave continues).
- Extend `summarizePortfolio` with a `syncByWorkspace` parameter pulled
  from a sync-status endpoint, once that endpoint lands. The helper
  already accepts the parameter and forwards it to the renderer.
- Consider a `format: 'text' | 'json'` switch if the Telegram bridge ever
  needs the structured rollup back in the same call.
