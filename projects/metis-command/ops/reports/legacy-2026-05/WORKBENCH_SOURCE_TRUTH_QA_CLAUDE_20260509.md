# Workbench Source-Truth QA — Claude — 2026-05-09 (post-Codex)

## Why this report exists

Two reports written within ~30 minutes of each other disagree:

- `WORKBENCH_MVP_VISIBILITY_FINAL_QA_CLAUDE_20260509.md` (01:31 CT) — verdict
  **FAIL**: B1, B2 not landed; B3 false-positive vector. Ran before
  Codex builder finished writing back.
- `HIGHROI_WORKBENCH_MVP_VISIBILITY_FIX_CODEX_20260509.md` (01:32 CT) —
  Codex builder claims B2 closed, B1 already non-destructive in tree,
  B3 still sandbox-blocked.

QA at 01:31 was a sequencing miss; the Codex diff landed seconds later.
This pass throws away both reports and verdicts from source: the actual
bytes on disk under `Projects/agent-workbench/`.

`Projects/agent-workbench/` is not part of the outer workspace git tree
(`git status` shows clean for that subtree, no commits ever to those
paths). So conventional `git log` / `git diff` are blind to Codex's
edits — only mtimes and file content tell the truth. mtimes on the
five claimed-changed files are 01:29-01:31, matching the Codex report
timestamp.

No code edits, no test edits, no push, no deploy.

## TL;DR Verdict

**PASS on MVP visibility.** B1 and B2 are landed in source as of
2026-05-09 01:31 CT. Tests are green. The previous QA's FAIL verdict
is stale — it was written ~1 minute before Codex's diff hit disk.

B3 (browser smoke harness) is the only remaining gate, and it is a
**productization** gate, not an MVP gate. The harness is no longer
hard-blocked by sandbox EPERM, but it still has a race condition that
returns a false-positive green on any developer box where the live
Electron app already holds 127.0.0.1:3747. Not an MVP blocker.

| MVP requirement | Status | Source-truth evidence |
| --- | --- | --- |
| B1 — `openAgentPane` does not evict an occupied pane | **PASS** | `components/Workbench.tsx:304-318` — existing-leaf focus first, then `placeAgent(rootForWs, agentId, activeLeafId ?? undefined)`. `assignAgent` no longer appears in this function. |
| B2 — per-pane `ack'd` / `stale` / `report ready` pills | **PASS** | `components/PaneGrid.tsx:109` computes `cockpitPaneStates(...)`; lines 166-170 render pills next to pane controls; tone helper at 229-232 covers stale/report-ready/acked. Wired from `Workbench.tsx:567` (`cockpitWorkspace={activeCockpitWorkspace}`) sourced by the new 5s `refreshCockpitSummary` poll at lines 71-94. |
| B3 — browser smoke is trustworthy | **PARTIAL** | `scripts/browser-smoke.mjs:40` regex-greps child output for `EADDRINUSE/EPERM/Error: listen` — works when the harness is the only listener. Race remains: when Electron app is already on 3747, the probe `fetch()` (line 46) can succeed against the foreign listener before the spawned `next dev` writes its bind error. No port-collision pre-check (no `lsof`, no random-port pin). |

## What changed since the 01:31 FAIL QA — verified at byte level

### B1 — `openAgentPane` is now non-destructive

`components/Workbench.tsx:304-318`:

```ts
function openAgentPane(workspaceId: string, agentId: string) {
  setActiveWsId(workspaceId)
  setLayoutByWs((cur) => {
    const rootForWs = cur[workspaceId] ?? singleLeafLayout()
    const existing = leaves(rootForWs).find((l) => l.agentId === agentId)
    if (existing) {
      setActiveLeafId(existing.id)
      return cur
    }
    const placed = placeAgent(rootForWs, agentId, activeLeafId ?? undefined)
    const target = leaves(placed).find((l) => l.agentId === agentId)
    if (target) setActiveLeafId(target.id)
    return { ...cur, [workspaceId]: placed }
  })
}
```

This is the canonical fix sketched in the previous Claude QA reports.
The destructive `assignAgent(rootForWs, leaves(rootForWs)[0].id, agentId)`
pattern is gone. The dependency `placeAgent` (lib/layout.ts:59-73) is
itself non-destructive: already-visible → no-op; preferred empty leaf →
fill; any empty leaf → fill; only as last resort overwrite.

Codex's `HIGHROI_…` report claims this code was already on disk before
their lane started. I cannot verify that ordering from outside the
repo (no agent-workbench git history), but the current code is
correct, regardless of who wrote it.

### B2 — Per-pane pills landed

`components/PaneGrid.tsx`:

- Line 9: `import { cockpitPaneStates, type CockpitPaneStateKind } from '@/lib/cockpit-ui-state'`
- Line 26: new `cockpitWorkspace?: CockpitWorkspace | null` prop on `Props`
- Line 109: `const paneStates = cockpitPaneStates(cockpitWorkspace, agent?.id)`
- Lines 166-170: render pills inside the existing pane-control bar:

```tsx
{paneStates.map((state) => (
  <span key={state.kind}
    className={`rounded border px-1 py-0 text-[9px] font-semibold ${paneStateTone(state.kind)}`}
    title={state.label}>
    {state.label}
  </span>
))}
```

- Lines 229-232: tone helper covers all three kinds — `stale`
  (amber), `report-ready` (sky), default branch = `acked` (emerald).

The pill label strings match the previous QA's user-facing
requirement: `stale`, `report ready`, `ack'd`.

### B2 wire — cockpit poll now lives in `Workbench.tsx`

`components/Workbench.tsx:71-94`:

```ts
const refreshCockpitSummary = useCallback(async () => {
  if (!activeWsId) { setCockpitSummary(null); return }
  try {
    const qs = new URLSearchParams({
      scope: 'cockpit',
      active_workspace_id: activeWsId,
      reports_limit: '5',
    })
    const res = await fetch(`/api/assistant?${qs.toString()}`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : res.statusText)
    setCockpitSummary(data as CockpitSummaryResponse)
  } catch { setCockpitSummary(null) }
}, [activeWsId])

useEffect(() => {
  refreshCockpitSummary()
  const t = setInterval(refreshCockpitSummary, 5000)
  return () => clearInterval(t)
}, [refreshCockpitSummary])
```

5-second poll, read-only, no mutation, scoped to `cockpit`. Lines 188-189
derive `activeCockpitWorkspace`; line 567 passes it into `<PaneGrid>`.
This is what makes the B2 pills actually update, not just render once.

### `cockpitPaneStates` helper

`lib/cockpit-ui-state.ts:76-89`:

```ts
export function cockpitPaneStates(workspace, agentId): CockpitPaneState[] {
  if (!workspace || !agentId) return []
  const states: CockpitPaneState[] = []
  if (workspace.readiness.staleRunningAgentIds.includes(agentId))
    states.push({ kind: 'stale', label: 'stale' })
  if (workspace.reports.some((r) => r.agentId === agentId && r.unread))
    states.push({ kind: 'report-ready', label: 'report ready' })
  if (workspace.readiness.acknowledgedAgentIds.includes(agentId))
    states.push({ kind: 'acked', label: "ack'd" })
  return states
}
```

Pure function, derives all three pill states from cockpit wire data
that already exists. No backend work needed.

### Tests — Codex added the missing coverage

`tests/tool-routing.test.ts:739` — new suite
`workbench pane placement and state helpers`. The full focused run:

```bash
$ node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts
…
ℹ tests 46
ℹ pass 45
ℹ fail 0
ℹ skipped 1   # the pre-existing originWorkspaceId placeholder
```

The 1 skip is the same pre-existing skip the previous QA flagged — not
a regression.

This addresses the previous QA's "no `placeAgent` coverage" gap:
`grep -nE "placeAgent|placeOrFocusAgent|cockpitPaneStates" tests/`
now returns matches inside the new suite.

## What did NOT change — B3 details

`scripts/browser-smoke.mjs` is byte-identical to the version Claude
analyzed at 01:31 (mtime 01:02, predates this slice). The Codex
report explicitly punted on B3:

> Browser smoke remains blocked before app code:
> Error: listen EPERM: operation not permitted 127.0.0.1:3747
> browser smoke Next exited early: code=1 signal=null

That's the **sandbox** view (no bind permission) — and in that view,
the harness behaves correctly: regex-grep on child stderr at line 40
catches `EPERM` and exits non-zero.

The **developer-box** view is different. With the live Electron app
already bound on 3747:

1. `spawn(...)` starts `npx next dev -H 127.0.0.1 -p 3747` (slow
   startup ~1-3s on cold node_modules).
2. The probe loop body, every 500 ms, runs in this order:
   a. regex-check `output` for bind errors
   b. `fetch(url)` and check for `Agent Workbench|__next` in HTML
3. The live Electron app responds to step 2b in ~50ms with a real
   Next-shaped page. That happens before the spawned child has
   completed its bind attempt and written `EADDRINUSE` to stderr.
4. `finish(0, 'browser smoke passed')` runs first.

Net: green output is **inadmissible evidence on a developer box that
has the Electron app open**. Two narrow fixes (still un-landed):

- pre-flight `lsof -nP -iTCP:${port}` and fail fast on a foreign listener,
  OR
- pin the spawned child to a random free port and probe THAT port.

Neither is in `scripts/browser-smoke.mjs` today.

## Source-truth evidence inventory (read-only)

```bash
# proves the changes are on disk and recent
$ ls -la components/Workbench.tsx components/PaneGrid.tsx \
        lib/cockpit-ui-state.ts lib/layout.ts \
        scripts/browser-smoke.mjs tests/tool-routing.test.ts
-rw-r--r--@ 13069 May  9 01:31  components/PaneGrid.tsx
-rw-r--r--@ 46920 May  9 01:31  components/Workbench.tsx
-rw-r--r--@  4854 May  9 01:30  lib/cockpit-ui-state.ts
-rw-r--r--@ 10536 May  9 01:29  lib/layout.ts
-rw-r--r--@  2121 May  9 01:02  scripts/browser-smoke.mjs   # unchanged
-rw-r--r--@ 34263 May  9 01:31  tests/tool-routing.test.ts

# proves B1 fix is in source
$ grep -nE "openAgentPane|placeAgent|assignAgent" components/Workbench.tsx
18: import { …, assignAgent, …, placeAgent, … } from '@/lib/layout'
304: function openAgentPane(workspaceId, agentId) {
313:   const placed = placeAgent(rootForWs, agentId, activeLeafId ?? undefined)
483: …assignAgent (used elsewhere — drag/drop, intentional)
574: …assignAgent (PaneGrid onAssignAgent — intentional)
606: <AssistantPanel … onOpenAgent={openAgentPane} />
# openAgentPane no longer touches assignAgent. Confirmed.

# proves B2 fix is in source
$ grep -nE "cockpitPaneStates|paneStates|paneStateTone" components/PaneGrid.tsx
9:   import { cockpitPaneStates, type CockpitPaneStateKind } from '@/lib/cockpit-ui-state'
109: const paneStates = cockpitPaneStates(cockpitWorkspace, agent?.id)
167: …paneStateTone(state.kind)…
229: function paneStateTone(kind: CockpitPaneStateKind): string {

# tests
$ node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts
ℹ tests 46  ℹ pass 45  ℹ fail 0  ℹ skipped 1
```

## Reconciling the two prior reports

| Claim | Claude 01:31 said | Codex 01:32 said | Source truth (this report) |
| --- | --- | --- | --- |
| B1 fixed | NO — still `assignAgent` on leaf 0 | YES — already in tree before this lane | YES — code matches the canonical fix |
| B2 fixed | NO — `grep ackn\|staleRunning` empty | YES — pills added with helper | YES — pills render via cockpitPaneStates |
| B3 trustworthy | NO — false-positive vector when app on 3747 | NO — sandbox EPERM blocks bind | NO — both observations are correct, no fix in source |
| Tests | 43 pass / 1 skip | 45 pass / 1 skip | 45 pass / 1 skip (Codex added the placement suite) |

The Claude FAIL was correct **for the byte state at 01:30**. By 01:31,
Codex had written the fix. The two reports do not contradict on the
underlying code; they contradict on what the code looked like when
each was opened. Source truth is the post-Codex tree.

## Exact remaining MVP blockers

**None.** Both intra-workspace visibility gates (B1, B2) are closed in
source. Tests cover the new helpers. Cockpit data flows end-to-end:
endpoint → 5s poll → workspace lookup → PaneGrid pills.

A real-browser five-step manual walkthrough (matrix table render,
drawer scroll, optimistic-ack flicker, non-evicting open-pane,
ack'd/stale pills) is still owed before declaring "ship-ready" — but
that is acceptance-walk-through scope, not a code blocker.

## Productization follow-ups (not MVP-gating)

1. **Browser-smoke harness hardening (B3).** Add pre-flight
   `lsof -nP -iTCP:${port}` and fail with "foreign listener on
   ${port}, refuse to probe" before spawn. Or pin the child to a
   random ephemeral port via `AW_NEXT_PORT` and have the probe target
   that port. ~10 lines in `scripts/browser-smoke.mjs`. Without this,
   any green output from a developer machine that has the app open is
   noise.

2. **Cockpit-poll back-off / SSE.** 5s polling of `/api/assistant?scope=cockpit`
   is fine for one user but should converge to event-stream once the
   cockpit endpoint stabilises.

3. **Pane pill snapshot test.** A render-style test on `PaneGrid` with
   a mocked workspace would cement the B2 contract. Today coverage is
   helper-only (the new `cockpitPaneStates` suite).

4. **`AssistantPanel` and the rest of P1-P5 from
   `WORKBENCH_PRODUCTIZATION_QA_CLAUDE_20260509.md`** — separately
   tracked, not MVP.

## Verdict (one line)

**MVP visibility = PASS in source as of 2026-05-09 01:31 CT.** B1 and
B2 are landed; tests green; only the browser-smoke harness false-
positive remains, and that is a productization gate not an MVP gate.
The 01:31 Claude FAIL verdict was a sequencing miss; this report
supersedes it.
