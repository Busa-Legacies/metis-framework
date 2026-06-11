# Workbench Exec Release Consolidation - 2026-05-10

## Repo State

- CWD: `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`
- Branch: `slice/summarize-portfolio-tool`
- Upstream: `origin/slice/summarize-portfolio-tool`
- Remote: `https://github.com/Busa-Legacies/agent-workbench.git`
- HEAD: `c97ff8a docs(workbench): report overnight agent state slice`

`slice/summarize-portfolio-tool` is up to date with its upstream. The shipped summarize-portfolio work is already committed at `e4c4bc6` and documented in `WB_SUMMARIZE_PORTFOLIO_REPORT_20260509.md`.

## Dirty / Untracked Slices

Tracked modified:

- `.gitignore`
- `eslint.config.mjs`
- `components/AssistantPanel.tsx`
- `server/pty-server.ts`

Untracked code/tests:

- `lib/ceo-cockpit-view.ts`
- `tests/ceo-cockpit-view.test.ts`
- `lib/effort-level.ts`
- `tests/effort-level.test.ts`
- `lib/runtime-guardrails.ts`
- `tests/runtime-guardrails.test.ts`

Untracked reports:

- `PM_HANDOFF_20260509.md`
- `PM_NEXT_SLICE_REPORT_20260509.md`
- `WB_EFFORT_SELECTOR_REPORT_20260509.md`
- `WB_RISK_TIER_SLICE_REPORT_20260509.md`
- `WB_SUMMARIZE_PORTFOLIO_REPORT_20260509.md`
- `WORKBENCH_OVERNIGHT_CEO_COCKPIT_CODEX_FINALIZE_20260510.md`
- `WORKBENCH_OVERNIGHT_CEO_COCKPIT_DESIGN_CLAUDE_20260510.md`
- `WORKBENCH_OVERNIGHT_CEO_COCKPIT_POLISH_CODEX_20260510.md`
- `WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_REVIEW_CLAUDE_20260510.md`
- `WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_WIRE_CODEX_20260510.md`

## Consolidation Summary

- Summarize portfolio: already shipped and pushed on this branch.
- CEO cockpit helper/UI: pending local additive slice. It adds a pure CEO cockpit view model, focused tests, and a read-only CEO overnight block in the assistant cockpit drawer.
- Effort selector: pending local server-side spawn option. It adds backend-aware `effortLevel` constants/helpers and tests, and wires `POST /agents` to accept the field.
- Runtime guardrails: pending local guardrail prep. It extracts output/chat/resume caps into `lib/runtime-guardrails.ts`, adds tests for defaults/env override/trimming, and wires PTY output trimming to the helper.
- Local hygiene: generated `.claude/worktrees` are now ignored by git and ESLint so status/lint are not polluted by nested generated worktrees or copied build artifacts.

## Files Changed By This Consolidation Pass

- `.gitignore`
  - Added ignore coverage for generated Claude worktree pollution.
  - Current diff also ignores `.claude/settings.local.json`, which is local-machine state and was already treated as ignored by the environment.
- `eslint.config.mjs`
  - Added `.claude/worktrees/**` to global ignores so `npm run lint` does not recurse into generated nested worktrees.
- `WORKBENCH_EXEC_RELEASE_CONSOLIDATION_20260510.md`
  - This report.

No pushes, deploys, worktree deletes, or destructive git operations were performed.

## Verification

- `npm run typecheck`: PASS.
- `npm run build`: PASS.
  - Warning remains: Turbopack reports an unexpected traced file path involving `next.config.ts -> lib/dispatch-runs.ts -> app/api/assistant/route.ts`.
- `npm run lint`: PASS with warnings only.
  - 28 warnings in the real repo after ignoring `.claude/worktrees/**`.
  - Before the ESLint ignore, lint failed only because it recursed into generated `.claude/worktrees` build artifacts.
- `npm test`: BLOCKED before executing tests.
  - `tsx` CLI failed with `listen EPERM` on a temp IPC pipe under this sandbox.
- `node --import tsx --test tests/*.test.ts`: PARTIAL/BLOCKED.
  - 123 pass, 1 skip, 7 fail.
  - All failures are PTY lifecycle tests blocked by `listen EPERM: operation not permitted 127.0.0.1`.
- Full non-PTY suite:
  - Command: `node --import tsx --test tests/ceo-cockpit-view.test.ts tests/cockpit-continuity.test.ts tests/cockpit-to-rollup.test.ts tests/effort-level.test.ts tests/evidence-ledger.test.ts tests/portfolio-render.test.ts tests/runtime-guardrails.test.ts tests/summarize-portfolio-tool.test.ts tests/tool-routing.test.ts tests/workbench-layout.test.ts`
  - PASS: 123 pass, 0 fail, 1 skipped.
- Focused guardrail/cockpit/effort suite:
  - Command: `node --import tsx --test tests/ceo-cockpit-view.test.ts tests/effort-level.test.ts tests/runtime-guardrails.test.ts`
  - PASS: 34 pass, 0 fail.

## Blockers / Residual Risk

- PTY lifecycle tests cannot bind localhost in this sandbox, so runtime lifecycle behavior still needs validation in an environment where `127.0.0.1` listening is permitted.
- `npm test` remains unusable in this sandbox because `tsx --test` tries to create an IPC pipe and gets `EPERM`.
- CEO cockpit UI still lacks browser visual QA. Existing reports call out the need to verify drawer layout, wrapping, contrast, and representative bucket states in a running app.
- `components/AssistantPanel.tsx` currently calls `buildCeoCockpitView({ summary })` without `gitByWorkspace`, so real branch/ahead/dirty chips remain suppressed until git status is plumbed into that drawer path.
- Risk-tier prompt wrapper is documented in `WB_RISK_TIER_SLICE_REPORT_20260509.md` but its actual code files are not present in this working tree.

## Exact Next Commit Recommendation

Commit the pending local release-prep code and reports as one consolidation checkpoint after a quick human review of the mixed `server/pty-server.ts` changes:

```bash
git add .gitignore eslint.config.mjs \
  server/pty-server.ts components/AssistantPanel.tsx \
  lib/ceo-cockpit-view.ts lib/effort-level.ts lib/runtime-guardrails.ts \
  tests/ceo-cockpit-view.test.ts tests/effort-level.test.ts tests/runtime-guardrails.test.ts \
  PM_HANDOFF_20260509.md PM_NEXT_SLICE_REPORT_20260509.md \
  WB_EFFORT_SELECTOR_REPORT_20260509.md WB_RISK_TIER_SLICE_REPORT_20260509.md WB_SUMMARIZE_PORTFOLIO_REPORT_20260509.md \
  WORKBENCH_OVERNIGHT_CEO_COCKPIT_CODEX_FINALIZE_20260510.md WORKBENCH_OVERNIGHT_CEO_COCKPIT_DESIGN_CLAUDE_20260510.md \
  WORKBENCH_OVERNIGHT_CEO_COCKPIT_POLISH_CODEX_20260510.md WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_REVIEW_CLAUDE_20260510.md \
  WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_WIRE_CODEX_20260510.md WORKBENCH_EXEC_RELEASE_CONSOLIDATION_20260510.md
git commit -m "chore(workbench): consolidate release guardrails and CEO cockpit prep"
```

Do not push until PTY lifecycle tests have been rerun in a non-sandboxed environment or explicitly waived for this release checkpoint.
