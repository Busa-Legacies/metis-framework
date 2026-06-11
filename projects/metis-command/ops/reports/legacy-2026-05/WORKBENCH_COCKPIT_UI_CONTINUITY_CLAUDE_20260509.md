# Workbench Cockpit UI Continuity — Claude — 2026-05-09

## Scope

Define the next UI-facing slice on top of the landed cockpit summary fan-out
(`WORKBENCH_COCKPIT_SUMMARY_ENDPOINT_CODEX_20260508.md`,
`WORKBENCH_COCKPIT_ENDPOINT_REVIEW_CLAUDE_20260508.md`). The fan-out gives Jarvis
data; this slice gives Jarvis a **continuous view** that survives a poll cycle:

- See all workspace agents at once (running / exited / stale).
- Surface completed reports the agents wrote to disk.
- Surface stale panes (running but silent for too long).
- Compute deterministic next-action recommendations.
- **Never silently clears visible agents.** The cockpit and its tools recommend
  closes; they do not perform them.

Inputs read this pass:

- `lib/cockpit-summary.ts`, `app/api/assistant/route.ts:786-820` (cockpit GET).
- `components/AssistantPanel.tsx:319-442` (per-workspace strip).
- `components/Workbench.tsx:236-239`, `:307-319` (existing manual `clear exited`
  button — stays as the only deletion path).
- `server/pty-server.ts:485-609` (`lastOutputAt`, `markAgentExited`,
  `clearExitedAgents`, `outputTails`).
- `lib/types.ts:12-29` (`Agent.exitCode`, `Agent.lastOutputAt`, `Agent.lastOutput`).
- `lib/dispatch-runs.ts` (run/action shapes feed the cockpit, no change here).
- `WORKBENCH_CLEAR_EXITED_PANES_BUGFIX_20260508.md` (deletion semantics — the
  bugfix that motivates the "do not auto-clear" invariant).

No code/test edits were made in this pass. This file is the spec only;
`Optional Safe Patches` at the bottom enumerates the small additive edits a
follow-up Codex lane can land without risk.

## Why now

Three things in the current cockpit are not yet "continuity-safe":

1. **`reviewReadyAgentIds` overstates clean exit** (review note #1, 2026-05-08).
   `exitCode === undefined` (PTY went missing, SIGKILL grace) buckets identically
   to `exitCode === 0`. Jarvis cannot distinguish a clean reviewer hand-off from
   a process that just disappeared — and will quietly recommend closing both.
2. **No surface for stale running panes.** A Codex pane that hung 40 minutes
   ago is `status === 'running'`, never enters `reviewReadyAgentIds`, and is
   invisible to the cockpit summary. Jarvis must scroll into the pane to notice.
3. **Reports are tied to the agent that wrote them.** The clear-exited button
   deletes `outputTails` and the runtime row in one step
   (`server/pty-server.ts:584-608`). Any lane that recommended "close pane X"
   without first surfacing X's report path leaves Jarvis with a missing artifact
   after the next click.

This slice closes those three gaps and defines the **non-mutating contract**
the rest of the cockpit work depends on.

## Continuity invariants (the contract)

1. **The cockpit GET is pure read.** No FS writes, no PTY signals, no
   dispatch-run mutation. Polling at 5s parity must leave every
   `data/dispatch-runs/<workspaceId>.json` mtime+hash and every PTY agent state
   unchanged. (Already true for the fan-out; this slice extends the same rule
   to acknowledgements — see `acknowledge_agent` below.)
2. **Acknowledgement ≠ deletion.** A reviewed exited pane is *acknowledged*; the
   pane stays visible (greyed) until a human or an explicit close-tool removes
   it. The existing `clear exited` UI button (`Workbench.tsx:312`) remains the
   *only* path that calls `DELETE /agents/exited`. No tool added in this slice
   may invoke that endpoint.
3. **Reports outlive their agents.** Report paths are recorded under
   `data/cockpit-reports.json` keyed by workspace; once an agent is cleared,
   the corresponding report rows survive. The cockpit response surfaces them
   from this store, not from runtime agent state.
4. **Stale ≠ exited.** A stale running agent shows up in
   `staleRunningAgentIds` but never flips to `reviewReadyAgentIds`. Jarvis must
   take an explicit action (wake, kill, or reassign) — the cockpit recommends,
   never decides.
5. **`reviewReadyAgentIds` is "clean exit only".** `exitCode === 0` only;
   `undefined` (signal/missing) and any non-zero code go to other buckets. This
   carries forward review note #1.
6. **No auto-clear.** No path in this slice writes to `outputTails` or removes
   runtime agents. The pre-existing manual button stays. If the assistant later
   wants a `clear_exited_agents` tool, that is a separate lane with its own
   spec — out of scope here.

## What Jarvis needs to see (delta over today's cockpit)

Across all workspaces, in priority order:

1. **Per-agent close-recommendation, in three buckets** instead of two:
   - `reviewReadyAgentIds` — `exited && exitCode === 0`. Reviewer should pick up.
   - `blockedAgentIds` — `exited && exitCode !== 0 && exitCode !== undefined`.
     Needs investigation; do not auto-close.
   - `unknownExitAgentIds` — `exited && exitCode === undefined`. Process
     disappeared (`markAgentExited(_, undefined, 'missing')` at
     `pty-server.ts:643`) or was SIGKILLed (`pty-server.ts:563`); operator
     verdict required before close.
2. **Stale running panes.** `running && lastOutputAt < now - staleThresholdMs`.
   Default threshold 10 minutes; configurable per-call via query param /
   tool arg. Surfaced as `staleRunningAgentIds[]` per workspace and a
   `staleRunningAgentCount` total.
3. **Completed reports per workspace.** Up to N most recent rows from the
   reports store, newest first, each carrying `{ path, agentId, kind, mtime,
   sizeBytes }`. Reports persist after their agent is cleared.
4. **Next-action queue.** Deterministic flat list of suggested actions across
   all workspaces, ordered by severity, each entry traceable to the field it
   was derived from. Never auto-executed.
5. **Acknowledgement state.** Per-agent `{ ackedAt, by }` so the strip can
   visually distinguish "reviewed but not yet cleared" from "still owed a
   review". Acks are append-only metadata; clearing the pane drops the row.

## API: extensions

### Extended cockpit response

Additive changes only. Existing fields remain wire-compatible.

```ts
interface CockpitWorkspaceReadiness {
  activeRunCount: number
  partialRunCount: number
  failedRunCount: number
  succeededRunCount: number
  retryableFailedSpecCount: number
  reviewReadyAgentIds: string[]            // tightened: exitCode === 0 only
  blockedAgentIds: string[]                // exitCode !== 0 && !== undefined
  unknownExitAgentIds: string[]            // NEW: exitCode === undefined
  staleRunningAgentIds: string[]           // NEW: running, no output ≥ threshold
  acknowledgedAgentIds: string[]           // NEW: ack’ed but not yet cleared
}

interface CockpitReportEntry {
  path: string                              // absolute or workspace-relative
  agentId?: string                          // best-effort link; may be undefined
  kind: 'markdown' | 'json' | 'log' | 'other'
  mtime: string                             // ISO
  sizeBytes: number
  unread: boolean                           // mtime > workspace.lastReportAckAt
}

interface CockpitWorkspace {
  // ...existing fields...
  reports: CockpitReportEntry[]             // NEW: bounded by reports_limit
  staleThresholdMs: number                  // NEW: echoed back for UI tooltip
}

interface CockpitNextAction {
  kind: 'review' | 'investigate' | 'ack_or_clear' | 'retry' | 'wake' | 'read_report'
  workspaceId: string
  agentId?: string
  reportPath?: string
  reason: string                            // human string, never a template id
  derivedFrom: 'reviewReadyAgentIds'
              | 'blockedAgentIds'
              | 'unknownExitAgentIds'
              | 'staleRunningAgentIds'
              | 'retryableFailedSpecCount'
              | 'reports.unread'
  severity: 1 | 2 | 3                       // 1=info, 2=needs-review, 3=urgent
}

interface CockpitTotals {
  // ...existing fields...
  unknownExitAgentCount: number             // NEW
  staleRunningAgentCount: number            // NEW
  acknowledgedAgentCount: number            // NEW
  unreadReportCount: number                 // NEW
  nextActionCount: number                   // NEW
}

interface CockpitSummaryResponse {
  generatedAt: string
  workspaces: CockpitWorkspace[]
  totals: CockpitTotals
  nextActions: CockpitNextAction[]          // NEW: flat, severity-desc
}
```

### Query param additions on `GET /api/assistant?scope=cockpit`

- `active_workspace_id=<id>` — threads through `ctx.activeWorkspaceId` so the
  GET surface honours the same "active first" sort the tool already does
  (carries forward review note #2).
- `stale_threshold_ms=<n>` — integer ≥ 60_000, ≤ 3_600_000, default 600_000
  (10 minutes). Validates server-side identically to `runs_limit`.
- `reports_limit=<n>` — integer 1..20, default 5. Per workspace.
- `include_acked=<bool>` — when `false` (default), `acknowledgedAgentIds` is
  populated but `nextActions` skips ack’ed rows so the queue does not loop.

Auth model unchanged: bridge bearer required for non-localhost callers
(`route.ts:788`).

### New assistant tool: `acknowledge_agent`

```ts
acknowledge_agent({
  agent_id: string,                  // required
  workspace_id?: string,             // optional; resolves via the P1 selector
  reason?: string,                   // optional, max 200 chars
  by?: 'jarvis' | 'reviewer' | string // optional, default 'jarvis'
})
  -> { agentId: string, ackedAt: string, by: string, reason?: string }
```

- Pure metadata write to `data/cockpit-acks.json`. No PTY contact, no run
  mutation, no dispatch-action ledger row.
- Validates that the agent currently exists with `status === 'exited'`. Acking
  a running agent returns `400` with `"can only acknowledge exited agents"`.
- Idempotent on `(agentId, ackedAt)` — re-ack overwrites `reason`/`by`/timestamp.
- Carved out of the dispatch-run wrapper alongside `get_dispatch_status` and
  `get_cockpit_summary` (`route.ts:235`).
- Tool description must explicitly state: **acknowledgement does not delete
  the pane; it only marks the agent as reviewed for the cockpit queue. Use the
  manual UI button or a future `clear_exited_agents` tool to actually remove
  the pane.**

### New assistant tool: `list_workspace_reports`

```ts
list_workspace_reports({
  workspace_id: string,              // required, resolved via P1 selector
  reports_limit?: number,            // optional, 1..50, default 10
  unread_only?: boolean              // optional, default false
})
  -> { reports: CockpitReportEntry[] }
```

- Pure read. Reads `data/cockpit-reports.json` (see persistence below) and
  filters by workspace.
- Used to drill into the report list for a single workspace when the cockpit
  response truncates at `reports_limit`.

### Persistence

Two new files under `data/`:

- `data/cockpit-acks.json` — `{ acks: [{ workspaceId, agentId, ackedAt, by, reason? }] }`
  - Keyed-write: latest entry per `(workspaceId, agentId)` wins on read.
  - Atomic write via temp-file + rename (the same fix already flagged for
    dispatch-runs in review note "polling cost"). Cockpit reads must tolerate
    a missing file.
- `data/cockpit-reports.json` — `{ reports: [...CockpitReportEntry & { workspaceId }] }`
  - Append-on-detect (see Detection below). Bounded length per workspace
    (default 50). Old rows ejected oldest-first.
  - `workspace.lastReportAckAt` lives in this file so `unread` is computable.

Both files are read-once-per-cockpit-call; if either is missing or corrupt,
the cockpit returns empty arrays for the affected fields rather than 500.

### Report detection (cheap heuristic, deterministic)

Run inside the cockpit GET path, **once per call**:

1. For each workspace, list `*.md` files in `workspace.cwd` whose mtime is
   within the last 7 days (cap N=50 per workspace, cheapest `fs.readdirSync` +
   `fs.statSync` only — no recursion).
2. Cross-reference each path with the existing recorded entries in
   `data/cockpit-reports.json`; new paths are appended, existing rows update
   `mtime` / `sizeBytes` if they grew.
3. `agentId` is set when an agent in the same workspace had
   `lastOutputAt` within `[mtime - 30s, mtime + 30s]`. Otherwise undefined —
   the report still surfaces, it just lacks an agent attribution.
4. `unread` is `mtime > workspace.lastReportAckAt`.

This is deliberately heuristic: report detection is "best effort", not a
contract. The contract is that whatever rows the store contains, the cockpit
surfaces them. A future agent-side report-write hook can populate the store
directly and the cockpit code does not change.

### Stale-pane detection

Run inside the cockpit GET path:

- For each `agent` with `status === 'running'`:
  - If `lastOutputAt` is unset, `staleSince = createdAt`.
  - If `(now - lastOutputAt) >= staleThresholdMs`, push to
    `staleRunningAgentIds`.
- Threshold defaults to 600_000 ms (10 min). The cockpit echoes the resolved
  threshold per workspace (`staleThresholdMs`) so the UI can render
  "stale ≥ Xm" in the tooltip.

### Next-action queue derivation

Pure reduction — server-side, deterministic, sorted severity-desc then
workspace-name-asc. One row per (workspace, agent or report) source. No
duplicates: an ack’ed agent never appears in `nextActions`.

| `kind`          | `derivedFrom`                | `severity` | Trigger |
| ---             | ---                          | ---        | --- |
| `review`        | `reviewReadyAgentIds`        | 2          | exit==0 and not ack’ed |
| `investigate`   | `blockedAgentIds`            | 3          | exit!=0 |
| `ack_or_clear`  | `unknownExitAgentIds`        | 2          | exit==undefined and not ack’ed |
| `wake`          | `staleRunningAgentIds`       | 2          | stale running |
| `retry`         | `retryableFailedSpecCount>0` | 2          | one row per workspace, not per spec |
| `read_report`   | `reports.unread`             | 1          | unread report |

`reason` is a human string built from the source row, e.g.
`"codex-builder exited with code 0; 2 minutes ago"`. The UI does not parse it.

## UI surface

This slice **does not** ship a new cockpit page. It adds:

### 1. Cockpit aggregate disclosure under the existing strip

Single row in `components/AssistantPanel.tsx`, immediately under the
per-workspace dispatch strip block at `:392-442`. Source: the new cockpit
fetch run in parallel with `refreshDispatchStatus` at `:182-186`.

Wire format (text only, never HTML-injected):

```
4 ws · 11 running · 3 stale · 2 review-ready · 1 blocked · 2 reports
```

- Each numeric block is a button. Click opens the next-action drawer
  (below). No click target opens an empty page; if the count is 0 the block
  is rendered as muted text, not a button.
- `stale`, `review-ready`, `blocked`, and `reports` are colour-coded with the
  existing `statusTone` palette so the strip looks like a continuation, not a
  new component.
- The block respects the same 5s poll lifecycle and dies with
  `activeWorkspaceId` going null (carries the "fetch dies with workspace"
  rule from the dispatch strip).

### 2. Next-action drawer (right-edge slide-in, modal-less)

Triggered from any aggregate block click. New component
`components/CockpitNextActionsDrawer.tsx`, ~150 LoC:

- Header: workspace count + total next-action count.
- Body: grouped-by-workspace list of `nextActions` rows, each with:
  - Severity dot.
  - One-line reason.
  - `kind`-specific affordances:
    - `review` → "Open pane" (focuses the existing pane in
      `Workbench.tsx`) and "Acknowledge" (calls the new tool).
    - `investigate` → "Open pane" only. **No close button.**
    - `ack_or_clear` → "Open pane" + "Acknowledge". **No close button.**
    - `wake` → "Open pane" + "Send `\n`" (pty input poke; pre-existing tool).
    - `retry` → "Open dispatch run" (jumps to per-workspace strip).
    - `read_report` → "Open file" via `obsidian-uri` or system handler.
- Closing the drawer never mutates anything.
- The drawer is the **only** UI surface that calls `acknowledge_agent`.

### 3. Strip badge: acknowledged-but-not-cleared

In the per-pane title bar (existing in `Workbench.tsx`'s pane list), render
a small "ack’d" pill when `agent.id ∈ acknowledgedAgentIds`. Pure
presentational; clicking the pill removes the ack via a future tool (not
landed in this slice — for now the pill clears only when the pane is
explicitly cleared by the manual button).

### 4. The existing manual `clear exited` button is unchanged

`Workbench.tsx:312` stays the only deletion path. The drawer cannot bulk-clear.
If a future lane wants drawer-driven bulk clear, it must be a separate
opt-in confirmation flow that calls `ptyApi.clearExitedAgents(activeWsId)` —
out of scope here.

## Acceptance tests

Add to `tests/tool-routing.test.ts` (or split to
`tests/cockpit-continuity.test.ts` — either is fine; the existing pattern
seeds workspaces and agents with test doubles).

1. **Tightened `reviewReadyAgentIds`.** Seed three exited agents per workspace:
   `exitCode === 0`, `exitCode === 1`, `exitCode === undefined`. Assert
   `reviewReadyAgentIds` contains only the exit-0 agent;
   `blockedAgentIds` only the exit-1; `unknownExitAgentIds` only the
   undefined-exit. Assert `nextActions` carries one `review` row, one
   `investigate` row, one `ack_or_clear` row, all with `severity` matching
   the table above.

2. **Stale-pane detection.** Seed two running agents in the same workspace:
   one with `lastOutputAt = now - 12 min`, one with
   `lastOutputAt = now - 1 min`. Assert the first appears in
   `staleRunningAgentIds`, the second does not. Override
   `?stale_threshold_ms=120000` and assert both appear. Reject
   `stale_threshold_ms=10` (sub-minute) with `400`.

3. **Reports survive agent removal.** Seed one report row in
   `data/cockpit-reports.json` whose `agentId` no longer exists in
   `listAgents()`. Assert the report still appears in the workspace's
   `reports[]` with `agentId` echoed and `unread === true`.

4. **Acknowledgement is non-mutating elsewhere.** Snapshot every workspace's
   `data/dispatch-runs/<id>.json` and the live agent list before calling
   `acknowledge_agent`. After the call, assert: dispatch-runs files
   byte-identical; agent list byte-identical; only `data/cockpit-acks.json`
   changed; agent appears in `acknowledgedAgentIds` and is no longer in
   `nextActions`.

5. **Acking a running agent fails.** Seed a running agent and call
   `acknowledge_agent`. Assert `400` with the exact string
   `"can only acknowledge exited agents"`. Assert `data/cockpit-acks.json`
   was not written.

6. **No auto-clear contract.** Drive the full cockpit GET against a fixture
   with five exited agents across three workspaces; assert the PTY test
   double's `clearExitedAgents` was never invoked and `outputTails`
   remained byte-identical. (This is the central continuity test for the
   slice; if it fails the slice fails.)

7. **`active_workspace_id` query param threads through.** Pass
   `?active_workspace_id=<wsB>` against three workspaces sorted A/B/C;
   assert `workspaces[0].workspaceId === wsB`. Without the param, assert
   alphabetical sort.

8. **Next-action ordering is deterministic.** Seed the same fixture twice
   and assert the two `nextActions` arrays are byte-identical. Severity
   3 rows precede severity 2 rows; within severity, workspace-name asc;
   within workspace, agent-id asc.

9. **Tool validation.** `acknowledge_agent` rejects empty `agent_id`,
   rejects `reason` longer than 200 chars, accepts `by` as any non-empty
   string ≤ 32 chars.

10. **`include_acked=false` excludes acked from queue.** Ack one
    review-ready agent; call cockpit; assert it is in
    `acknowledgedAgentIds` but not in `nextActions`. Re-call with
    `include_acked=true` and assert it appears in `nextActions` again
    (severity unchanged, `kind === 'review'`).

`npm run typecheck` and the tool-routing test file must stay green. PTY
lifecycle tests are out of scope; use the same `listAgents` test doubles
the existing cockpit suite uses to avoid the sandbox EPERM blocker.

## Polling cost

Per cockpit GET, on top of the existing 6 ops/call:

- 1 read of `data/cockpit-acks.json` (small, cached by the OS).
- 1 read of `data/cockpit-reports.json` (small).
- N `fs.readdirSync(workspace.cwd)` for report detection — bounded by an
  in-process LRU keyed by `(cwd, mtime-of-cwd)` so unchanged directories
  cost nothing after the first hit.
- Stale detection is a pure reduction on the agent list already fetched.

At 5s poll cadence and N=4 workspaces this is ~10 ops/call, ~120 ops/min —
still trivial. At N=20 it is ~440 ops/min; the LRU keeps the `readdir`
component close to constant in practice.

## Non-goals (explicit)

This slice **does not**:

1. Build a full cockpit page. The drawer is the surface.
2. Add a `clear_exited_agents` assistant tool. The manual UI button stays
   the only deletion path.
3. Extend the dispatch-run model. Reports are a separate store.
4. Add a `/recommendations/execute` endpoint. The cockpit recommends; it
   does not act.
5. Plumb reviewer verdict / done-gate fields. That is gap-report
   Priority 3/4.
6. Modify `markAgentExited` or `clearExitedAgents` semantics. The 2026-05-08
   bugfix stands.
7. Add WebSocket / SSE push. 5s poll parity.
8. Touch lint / `dist-app` debt.
9. Index the workspace cwd recursively for reports — flat `*.md` only.
10. Bulk operations of any kind in the drawer.

## Sequencing recommendation

1. **Step 1 — store + tightened buckets (this slice, part A).** Single
   Codex lane: introduce `data/cockpit-acks.json` + `data/cockpit-reports.json`;
   tighten `reviewReadyAgentIds`; add `unknownExitAgentIds`,
   `staleRunningAgentIds`, `acknowledgedAgentIds`, `reports[]`,
   `nextActions[]`, plus the new query params. Tool: `acknowledge_agent`
   only. Tests #1–#10 above except #6’s drawer assertions.
2. **Step 2 — UI (this slice, part B).** Cockpit aggregate disclosure +
   `CockpitNextActionsDrawer`. Two acceptance tests on the disclosure: (a) a
   render test with a static cockpit fixture, (b) a click test that fires
   `acknowledge_agent` and asserts the drawer hides the row without a
   refetch.
3. **Step 3 — `list_workspace_reports` tool.** Tiny, additive, tested in
   isolation. Lands once part A is in.
4. **Then** the gap-report Priority 3 task-tools lane gains a real
   `request_review` / `record_review_verdict` flow on top of these acks.
5. **Then** Priority 4 archive lifecycle can extend `cockpit-reports.json`
   into a durable per-workspace deliverable index.

Steps 1 and 2 are independent enough that part B can wait without blocking
Jarvis from getting cross-workspace continuity through the assistant tool
alone.

## Out-of-spec follow-ups carried forward

- Atomic write for `data/dispatch-runs/<id>.json` (review note "polling
  cost"). Apply the same temp+rename to the two new cockpit files in part A
  so we do not introduce the exact regression we already plan to fix.
- Auth-parity test for the cockpit GET (review note acceptance #6 still
  outstanding). Fold into part A.
- `active_workspace_id` query param (review note #2). Lands as part of part A.
- `originWorkspaceId` populated once the P1 session-metadata propagation
  follow-up lands (`WORKBENCH_TARGET_GUARDRAILS_CLAUDE_20260508.md` #3).
  No code change here, but the next-action `derivedFrom` enum should be
  forward-compatible with a future `origin` source.

## Risk register

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| `data/cockpit-reports.json` grows unbounded | low | per-workspace cap N=50, oldest-first eviction; one-line test |
| `readdirSync(cwd)` on a slow network mount stalls the poll | low | LRU on `(cwd, dir-mtime)`; on first hit, time-box the read at 250 ms and fall back to last cached row set |
| Heuristic `agentId` mis-attribution on a report | medium | accepted; agentId is best-effort, surfaced as undefined when uncertain — UI must not gate on it |
| `acknowledge_agent` raced against pane clear | low | acks file is keyed by `(workspaceId, agentId)`; clearing the pane drops the row at the next cockpit read so a stale ack cannot mislead the queue |
| Drawer click triggers a hidden mutation | high if not enforced | covered by acceptance test #6 (no auto-clear contract); the drawer code path must call only `acknowledge_agent` and pre-existing read tools |
| Stale threshold too aggressive (false positives) | medium | configurable per-call; UI default conservative at 10 min; unit test for the 0 < ms < 60_000 reject path |

## Optional safe patches (deferred)

These are additive-only edits that part A would land. Listed here for the
follow-up Codex lane; **not applied this pass** because the user instruction
was "patch docs/tests only if safe; no push/deploy" and the right place for
these is alongside the test fixtures.

1. `lib/cockpit-summary.ts` — split the agent bucketing loop so
   `exitCode === undefined` lands in a new `unknownExitAgentIds` array.
   ~5 lines, no API break (the field is additive). Carries review note #1.
2. `tests/tool-routing.test.ts` — add a `t.skip` placeholder named
   `"cockpit acknowledge agent — non-mutating contract"` referencing
   acceptance test #6 above so it does not get lost in the next sweep.
3. `app/api/assistant/route.ts` — accept `active_workspace_id` on the
   cockpit GET and thread it into the `ctx`. ~3 lines.

Each of those is a one-PR change; they should not be batched with the
ack/reports stores because the test file weight grows quickly past a
single review.

## Verdict

Smallest UI-facing continuity slice on top of the landed cockpit fan-out is:

- Three new readiness buckets (`unknownExitAgentIds`, `staleRunningAgentIds`,
  `acknowledgedAgentIds`).
- Two persistence files (`cockpit-acks.json`, `cockpit-reports.json`) with
  atomic writes.
- One mutating tool (`acknowledge_agent`) and one read tool
  (`list_workspace_reports`), both carved out of the dispatch-run wrapper.
- One aggregate disclosure under the existing strip and one drawer.
- A formal **no-auto-clear** invariant enforced by acceptance test #6.

It moves Jarvis from "I can see all workspaces once per poll" to "I can hold
all workspaces in view across polls, watch them go stale, and pick the next
action without losing the artifacts the agents already produced" — without
touching the deletion path.

No code changed in this spec pass.
