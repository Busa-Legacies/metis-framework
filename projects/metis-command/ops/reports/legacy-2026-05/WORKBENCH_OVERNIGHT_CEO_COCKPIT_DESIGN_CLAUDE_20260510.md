# Workbench Overnight CEO/PMA Cockpit Design - Claude - 2026-05-10 CT

Started: 2026-05-10 03:51 CDT.
Branch: slice/summarize-portfolio-tool
Lane: OVN-WORKBENCH-ceo-cockpit-design (parallel with OVN-WORKBENCH-agent-state).

## TL;DR

Shipped one additive, pure-function helper plus a focused unit-test suite. No
UI rewrite. No server change. No new endpoint. Workbench remains live.

- New: lib/ceo-cockpit-view.ts - buildCeoCockpitView + renderCeoWorkspaceLine
- New: tests/ceo-cockpit-view.test.ts - 7 tests, 7 pass
- Verified: npm typecheck OK; 115 pass / 1 skip / 0 fail across the
  non-PTY focused suite (ceo-cockpit-view + cockpit-continuity +
  cockpit-to-rollup + effort-level + evidence-ledger + portfolio-render +
  summarize-portfolio-tool + tool-routing + workbench-layout).

## Coordination

OVN-WORKBENCH-agent-state landed agentStates[] in cockpit-summary.ts (commit 70fcef5).
This lane consumes that spine without re-modifying it.

Boundaries observed:
- I do not modify lib/cockpit-summary.ts (their shipped surface).
- I do not touch server/pty-server.ts (already dirty with effort-level work).
- I do not modify any existing endpoint or React component.
- The new helper lives in a new file, importing only types.

Result: zero risk of conflict with the live Workbench app or with the next
Codex slice that wires agentStates[] into the drawer.

## What the CEO/PMA cockpit must show

Per the prompt and Nick’s overnight need, the cockpit must answer six
questions for every workspace at a glance:

1. **done** - agents that finished cleanly and were already reviewed/acked
2. **needs-approval** - agents that finished cleanly but await human review
3. **stuck** - agents blocked (exit non-zero), stale (no recent output), or unknown_exit
4. **branch / repo state** - branch name, dirty/ahead/behind, clean flag
5. **last output / freshness** - per-agent last-output timestamp + tail text + idle age
6. **next action** - the highest-severity recommended action for the workspace

Plus a passive evidence summary (test-evidence-count, unread report count) and
a placeholder budget surface for the future token/$ tracking lane.

## Bucket mapping

Derivable purely from the existing CockpitAgentState.state plus acknowledged:

| CockpitAgentState         | CEO bucket       | Notes                              |
|---------------------------|------------------|------------------------------------|
| done + acknowledged       | done             | reviewed/closed                    |
| done + NOT acknowledged   | needs_approval   | review-ready, must approve/ack     |
| blocked                   | stuck            | exit non-zero, investigate         |
| stale                     | stuck            | running, no recent output, wake    |
| unknown_exit              | stuck            | no exit code recorded, ack/clear   |
| running (fresh)           | in_flight        | streaming output                    |
| starting                  | starting         | spawn race in progress              |

Stuck rows carry a stuckReason field so callers can show different button sets without re-reading the raw state.

## Public surface

lib/ceo-cockpit-view.ts exports two pure functions:

- buildCeoCockpitView({ summary, agents?, gitByWorkspace? }): CeoCockpitView
- renderCeoWorkspaceLine(ws): string  (Telegram-safe one-liner per workspace)

Inputs:
- summary: existing CockpitSummaryResponse from GET /api/assistant?scope=cockpit.
- agents: existing Agent[] from ptyApi.listAgents (used to pluck lastOutput tail text).
- gitByWorkspace: existing per-workspace git status snapshot (Workbench.tsx already polls every ~12s).

Output (CeoCockpitView):

- generatedAt + totals (workspaces, done, needsApproval, stuck, inFlight, starting, reportsUnread, retryableFailedSpecCount)
- workspaces[]: per-workspace CeoWorkspaceCockpit with branch, budget, tests, the 5 bucket arrays, reportsUnread, retryableFailedSpecCount, lastShippedAt, nextAction.

Each CeoAgentRow carries: agentId, name, kind, bucket, state, acknowledged, hasReport, stuckReason, idleMs, outputBytes, exitCode, lastOutput, lastOutputAt.

## UI integration sketch (next slice, not this one)

In components/AssistantPanel.tsx the existing CockpitNextActionsDrawer
renders one row per workspace from getCockpitWorkspaceMatrix.

A future slice can add a CEO drawer (or extend the matrix row) to render:

Workspace card (one per workspace, sorted by attentionCount desc):

    Workbench   branch slice/x, 2 dirty   tests: 3 ev   budget: -
    done 1   needs-approval 2   stuck 1   in-flight 3
    next: ag_blocked (codex) exited with code 2     [investigate]

Within each card, four collapsible groups: needs-approval, stuck, in-flight,
done. Each row shows agent name + kind + idle age + tail of last output
(truncated 80 chars) + per-row action button.

Per-row buttons map directly to existing endpoints:
- needs_approval: "acknowledge" -> POST /api/assistant?scope=acknowledge_agent (already wired)
- stuck (stale): "send newline" -> ptyApi.sendInput(agentId, "\\r") (already wired)
- stuck (blocked / unknown_exit): "open pane" -> existing onOpenAgent
- in_flight: "open pane" only (no mutation)
- done: no buttons (already closed)

## Sourcing each field

- done / needs_approval / stuck / in_flight / starting: from summary.workspaces[].readiness.agentStates[] (Codex lane).
- branch: from existing per-workspace ptyApi.gitStatus polled by Workbench.tsx (Workbench passes its gitByWs map into the helper).
- last output: agent.lastOutput (last 200 chars, ANSI-stripped, already maintained by pty-server) plus state.lastOutputAt + state.idleMs.
- next action: summary.nextActions (already sorted severity-desc), filtered to this workspace, take first.
- tests: workspace.evidence.byKind.test (count of recorded test-evidence rows).
- budget: { kind: unknown } placeholder. No token/$ tracking exists yet; flagged in followups.
- lastShippedAt: most recent succeeded run.updatedAt across workspace.recentRuns.

## Tests

tests/ceo-cockpit-view.test.ts (7 cases, all PASS):

1. buckets agent states into done / needs-approval / stuck / in-flight / starting
2. totals aggregate across workspaces
3. attaches branch snapshot from gitByWorkspace and falls back to no-repo
4. picks the highest-severity next action per workspace
5. attaches lastOutput from agents map onto in-flight rows
