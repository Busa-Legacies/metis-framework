# Workbench Mission/Lane Contract Foundation
Date: 2026-05-11
Owner: Worker 1

## Scope
Implemented the pure TypeScript foundation for BridgeMind-style mission packets and lane selection.

Owned files changed:
- `lib/mission-packet.ts`
- `lib/lane-advisor.ts`
- `tests/mission-packet.test.ts`
- `tests/lane-advisor.test.ts`
- `WORKBENCH_MISSION_LANE_CONTRACT_20260511.md`

No edits were made to `server/pty-server.ts`, `components/*`, or existing shared files.

## Contract Added
- `MissionPacket` captures mission id, workspace, title, goal, lanes, constraints, deliverables, acceptance criteria, budget, and review gate.
- `MissionLane` captures lane id, target `AgentKind`, owner `AgentRole`, scope, evidence path or explicit rationale, selection reason, budget, and stop conditions.
- Stable id helpers:
  - `deriveMissionId`
  - `deriveMissionLaneId`
- JSON-safe helpers:
  - `normalizeJsonSafe`
  - `normalizeMissionPacket`
  - `missionPacketToStableJson`
- Validation:
  - `validateMissionPacket`
  - `buildMissionPacket`

Validation requires every lane to have:
- scope
- valid owner role
- expected evidence path or explicit evidence rationale

## Lane Advisor Added
`recommendMissionLane` provides deterministic Claude/Codex/shell/gemini routing using existing `AgentKind` and `AgentRole` types.

Canonical mappings covered by tests:
- multi-file implementation with tests -> `codex` / `builder`
- UI review -> `claude` / `reviewer`
- read-only architecture/source inspection -> `claude` / `scout`
- terminal/log/script work -> `shell` / `scout`
- documentation lookup -> `gemini` / `scout`

Jarvis overrides are supported through `preferredKind` and `preferredRole`, with the override recorded in the recommendation reason.

## Integration Hooks Needed
Future workers can wire this foundation without changing the contract shape:

1. `spawn_agents` tool args can accept `mission_packet` or `mission_id`.
2. Dispatch run persistence can store the mission packet and map spawned agent ids to lane ids.
3. Assistant/Jarvis prompt context can include a compact mission summary plus lane-specific scope/evidence obligations.
4. Evidence ledger rows can attach to `missionId` and `laneId` already present in `lib/evidence-ledger.ts`.
5. UI can expose lane advisor recommendations with an override reason field before dispatch.
6. Task done/review gating can call `validateMissionPacket` and evidence checks before allowing mission completion.

## Tests
Focused tests added for mission packet normalization/validation/stable ids and lane advisor routing. Run command:

```bash
tsx --test tests/mission-packet.test.ts tests/lane-advisor.test.ts
```
