# Workbench UX Control Polish - 2026-05-08

## Scope

Closed the two smallest post-QA UX gaps from `WORKBENCH_CLAUDE_CONTROL_PLANE_QA_20260508.md` where safe:

1. Pane header X vs agent tab X mismatch for exited agents, without adding a destructive running-agent behavior.
2. Resume-banner copy hint explaining clear exited vs dismiss/forget.

No GitHub push or deploy was performed.

## Changes

### Pane header close behavior

Files:
- `components/Workbench.tsx`
- `components/PaneGrid.tsx`

Behavior:
- Closing a pane assigned to an already-exited agent now also calls the existing `kill()` cleanup path for that exited agent.
- This removes the pane and clears the matching exited tab/runtime tombstone through the same server path already covered by lifecycle tests.
- Closing a pane assigned to a running agent still only closes the pane. It does not kill or signal the process.

UX copy:
- Exited-agent pane X title: `clear exited agent and close pane`
- Running-agent pane X title: `close pane; agent keeps running in tabs`
- Empty/browser pane X title remains `close pane`

Rationale:
- Clearing an exited runtime via the existing `DELETE /agents/:id` path is safe after the prior server fix.
- Killing a running agent implicitly from a pane close would be destructive and surprising, so this pass documents the running-agent behavior in the control hint instead of changing it.

### Resume banner hint

File:
- `components/Workbench.tsx`

Copy now says:
- `Pick up where you left off? N agent(s) from the last session in this workspace.`
- `Clear exited removes dead tabs; dismiss forgets this resume list.`

Rationale:
- `clearExitedAgents()` intentionally does not touch `state.resume`.
- The banner now makes that contract visible: clearing dead tabs is display cleanup; dismissing the banner forgets the resume specs.

## Verification

- `npm run typecheck` - pass.
- `node --import tsx --test tests/tool-routing.test.ts` - pass, 14 / 14.
- `node --import tsx --test tests/pty-server-lifecycle.test.ts` - blocked before application code by sandbox socket permissions:
  - `listen EPERM: operation not permitted 127.0.0.1`
  - All 5 tests fail at test server bind setup for the same reason.
- `npm run lint` - blocked by existing lint debt and packaged `dist-app` output being linted:
  - 36,209 reported problems before truncation.
  - Includes duplicated errors under `dist-app/mac-arm64/...`.
- Targeted UI-safe check: `npx eslint components/PaneGrid.tsx components/Workbench.tsx`
  - Still blocked by pre-existing issues in the touched files, including React hook purity/set-state-in-effect findings and unused imports.
  - The new resume-copy apostrophe lint issue was fixed; remaining targeted errors are not introduced by this patch.

## Remaining Blockers

- PTY lifecycle tests need an environment that allows binding `127.0.0.1`.
- Repository lint needs a separate cleanup/config pass, especially excluding packaged `dist-app` artifacts.
- Running-agent pane close still leaves the agent running in the tab strip by design. A future UX pass could add a non-destructive toast/action affordance such as "show in pane" / "kill", but implicit kill from pane close was not safe for this tiny polish lane.

## Merge Readiness Verdict

Ready to merge from this lane once the PTY lifecycle suite is rerun in a socket-capable environment.

The code change is tiny, typed, uses existing cleanup APIs, and avoids killing running agents. Typecheck and routing tests are green. The remaining verification blockers are environmental or pre-existing lint debt, not new functional failures from this patch.
