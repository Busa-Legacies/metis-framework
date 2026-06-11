# Workbench ADE Adapter V1 Implementation Plan

Date: 2026-05-20
Repo: `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`
Lane: Workbench-side ADE lane request adapter, planning only

## Objective

Implement the first actual Workbench-side adapter for ADE `WorkbenchLaneSpawnRequest` envelopes. The change must be additive, preserve the existing internal Swarm Ops mode, require preview/approval before spawning ADE-originated lanes, support `dryRun`, and map ADE role, privacy, model, route preview, and artifact metadata onto existing Workbench primitives.

Input contract:

- Source: `/Users/jarvis/.openclaw/workspace/Projects/ade-os/docs/agent-workbench-integration-contract.md`
- Schema version: `2026-05-19.workbench-lane-spawn.v1`
- ADE producer: `toWorkbenchLaneSpawnRequests(route, execution, options)`

Relevant Workbench entry points inspected:

- `server/pty-server.ts`
- `lib/pty-client.ts`
- `lib/types.ts`
- `components/Workbench.tsx`

## Current Workbench Primitives

`server/pty-server.ts` already has the runtime choke point needed for this adapter:

- `spawnAgent(input)` validates workspace existence, validates cwd via `validateWorkspaceCwd(...)`, applies default commands, injects knowledge/skills/MCP context, persists resume specs, and starts the PTY.
- `POST /agents` calls `spawnAgent(...)` directly and should remain the internal Swarm Ops route.
- `POST /workspaces/:wsId/tasks/:taskId/build` maps tasks to Codex builder lanes.
- `POST /workspaces/:wsId/tasks/:taskId/review` maps tasks to Claude reviewer lanes.
- Evidence exists through `appendEvidence(...)`, `listEvidence(...)`, and task evidence routes, but existing `EvidenceKind` does not yet include ADE approval events.

`lib/pty-client.ts` exposes the browser boundary:

- `ptyApi.spawnAgent(...)` calls raw `POST /agents`.
- New ADE wrappers should live here so ADE UI code never calls raw `/agents`.

`lib/types.ts` currently exposes:

- `AgentKind = 'claude' | 'codex' | 'shell' | 'gemini' | 'python' | 'custom'`
- `AgentRole = 'builder' | 'reviewer' | 'scout' | 'coordinator'`
- `Agent` with `role?: AgentRole` and `taskId?: string`
- `EvidenceKind` without `lane_approval`

`components/Workbench.tsx` currently hosts internal Swarm Ops:

- `spawn(kind, name, cmd, args, role, initialPrompt)` calls `ptyApi.spawnAgent(...)`.
- `SpawnMenu` is operator-first and should not be modified for ADE.
- The header copy and tabs remain internal Swarm Ops.

## Required Additive Design

Add an ADE adapter module and API route that translates ADE envelopes into Workbench spawn inputs only after approval.

Do not replace these existing flows:

- `POST /agents`
- `ptyApi.spawnAgent(...)`
- `Workbench.spawn(...)`
- `SpawnMenu`
- task build/review routes
- operator AssistantPanel and right rail

The adapter should introduce a separate ADE path:

- Preview/dry run: validate and return a product-safe preview; never spawn.
- Approval-required request: validate and return preview plus `requiresApproval`; never spawn.
- Approved request: validate, record approval metadata, then call `spawnAgent(...)`.

## Files To Add

### `lib/ade-lane-adapter.ts`

Create this as the pure translation and validation module. Keep it independent of React and node-pty.

Exports:

```ts
export const WORKBENCH_LANE_SPAWN_SCHEMA_VERSION = '2026-05-19.workbench-lane-spawn.v1' as const

export function validateWorkbenchLaneSpawnEnvelope(input: unknown): WorkbenchLaneSpawnEnvelope

export function previewWorkbenchLaneSpawnRequest(
  envelope: WorkbenchLaneSpawnEnvelope,
  context: WorkbenchLaneAdapterContext,
): WorkbenchLaneSpawnPreview

export function toWorkbenchAgentSpawnInput(
  preview: WorkbenchLaneSpawnPreview,
  options: { approved: boolean },
): WorkbenchAgentSpawnInput
```

Types should either be exported here and re-exported from `lib/types.ts`, or defined in `lib/types.ts` and imported here. Prefer defining shared API types in `lib/types.ts` so client and server agree.

Validation rules:

- Require `schemaVersion === '2026-05-19.workbench-lane-spawn.v1'`.
- Require `request.workspaceId`, `projectId`, `runId`, `routeId`, `routeNodeId`, `mockExecutionStepId`.
- Require `request.prompt` to be a non-empty string.
- Require `request.role` to be one of `planner`, `builder`, `reviewer`, `synthesizer`, `local_worker`.
- Require `privacyBoundary` to be one of `public`, `internal`, `private`, `local_only` if the ADE payload uses these current classes.
- Require `artifactHints` to be an array of strings and cap stored/rendered hints to a small bounded list, for example 20 names.
- Preserve unknown fields only inside a bounded `rawRequest` or not at all; do not pass raw ADE output into agent prompts.

Mapping rules:

- `request.workspaceId` -> `spawnAgent.workspaceId`.
- `request.customerLabel` -> `spawnAgent.name`, fallback to mapped role label.
- `request.prompt` -> `spawnAgent.initialPrompt`.
- ADE `builder` -> Workbench `kind: 'codex'`, `role: 'builder'`.
- ADE `reviewer` -> Workbench `kind: 'claude'`, `role: 'reviewer'`.
- ADE `planner` -> Workbench `kind: 'claude'`, `role: 'coordinator'`.
- ADE `synthesizer` -> Workbench `kind: 'claude'`, `role: 'coordinator'`.
- ADE `local_worker` -> Workbench `kind: 'codex'`, `role: 'builder'` unless model metadata explicitly maps to another supported backend.
- `model.provider/modelId/displayName/hosting/quotaBucket` -> product lane metadata, not `cmd`/`args`.
- `routePreview` -> preview response and persisted lane metadata.
- `approvalGate` -> preview response and approval enforcement.
- `privacyBoundary` -> preview response and metadata; use it to constrain `addDirs`.
- `artifactHints` -> metadata and optional evidence payload.

Privacy/add-dir rules:

- For `public` and `internal`, allow normal workspace behavior unless future policy says otherwise.
- For `private` and `local_only`, set `addDirs` to `[workspace.cwd]` plus explicitly allowed pinned roots only if ADE request metadata names them. Do not use `defaultAddDirs(...)` broad home/OpenClaw/Claude/Codex roots for ADE private/local lanes.
- Because `spawnAgent(...)` currently defaults broad addDirs when `addDirs` is undefined, the adapter must pass an explicit bounded `addDirs` array for ADE lanes.

Approval rules:

- If `dryRun === true`, never spawn.
- If `request.approvalGate.required === true`, never spawn unless the API call includes explicit approval.
- If approval reasons include `high_cost`, `local_private_data`, `external_action`, or `secret_access`, return them exactly in the preview.
- If approved, persist an approval record before spawn.

### `tests/ade-lane-adapter.test.ts`

Pure unit tests for mapping and validation:

- rejects unsupported schema version
- rejects missing workspace/project/run/route identifiers
- maps `planner` to Claude coordinator preview
- maps `builder` to Codex builder preview
- maps `reviewer` to Claude reviewer preview
- maps `synthesizer` to Claude coordinator preview
- maps `local_worker` to Codex builder preview
- `dryRun` preview never produces a spawn action
- approval-required request returns `requiresApproval: true`
- approved request produces a bounded `WorkbenchAgentSpawnInput`
- private/local privacy uses bounded `addDirs`, not broad default knowledge roots
- artifact hints are capped and preserved in metadata
- model metadata is preserved in metadata and not translated to raw command args

## Files To Modify

### `lib/types.ts`

Add shared ADE/product lane types without changing existing internal types:

```ts
export type AdeLaneRole = 'planner' | 'builder' | 'reviewer' | 'synthesizer' | 'local_worker'
export type AdePrivacyBoundary = 'public' | 'internal' | 'private' | 'local_only'

export interface WorkbenchLaneSpawnRequestEnvelope {
  schemaVersion: '2026-05-19.workbench-lane-spawn.v1'
  request: WorkbenchLaneSpawnRequest
  dryRun?: boolean
  approval?: WorkbenchLaneApprovalInput
}

export interface WorkbenchLaneSpawnRequest {
  workspaceId: string
  projectId: string
  runId: string
  routeId: string
  routeNodeId: string
  mockExecutionStepId: string
  role: AdeLaneRole
  customerLabel: string
  customerSummary?: string
  model?: WorkbenchLaneModelMetadata
  routePreview?: WorkbenchRoutePreviewMetadata
  approvalGate?: WorkbenchApprovalGateMetadata
  privacyBoundary: AdePrivacyBoundary
  artifactHints?: string[]
  prompt: string
}

export interface ProductLaneMetadata {
  source: 'ade'
  schemaVersion: '2026-05-19.workbench-lane-spawn.v1'
  projectId: string
  runId: string
  routeId: string
  routeNodeId: string
  mockExecutionStepId: string
  adeRole: AdeLaneRole
  privacyBoundary: AdePrivacyBoundary
  model?: WorkbenchLaneModelMetadata
  routePreview?: WorkbenchRoutePreviewMetadata
  artifactHints: string[]
  approval?: WorkbenchLaneApprovalRecord
}
```

Extend `Agent` additively:

```ts
productLane?: ProductLaneMetadata
```

Do not expand `AgentRole` for ADE roles. Keep ADE role as `productLane.adeRole` and map to the closest existing internal `AgentRole`.

Extend `EvidenceKind` additively:

```ts
| 'lane_approval'
| 'lane_preview'
```

### `server/pty-server.ts`

Add imports:

```ts
import {
  previewWorkbenchLaneSpawnRequest,
  toWorkbenchAgentSpawnInput,
  validateWorkbenchLaneSpawnEnvelope,
} from '../lib/ade-lane-adapter.ts'
```

Extend local server interfaces to match shared metadata:

- `AgentMeta` add `productLane?: ProductLaneMetadata`
- `ResumeSpec` add `productLane?: ProductLaneMetadata`
- `PersistedAgentOutput.meta` remains compatible through `AgentMeta`

Extend `spawnAgent(input)`:

- Add optional `productLane?: ProductLaneMetadata`
- Add optional explicit `addDirs?: string[]` already exists and should be used by adapter
- Copy `input.productLane` onto `meta.productLane`
- Copy `productLane` into `ResumeSpec`
- Preserve existing behavior when `productLane` is absent

Add route before raw `/agents/:id` handlers:

```ts
// POST /ade/lane-requests
```

Route behavior:

1. Read JSON envelope.
2. Validate schema and request.
3. Confirm `workspaceId` exists in `state.workspaces`.
4. Build preview with context:
   - matching workspace
   - pinned roots for that workspace
   - current timestamp
5. If `envelope.dryRun === true`, return `200 { preview, dryRun: true, spawned: false }`.
6. If preview requires approval and `envelope.approval?.approved !== true`, return `202 { preview, requiresApproval: true, spawned: false }`.
7. If approved, append evidence:
   - `kind: 'lane_approval'`
   - `workspaceId`
   - `missionId: request.runId`
   - `laneId: request.routeNodeId`
   - summary like `Approved ADE lane: ${customerLabel}`
   - payload includes approval reasons, role, privacy, model, route ids, artifact hints
8. Call `spawnAgent(toWorkbenchAgentSpawnInput(preview, { approved: true }))`.
9. Return `201 { preview, agent, spawned: true }`.

Status codes:

- `400` invalid envelope/schema/request
- `404` unknown workspace
- `202` valid but waiting for approval
- `200` dry run/preview only
- `201` approved and spawned
- `500` only for actual spawn failure

Important: keep `POST /agents` unchanged so internal Swarm Ops can still spawn directly.

### `lib/pty-client.ts`

Update imports to include ADE types.

Add wrappers:

```ts
previewLaneRequest: (input: WorkbenchLaneSpawnRequestEnvelope) =>
  fetch(`${PTY_BASE}/ade/lane-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, dryRun: true }),
  }).then(j<WorkbenchLaneSpawnResponse>),

spawnLaneRequest: (input: WorkbenchLaneSpawnRequestEnvelope) =>
  fetch(`${PTY_BASE}/ade/lane-requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then(j<WorkbenchLaneSpawnResponse>),
```

Do not alter `spawnAgent(...)`.

### `components/Workbench.tsx`

V1 can avoid a visible ADE shell change. If a minimal UI hook is required by the builder lane, add it behind an explicit mode flag and keep Swarm Ops default:

```ts
const workbenchMode = process.env.NEXT_PUBLIC_WORKBENCH_MODE === 'ade' ? 'ade' : 'internal'
```

Allowed additive UI for V1:

- Add an `AdeLaneRequestPanel` only when `workbenchMode === 'ade'`.
- The panel calls `ptyApi.previewLaneRequest(...)` first.
- It shows route label, summary, privacy, model display name, quota impact, warnings, approval reasons, and artifact hints.
- It enables spawn only after explicit approval.

Do not change:

- Header label `Swarm Ops` in internal mode
- `SpawnMenu`
- internal `spawn(...)`
- assistant/operator tabs

Preferred V1 approach: implement server/client adapter and tests first, defer UI shell until ADE can deliver real envelopes into Workbench.

## Tests To Add Or Extend

### `tests/ade-lane-adapter.test.ts`

Add pure unit tests listed above.

### `tests/pty-server-lifecycle.test.ts`

Append integration tests using the existing `startPtyServer(...)`, `api(...)`, and temp `AW_DATA_DIR` helpers:

1. `ADE lane request dryRun returns preview and does not spawn`
   - POST `/ade/lane-requests` with `dryRun: true`
   - assert status `200`
   - assert `spawned === false`
   - assert `/agents?include=exited` remains empty for the workspace

2. `ADE lane request requiring approval does not spawn without approval`
   - request includes `approvalGate.required: true`
   - assert status `202`
   - assert `requiresApproval === true`
   - assert no agent spawned

3. `ADE approved lane request spawns mapped Workbench agent`
   - use custom-safe mapping if the test must avoid invoking real Codex/Claude, or set env `AW_CODEX_CMD=/bin/sh` with args strategy in the adapter test harness
   - assert response `201`
   - assert agent name uses `customerLabel`
   - assert `agent.productLane.source === 'ade'`
   - assert `agent.productLane.routeNodeId` and `runId` are preserved

4. `ADE private lane passes bounded addDirs`
   - use a request with `privacyBoundary: 'private'`
   - assert the spawned command args or metadata do not include broad `~/.openclaw`, `~/.claude`, `~/.codex` injected add-dir roots for Claude
   - if this is hard to assert through runtime output, cover it in `tests/ade-lane-adapter.test.ts` and add one server response metadata assertion

5. `ADE approval is recorded as evidence`
   - approved request
   - call `/workspaces/:wsId/tasks/:taskId/evidence` only if a task is created, or add a workspace-level evidence list endpoint in a later lane
   - For V1, prefer verifying through `appendEvidence(...)` unit coverage unless server lacks workspace-level evidence retrieval.

### Commands For Builder Lane Verification

Run:

```bash
npm run test:pty
npm test
npm run typecheck
```

If UI changes are added:

```bash
npm run lint
npm run build
```

## Implementation Phases

### Phase 1: Types And Pure Adapter

Files:

- `lib/types.ts`
- `lib/ade-lane-adapter.ts`
- `tests/ade-lane-adapter.test.ts`

Done when:

- ADE envelope can be validated.
- Each ADE role maps to a Workbench `AgentKind` and existing internal `AgentRole`.
- Preview response contains privacy, route, approval, model, and artifact metadata.
- `dryRun` and approval-required cases are represented without spawning.

### Phase 2: Server Endpoint

Files:

- `server/pty-server.ts`
- `tests/pty-server-lifecycle.test.ts`

Done when:

- `POST /ade/lane-requests` supports dry run, approval-required preview, and approved spawn.
- `POST /agents` remains unchanged.
- `spawnAgent(...)` accepts and persists `productLane` metadata.
- ADE private/local lanes pass explicit bounded `addDirs`.

### Phase 3: Client API Wrapper

Files:

- `lib/pty-client.ts`

Done when:

- ADE callers have `ptyApi.previewLaneRequest(...)`.
- ADE callers have `ptyApi.spawnLaneRequest(...)`.
- Existing `ptyApi.spawnAgent(...)` remains unchanged.

### Phase 4: Optional ADE Mode UI Hook

Files:

- `components/Workbench.tsx`
- optional new `components/AdeLaneRequestPanel.tsx`

Done when:

- Internal Swarm Ops is default and visually unchanged.
- ADE mode is gated by `NEXT_PUBLIC_WORKBENCH_MODE=ade`.
- ADE mode requires preview before approval/spawn.

## Non-Goals For V1

- No branch creation.
- No replacement of Swarm Ops terminology in internal mode.
- No rewrite of `components/Workbench.tsx`.
- No removal or behavior change of `POST /agents`.
- No direct ADE access to raw `cmd`/`args`.
- No external actions, deploys, messages, or pushes.
- No broad customer shell redesign.
- No migration from `state.json` to a new persistence backend.

## Key Risks And Mitigations

- Role mismatch: ADE roles do not match `AgentRole`. Keep ADE role in `productLane.adeRole`; map to existing role only for agent behavior.
- Approval bypass: raw `/agents` remains for internal mode. ADE UI and ADE clients must call only `/ade/lane-requests`.
- Privacy overexposure: `spawnAgent(...)` defaults broad local roots. ADE adapter must pass explicit bounded `addDirs`, especially for `private` and `local_only`.
- Dirty repo risk: many useful files are already modified or untracked. Keep the builder lane scoped to the listed files and avoid broad UI changes.
- Evidence retrieval gap: approval can be appended, but workspace-level evidence retrieval may not exist. Do not expand evidence APIs in V1 unless needed by tests.

## Acceptance Criteria

- ADE lane envelopes can be previewed without spawning.
- `dryRun: true` never starts a PTY.
- Approval-required lanes never start a PTY without explicit approval.
- Approved lanes spawn through existing `spawnAgent(...)`.
- Spawned ADE lanes carry `productLane` metadata with role, privacy, model, artifact hints, route ids, project id, and run id.
- Existing internal Swarm Ops direct spawn still works.
- Tests cover adapter mapping, dry run, approval gating, metadata preservation, and privacy-bounded addDirs.
