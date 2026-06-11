# Workbench CEO Cockpit Next Slice — Claude Architect — 2026-05-08

## Scope

Architect/reviewer pass to define the **smallest useful next slice** of the
Agent Workbench CEO cockpit, after the three landed lanes:

- P0 — durable dispatch runs (`WORKBENCH_DISPATCH_RUNS_P0_20260508.md`).
- Status strip in `AssistantPanel.tsx` (`WORKBENCH_DISPATCH_STATUS_UI_*_20260508.md`).
- P1 — direct-tool target/workspace guardrails (`WORKBENCH_TARGET_GUARDRAILS_*_20260508.md`).

Inputs read:

- `WORKBENCH_CEO_FLOW_NEXT_GAPS_20260508.md` (gap report + recommended order).
- `WORKBENCH_DISPATCH_RUNS_P0_20260508.md` (data model + GET endpoint).
- `WORKBENCH_DISPATCH_STATUS_UI_CLAUDE_20260508.md` + `..._CODEX_..._20260508.md` (strip implementation review).
- `WORKBENCH_TARGET_GUARDRAILS_CLAUDE_20260508.md` + `..._P1_CODEX_..._20260508.md` (guardrail review).
- `WORKBENCH_REGRESSION_GAP_TESTS_20260508.md`, `WORKBENCH_UX_CONTROL_POLISH_20260508.md`,
  `WORKBENCH_ISOLATION_IMPLEMENTATION_REPORT_20260508.md`, `WORKBENCH_CLAUDE_CONTROL_PLANE_QA_20260508.md`,
  `WORKBENCH_CLEAR_EXITED_PANES_BUGFIX_20260508.md`, `WORKBENCH_JARVIS_ISOLATION_SPEC_20260508.md`.
- `../../ops/reports/workbench_dispatch_20260508.md`,
  `../../ops/reports/workbench_ceo_control_map_20260508.md`,
  `../../ops/reports/workbench_project_governance_protocol_20260508.md`.
- `lib/dispatch-runs.ts`, `app/api/assistant/route.ts`, `components/AssistantPanel.tsx`,
  `server/pty-server.ts` (task model).

No code/test edits in this pass. No push, no deploy. The patch surface this spec
implies is small enough for a single Codex lane; this file is the spec only.

## Current State (One Paragraph)

Jarvis can now durably persist dispatch intent + spawn results per workspace,
poll structured status for the **active** workspace via
`GET /api/assistant?workspaceId=<active>`, and route direct agent tools without
crossing workspace boundaries unless the model supplies an explicit `workspace_id`.
But the persisted truth is **fragmented per workspace file** in
`data/dispatch-runs/<workspaceId>.json`, and the status strip only renders the
single workspace currently focused in the UI. In practice (see
`workbench_dispatch_20260508.md`) Jarvis runs 3–4 workspaces in parallel
(REOS, Sitework, Workbench, Market Alpha) and cannot answer "what's done /
blocked / needs me, across all of them?" without N round-trips or terminal
scrollback. Tasks exist (`server/pty-server.ts:52`, `1048`) but are not wired
to dispatch runs, and the assistant has no task tools yet — so the
done/review-gate work is bigger than one slice.

## The Next Slice

**Cockpit summary fan-out + per-agent close-recommendation rollup.**

A single read-only endpoint and matching assistant tool that fans out the
existing per-workspace dispatch state, joins it with the existing PTY agent
list, and emits a structured "what does Jarvis need to see across everything
right now" payload. **No new task model. No mutations. No UI dashboard rewrite.**

This is intentionally narrower than gap-report Priority 3 (task tools and
done/review gates) and Priority 5 (cockpit status + UI panel). It picks the
read-fan-out half of Priority 5 and ships it standalone, because:

1. It unblocks Jarvis multi-workspace operation **today** without changing
   any behavior the user can corrupt.
2. It is the same response shape the future task lane will extend (additive
   `tasks.*` block) — no schema rework.
3. It has an obvious acceptance bar: every field is derivable from existing
   persisted state plus the existing `listWorkspaces` / `listAgents` calls.
4. It keeps the running/exited/dispatch-action signals in one place, so the
   later "done-gate" lane only has to add reviewer verdict and evidence
   fields, not invent the spine.

## What Jarvis Needs To See / Do

Across workspaces, in priority order:

1. **Per workspace, last dispatch run status** — same fields the strip already
   shows, but for every workspace, not just active.
2. **Aggregate counts** — running agents, exited agents, runs in each terminal
   state — so Jarvis can decide where to focus.
3. **Retryable failed specs across all workspaces** — Jarvis can already
   re-issue `spawn_agents` with a narrowed `specs[]`; today it has to know
   per-workspace where the failures live.
4. **Per-agent close-recommendation signal** — exited+exit-0 vs exited+exit≠0
   vs running. This is the exit-code half of "ready to close pane" /
   "blocked" without depending on a not-yet-built reviewer verdict.
5. **Cross-workspace dispatch attribution** — when a run was issued from
   workspace A but explicitly targeted workspace B (the P1 lane already
   records this), the cockpit must show it under B's workspace block with a
   visible `originWorkspaceId` so Jarvis doesn't double-count.

Things Jarvis does **not** yet need to do from this endpoint:

- Mutate runs, kill agents, or write tasks — this slice is pure read.
- Subscribe to a stream — 5s poll parity with the strip is enough.
- See git/diff state — that's a separate (and more expensive) slice.

## API: Required Fields

### New endpoint

`GET /api/assistant?scope=cockpit`

- Same auth model as the existing GET (local-host bypass mirrors POST,
  remote callers must present the bridge bearer token —
  `app/api/assistant/route.ts:753-761`).
- `scope=cockpit` is the only differentiator vs the current per-workspace GET.
- Optional query params:
  - `workspace_ids=<csv>` — restrict fan-out to a subset (resolved id-or-name,
    same selector rules as the P1 lane). Unknown ids/names → 400 with the
    same `unknown workspace id/name` / `ambiguous workspace name` strings the
    POST path already returns. Re-use `resolveWorkspaceSelector` (see
    minor follow-up #1 in `WORKBENCH_TARGET_GUARDRAILS_CLAUDE_20260508.md` —
    extract it to `lib/workspace-selector.ts` as part of this lane so it can
    be unit-tested directly).
  - `runs_limit=<n>` — cap recent-run aggregation per workspace; default 10,
    max 50, mirrors `listDispatchRuns()` clamp at `lib/dispatch-runs.ts:259`.

### Response shape

```ts
interface CockpitWorkspaceAgents {
  total: number
  running: number
  exited: number
  byKind?: Record<string, number>          // 'claude' | 'codex' | 'shell' | …
}

interface CockpitWorkspaceReadiness {
  activeRunCount: number                    // runs with status === 'running'
  partialRunCount: number                   // status === 'partial_failed'
  failedRunCount: number                    // status === 'failed'
  succeededRunCount: number                 // status === 'succeeded'
  retryableFailedSpecCount: number          // sum of failedSpecs across last N runs
  reviewReadyAgentIds: string[]             // exited && (exitCode === 0 | undefined)
  blockedAgentIds: string[]                 // exited && exitCode !== 0
}

interface CockpitLastRunSummary {
  runId: string
  status: DispatchRunStatus
  createdAt: string
  updatedAt: string
  userPrompt: string                         // already in DispatchRun
  actionCount: number
  spawnedAgentIds: string[]                  // flat dedup across actions
  failedSpecCount: number
  originWorkspaceId?: string                 // run.workspaceId if it differs
                                             // from this block's workspaceId
                                             // (cross-workspace dispatch via P1)
  explicitTargetWorkspaceId?: string         // mirrors run.explicitTargetWorkspaceId
}

interface CockpitWorkspace {
  workspaceId: string
  workspaceName: string
  cwd: string
  agents: CockpitWorkspaceAgents
  lastRun: CockpitLastRunSummary | null
  recentRuns: CockpitLastRunSummary[]        // up to runs_limit, newest first
  readiness: CockpitWorkspaceReadiness
}

interface CockpitTotals {
  workspaces: number
  runningAgents: number
  exitedAgents: number
  activeRunCount: number
  partialRunCount: number
  failedRunCount: number
  retryableFailedSpecCount: number
  reviewReadyAgentCount: number
  blockedAgentCount: number
}

interface CockpitSummaryResponse {
  generatedAt: string                        // ISO UTC
  workspaces: CockpitWorkspace[]             // ordered: active first if known,
                                             // else by name asc
  totals: CockpitTotals
}
```

Notes on derivation (no new persistence):

- `agents.*` from `ptyApi.listAgents({ includeExited: true })`, filtered by
  `agent.workspaceId`. Already used at `app/api/assistant/route.ts:368` for the
  prompt-context summary; the cockpit endpoint should call it once and bucket.
- `readiness.review*` / `readiness.blocked*` from `agent.meta.status === 'exited'`
  plus `agent.meta.exitCode`. The PTY server already records `exitCode` on
  exit (`server/pty-server.ts:markAgentExited`); confirm the field is exposed
  via `listAgents` before relying on it. If it isn't, add it as a one-line
  passthrough in the same lane — that is the only PTY-server change this slice
  permits.
- `lastRun` / `recentRuns` from `dispatchRunStatus(workspaceId, undefined)`,
  which already returns `{ run, runs }`. Map each `DispatchRun` to a
  `CockpitLastRunSummary` server-side so the wire payload stays small —
  individual `actions[*]` rows do not need to be re-shipped here; the UI/tool
  can drill into the per-workspace endpoint for that.
- `originWorkspaceId` is set when a run's `workspaceId` differs from the
  block's `workspaceId`. Today the P1 lane stores cross-workspace runs under
  the **resolved target** (`app/api/assistant/route.ts:230` uses
  `wsId = target.workspaceId`), so `originWorkspaceId` will normally be
  undefined. The field is reserved so we don't need a wire-format change once
  Codex's follow-up #3 (propagate explicit target into session metadata)
  lands.
- `spawnedAgentIds` is a `Set` flattened across the run's `actions[*].spawnedAgents`.
- `failedSpecCount` is a sum across the run's `actions[*].failedSpecs`.
- `totals` is a deterministic reduction over `workspaces`, computed
  server-side so the UI/tool never has to re-derive.

### New assistant tool

`get_cockpit_summary({ workspace_ids?: string[], runs_limit?: number })`

- Validation: lives in `lib/tool-routing.ts` next to `get_dispatch_status`.
  `workspace_ids` is an optional string array; `runs_limit` is an optional
  positive integer ≤ 50.
- Execution: bypasses `execTool`'s dispatch-run wrapping (same exemption
  carve-out the existing `get_dispatch_status` already enjoys at
  `app/api/assistant/route.ts:226`). Pure read.
- Returns the same `CockpitSummaryResponse` as the GET endpoint.
- Description string should make explicit that the tool is **read-only and
  multi-workspace** and that mutations still require workspace-scoped tools.

### Strip surfacing (UI, optional + tiny)

Do **not** rewrite the strip. Add at most one inline disclosure under the
existing per-workspace strip in `components/AssistantPanel.tsx`:

> `4 workspaces · 11 running · 2 partial · 1 retryable spec`

- Single `<div>`, derived from the new cockpit response.
- Same 5s poll lifecycle as the existing strip (`AssistantPanel.tsx:176-180`),
  but issued in parallel with the per-workspace fetch, gated on the same
  `activeWorkspaceId` so the cockpit fetch dies with the workspace.
- Click target opens nothing in this slice — that is the future cockpit panel,
  out of scope here.

## Acceptance Tests

Add in `tests/tool-routing.test.ts` (or split into a new `tests/cockpit-summary.test.ts`
to keep file weight down — either is fine):

1. **Aggregate fan-out across workspaces.** Seed two workspace dispatch
   files with one succeeded run each; assert
   `GET /api/assistant?scope=cockpit` returns both workspaces, `totals.workspaces === 2`,
   `totals.succeededRunCount === 2`, and per-workspace `lastRun.status === 'succeeded'`.

2. **Mixed status totals.** Seed three workspaces — one running, one
   partial_failed (one succeeded action + one failed action), one failed.
   Assert the totals reduction matches the per-workspace counts and that
   `retryableFailedSpecCount` equals the seeded `failedSpecs.length` from
   the partial workspace.

3. **`workspace_ids` selector.** Pass `?workspace_ids=Sitework` (case-
   insensitive name match via the extracted `resolveWorkspaceSelector`);
   assert response contains only the Sitework block. Pass an unknown name;
   assert 400 with the `unknown workspace id/name` shape. Pass an ambiguous
   name (two workspaces sharing a name); assert 400 with the candidate-id
   list — same as POST.

4. **Cross-workspace origin attribution.** Seed a run under `wsB` whose
   `targetWorkspaceId === wsB` but with the action carrying
   `explicitTargetWorkspaceId === wsB`; spawn an agent record whose
   `workspaceId === wsB`. Cockpit should show the spawned agent id in the
   `wsB` block with `lastRun.originWorkspaceId` undefined (today's behavior).
   Add a TODO test, marked `t.skip` with a reference to follow-up #3 in
   `WORKBENCH_TARGET_GUARDRAILS_CLAUDE_20260508.md`, asserting the expected
   shape once session-metadata propagation lands.

5. **Per-agent close-recommendation buckets.** Seed `listAgents` (test
   double already used in the existing tool-routing tests for guardrails)
   with three agents per workspace: one running, one exited+exit-0, one
   exited+exit-1. Assert `reviewReadyAgentIds` contains only the exit-0 id,
   `blockedAgentIds` contains only the exit-1 id, and `agents.running === 1`.

6. **Auth parity with current GET.** Reuse the bridge-bearer fixture from
   the existing GET path; assert that an unauthenticated remote-host request
   returns the same 401 shape as POST and per-workspace GET (no information
   leak about workspace count via 401 vs 200).

7. **Read-only invariance.** Snapshot every workspace's
   `data/dispatch-runs/<workspaceId>.json` mtime + content hash before the
   call; call the endpoint; assert no file changed. This is the equivalent
   of the polling-doesn't-mutate guarantee the strip already relies on
   (`WORKBENCH_DISPATCH_RUNS_P0_20260508.md` "Kept status reads out of the
   action ledger").

8. **Tool-routing validation.** `get_cockpit_summary` rejects
   `runs_limit > 50`, rejects non-array `workspace_ids`, accepts the empty
   `{}` payload (returns all workspaces).

`npm run typecheck` and `node --import tsx --test tests/tool-routing.test.ts`
must stay green. PTY lifecycle suite is not in scope; if the lane chooses to
use `listAgents` test doubles instead of standing up the PTY sidecar, the
sandbox EPERM seen across other lanes is avoided cleanly.

## Non-Goals (Explicit)

This slice **does not** include:

1. **Task tools.** No `create_task`, `claim_task_files`, `request_review`,
   `record_review_verdict`, `mark_task_done`, `list_tasks`. Those are gap-
   report Priority 3 and a separate lane.
2. **Done-gate enforcement.** A task can still be moved through any status
   server-side via the existing `PATCH /workspaces/:id/tasks/:id`; this lane
   does not change that and does not block it. The gate work needs the task
   tools first.
3. **Reviewer verdict modeling.** `reviewReadyAgentIds` is the exit-code
   approximation only. A real "ready for review" signal needs the task
   evidence fields enumerated in gap-report Priority 4 (`reportPath`,
   `reviewerAgentId`, `reviewVerdict`).
4. **Dirty git per workspace.** Mentioned in gap-report Priority 5; this
   slice deliberately defers it because it requires shell exec and a separate
   permission story.
5. **WebSocket / SSE push.** 5s poll model carries over from the strip.
6. **New cockpit UI panel / tab.** The single-line aggregate disclosure
   under the existing strip is the entire UI surface for this slice.
7. **Mutating cross-workspace tools.** P1 already approved explicit
   `workspace_id` for direct tools; nothing about that changes.
8. **Auto-close exited panes / archive policy.** Out of scope here; tracked
   in gap-report Priority 3 / Priority 4.
9. **Pane hydration / resume lifecycle work** (gap-report Priority 4).
   Independent of this slice; can interleave or land first.
10. **Lint debt cleanup.** Same exemption every recent lane has taken.
    `dist-app` exclusion belongs in its own pass.

## Sequencing Recommendation

1. **This slice — cockpit summary fan-out + close-recommendation rollup.**
   1 endpoint + 1 tool + 1 selector extraction + ~8 tests + ~5 lines of UI.
   Single Codex lane; reviewer pass by Claude.
2. Then **gap-report Priority 3** — task tools and done/review gates. The
   cockpit response gains a `tasks.*` block additively; no breaking change
   to the wire format. This is the lane that justifies the
   `reviewReadyAgentIds` / `blockedAgentIds` fields growing into real
   reviewer verdicts.
3. Then **gap-report Priority 4** — pane hydration / resume / archive
   lifecycle. The cockpit gains an `archivable.*` block at this point.
4. Then **full Priority 5 UI** — a real cockpit page, fed by the same
   endpoint shipped in step 1, plus the additions from steps 2–3. The strip
   stays as a per-workspace summary.

## Out-of-Spec Follow-Ups Carried Forward

These were already flagged in the inputs and remain non-blocking but should
not be lost in the next planning pass:

- Visibility/backoff on the strip's 5s poll — `WORKBENCH_DISPATCH_STATUS_UI_CLAUDE_20260508.md`
  (item 1, "Issues / Findings"). The cockpit fetch should respect the same
  treatment when added.
- Targeted React render test for the strip (and, when added, the cockpit
  disclosure line) — same source, item 2.
- Browser smoke verification on a workbench instance with 3747/3748 free —
  same source, item 3. Pair with the cockpit disclosure smoke once landed.
- `resolveWorkspaceSelector` extraction to `lib/workspace-selector.ts` —
  `WORKBENCH_TARGET_GUARDRAILS_CLAUDE_20260508.md` follow-up #1. Required by
  this slice anyway; do it here.
- Session-metadata propagation of explicit cross-workspace target —
  `WORKBENCH_TARGET_GUARDRAILS_CLAUDE_20260508.md` follow-up #3 / Codex's
  own note. Unblocks the `originWorkspaceId` field in this spec.
- Lint/dist-app cleanup pass — pre-existing debt from
  `WORKBENCH_UX_CONTROL_POLISH_20260508.md`. Not blocking, but every lane
  has dodged it; schedule a single pass.

## Verdict

Smallest useful next slice is a **read-only cockpit summary fan-out** with
the response shape above, an `assistant` tool wrapper, an extracted workspace
selector helper, eight targeted tests, and a single line of UI under the
existing dispatch strip. It moves Jarvis from "I can see one workspace" to
"I can see all workspaces" without taking on the larger task-tools /
done-gate / cockpit-UI lanes that should follow it. No code changed in this
spec pass.
