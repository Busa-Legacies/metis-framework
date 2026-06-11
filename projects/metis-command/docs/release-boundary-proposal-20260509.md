# Agent Workbench Release Boundary Proposal - 2026-05-09

## Current State

- `Projects/agent-workbench` is not a git repository.
- The parent workspace repository excludes `/Projects/`, so Agent Workbench is not tracked by the Jarvis workspace remote.
- Local build artifacts are large and product-specific: `.next/`, `dist-app/`, `node_modules/`, `*.db`, logs, and local override data.
- Product shape is already standalone: Next.js app, Electron shell, PTY sidecar, package scripts, tests, and docs all live under this directory.

## Recommendation

Use a standalone private repository for Agent Workbench.

Suggested boundary:

- Repo: `Busa-Legacies/agent-workbench` or `Jarvis-ent/agent-workbench`
- Root: current `Projects/agent-workbench`
- Initial branch: `main`
- Initial commit: sanitized mirror only, excluding local secrets, build outputs, runtime data, app bundles, logs, and databases.

## Why Standalone

- Release control matches the product: desktop app + web renderer + PTY sidecar has its own build and smoke gates.
- Keeps the Jarvis OS workspace repo from absorbing Electron artifacts and product-specific churn.
- Enables normal PR/CI/release flow without changing the parent workspace `/Projects/` ignore policy.
- Avoids mixing operational memory and product source history.

## Monorepo Alternative

If Nick chooses a monorepo package instead:

- Remove or narrow the parent workspace `/Projects/` ignore rule for `Projects/agent-workbench`.
- Add explicit ignores for `Projects/agent-workbench/node_modules/`, `.next/`, `dist-app/`, logs, databases, and local data.
- Accept that Agent Workbench source becomes part of `Jarvis-ent/Jarvis` history and release cadence.
- Define package-scoped CI commands so Workbench changes do not rely on whole-workspace validation.

## Required Release Gates

- `npm run typecheck`
- `node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts`
- `npm run smoke:browser`
- `npm run build`
- Electron packaging gate when preparing a desktop release: `npm run app:dist:dir` or `npm run app:dist`

## Browser Smoke Status

`npm run smoke:browser` now provides a package-local smoke harness. It starts the Next renderer on `127.0.0.1:3747`, fetches the root page, and fails with a clear bind error if the environment blocks local server binding.

The current Codex sandbox blocks local bind, so browser smoke remains an environment-gated check until run from a normal local shell or CI runner with localhost binding enabled.
