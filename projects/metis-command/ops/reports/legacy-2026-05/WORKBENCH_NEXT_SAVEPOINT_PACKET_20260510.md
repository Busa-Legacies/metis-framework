# Workbench Next Savepoint Packet - 2026-05-10

## Current Repo State

- CWD: `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`
- Branch: `slice/summarize-portfolio-tool`
- HEAD: `c97ff8a docs(workbench): report overnight agent state slice`
- Upstream: `origin/slice/summarize-portfolio-tool`
- Cached/staged files: none.
- Push/deploy: not performed.

Tracked modified files:

```text
.gitignore
bridge/telegram.cjs
components/AssistantPanel.tsx
components/Workbench.tsx
eslint.config.mjs
lib/pty-client.ts
server/pty-server.ts
tests/pty-server-lifecycle.test.ts
```

Untracked files:

```text
PM_HANDOFF_20260509.md
PM_NEXT_SLICE_REPORT_20260509.md
WB_EFFORT_SELECTOR_REPORT_20260509.md
WB_RISK_TIER_SLICE_REPORT_20260509.md
WB_SUMMARIZE_PORTFOLIO_REPORT_20260509.md
WORKBENCH_EXEC_RELEASE_CONSOLIDATION_20260510.md
WORKBENCH_NEXT_SAVEPOINT_PACKET_20260510.md
WORKBENCH_OVERNIGHT_CEO_COCKPIT_CODEX_FINALIZE_20260510.md
WORKBENCH_OVERNIGHT_CEO_COCKPIT_DESIGN_CLAUDE_20260510.md
WORKBENCH_OVERNIGHT_CEO_COCKPIT_POLISH_CODEX_20260510.md
WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_REVIEW_CLAUDE_20260510.md
WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_WIRE_CODEX_20260510.md
WORKBENCH_TELEGRAM_FINAL_DELIVERY_FIX_20260510.md
WORKBENCH_TELEGRAM_ROUTING_INVESTIGATION_20260510.md
WORKBENCH_VISUAL_UX_QA_EXEC_20260510.md
WORKBENCH_WORKSPACE_UX_CLOSE_ADD_20260510.md
WORKBENCH_WORKSPACE_UX_QA_SAVEPOINT_20260510.md
lib/ceo-cockpit-view.ts
lib/effort-level.ts
lib/runtime-guardrails.ts
tests/ceo-cockpit-view.test.ts
tests/effort-level.test.ts
tests/runtime-guardrails.test.ts
tests/telegram-bridge.test.mjs
```

## Tiny Typecheck Fix Applied

`npm run typecheck` was still blocked by `tests/runtime-guardrails.test.ts` passing plain env-shaped objects into `buildRuntimeGuardrailConfig`. The helper only needs indexed string env reads, so `lib/runtime-guardrails.ts` now accepts `Record<string, string | undefined>` instead of requiring `NodeJS.ProcessEnv`. This is type-only at the API boundary and does not change runtime behavior.

Verification after fix:

```text
npm run typecheck: PASS
node --import tsx --test tests/runtime-guardrails.test.ts tests/effort-level.test.ts tests/ceo-cockpit-view.test.ts: PASS, 34 pass
git diff --check: PASS
```

## Exact Savepoint Groups

### Group 1 - Report Provenance / Already-Shipped Context

Stage:

```bash
git add PM_HANDOFF_20260509.md PM_NEXT_SLICE_REPORT_20260509.md WB_SUMMARIZE_PORTFOLIO_REPORT_20260509.md
```

Commit:

```bash
git commit -m "docs(workbench): add prior PM slice reports"
```

Risk: docs only.

### Group 2 - Local Hygiene

Stage:

```bash
git add .gitignore eslint.config.mjs
```

Commit:

```bash
git commit -m "chore(workbench): ignore generated Claude worktrees"
```

Risk: low. Keeps lint/status from traversing generated `.claude/worktrees/**`.

### Group 3 - Runtime Guardrails And Effort Selector

Stage:

```bash
git add lib/runtime-guardrails.ts tests/runtime-guardrails.test.ts lib/effort-level.ts tests/effort-level.test.ts WB_EFFORT_SELECTOR_REPORT_20260509.md WORKBENCH_EXEC_RELEASE_CONSOLIDATION_20260510.md
git add -p server/pty-server.ts
```

Only stage these `server/pty-server.ts` hunks in this group:

- imports for `coerceEffortLevel`, `effortFlagsForKind`, `EffortLevel`
- imports for `RUNTIME_GUARDRAILS`, `trimRuntimeOutputLine`, `trimRuntimePersistedOutputLines`
- replacement of local output/chat/resume guardrail constants with `RUNTIME_GUARDRAILS`
- `trimOutputLine` / `trimPersistedOutputLines` delegation
- `spawnAgent` input `effortLevel?: EffortLevel`
- effort flag injection block before spawn args are finalized
- `POST /agents` `effortLevel: coerceEffortLevel(body.effortLevel)`

Commit:

```bash
git commit -m "feat(workbench): add spawn effort and runtime guardrails"
```

Risk: medium because the same server file also contains workspace UX hunks. Use hunk staging, or collapse Groups 3 and 5 into one checkpoint if hunk staging is not desired.

### Group 4 - CEO Cockpit Helper And Drawer UI

Stage:

```bash
git add components/AssistantPanel.tsx lib/ceo-cockpit-view.ts tests/ceo-cockpit-view.test.ts \
  WORKBENCH_OVERNIGHT_CEO_COCKPIT_CODEX_FINALIZE_20260510.md \
  WORKBENCH_OVERNIGHT_CEO_COCKPIT_DESIGN_CLAUDE_20260510.md \
  WORKBENCH_OVERNIGHT_CEO_COCKPIT_POLISH_CODEX_20260510.md \
  WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_REVIEW_CLAUDE_20260510.md \
  WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_WIRE_CODEX_20260510.md
```

Commit:

```bash
git commit -m "feat(workbench): add CEO cockpit digest"
```

Risk: medium-low. UI is additive and read-only, but browser visual QA is still not done.

### Group 5 - Workspace Close And Unnamed Add UX

Stage:

```bash
git add components/Workbench.tsx lib/pty-client.ts tests/pty-server-lifecycle.test.ts \
  WORKBENCH_WORKSPACE_UX_CLOSE_ADD_20260510.md \
  WORKBENCH_WORKSPACE_UX_QA_SAVEPOINT_20260510.md \
  WORKBENCH_VISUAL_UX_QA_EXEC_20260510.md
git add -p server/pty-server.ts
```

Only stage these `server/pty-server.ts` hunks in this group:

- `workspaceNameFromInput`
- `POST /workspaces` cwd/name derivation using `cwdWasProvided`

Commit:

```bash
git commit -m "feat(workbench): add workspace close and unnamed create UX"
```

Risk: medium. PTY lifecycle tests that cover this behavior are blocked in this sandbox by localhost bind permissions.

### Group 6 - Telegram Bridge Investigation / Bridge Hardening

Stage:

```bash
git add bridge/telegram.cjs tests/telegram-bridge.test.mjs \
  WORKBENCH_TELEGRAM_ROUTING_INVESTIGATION_20260510.md \
  WORKBENCH_TELEGRAM_FINAL_DELIVERY_FIX_20260510.md
```

Commit:

```bash
git commit -m "fix(telegram): surface bridge send failures"
```

Risk: medium. The bridge change stops swallowing Telegram send errors, removes Markdown parse mode, records final delivery status, adds explicit mirror-final skip handling, and exports helpers for tests. Focused bridge tests now pass with stubbed `fetch`; no external Telegram send was performed.

### Group 7 - Risk-Tier Report Only

Stage:

```bash
git add WB_RISK_TIER_SLICE_REPORT_20260509.md
```

Commit:

```bash
git commit -m "docs(workbench): add risk-tier slice report"
```

Risk: docs only. The report says risk-tier code shipped elsewhere, but matching `lib/risk-tier.ts` / `tests/risk-tier.test.ts` files are not present in this working tree.

## Safest Local Commit Order

1. Group 1 - prior PM report provenance.
2. Group 2 - local hygiene ignores.
3. Group 3 - runtime guardrails and effort selector, using `git add -p server/pty-server.ts`.
4. Group 4 - CEO cockpit helper/UI.
5. Group 5 - workspace close/add UX, using `git add -p server/pty-server.ts`.
6. Group 6 - Telegram bridge hardening.
7. Group 7 - risk-tier report only.

If the goal is one durable local savepoint rather than lane-pure history, the safest low-operator-risk alternative is a single checkpoint commit:

```bash
git add .gitignore eslint.config.mjs bridge/telegram.cjs components/AssistantPanel.tsx components/Workbench.tsx lib/pty-client.ts server/pty-server.ts tests/pty-server-lifecycle.test.ts \
  lib/ceo-cockpit-view.ts lib/effort-level.ts lib/runtime-guardrails.ts \
  tests/ceo-cockpit-view.test.ts tests/effort-level.test.ts tests/runtime-guardrails.test.ts tests/telegram-bridge.test.mjs \
  PM_HANDOFF_20260509.md PM_NEXT_SLICE_REPORT_20260509.md WB_EFFORT_SELECTOR_REPORT_20260509.md WB_RISK_TIER_SLICE_REPORT_20260509.md WB_SUMMARIZE_PORTFOLIO_REPORT_20260509.md \
  WORKBENCH_EXEC_RELEASE_CONSOLIDATION_20260510.md WORKBENCH_OVERNIGHT_CEO_COCKPIT_CODEX_FINALIZE_20260510.md WORKBENCH_OVERNIGHT_CEO_COCKPIT_DESIGN_CLAUDE_20260510.md WORKBENCH_OVERNIGHT_CEO_COCKPIT_POLISH_CODEX_20260510.md WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_REVIEW_CLAUDE_20260510.md WORKBENCH_OVERNIGHT_CEO_COCKPIT_UI_WIRE_CODEX_20260510.md WORKBENCH_TELEGRAM_ROUTING_INVESTIGATION_20260510.md WORKBENCH_TELEGRAM_FINAL_DELIVERY_FIX_20260510.md WORKBENCH_VISUAL_UX_QA_EXEC_20260510.md WORKBENCH_WORKSPACE_UX_CLOSE_ADD_20260510.md WORKBENCH_WORKSPACE_UX_QA_SAVEPOINT_20260510.md WORKBENCH_NEXT_SAVEPOINT_PACKET_20260510.md
git commit -m "chore(workbench): savepoint local UX and release prep"
```

Do not push until the blocked PTY lifecycle/browser checks are rerun or explicitly waived.

## Tests Already Run

From the inspected reports:

```text
WORKBENCH_WORKSPACE_UX_CLOSE_ADD_20260510.md:
- npm run lint: PASS with 28 warnings
- npm run build: PASS
- npm run typecheck: FAIL at that time on runtime-guardrails ProcessEnv typing
- npm run test:pty: BLOCKED by listen EPERM on 127.0.0.1

WORKBENCH_WORKSPACE_UX_QA_SAVEPOINT_20260510.md:
- git diff --check -- workspace UX files: PASS
- npm run lint: PASS with 28 warnings
- node --import tsx --test tests/tool-routing.test.ts tests/workbench-layout.test.ts tests/effort-level.test.ts tests/runtime-guardrails.test.ts: PASS, 66 pass, 1 skipped
- npm run typecheck: FAIL at that time on runtime-guardrails ProcessEnv typing

WORKBENCH_VISUAL_UX_QA_EXEC_20260510.md:
- git diff --check -- workspace UX files: PASS
- npm run lint: PASS with 28 warnings
- node --import tsx --test tests/tool-routing.test.ts tests/workbench-layout.test.ts tests/effort-level.test.ts tests/runtime-guardrails.test.ts: PASS, 66 pass, 1 skipped
- npm run build: PASS
- npm run typecheck: FAIL at that time on runtime-guardrails ProcessEnv typing
- npm run test:pty: BLOCKED by listen EPERM on 127.0.0.1

WORKBENCH_EXEC_RELEASE_CONSOLIDATION_20260510.md:
- npm run typecheck: PASS at that time
- npm run build: PASS
- npm run lint: PASS with warnings
- npm test: BLOCKED by tsx IPC listen EPERM
- node --import tsx --test tests/*.test.ts: PARTIAL, PTY tests blocked by 127.0.0.1 listen EPERM
- full non-PTY suite listed in report: PASS, 123 pass, 1 skipped
- focused guardrail/cockpit/effort suite: PASS, 34 pass
```

From this packet pass:

```text
npm run typecheck: PASS
node --import tsx --test tests/runtime-guardrails.test.ts tests/effort-level.test.ts tests/ceo-cockpit-view.test.ts: PASS, 34 pass
node --check bridge/telegram.cjs: PASS
node --test tests/telegram-bridge.test.mjs: PASS, 3 pass
git diff --check: PASS
```

## Tests Still Blocked / Not Yet Run

- `npm run test:pty`: blocked in this sandbox because the test server cannot bind `127.0.0.1` (`listen EPERM`).
- `npm test`: reported blocked by `tsx --test` IPC listen `EPERM` in this sandbox.
- Browser/manual visual QA for the Workbench drawer and workspace close/add UX: not run here.
- Telegram bridge send path: focused stubbed tests pass; no external Telegram send was performed.

## Main Risks

- `server/pty-server.ts` is a mixed file containing runtime guardrail, effort selector, and workspace create/delete hunks. Lane-pure commits require deliberate hunk staging.
- Workspace close/add behavior depends on PTY lifecycle endpoints whose focused tests are blocked locally by sandbox networking.
- CEO cockpit UI has source/test coverage, but no browser screenshot verification for wrapping, contrast, drawer sizing, or representative real states.
- Telegram bridge change likely improves delivery observability but changes helper-level failure behavior from swallowed errors to thrown/logged errors. The polling loop still catches final delivery failures.
- Risk-tier report is present without corresponding code files in this tree, so treat it as historical documentation only.
