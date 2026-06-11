# Workbench Browser Smoke Harness Hardening — Codex — 2026-05-09

## Scope

Objective: harden `scripts/browser-smoke.mjs` against false-positive success when another process already owns `127.0.0.1:3747`.

No push or deploy performed. Work stayed inside `Projects/agent-workbench`.

## Inputs Read

- `WORKBENCH_SOURCE_TRUTH_QA_CLAUDE_20260509.md`
- `WORKBENCH_BROWSER_SMOKE_RELEASE_BOUNDARY_CODEX_20260509.md`
- Required operating context: `SOUL.md`, `USER.md`, `IDENTITY.md`, `SYSTEM_MAP.md`, `memory/working-context.md`, `eco/daily_state.md`

## What Changed

- `scripts/browser-smoke.mjs`
  - Refactored the script into a testable module with exported configuration helpers.
  - Default behavior now reserves a free ephemeral loopback port, releases it, starts `next dev` on that exact port, and probes that exact URL.
  - `AW_NEXT_PORT` and `AW_SMOKE_PORT` remain deterministic port overrides. `AW_NEXT_PORT` takes precedence.
  - Deterministic overrides now go through the same pre-bind reservation check, so an already-owned port fails before the probe can accidentally hit a foreign Next/Electron listener.
  - Invalid port and timeout values now fail with explicit messages before spawn.
  - Existing child-output bind-error detection remains in place for races after reservation release.

- `tests/browser-smoke.test.mjs`
  - Added focused `node:test` coverage for port override precedence, validation, default host behavior, and occupied-port detection.
  - The occupied-port test tolerates sandbox `EPERM`/`EACCES` on environments where local binding is denied before application code can run.

- `README.md`
  - Updated browser smoke docs: default is now a free loopback port, with deterministic override via `AW_NEXT_PORT` or `AW_SMOKE_PORT`.

- `memory/working-context.md`
  - Checkpointed this lane for compaction continuity.

## False-Positive Boundary Closed

Previous failure mode:

1. Harness spawned `next dev` on fixed `127.0.0.1:3747`.
2. Probe fetched `http://127.0.0.1:3747`.
3. If the live Electron app already owned that port, the probe could receive a valid Workbench page from the foreign process before the spawned child emitted `EADDRINUSE`.
4. Harness exited green with inadmissible evidence.

Current behavior:

- Default run does not target `3747`; it targets a freshly reserved free port.
- Forced-port run fails before probing if that port is already owned.
- If another process grabs the selected port after reservation release, the child-output `EADDRINUSE`/`Error: listen` guard still fails the run.

## Verification

Passed:

```bash
npm run typecheck
node --check scripts/browser-smoke.mjs && node --check tests/browser-smoke.test.mjs
node --test tests/browser-smoke.test.mjs
node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts tests/workbench-layout.test.ts
```

Results:

- Browser smoke harness tests: 4/4 passed.
- Existing focused Workbench tests: 47/48 passed, 1 existing skipped placeholder.
- Typecheck passed.
- Syntax checks passed.

Blocked, but now safely:

```bash
AW_SMOKE_TIMEOUT_MS=8000 npm run smoke:browser
```

Result:

```text
browser smoke cannot reserve 127.0.0.1:0: listen EPERM: operation not permitted 127.0.0.1
```

This is the desired failure direction in this sandbox: the harness fails before any browser probe can report a false green.

## Git Boundary Note

`Projects/agent-workbench` is ignored by the parent workspace git repository via `/Projects/`, so `git diff` and `git status` do not expose these file changes. Source-truth verification is by file content and mtimes in this directory.

## Final Status

Browser smoke false-positive vector is closed at harness level. The remaining limitation is environmental: this sandbox cannot complete an end-to-end `next dev` browser smoke because local bind reservation is denied for the package command.
