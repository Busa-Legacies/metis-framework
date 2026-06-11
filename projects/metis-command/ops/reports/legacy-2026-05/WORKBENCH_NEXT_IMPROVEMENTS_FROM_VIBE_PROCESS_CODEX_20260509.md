# Workbench Next Improvements From Vibe Process - Codex - 2026-05-09 CT

## Scope

Read-only product improvement audit for Agent Workbench as Jarvis-controlled multi-agent build cockpit.

Constraints honored:

- Worked only in `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`.
- No push, deploy, install, delete, or source modification.
- Wrote exactly this doc-only report.

## Sources Inspected

- Core runtime/control plane: `app/api/assistant/route.ts`, `server/pty-server.ts`, `lib/dispatch-runs.ts`, `lib/cockpit-summary.ts`, `lib/cockpit-ui-state.ts`, `lib/tool-routing.ts`, `lib/action-ledger.ts`, `lib/types.ts`.
- Tests: `tests/tool-routing.test.ts`, `tests/cockpit-continuity.test.ts`, `tests/workbench-layout.test.ts`.
- Recent reports: `WORKBENCH_NEXT_LANE_QA_CLAUDE_20260509.md`, `WORKBENCH_PRODUCT_WAVE_QA_CLAUDE_20260509.md`, `WORKBENCH_STALE_AGENT_WATCHDOG_CODEX_20260509.md`, `WORKBENCH_RUNTIME_SPAWN_QA_CODEX_20260509.md`, `WORKBENCH_CEO_FLOW_NEXT_GAPS_20260508.md`, plus related release-boundary and cockpit reports.

No test commands were run for this audit; evidence is from source and report inspection.

## Current Product Baseline

Workbench already has the right foundation:

- Durable dispatch runs exist in `lib/dispatch-runs.ts`, including action fingerprints, spawned agent ids, partial failures, workspace targeting, session status, and atomic same-directory JSON writes.
- Jarvis/assistant action replay hygiene exists in `lib/action-ledger.ts` for current-turn `aw_action` blocks and in dispatch-run duplicate suppression.
- Cockpit summary exists in `lib/cockpit-summary.ts`, with active/failed/partial runs, stale running agents, reports, acknowledgements, next actions, and workspace filtering.
- Stale-agent visibility now includes idle age, output bytes, last output time, and report-state detail.
- Runtime spawn hardening launches Codex initial prompts noninteractively through `codex exec --sandbox workspace-write <prompt>`, while leaving interactive Codex, resume, Claude, shell, and Python paths intact.
- PTY server exposes workspace git status, but GitHub/release-boundary status is not promoted into Jarvis's cockpit flow.
- Tasks exist in PTY state/UI, but Jarvis cannot create lane tasks, enforce evidence, or move a mission through a done/review gate via assistant tools.

The main product gap is not another cockpit widget. It is a missing mission-control contract: Jarvis can spawn and steer agents, but the system does not yet force every multi-agent build through one durable mission packet with lanes, budgets, evidence, checkpoint obligations, GitHub sync state, and final approval gates.

## Top 10 Prioritized Improvements

| Priority | Improvement | Why It Matters | Suggested Lane | Acceptance Criteria |
| --- | --- | --- | --- | --- |
| 1 | Mission Packet Builder | Jarvis needs one structured contract before fanout: goal, target workspace, hard constraints, lanes, expected files, acceptance tests, report names, budget, and review owner. Today `spawn_agents` specs only carry kind/name/cwd/cmd/args, so critical constraints live in chat text. | Forge P0 with Shield review | Add `MissionPacket` and `MissionLane` types. `spawn_agents` accepts optional `mission_packet` or `mission_id` and persists it into dispatch runs. Assistant/Jarvis prompt includes the current mission packet summary. Each spawned agent receives a lane-specific initial prompt with scope, evidence path, budget, and stop conditions. Tests assert mission packet persistence, lane-to-agent mapping, and stable serialization. |
| 2 | First-Class Evidence Ledger | Reports and dispatch actions are separate. Jarvis cannot reliably say which lane produced what proof, which tests passed, and which artifacts remain unread. | Forge P0 with Shield review | Add `data/evidence-ledger/<workspace>.json` or extend dispatch runs with `evidence[]` entries: `laneId`, `agentId`, `artifactPath`, `testCommand`, `exitStatus`, `summary`, `recordedAt`, `verifiedBy`. Cockpit summary surfaces evidence counts and missing-evidence lanes. A task/run cannot be marked complete without at least one evidence row or explicit override. Tests cover report detection linking to lanes and evidence persistence across agent clear. |
| 3 | Checkpoint Scheduler | AGENTS operating law requires working-context rewrites during deep work, but Workbench does not track checkpoint obligations or remind agents. | Forge P1 with Shield review | Add per-lane checkpoint policy in mission packet: interval by tool count/time/output bytes. Track `lastCheckpointAt`, `checkpointCount`, and `checkpointDue` from agent output/time. Cockpit next actions includes `checkpoint_due`. Jarvis can send a checkpoint prompt to one lane. Acceptance: a stale-but-outputting lane with no checkpoint becomes `checkpoint_due`; an evidence/checkpoint artifact clears it. |
| 4 | Budget and 5h Limit Visibility | Jarvis needs to see budget burn, soft deadlines, hard deadlines, and five-hour work-window risk before spawning or continuing agents. Today hop caps exist for assistant loops, but mission time budget is not visible. | Forge P1 with Echo copy review | Add mission-level `budget` fields: `startedAt`, `softLimitMinutes`, `hardLimitMinutes`, `fiveHourDeadlineAt`, `costBudget`, `timeRemaining`. Show budget chips in dispatch strip/cockpit matrix. Add warning next actions at 50/80/100 percent. Acceptance: synthetic mission with 5h limit shows remaining time, crossing soft limit creates `budget_warning`, crossing hard limit blocks auto-spawn without explicit override. |
| 5 | Stale-Agent Watchdog Actions | Current stale watchdog is indicator-only. It identifies idle agents but does not guide a safe escalation ladder. | Forge P1 | Add explicit watchdog state: `idle`, `checkpoint_due`, `needs_wake`, `needs_read`, `needs_stop_decision`. Provide manual cockpit actions: read output, send newline/status prompt, request checkpoint, mark blocked, or stop. No auto-kill. Acceptance: stale details display idle age/output/report state plus recommended manual action; tests assert no mutation occurs from read-only summary and wake prompt text is scoped to the agent/lane. |
| 6 | GitHub Sync and Release Boundary Status | PTY exposes local git status, but Jarvis lacks release truth: repo present, branch, upstream, ahead/behind, dirty files, ignored project status, PR/remote status, and whether this workspace can be pushed. | Forge P1, Scout for GitHub contract | Extend workspace git endpoint or add `sync-status` summary: `inRepo`, `releaseBoundary`, `branch`, `upstream`, `ahead`, `behind`, `dirty`, `untracked`, `remoteUrl`, `githubReachable`, `pushAllowed`, `lastSyncCheckAt`. Cockpit shows GitHub sync state per workspace and warns when Workbench is outside a repo or parent git ignores it. Acceptance: non-repo Workbench state is explicitly shown, dirty/ahead/behind states are tested with mocked git output, and no push action exists without user approval. |
| 7 | Claude/Codex Lane Selection Advisor | Jarvis currently relies on prompt judgment to pick Claude vs Codex. The product should encode lane choice heuristics so dispatch is consistent and auditable. | Scout spec, Forge P1 implementation | Add `recommend_lane_kind(task)` helper or pure module using criteria: code edit vs review, file scope, frontend/UI, source inspection, test writing, long-running implementation, OpenClaw/OpenAI docs, sandbox limits. Mission packet builder uses advisor and records `selectedKind` plus `selectionReason`. Acceptance: tests cover canonical examples: multi-file implementation -> Codex/Forge, UI review -> Claude/Shield, read-only architecture -> Scout/Claude, source patch with tests -> Codex. UI lets Jarvis override with reason. |
| 8 | Safe Noninteractive Launch Preflight | Codex initial prompts now use `codex exec`, but command construction is embedded in `server/pty-server.ts` and not directly unit-tested. Safe launch should validate PATH, auth, cwd, prompt delivery, and dangerous args before spawning. | Forge P1 with Shield runtime review | Extract command planning into a pure `agent-launch-plan` module. It returns cmd/args/env/cwd and `preflightWarnings`. Test Codex prompt -> `codex exec --sandbox workspace-write`, Codex no prompt -> interactive, resume -> `codex resume --last`, Claude prompt -> `--append-system-prompt`, custom cmd handling, PATH hardening. Add UI/cockpit launch error if CLI missing or cwd invalid. |
| 9 | Task/Done Gate Tools | Tasks exist but Jarvis cannot create/update lanes as first-class governed work. Done remains text-based rather than evidence-gated. | Forge P2 with Shield QA | Add assistant tools: `create_task`, `assign_task_agent`, `update_task_status`, `attach_task_evidence`, `request_task_review`, `approve_task`, `block_task`. Enforce transition rules: `done` requires evidence and reviewer approval unless explicit override. Acceptance: Jarvis can spawn 3 lanes and create 3 linked tasks in one dispatch; API rejects `done` without evidence/review; cockpit next actions show review-ready and blocked tasks. |
| 10 | Mission Resume and Recovery | Dispatch runs survive restart, but there is no one-click mission recovery that reconstructs lanes, panes, reports, pending checkpoints, and next unblocked action after app restart or sandbox failure. | Forge P2 | Add `get_mission_status` and `resume_mission` read/action path. Resume view groups by mission -> lanes -> agents -> evidence -> blockers. It never replays old actions automatically; it proposes safe next actions. Acceptance: after simulated restart with persisted dispatch/evidence/cockpit data, mission status reconstructs lane state and duplicate action suppression prevents accidental respawn. |

## Recommended Implementation Sequence

1. P0 control contract: mission packet builder plus evidence ledger. This turns fanout from "spawn agents with prompt text" into a durable build object Jarvis can supervise.
2. P1 operating safety: checkpoint scheduler, budget/5h visibility, stale watchdog actions, and safe launch preflight.
3. P1 external truth: GitHub sync/release-boundary status, still read-only and explicit about push prohibition.
4. P1/P2 routing quality: Claude/Codex lane advisor, then task/done gate tools.
5. P2 recovery: mission resume dashboard and safe next-action generator.

## Implementation Lanes

- Forge: code changes in `lib/`, `app/api/assistant/route.ts`, `server/pty-server.ts`, and focused UI wiring.
- Shield: route/tool validation, persistence invariants, no-auto-mutation checks, stale/recovery tests, launch-plan tests.
- Scout: lane selection heuristic spec and GitHub sync contract.
- Echo: user-facing copy for mission packet, budget warnings, safe overrides, and report naming conventions.

## Product Principles For These Changes

- Cockpit recommends; Jarvis approves; agents execute.
- No automatic kill, push, deploy, purchase, or external send.
- Every multi-agent build starts with a mission packet and ends with evidence.
- Every lane has one owner, one scope, one budget, one report path, and one review state.
- Stale, over-budget, dirty-git, missing-evidence, and no-checkpoint states must be visible before Jarvis says done.

## Final Verdict

Workbench has moved past basic multi-pane orchestration. The next product step is mission-grade supervision: mission packet, evidence ledger, checkpoint/budget watchdogs, GitHub sync truth, explicit Claude/Codex lane selection, and tested safe launch. Implement those before adding more broad cockpit surface area.
