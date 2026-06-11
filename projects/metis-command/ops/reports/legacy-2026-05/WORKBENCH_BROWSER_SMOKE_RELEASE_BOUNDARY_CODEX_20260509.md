# Workbench Browser Smoke / Release Boundary - Codex - 2026-05-09

## Scope

Objective: close the next real productization gap for Agent Workbench by packaging browser-smoke verification and documenting the release-boundary decision needed before this product can claim release control.

No push or deploy performed.

## Inputs Read

- `WORKBENCH_VISIBLE_COCKPIT_NEXT_CODEX_20260509.md`
- `/Users/jarvis/.openclaw/workspace/ops/reports/github/product-release-control-audit-20260509.md`
- Required operating context: `SOUL.md`, `USER.md`, `IDENTITY.md`, `SYSTEM_MAP.md`, `memory/working-context.md`, `eco/daily_state.md`

## What Changed

- `package.json`
  - Added `npm run smoke:browser`.

- `scripts/browser-smoke.mjs`
  - New package-local smoke harness.
  - Starts the Next renderer with `npx next dev -H 127.0.0.1 -p 3747`.
  - Fetches `/` and verifies the response looks like a rendered Next app.
  - Supports `AW_NEXT_PORT`, `AW_SMOKE_HOST`, and `AW_SMOKE_TIMEOUT_MS`.
  - Fails clearly on bind errors such as `listen EPERM` or `EADDRINUSE`.

- `README.md`
  - Added browser-renderer smoke instructions.

- `docs/release-boundary-proposal-20260509.md`
  - Added standalone repo vs monorepo package proposal.
  - Recommends a standalone private repo for Agent Workbench.
  - Defines release gates for typecheck, focused tests, browser smoke, build, and Electron package verification.

- `memory/working-context.md`
  - Checkpointed this lane for compaction continuity.

## Browser Smoke Result

Command run:

```bash
AW_SMOKE_TIMEOUT_MS=8000 npm run smoke:browser
```

Result: blocked before app code by sandbox local-bind denial.

Exact blocker:

```text
Error: listen EPERM: operation not permitted 127.0.0.1:3747
```

This confirms the previous `0.0.0.0:3747` failure was not only an all-interfaces bind issue. The current sandbox blocks binding the renderer even on `127.0.0.1`.

## Release-Boundary Proposal

Recommended boundary: standalone private GitHub repository.

Suggested repo:

- `Busa-Legacies/agent-workbench` or `Jarvis-ent/agent-workbench`

Reasoning:

- Agent Workbench is already structurally standalone: Next app, Electron shell, PTY sidecar, tests, package scripts, and docs all live under this directory.
- The parent workspace repo excludes `/Projects/`, so this product currently has no local git history, no remote backup, no PR flow, and no CI boundary.
- Standalone repo keeps Electron build artifacts and product churn out of the Jarvis OS workspace history.
- CI can run package-specific gates without coupling to unrelated workspace memory/ops files.

Monorepo alternative:

- Narrow the parent workspace `/Projects/` ignore rule for `Projects/agent-workbench`.
- Add explicit ignores for local build/runtime outputs.
- Accept that Agent Workbench becomes part of `Jarvis-ent/Jarvis` release cadence and history.
- Define package-scoped CI to avoid whole-workspace validation noise.

## Verification

Passed:

- `npm run typecheck`
- `node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts`
  - 43 tests total: 42 passed, 1 existing skipped placeholder.
- `npm run build`
  - Passed with the existing Turbopack NFT trace warning involving `next.config.ts -> lib/dispatch-runs.ts -> app/api/assistant/route.ts`.

Blocked:

- `AW_SMOKE_TIMEOUT_MS=8000 npm run smoke:browser`
  - Blocked by sandbox `listen EPERM: operation not permitted 127.0.0.1:3747`.

## Final Status

The productization gap is closed as far as this sandbox permits:

- Browser smoke is now a repeatable package command.
- The exact current bind blocker is documented from the new command.
- The release-boundary decision package exists and recommends standalone repo creation.

The remaining release-control blocker is an owner decision: standalone repo vs monorepo package. Until that decision is made, Agent Workbench remains local-only and should not be described as release-controlled.
