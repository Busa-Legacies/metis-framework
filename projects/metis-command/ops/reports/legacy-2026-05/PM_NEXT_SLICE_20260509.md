# PM Next Slice — Telegram-Safe Portfolio Renderer — 2026-05-09 CT

## Slice in one sentence

Add `lib/portfolio-render.ts` — a pure, deterministic function that turns
a structured portfolio rollup into a Telegram-safe plain-prose string,
plus unit tests gating the three P0 contracts (no markdown tables, no
fenced blocks, no headers; deterministic; zero outbound side effects).

## Why this is the smallest testable slice

The CEO-flow spec (`WORKBENCH_CEO_PRODUCT_MANAGEMENT_FLOW_SPEC_CLAUDE_20260509.md`,
S2 + AC2.1–AC2.3) requires Jarvis to answer "where do I start?" from
**structured cockpit state**, rendered in a Telegram-safe shape because
Nick reads in Telegram (`feedback_telegram_plain_text.md`). Of the
ten-item product backlog, this is the only Wave-C slice that:

1. Is a single pure function with no PTY, no network, no UI surface.
2. Has three P0 acceptance tests already written
   (`WORKBENCH_CEO_FLOW_QA_ACCEPTANCE_CLAUDE_20260509.md`,
   T-TGCKPT-3 / T-TGCKPT-4 / T-TGCKPT-5).
3. Adds zero dependencies — node:test + the existing `tsx --test`
   harness already in `package.json:test`.
4. Locks in a Nick-facing UX rule (no tables, no fences, no headers)
   in code, not in habit.
5. Becomes the rendering primitive the future `summarize_portfolio`
   assistant tool will call (Wave C1) — so this lays substrate without
   committing to the tool wrapper yet.

Other Wave-A candidates rejected as larger:

- **A1 sync-status endpoint** — needs `git` shell mocks + an HTTP
  route + workspace-boundary integration. Real, but several hours.
- **A2 evidence-ledger writes** — already implemented at
  `lib/evidence-ledger.ts`; the missing piece is the *reader* into
  rollup shape, which this slice's input type defines.
- **A3 Workspace Review Strip** — a UI component; needs render
  fixtures and DOM assertions; bigger surface than one .ts file.
- **B1 mission packet model** — needs new tools, route plumbing, and
  pane-title format change in a UI component.

## Scope (what this slice adds)

### New file: `lib/portfolio-render.ts`

Exports:

- `interface PortfolioWorkspaceRollup` — `{ workspaceId, name, sync,
  inFlight, lastShipped, nextAction, evidenceCounts }`.
- `interface PortfolioRollup` — `{ generatedAt, workspaces:
  PortfolioWorkspaceRollup[] }`.
- `function renderPortfolioForTelegram(rollup: PortfolioRollup,
  options?: { filterToActionable?: boolean }): string` — returns
  plain prose. Stable workspace ordering: `nextAction` workspaces first
  (sorted by name asc), then quiet workspaces (name asc). Lines are
  `<name> — <plain English status>. Next: <action or "nothing
  pending">.`
- `function assertTelegramSafe(text: string): void` — throws if the
  string contains a fenced block (` ``` `), an ATX header (lines
  starting with `#`), a Setext underline (`===`/`---` row after a
  text row), or a markdown table marker (`|---|` or pipe-rows with
  ≥2 pipes).

### New test: `tests/portfolio-render.test.ts`

Cases:

1. **Zero workspaces** → returns "No workspaces tracked." (Telegram-safe).
2. **One workspace, no next action, sync clean** → "Workbench — clean,
   no items in flight. Next: nothing pending."
3. **Three workspaces, mixed states (filterToActionable=true)** →
   only the two with a `nextAction` appear; ordering deterministic;
   `assertTelegramSafe` passes.
4. **`assertTelegramSafe` rejects** a string with a fenced block.
5. **`assertTelegramSafe` rejects** a string with a markdown table.
6. **`assertTelegramSafe` rejects** an ATX header line.
7. **Determinism** — the same rollup rendered twice yields a byte-equal
   string (T-TGCKPT-4 contract).
8. **No outbound side effects** — module imports nothing from `node:net`,
   `node:http`, `node:https`, `fetch`, `ws`; verified by reading the
   file's import set in the test (no `require('http')` either).

All tests are P0 unit, runnable via `npm test` (`tsx --test
tests/*.test.ts`) without any new deps.

## What this slice does NOT do

- Does not wire `summarize_portfolio` as an assistant tool — that is
  Wave C1 (next slice).
- Does not change the cockpit summary data shape — `PortfolioRollup`
  is a thin downstream view that a future endpoint can fill.
- Does not touch UI components or the PTY server.
- Does not modify the existing evidence ledger.

## Acceptance bar (Shield-PASS for this lane)

- `npm run typecheck` exits 0.
- `npm test` runs `tests/portfolio-render.test.ts` and reports zero
  failures.
- `lib/portfolio-render.ts` and `tests/portfolio-render.test.ts` are
  the only files added; no dep added; no other source touched.
- `assertTelegramSafe(renderPortfolioForTelegram(rollup))` is part of
  the test's pass condition for cases 1–3.

## Risk + reversibility

Tiny. One new lib file (~80 lines), one new test file. Reversible by
deletion. No public API change to existing modules.
