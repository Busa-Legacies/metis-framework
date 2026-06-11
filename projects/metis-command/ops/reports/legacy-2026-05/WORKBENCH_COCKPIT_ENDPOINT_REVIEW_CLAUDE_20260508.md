# Workbench CEO Cockpit Endpoint - Claude QA Review - 2026-05-08

## Scope

Reviewer pass on the cockpit summary fan-out lane defined in
`WORKBENCH_CEO_COCKPIT_NEXT_SPEC_CLAUDE_20260508.md`. The implementation has
landed in this branch; this review verifies API shape, privacy/workspace
isolation, polling cost, and acceptance-test coverage against the spec.

Looked for `WORKBENCH_*COCKPIT*_CODEX_*.md` lane note - none on disk yet,
so this review is against the source diff and tests directly. The matching
"Cockpit summary fan-out + close-recommendation rollup" entry in
`../../ops/reports/workbench_rebalance_wave_20260508.md` is the spec lane,
not an implementation report.

Files inspected (read-only):

- `lib/cockpit-summary.ts` (new)
- `lib/tool-routing.ts` (new validation case + new tool name)
- `lib/workspace-selector.ts` (already extracted in P1)
- `lib/dispatch-runs.ts` (P0 store; cockpit reuses `listDispatchRuns`)
- `app/api/assistant/route.ts` (new tool wiring + new GET branch)
- `tests/tool-routing.test.ts` (new "cockpit summary fan-out" suite)
- `server/pty-server.ts` (`AgentMeta.exitCode` pass-through verification)
- `lib/types.ts` (`Agent.exitCode` exposure)
- `components/AssistantPanel.tsx` (strip lifecycle reference)

Patches in this pass: 1 - added a single `it.skip` placeholder test for the
spec's missing follow-up #4 (cross-workspace `originWorkspaceId`). No code
changes, no push, no deploy.

Verification commands run:

- `npm run typecheck` -> clean (exit 0).
- `node --import tsx --test tests/tool-routing.test.ts` -> 31 tests, 30 pass,
  1 skipped (the placeholder I added), 0 fail.

## Verdict

APPROVE WITH MINOR FOLLOW-UPS. The cockpit summary fan-out is correct,
small, and matches the spec on every must-have field. Type safety, read-only
invariance, and selector resolution are all verified end-to-end. Two
spec-listed acceptance tests did not land and one semantic call in
`reviewReadyAgentIds` is worth tightening; none are blocking.

## API shape verification

`CockpitSummaryResponse` in `lib/cockpit-summary.ts:58` matches the spec
field-by-field:

| Field                                | Status | Notes |
| ---                                  | ---    | --- |
| `generatedAt`                        | OK     | server-side ISO; injectable via `input.generatedAt` for tests. |
| `workspaces[].workspaceId/name/cwd`  | OK     | sourced from `ptyApi.listWorkspaces()`. |
| `workspaces[].agents.{total,running,exited,byKind}` | OK | `byKind` is always populated; spec marked it optional, implementation makes it required (better UX, no churn). |
| `workspaces[].lastRun`               | OK     | `recentRuns[0] ?? null`. |
| `workspaces[].recentRuns`            | OK     | newest-first via `listDispatchRuns()` (insertion order via `unshift`). |
| `workspaces[].readiness.activeRunCount/partial/failed/succeeded` | OK | aggregated from `recentRuns` (note scope below). |
| `readiness.retryableFailedSpecCount` | OK     | sum of `failedSpecCount` across `recentRuns`. |
| `readiness.reviewReadyAgentIds`      | OK     | `exited && (exitCode === 0 \|\| undefined)` - see "Substantive notes" #1. |
| `readiness.blockedAgentIds`          | OK     | `exited && exitCode !== 0 && exitCode !== undefined`. |
| `lastRun.originWorkspaceId`          | OK     | reserved field; today always undefined because P1 stores runs under the resolved target (matches spec note). |
| `lastRun.explicitTargetWorkspaceId`  | OK     | mirrors `run.explicitTargetWorkspaceId`. |
| `totals.*`                           | OK     | implementation adds `succeededRunCount` to totals (the spec's totals interface omitted it; the addition is harmless and makes the strip's "X done / Y partial" math derivable client-side). |

Two endpoint surfaces, both pure read:

- HTTP: `GET /api/assistant?scope=cockpit[&workspace_ids=csv][&runs_limit=n]`
  at `app/api/assistant/route.ts:796-816`. Reuses the existing
  `bridgeApiKey` + local-host bypass guard (route.ts:788-793).
- Tool: `get_cockpit_summary({ workspace_ids?: string[], runs_limit?: number })`
  at `app/api/assistant/route.ts:88` (OpenAI schema), `route.ts:75`
  (text-prompt schema), `route.ts:215` (dispatch). Validation in
  `lib/tool-routing.ts:132`. Carved out of the dispatch-run wrapper at
  `route.ts:235` so the tool itself never appends to the action ledger.

`runs_limit` clamps consistently in three layers:

1. Tool validator rejects non-integer or out-of-range up front
   (`tool-routing.ts:136`).
2. GET handler runs the same range check on the parsed query value
   (`route.ts:801`).
3. `clampRunsLimit` inside the builder still defends with
   `Math.max(1, Math.min(50, Math.trunc(limit)))` (`cockpit-summary.ts:77`).

Belt-and-suspenders is fine here; the third layer protects against future
callers that bypass the validator (e.g., the GET path passing `runs_limit`
directly to `getCockpitSummary`).

## Privacy / workspace isolation

| Concern                                          | Status |
| ---                                              | --- |
| Bearer token enforced for non-localhost callers  | OK - `route.ts:788`. Same shape as POST and per-workspace GET. |
| Workspace path-traversal via selector input      | OK - `safeWorkspaceFile()` at `dispatch-runs.ts:90` strips non `[A-Za-z0-9_.-]`. |
| Cross-workspace agent leakage in `agents.*`      | OK - `cockpit-summary.ts:147` filters `agents` by `workspaceId === workspace.id`. |
| Selector ambiguity collapses to a guess          | OK - `resolveRequestedWorkspaces()` returns the same `ambiguous workspace name` / `unknown workspace id/name` strings as P1's POST path. |
| Orphaned `data/dispatch-runs/<deleted>.json`     | OK - cockpit walks live `workspaces` only; orphaned files are silently ignored. No leak; nothing to clean here. |
| Information leak via 401 vs 200                  | OK - 401 returned before any body read; identical to POST 401. |
| Per-workspace ACL                                | NOT REQUIRED - matches the existing trust model (bridge token = global read). Worth documenting in the threat model when the bridge gains remote use. |

## Polling cost

Per cockpit GET call:

- 1 `ptyApi.listWorkspaces()` HTTP roundtrip to the PTY sidecar.
- 1 `ptyApi.listAgents({ includeExited: true })` HTTP roundtrip.
- N file reads (one per workspace) inside `listDispatchRuns()`.

For today's N = 4 workspaces (REOS, Sitework, Workbench, Market Alpha),
that is 6 ops/call. At the spec's 5s poll cadence that is ~72 ops/min - fine
on a local dev tool. At N = 20 it is ~280 ops/min, still trivial. The strip
poll runs in parallel with the existing per-workspace status poll, so the
combined load is ~12 ops every 5s for the active user.

Two pre-existing risks that get marginally larger with cockpit fan-out:

- `writeWorkspaceData()` is `fs.writeFileSync` without temp+rename. A
  partial JSON during a dispatch action could be read by the cockpit and
  swallowed by `readWorkspaceData`'s try/catch, briefly returning empty
  `recentRuns` for that workspace. Same risk the per-workspace status
  endpoint already inherits; not introduced here. Worth a tiny
  follow-up to write atomically (`writeFileSync` to `.tmp` then `renameSync`).
- The PTY sidecar's `/agents?include=exited` walks all live agents plus
  recovered tails on every call. Cheap today; if the runtime ever stores
  thousands of exited tails this becomes the hot path. No action now.

## Acceptance-test coverage

Reconciled against the spec's eight required tests in
`WORKBENCH_CEO_COCKPIT_NEXT_SPEC_CLAUDE_20260508.md` "Acceptance Tests":

| #  | Spec test                                          | Landed | Location |
| -- | ---                                                | ---    | --- |
| 1  | aggregate fan-out across workspaces                | YES    | `tests/tool-routing.test.ts:376`. |
| 2  | mixed status totals                                | YES    | `tests/tool-routing.test.ts:409` (folded with #5). |
| 3  | `workspace_ids` selector + 400s                    | YES    | `tests/tool-routing.test.ts:475`. |
| 4  | cross-workspace origin attribution + `t.skip`      | PATCHED | `tests/tool-routing.test.ts:514`. I added the `it.skip` placeholder this pass; the active assertion was deferred per the spec ("today's behavior" matches the implementation already). |
| 5  | per-agent close-recommendation buckets             | YES    | folded into test 2 at `tests/tool-routing.test.ts:454-471`. |
| 6  | auth parity with current GET                       | MISSING | spec wanted a bridge-bearer fixture asserting same 401 shape. Not landed. The current tests do not import the route handler, so this would require a new test pattern. Flagging as follow-up. |
| 7  | read-only invariance                               | YES    | `tests/tool-routing.test.ts:493`. |
| 8  | tool-routing validation                            | YES    | `tests/tool-routing.test.ts:84`. |

Net: 6 of 8 spec tests landed prior to this review, 1 patched in this pass
(`it.skip` placeholder for #4), 1 still outstanding (#6 auth parity).

## Substantive notes (non-blocking)

1. **`reviewReadyAgentIds` includes signal-killed agents.** The
   implementation at `cockpit-summary.ts:161` follows the spec literally:
   `exitCode === undefined || exitCode === 0` -> review-ready. But
   `markAgentExited(agent, undefined, 'missing')` at `server/pty-server.ts:643`
   sets `exitCode = undefined` whenever the PTY's PID disappears without an
   observed exit, and `markAgentExited(agent, agent.meta.exitCode, 'SIGKILL')`
   at `server/pty-server.ts:563` does the same for the kill grace path. Both
   end up bucketed as "ready to close" today. This overstates "clean exit".
   Recommend tightening to `exitCode === 0` only and adding a third bucket
   (e.g., `unknownExitAgentIds`) when the cockpit grows real reviewer
   verdicts in the next slice. Spec change required, so leaving for a
   follow-up rather than patching the implementation now.

2. **GET path passes empty `ctx` to `getCockpitSummary`.** At
   `route.ts:805-808` the GET handler calls `getCockpitSummary({...}, {})`,
   so `activeWorkspaceId` is always undefined on the GET surface and the
   "active workspace first" ordering only applies when the cockpit is hit
   via the assistant tool. The spec did not enumerate an
   `active_workspace_id` query param, so this is technically correct, but
   the pending strip-disclosure UI lane will need either:
   (a) a new `?active_workspace_id=<id>` query param threaded into `ctx`,
   or (b) client-side resort. Recommend (a) - the active id is already
   known by the panel and threading it through is cheaper than re-sorting.

3. **`explicitTargetWorkspaceId` on the per-block summary is
   information-redundant.** Once a run is stored under its resolved target,
   `run.workspaceId === blockWorkspaceId` and
   `run.explicitTargetWorkspaceId` (when set) equals the same value.
   Keeping the field is fine for hand-off into the post-Codex P2 lane that
   propagates session metadata, but documenting that it is "the explicit
   target the brain selected, equal to the block id by construction" would
   help the next reader.

4. **Numeric runs_limit only rejects non-integer at validator level.** The
   GET handler uses `Number()` then `Number.isInteger`, so a fractional
   query like `?runs_limit=3.5` returns the same 400 ("must be an integer
   between 1 and 50"). The tool validator does the same. Consistent. No
   fix required - calling out only to confirm parity.

5. **`workspace_ids` CSV dedup.** Passing
   `?workspace_ids=Sitework,Sitework` does not 400 (the loop in
   `resolveRequestedWorkspaces` puts ids into a Set before filtering). Good
   default; would have been worth a one-line acceptance test. Optional
   add-on, low value.

6. **No README / docs entry.** None of `docs/`, `README.md`, or
   `CLAUDE.md` mentions the cockpit endpoint. Not blocking; the assistant's
   own `toolDescriptions` text exposes it to Jarvis at runtime
   (`route.ts:75`).

## Spec self-correction worth carrying forward

The spec listed "extract `resolveWorkspaceSelector` to `lib/workspace-selector.ts`"
as part of this lane (Sequencing item 1 / Out-of-spec follow-ups #1). That
extraction had already landed in P1 (`lib/workspace-selector.ts` exists and
is unit-tested at `tests/tool-routing.test.ts:110-126`). The next spec pass
should drop the bullet to avoid future confusion.

## Recommendation

Land the implementation as-is. Pick up two follow-ups in the next planning
pass:

1. Tighten `reviewReadyAgentIds` to `exitCode === 0` only and introduce a
   neutral "unknown exit" bucket - one-line spec change plus matching
   implementation/test edits.
2. Add the auth-parity test (acceptance criterion #6) with a bridge-bearer
   fixture; either vendor a Next.js route harness or factor the bridge
   guard into a pure helper that tests can drive without standing up the
   route.

Treat these as cockpit-tightening housekeeping; do not gate the
gap-report Priority 3 task-tools lane behind them.
