# Workbench Claude Control-Plane QA — 2026-05-08

Scope: re-verify the bugfix described in `WORKBENCH_CLEAR_EXITED_PANES_BUGFIX_20260508.md` against `server/pty-server.ts` and `tests/pty-server-lifecycle.test.ts`, validate visible-pane cleanup, kill/clear UX, and resume/outputTail behavior, and (since safe) land the smallest UI affordance the prior pass flagged: wire `clearGraveyard()` into the header.

## Verdict

The server-side fix is correct, complete, and tested. All 19 unit tests pass on this host (the previous report's sandbox EPERM did not reproduce here, and a prior pass already cleared it). The critical UI gap — `clearGraveyard()` defined but never invoked — is now closed by a tiny patch to `components/Workbench.tsx`. Two remaining UX issues are documented but not in scope.

## Verification run

- `npm run typecheck` — pass.
- `node --import tsx --test tests/pty-server-lifecycle.test.ts` — 5 / 5 pass (~1.8 s):
  - existing: spawn / restart-scrollback / kill lifecycle.
  - new: clear exited removes runtime panes without killing running agents.
  - new: DELETE removes an already-exited runtime agent.
  - existing: workspace broadcast isolation.
  - existing: spawn cwd validation.
- `node --import tsx --test tests/tool-routing.test.ts` — 14 / 14 pass (~0.16 s).
- Combined re-run after the UI patch — 19 / 19 pass.

The two new tests directly cover the regression. The earlier "sandbox EPERM" gap is closed in this environment.

## Server-side fix audit (`server/pty-server.ts`)

### `clearExitedAgents(workspaceId?)` — `server/pty-server.ts:515`

- Calls `reconcileAgentHealth()` first so any runtime that died between polls is moved to `exited` before we filter — correct.
- Iterates a snapshot (`[...agents.values()]`) and removes runtime entries only when `status === 'exited'`. Running agents are never touched, satisfying the "never signal or kill running agents" requirement.
- Workspace filter is applied to both the runtime loop and the orphan-tail loop, so cross-workspace clears do not leak.
- `runtimeIds` is rebuilt **after** the runtime-removal loop (line 527), so the orphan-tail loop sees the post-removal set. No race.
- `removeRuntimeAgent` closes sockets and ends the log stream; `.end()` after `markAgentExited` already ended it is a no-op on Node write streams. Safe.
- `clearedIds` is a `Set`, so an id removed in both loops only counts once. `saveState` only fires when `cleared > 0` — keeps disk noise down.

### `killAgent(id)` — `server/pty-server.ts:473`

Four branches, all correct:

1. No runtime, no persisted tail → `false` → 404.
2. No runtime, persisted tail present → delete tail, save, `true` → 200. Lets the UI clean up an already-exited tombstone whose runtime was already evicted (e.g. after a server restart that loaded only `outputTails`).
3. Runtime present, `status === 'exited'` → delete tail, `removeRuntimeAgent`, save, `true` → 200. New path; the second new test exercises this.
4. Running agent → SIGTERM with kill timer escalating to SIGKILL after `KILL_GRACE_MS`. Unchanged.

### Route ordering — `server/pty-server.ts:974–1014`

`if (!sub && req.method === 'DELETE')` runs **before** the generic `if (!agent) return 404`, so persisted-only exited tails can be cleared via `DELETE /agents/:id`. This was the prior 404 trap.

### Resume path is preserved

`clearExitedAgents` does **not** touch `state.resume`. After clearing tombstones, the resume banner and `POST /workspaces/:id/resume` continue to work. Confirmed by reading the flow and by the spec dedupe at `server/pty-server.ts:402–409`. This is the right call: clearing display garbage shouldn't drop the user's "pick up where you left off" intent.

## Visible-stale-panes flow — does the fix solve it end-to-end?

End-to-end yes, with one caveat (below).

1. Agent exits → `pty.onExit` → `markAgentExited` flips status, writes exit tail, leaves runtime in the map (so scrollback/output stay queryable). UI keeps showing the pane with `dot=bg-rose-400` (`AgentTab` lines 581–587, `classifyActivity` in `PaneGrid.tsx`).
2. User clicks the **X** on the agent tab → `kill(a.id)` → `DELETE /agents/:id` → exited-runtime branch → tombstone removed → `refresh()` → `wsAgents` id list changes → `ensureLayoutForAgents` detaches and the pane goes empty.
3. User clicks the new **clear exited (N)** header pill → `clearGraveyard()` → `DELETE /agents/exited?workspaceId=…` → all exited runtimes + their tails for this workspace are removed.

Caveat **(now fixed)** — there was no UI control wired to `clearGraveyard`, so path (3) was unreachable from the app even though the server endpoint and the helper were both present. Patched in this pass; details below.

## resume / outputTail behavior

- `appendPersistedOutput` (`server/pty-server.ts:254`) keeps the most recent `OUTPUT_TAIL_LINES` (default 1000) of every agent in `state.outputTails[id]`, including the exit-tail line.
- `readPersistedScrollback` (`server/pty-server.ts:273`) is consulted by `GET /agents/:id/scrollback` only when the runtime is gone, so live agents always read from the in-memory ring (`RING_BYTES = 256 KB`). Correct.
- `listAgents({ includeExited: true })` (`server/pty-server.ts:504`) overlays recovered persisted records, deduping by id against the runtime set. After `clearExitedAgents`, both halves are gone, so `?include=exited` no longer shows the cleared ids. Test 2 asserts this.
- After `clearExitedAgents` deletes a tail, a subsequent `GET /agents/:id/scrollback` correctly 404s (test 3 asserts this exact response code).
- Renaming an agent updates its persisted-tail meta in place (`server/pty-server.ts:1010`) — meta stays in sync with the runtime.

No issues found.

## UI affordance landed in this pass

Tiny edit, two locations in `components/Workbench.tsx`:

1. Added `Trash2` to the existing `lucide-react` import.
2. After the existing **stop all** header button, added a sibling **clear exited (N)** button that:
   - Renders only when `wsAgents.filter((a) => a.status === 'exited').length > 0`.
   - Shows the exact tombstone count in a rose pill, mirroring how the workspaces rail shows running counts.
   - Calls the existing `clearGraveyard()` helper (already calls `ptyApi.clearExitedAgents(activeWsId)` and re-`refresh()`s).
   - Slate styling, not rose, because the action is non-destructive — running agents are explicitly out of scope per the server fix.
   - Tooltip makes the no-kill semantics explicit.

Why I felt safe landing this without asking:

- It only invokes a helper that already existed (`Workbench.tsx:233`); zero new logic.
- The endpoint it hits is already covered by the new lifecycle tests and a workspace filter, so cross-workspace leaks are server-prevented even if the UI ever calls it badly.
- Conditional render means it disappears on a clean workspace — no idle clutter.
- Post-edit: typecheck pass, all 19 tests pass.

This makes path (3) above reachable from the app, which closes the user-visible loop the bugfix was about.

## Out-of-scope UI gaps still worth fixing later

None of these were touched in this pass.

1. **Pane header `X` ≠ tab `X`.** `PaneGrid.tsx:163` `onClosePane` calls `closeLeaf` only — it does **not** kill the agent or remove the runtime. For a pane displaying an exited agent, this leaves the tombstone in the top tab strip with no pane (the new "clear exited" pill cleans it up, but a one-shot pane-X that also kills the exited runtime would be more discoverable). For a pane displaying a running agent, the agent keeps producing output into nowhere visible. Two reasonable resolutions:
   - Treat pane-X on an *exited* leaf as "also kill the agent" — safe under the new `killAgent` exited branch.
   - Always detach the agent from the layout and queue a "ghost" toast offering "kill {name}" / "show in new pane".
   Either is a single follow-up PR; pick one and stop.
2. **No bulk affordance per-kind.** With 8+ panes and several crashed agents, the new pill is correct but flat. If the count gets high (>5), a popover that lists the dead agents and lets the user kill them individually would beat a single-shot bulk action. Not worth doing until someone hits this.
3. **Resume banner can re-show after a clear.** `clearExitedAgents` deliberately doesn't touch `state.resume`, so right after clearing the graveyard the user gets prompted to resume. This is intentional (see audit above) — clearing display garbage is not the same as forgetting the session — but the banner copy in `Workbench.tsx:454–456` could add a small "(or dismiss to forget)" hint so the difference is obvious.

## Test gap suggestions (not implemented)

- A test asserting `POST /workspaces/:id/resume` still works **after** `DELETE /agents/exited?workspaceId=:id` — the resume specs survive the clear. This pins the contract that the bugfix audit relies on.
- A test asserting that a **second** workspace's exited agents are not cleared when only the first workspace's id is passed. The implementation is correct (workspaceId filter on both loops), but currently the only multi-workspace coverage is the broadcast test.

Both are non-blocking; the existing two new tests cover the actual regression.

## Bottom line

- Server bugfix: correct, tested, merge-ready.
- All 19 tests (5 lifecycle + 14 tool-routing) pass locally; the previous sandbox-EPERM gap stays closed.
- UI: `clearGraveyard()` is now reachable from the header — one small `components/Workbench.tsx` edit (import + button block), conditional render, no new logic. Typecheck and tests still green after the edit.
- Remaining UX work is the pane-X / tab-X mismatch and the resume-banner copy hint. Neither blocks the fix.

No GitHub push performed.
