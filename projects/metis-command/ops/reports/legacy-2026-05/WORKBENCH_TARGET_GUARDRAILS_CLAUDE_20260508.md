# Workbench Target Guardrails P1 - Claude Review - 2026-05-08

## Scope

Reviewer pass on Codex's Priority 1 target/agent guardrails lane. Verified against
`WORKBENCH_DISPATCH_RUNS_P0_20260508.md` (recommended next lane) and the
"Priority 1 - Target Workspace and Agent Guardrails" section of
`WORKBENCH_CEO_FLOW_NEXT_GAPS_20260508.md` (gap + acceptance criteria).

Files inspected:

- `lib/tool-routing.ts`
- `app/api/assistant/route.ts`
- `lib/dispatch-runs.ts`
- `tests/tool-routing.test.ts`
- `WORKBENCH_TARGET_GUARDRAILS_P1_CODEX_20260508.md` (Codex's lane note)

No code edits in this review pass. No push/deploy.

## Verdict

APPROVE. All P1 acceptance criteria are met by the diff. Typecheck and the
targeted test suite pass on the current tree. A small set of follow-ups is listed
below; none of them block this lane.

## Behavior verified against the spec

| Acceptance criterion | Status | Evidence |
| --- | --- | --- |
| `send_to_agent` to an id in another workspace fails unless `workspace_id` matches | Met | `lib/tool-routing.ts:165` `resolveDirectAgentTarget()`; `app/api/assistant/route.ts:174` `send_to_agent` case wires `target.explicit ? workspaceId : undefined` into `requireKnownAgent`. Test `tests/tool-routing.test.ts:72`. |
| `kill_agent` and `rename_agent` have the same guard | Met | `app/api/assistant/route.ts:160` and `app/api/assistant/route.ts:167` reuse the same `resolveTargetWorkspace` + `requireKnownAgent` shape. Validation accepts optional `workspace_id` for both: `lib/tool-routing.ts:82` and `lib/tool-routing.ts:90`. |
| `read_agent_output` is also guarded (implicit in P1 list — Codex extended) | Met | `app/api/assistant/route.ts:191`, validation at `lib/tool-routing.ts:82` (shared case with `kill_agent`). |
| "Spawn in Sitework" by name resolves server-side and records target workspace in the run | Met | `app/api/assistant/route.ts:93` `resolveWorkspaceSelector()` does case-insensitive unique-name match; `app/api/assistant/route.ts:230` synthesizes a run id under the resolved target and `app/api/assistant/route.ts:236` passes `targetWorkspaceId` / `explicitTargetWorkspaceId` to `beginDispatchAction`. Persistence verified at `lib/dispatch-runs.ts:178` and `lib/dispatch-runs.ts:206`. Test at `tests/tool-routing.test.ts:220`. |
| Ambiguous or missing workspace names return a user-visible choice, not a guess | Met | `app/api/assistant/route.ts:99` returns an error listing candidate `id (name)` rows for ambiguous names; `app/api/assistant/route.ts:102` returns "unknown workspace id/name" for misses. |
| Tests cover cross-workspace reject and explicit allow | Met | `tests/tool-routing.test.ts:71` "direct agent workspace guardrails" suite (3 cases) plus dispatch-run target test at `tests/tool-routing.test.ts:220`. |

## Test results

- `npm run typecheck` -> clean (no output, exit 0).
- `node --import tsx --test tests/tool-routing.test.ts` -> 22/22 pass.
  - Includes the three new direct-agent guardrail tests, the new
    `accepts optional workspace_id on direct agent tools` validation test, and
    the new "records explicit target workspace on runs and actions" dispatch-run
    test.

Not run in this pass (out of scope per lane brief): broad lint, PTY lifecycle
tests, end-to-end assistant-route tests.

## Correctness notes

1. `resolveDirectAgentTarget` correctly distinguishes the two cases:
   - With `explicitWorkspaceId`: agent's `workspaceId` must equal the explicit
     value; otherwise an ownership error is returned naming both ids
     (`lib/tool-routing.ts:174`). The active workspace is intentionally not
     consulted here, so a workspace-mismatched explicit selector cannot fall
     back to active.
   - Without explicit: requires an `activeWorkspaceId` and rejects with a
     "supply workspace_id to target it explicitly" hint when the agent lives
     elsewhere (`lib/tool-routing.ts:181`). Good error UX for Jarvis to repair
     the tool call.
2. `execTool` stores the dispatch run under the *resolved target* workspace id
   for explicit cross-workspace calls (`app/api/assistant/route.ts:230` uses
   `wsId = target.workspaceId`). This is the right choice for the
   "what dispatches happened in workspace X" question, and matches Codex's
   stated intent.
3. `beginDispatchAction` updates an existing run's `targetWorkspaceId` /
   `explicitTargetWorkspaceId` only when `explicitTargetWorkspaceId` is supplied
   on a later action (`lib/dispatch-runs.ts:191`). That preserves the first
   explicit target and avoids regressing it back to undefined when a later
   implicit action lands in the same run.
4. `broadcast` resolves the target workspace and uses the resolved id for the
   PTY broadcast call (`app/api/assistant/route.ts:183`). Combined with
   `selectBroadcastTargets` filtering on `agent.workspaceId === workspaceId`
   (`lib/tool-routing.ts:153`), explicit cross-workspace broadcast cannot leak
   into other workspaces.
5. `get_dispatch_status` runs the same selector resolution and returns status
   for the resolved workspace (`app/api/assistant/route.ts:201`). This is a
   read-only path; allowing cross-workspace status reads via explicit
   `workspace_id` is consistent with the broader CEO-cockpit goal and matches
   the "summary endpoint is workspace-scoped and excludes other workspaces
   unless explicitly requested" criterion in the gap report.

## Security notes

- No path traversal risk introduced: `safeWorkspaceFile` at
  `lib/dispatch-runs.ts:88` strips non `[A-Za-z0-9_.-]` characters from the
  workspace id used in the storage filename, so a hostile/explicit
  `workspace_id` value cannot escape `data/dispatch-runs`.
- The new bearer-token guard for the GET endpoint mirrors POST
  (`app/api/assistant/route.ts:756`), so the structured dispatch status read is
  not a quieter way to bypass `bridgeApiKey`.
- `resolveWorkspaceSelector` does an exact-id check first, then falls back to
  unique case-insensitive name. Multiple matches return an explicit-pick error
  rather than picking one — no silent ambiguity collapse.
- The diff does not introduce any new file write outside the existing
  `data/dispatch-runs` directory, and the workspace-scoped write set is the
  same shape as P0.

## Minor follow-ups (non-blocking)

1. `resolveWorkspaceSelector` is defined inline in `app/api/assistant/route.ts`
   and is not exported. Extracting it to `lib/workspace-selector.ts` (or
   similar) would let the ambiguity / case-insensitivity / unknown-id branches
   be unit-tested directly without standing up the full route handler.
2. Direct-agent tools currently incur two PTY roundtrips per call: one
   `listWorkspaces` inside `resolveTargetWorkspace` and one `listAgents` inside
   `requireKnownAgent`. For autonomous Jarvis fan-out this is fine, but a
   later lane could pass through the agents/workspaces snapshots that the
   conversation context already has.
3. Per Codex's own note, session metadata for explicit cross-workspace dispatch
   stays active-workspace-scoped; only the dispatch-run/action layer records
   the resolved target. The gap report's acceptance text mentions both
   "dispatch run and session metadata" — propagating target into session
   metadata is the natural next step when the cockpit status endpoint lane
   lands (Priority 5).
4. There is no test that drives `resolveWorkspaceSelector` ambiguity end to
   end. Once item (1) lands, add a case for two workspaces named `Sitework`
   and assert the candidate-id list is returned verbatim.
5. Consider whether `read_agent_output` should be in the same "direct agent"
   list as `send_to_agent` / `kill_agent` for consistency with the P1 spec
   wording. Codex already treats it the same way; just call it out explicitly
   in the spec text on the next pass.

## Recommendation

Land this lane as-is. Pick up follow-up (1) opportunistically when touching
`app/api/assistant/route.ts` again, and treat (3) as a hand-off into the
cockpit status / Priority 5 lane.
