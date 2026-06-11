# Workbench Dispatch Status UI - Claude Reviewer - 2026-05-08

## Scope

Reviewer pass on the compact last-dispatch UI strip implementation. Codex landed
the strip in `components/AssistantPanel.tsx` against the P0 dispatch-runs API
(`GET /api/assistant?workspaceId=<active>`); my role here is to verify the
implementation is safe, run targeted checks, and call out residual blockers
before any push or deploy.

No code edits, no push, no deploy.

## Verdict

Approve as a P0 read-only strip. Implementation is consistent with the P0 API,
type-safe, scope-tight, and does not introduce server mutations. Two non-blocking
notes below.

## Files Reviewed

- `components/AssistantPanel.tsx`
  - Dispatch types declared locally as a structural subset of
    `lib/dispatch-runs.ts` (`DispatchRunStatus`, `DispatchActionStatus`,
    `DispatchSpawnedAgent`, `DispatchFailedSpec`, `DispatchAction`, `DispatchRun`,
    `DispatchStatusResponse`). `components/AssistantPanel.tsx:17-59`.
  - `refreshDispatchStatus` fetches `/api/assistant?workspaceId=<active>`,
    handles non-OK and non-JSON responses, sets `dispatchErr` rather than
    throwing into render. `components/AssistantPanel.tsx:107-122`.
  - 5s poll interval clears on workspace change. `components/AssistantPanel.tsx:176-180`.
  - Post-turn refresh fires when `data.dispatchRunId` or `data.toolCalls?.length`
    is present. `components/AssistantPanel.tsx:261`.
  - Strip rendered only when `activeWorkspaceId` is set; shows status badge,
    compact run id, action count, spawned ids, failed-spec count, and
    `spawn_agents`-only retryable rows with hover tooltips listing
    `name/kind: error`. `components/AssistantPanel.tsx:381-430`.
- `app/api/assistant/route.ts` (GET handler)
  - Local/bridge auth guard mirrors POST exactly:
    `app/api/assistant/route.ts:753-761` vs `:695-702`.
  - 400 on missing `workspaceId`; accepts optional `runId`/`run_id`.
  - Read-only — calls `dispatchRunStatus()`, no mutation.
- `lib/dispatch-runs.ts`
  - `dispatchRunStatus` returns `{ run }` for runId queries and
    `{ run, runs }` (capped at 10) for list queries. `lib/dispatch-runs.ts:262-266`.

## Verification

Ran:

- `npm run typecheck` — clean (no diagnostics).
- `node --import tsx --test tests/tool-routing.test.ts` — 22/22 passing across
  `action-block validation`, `direct agent workspace guardrails`,
  `current-turn action replay hygiene`, `durable dispatch run ledger`,
  `workbench session keys`, `workspace cwd validation`, and `broadcast target
  selection`.

Did not run:

- `npm run dev:web` — Codex previously hit `EPERM` binding 0.0.0.0:3747 in
  sandbox; I did not retry to avoid colliding with a possibly-running
  workbench instance on 3747/3748. Browser smoke verification is still owed.
- Component tests — none exist for `AssistantPanel.tsx`. The consumed shape is
  exercised by the dispatch-runs unit tests.
- `npm run lint` — intentionally skipped per lane instruction (existing lint
  debt is out of scope).

## Schema Consistency Check

UI consumer types vs server canonical types in `lib/dispatch-runs.ts`:

- `DispatchRunStatus` / `DispatchActionStatus` — exact string-literal match.
- `DispatchSpawnedAgent` — UI subset matches server (`id` required;
  `name`, `kind`, `laneName`, `role` optional).
- `DispatchAction` — UI omits server-only fields (`targetWorkspaceId`,
  `explicitTargetWorkspaceId`, `argsHash`, `fingerprint`, `args`, `result`,
  `retryOf`). Subset is intentional and safe; the strip does not need them.
- `DispatchStatusResponse` — `{ run: DispatchRun | null, runs?: DispatchRun[] }`
  matches the GET response shape from `dispatchRunStatus()`.

## Auth/Security Review

- Local browser fetch from the Next dev server hits `Host: 127.0.0.1:3747`,
  which trips `isLocal` in both POST and GET, so an unauthenticated `fetch()`
  from the panel works in dev exactly like the existing POST path.
- Remote bridge callers must still present `Authorization: Bearer
  <bridgeApiKey>` to GET — parity with POST. This means a misconfigured remote
  Telegram/Jarvis bridge will fail the new status fetch the same way it would
  fail a POST, surfacing the same 401 — acceptable, no information leak.
- GET is read-only; the route delegates to `dispatchRunStatus()`, which only
  reads workspace JSON files. No write side-effects on poll.
- `dispatchRunStatus(workspaceId, runId)` does not validate the workspaceId
  beyond the on-disk filename sanitizer in `safeWorkspaceFile()`. A missing or
  fabricated id returns `{ run: null, runs: [] }` rather than 404, which is
  correct for the polling UX (no error toast on first run).

## Behavioral Notes

- Polling is unconditional at 5s while a workspace is active. For an Electron
  local app this is fine; if the assistant panel is ever embedded in a
  long-lived web client, consider gating the poll on `document.visibilityState`
  to avoid background-tab churn. Not a P0 blocker.
- `compactRunId()` uses `…` (single char) rather than `...`, which renders
  cleanly in the strip; `title={runId}` exposes the full id on hover.
- `labelFailedSpec()` falls back to `'spec'` when neither `name`, `laneName`,
  nor `kind` is present on a failed spec. Acceptable — failed specs from
  `summarizeFailedSpecs()` carry whatever the original spec object had.
- The strip currently surfaces `spawn_agents` as the only retryable tool. That
  matches today's failure semantics from `lib/dispatch-runs.ts:summarizeFailedSpecs`,
  which only populates `failedSpecs` from spawn results.
- `AlertTriangle` icon import added but no other lifecycle/state changes leak
  outside the strip — no impact on chat send, voice, or attachment paths.

## Issues / Findings

None blocking. Minor items worth tracking:

1. The 5s poll lacks visibility/backoff. Cheap follow-up.
2. There is no targeted React test for the strip. The shape is covered by
   `tests/tool-routing.test.ts` indirectly; a thin DOM/render test would close
   the loop, but is not P0.
3. Browser smoke verification is still owed — typecheck + unit tests confirm
   shape + types only. Worth a manual click-through once the workbench is
   running before next deploy.

## Next Blockers

Picking up the gap report's recommended order, the items still open after this
strip:

- Priority 1 — workspace/agent guardrails for direct tools. Tests already cover
  the rejection logic (`direct agent workspace guardrails` suite, 3 tests
  passing); the lane work for explicit target resolution + dispatch-run
  recording remains.
- Priority 3 — task tools and done/review gates. The strip reads dispatch
  state, but completion gating is still terminal-text only. Once task tools
  exist, the strip should grow a "lanes" row (running/review/done counts) — a
  natural extension of the current action/spawn summary.
- Priority 4 — pane hydration/resume lifecycle tests. Independent of this
  strip.
- Priority 5 — cockpit status endpoint. This strip is a forerunner; a true
  status endpoint should fold in tasks, blocked lanes, and dirty git summary,
  at which point the strip becomes a thin client of that endpoint instead of
  the raw dispatch ledger.

## Recommendation

Land the strip as-is for the next workbench cut. Pair with a 60-second manual
browser smoke before tagging a release. Move to Priority 1 (target/guardrails
follow-up) per the gap report.
