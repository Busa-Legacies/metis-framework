# Agent Workbench Capability Registry Plan

Date: 2026-05-20
Mode: planning only
Branch policy: main only; no branch, no push
Implementation wedge: read-only inventory for MCP, skills, and tool/provider capability cards

## Goal

Implement the first read-only capability registry wedge described in `/Users/jarvis/.openclaw/workspace/Projects/ade-os/docs/product/mcp-skills-tools-integration.md` without changing existing internal Workbench behavior.

The wedge should add a normalized inventory layer that scans skills, Workbench MCP state, and existing MCP config files, then returns safe capability cards for UI display. It must not enable, disable, import, write, spawn, mirror, install, authenticate, or mutate any capability.

## Existing Baseline

- `server/pty-server.ts`
  - `skillRootsForWorkspace(ws, pinnedRoots)` scans a limited set of skill roots.
  - `discoverSkills(ws, pinnedRoots, limit)` returns simple `SkillInfo` rows.
  - `skillsBrief(ws, pinnedRoots)` injects skill context into spawned agents.
  - `GET /workspaces/:id/skills` exposes current skill rows.
  - `GET /mcp/discover` reads Claude, OpenClaw, Claude Desktop, and Codex MCP config sources.
  - `GET|PUT /workspaces/:id/mcp-servers` owns mutable per-workspace MCP state.
  - `spawnAgent()` injects enabled Workbench MCP servers into Claude via generated `--mcp-config`.
- `lib/pty-client.ts`
  - Has client helpers for `listSkills`, `discoverMcp`, `getMcpServers`, and `putMcpServers`.
- `lib/types.ts`
  - Does not yet define capability registry types.
- `components/SkillsPanel.tsx`
  - Read-only skills list.
- `components/McpPanel.tsx`
  - Mutable MCP management UI with import/add/delete/toggle behavior.
- `components/Workbench.tsx`
  - Right rail tabs are `assistant`, `notes`, `knowledge`, `skills`, and `mcp`.
  - Product header and internal control-plane labels remain `Swarm Ops`.

## Wedge Scope

Build a pure registry scanner and read-only display surface.

In scope:

- Add normalized capability types.
- Add pure scanner functions with direct unit tests.
- Add a read-only PTY endpoint for one workspace.
- Add a client helper for that endpoint.
- Add a read-only capability panel/card UI.
- Add a right-rail `capabilities` tab, while keeping existing `skills` and `mcp` tabs available.
- Include skills and MCP servers/configs in one response.
- Redact secrets before returning any raw config to the browser.
- Preserve current `skillsBrief()`, `spawnAgent()`, `/workspaces/:id/skills`, `/mcp/discover`, and `/workspaces/:id/mcp-servers` behavior.

Out of scope for wedge 1:

- No route preview integration.
- No run trace integration.
- No enable/disable mutations in the new registry.
- No importing MCP configs into workspace state.
- No skill mirroring/conversion.
- No launching or probing MCP server processes.
- No external network checks.
- No provider billing/spend detection beyond static metadata inferred from config.

## Files and Functions

### New File: `lib/capability-registry.ts`

Add shared types and pure scanner helpers:

- `type CapabilitySource = 'global' | 'project' | 'agent' | 'workspace' | 'provider'`
- `type CapabilityKind = 'skill' | 'mcp_server' | 'mcp_tool' | 'provider' | 'local_model' | 'project_doc' | 'filesystem_root'`
- `type CapabilityStatus = 'available' | 'needs_auth' | 'broken' | 'disabled' | 'unknown'`
- `type CapabilityRisk = 'low' | 'medium' | 'high'`
- `interface CapabilityPermissions`
- `interface Capability`
- `interface CapabilityRegistry`
- `interface WorkspaceLike`
- `interface PersistedMcpServerLike`

Functions:

- `expandHomePath(input: string, homeDir: string): string`
- `shortHomePath(input: string, homeDir: string): string`
- `redactSecretValue(value: unknown): unknown`
- `redactConfig(input: unknown): unknown`
- `isSecretKey(key: string): boolean`
- `parseSkillMetadata(skillPath: string, root: string, ws: WorkspaceLike, homeDir: string): Capability | null`
- `skillScanRoots(ws: WorkspaceLike, pinnedRoots: string[], homeDir: string): string[]`
- `scanSkillCapabilities(ws: WorkspaceLike, pinnedRoots: string[], opts): Capability[]`
- `scanWorkbenchMcpCapabilities(workspaceId: string, servers: PersistedMcpServerLike[], homeDir: string): Capability[]`
- `scanExistingMcpConfigCapabilities(homeDir: string, workspaceCwd: string): Capability[]`
- `scanProjectInstructionCapabilities(ws: WorkspaceLike, pinnedRoots: string[], homeDir: string): Capability[]`
- `buildCapabilityRegistry(input): CapabilityRegistry`
- `dedupeCapabilities(capabilities: Capability[]): Capability[]`

Keep all scanner functions synchronous and deterministic so tests can use temp directories.

### Update: `server/pty-server.ts`

Add imports:

- `buildCapabilityRegistry`
- registry types as needed from `../lib/capability-registry.ts`

Add endpoint near the current skills/MCP routes:

- `GET /workspaces/:id/capabilities`

Endpoint behavior:

- Look up workspace by id.
- Read pinned roots from `state.pinnedRoots?.[id] ?? []`.
- Read workspace MCP servers from `state.mcpServers?.[id] ?? []`.
- Call `buildCapabilityRegistry({ workspace: ws, pinnedRoots, workspaceMcpServers, homeDir: os.homedir(), dataDir: DATA_DIR })`.
- Return `{ workspaceId, workspaceName, generatedAt, roots, capabilities, counts }`.
- Never call `saveState()`.
- Never reuse `/mcp/discover` response directly if it includes unredacted `env`; use scanner/redaction code instead.

Do not alter:

- `spawnAgent()`
- `defaultAddDirs()`
- `skillsBrief()`
- `/workspaces/:id/skills`
- `/mcp/discover`
- `/workspaces/:id/mcp-servers`

### Update: `lib/types.ts`

Export shared UI-facing types, either directly or by re-exporting from `lib/capability-registry.ts`:

- `CapabilitySource`
- `CapabilityKind`
- `CapabilityStatus`
- `CapabilityRisk`
- `CapabilityPermissions`
- `Capability`
- `CapabilityRegistry`

Keep these additive; do not change existing `Agent`, `Workspace`, `Task`, layout, or evidence types.

### Update: `lib/pty-client.ts`

Add:

- `getCapabilities(workspaceId: string) => fetch(`${PTY_BASE}/workspaces/${workspaceId}/capabilities`).then(j<CapabilityRegistry>)`

No existing client method should change.

### New File: `components/CapabilityPanel.tsx`

Create a read-only panel modeled after the density of `SkillsPanel.tsx`, not the mutable controls of `McpPanel.tsx`.

Props:

- `workspaceId: string | null`
- `workspaceName: string`

State:

- `registry`
- `query`
- `kindFilter`
- `sourceFilter`
- `loading`
- `error`

UI cards:

- Summary strip with counts by kind/status.
- Filter row with search and compact kind/source selectors.
- Section: `Connected MCP servers`
- Section: `Available tools`
- Section: `Skills by source`
- Section: `Project instructions`
- Section: `Local models/providers`
- Section: `Broken or needs auth`

Each card shows:

- Name.
- Safe summary.
- Kind and source.
- Short source path/config.
- Compatible agents.
- Status badge.
- Risk badge.
- Permission chips.
- Last verified/generated time.

Important UI constraint:

- No toggles, import buttons, edit fields, delete buttons, or auth buttons in wedge 1. This panel is inventory only.

### Update: `components/Workbench.tsx`

Add import:

- `CapabilityPanel from './CapabilityPanel'`

Update `rightTab` union:

- Add `'capabilities'`

Add right rail tab button:

- Label: `caps` or `capabilities`
- Place between `knowledge` and `skills` so it reads as context/inventory, not mutation.

Render:

- `rightTab === 'capabilities' ? <CapabilityPanel workspaceId={activeWsId} workspaceName={activeWs?.name ?? '—'} />`

Keep:

- Existing `skills` tab.
- Existing mutable `mcp` tab.
- Existing `Swarm Ops` header and internal operator workflows.

## Scanner Roots

### Global Skill Roots

Use these roots in this order:

- `~/.hermes/skills`
- `~/.openclaw/workspace/skills`
- `~/.openclaw/skills`
- `~/.codex/skills`
- `~/.claude/skills`

### Project Skill Roots

For the active workspace:

- `<workspace.cwd>/skills`
- `<workspace.cwd>/.agents/skills`
- `<workspace.cwd>/.codex/skills`
- `<workspace.cwd>/.claude/skills`

For each pinned root:

- `<pinnedRoot>/skills`
- `<pinnedRoot>/.agents/skills`
- `<pinnedRoot>/.codex/skills`
- `<pinnedRoot>/.claude/skills`

### Project Instruction Roots

For workspace cwd and pinned roots:

- `AGENTS.md`
- `WORKBENCH.md`
- `CLAUDE.md`
- `.cursorrules`

### MCP Config Roots

Read these config files if present:

- Workbench workspace state: `state.mcpServers[workspaceId]`
- Generated Workbench config path, if present: `~/.openclaw/agent-workbench/mcp/<workspaceId>.json`
- Claude project/global config: `~/.claude.json`
- Claude Desktop macOS config: `~/Library/Application Support/Claude/claude_desktop_config.json`
- OpenClaw workspace config: `~/.openclaw/workspace/.config/mcp.json`
- Codex config: `~/.codex/config.toml`
- Hermes config: `~/.hermes/config.yaml`, under `mcp_servers`

### Tool/Provider Roots For Later Static Cards

Wedge 1 can include placeholder/static provider cards only if the config is present and can be safely parsed without secrets:

- `~/.codex/config.toml`
- `~/.hermes/config.yaml`
- Workbench settings/provider state if already present in repo APIs

If provider parsing is uncertain, defer provider cards and keep the endpoint shape ready.

## Normalization Rules

### Skills

Skill capability fields:

- `id`: stable hash of canonical `SKILL.md` path plus content hash.
- `kind`: `skill`
- `source`: `global`, `project`, or `agent`
- `name`: first Markdown H1, then directory name fallback.
- `description`: frontmatter `description:` or first non-heading paragraph, max 260 chars.
- `originPath`: absolute path.
- `workspaceId`: active workspace id for project/pinned roots.
- `agentCompatibility`:
  - `.claude/skills` -> `['claude']`
  - `.codex/skills` -> `['codex']`
  - `.openclaw/.../skills`, workspace `skills`, `.agents/skills` -> `['workbench', 'openclaw', 'claude', 'codex']` unless a future metadata field narrows it.
  - `.hermes/skills` -> `['hermes']`
- `status`: `available` if readable; `broken` if directory entry exists but `SKILL.md` cannot be read.
- `risk`: `low` by default; `medium` if description/path suggests external actions; `high` only if clear publish/deploy/send/spend terms are present.
- `permissions`: inferred from metadata/description/path.
- `safeSummary`: concise generated sentence using only redacted metadata.

### MCP Servers

MCP server capability fields:

- `id`: stable hash of source path/config scope plus server name.
- `kind`: `mcp_server`
- `source`: `workspace` for Workbench state, `agent` for Claude/Codex/Hermes configs.
- `name`: server name.
- `originPath`: config path or `state.mcpServers[workspaceId]`.
- `workspaceId`: active workspace id for Workbench state.
- `agentCompatibility`:
  - Workbench MCP state -> `['workbench', 'claude']`
  - Claude configs -> `['claude']`
  - Codex config -> `['codex']`
  - Hermes config -> `['hermes']`
- `status`:
  - `available` when command exists syntactically and no obvious secret env is missing.
  - `disabled` for Workbench servers with `enabled === false`.
  - `needs_auth` if env contains secret-like key with blank, placeholder, or redacted value.
  - `broken` if command is missing.
  - `unknown` when config parsing is best-effort.
- `risk`: infer from command/package/name/args.
- `permissions`: infer from server name/args/env keys.
- `rawConfigRedacted`: command, args with secret-looking arguments redacted, env keys with values redacted.

### Project Docs

Project instruction capability fields:

- `kind`: `project_doc`
- `source`: `project`
- `name`: filename.
- `status`: `available` if readable.
- `risk`: `low`
- `permissions.readsFiles`: true
- `safeSummary`: first non-empty line, capped and redacted.

## Redaction Rules

Redaction must happen before any config reaches UI, logs, reports, prompts, or tests snapshots.

Secret key detection:

- Case-insensitive keys containing: `token`, `secret`, `password`, `passwd`, `credential`, `credentials`, `api_key`, `apikey`, `access_key`, `private_key`, `client_secret`, `session`, `cookie`, `bearer`, `auth`, `keychain`, `jwt`.

Value redaction:

- For secret-like keys, always return `"[REDACTED]"`.
- For string values matching common token patterns, return `"[REDACTED]"` even when key is not secret-like:
  - `sk-...`
  - `ghp_...`, `github_pat_...`
  - `xoxb-...`, `xoxp-...`
  - `Bearer ...`
  - JWT-shaped `xxxxx.yyyyy.zzzzz`
  - AWS-looking `AKIA...`
- Redact env var references in args when they are secret-like:
  - `$GITHUB_TOKEN`
  - `${OPENAI_API_KEY}`
  - `--token=...`
  - `--api-key ...`
- Preserve env key names but never values.
- Preserve non-secret command names and non-secret package names.
- Do not include full raw file contents in `rawConfigRedacted`.

Path redaction:

- UI may shorten `/Users/<name>` to `~`.
- API can return absolute `originPath` because this is local-only Workbench, but any generated `safeSummary` should use short paths.

## Risk And Permission Inference

Start conservative and transparent; all inference is static.

Low risk:

- Skills and docs that only describe local workflows.
- Memory/search/docs-oriented MCP servers.

Medium risk:

- Filesystem MCP servers.
- Browser automation MCP servers.
- GitHub/GitLab/Jira/Linear/Notion/Slack/Gmail providers without send/publish wording.
- Any capability with `externalNetwork: true`.

High risk:

- Names/args/descriptions indicating deploy, publish, release, payment, billing, email send, Slack post, destructive file operations, cloud infra, production, or secrets management.

Permission flags:

- `readsFiles`: filesystem, file, repo, workspace, memory, docs.
- `writesFiles`: filesystem with broad writable args, skills mentioning edit/write/create/delete.
- `externalNetwork`: github, gitlab, slack, gmail, notion, jira, linear, browser, puppeteer, fetch, web.
- `spendsMoney`: billing, payment, stripe, cloud spend, model provider billing.
- `sendsMessages`: gmail, slack, teams, discord, telegram, send, post, message.
- `deploysOrPublishes`: deploy, release, publish, vercel, netlify, docker push, npm publish.
- `needsSecrets`: secret-like env keys or auth/provider wording.

## UI Cards

Capability card layout:

- Header row: icon, `name`, status badge.
- Metadata row: `kind`, `source`, compatible agents.
- Body: `safeSummary`, 2-3 lines max.
- Path row: short `originPath` in monospace.
- Footer chips: risk and permission chips.

Section behavior:

- `Broken or needs auth` appears first when non-empty.
- `Connected MCP servers` shows Workbench MCP state and discovered config MCP servers.
- `Available tools` can be empty in wedge 1, with no noisy placeholder.
- `Skills by source` groups by `global`, `project`, and `agent`.
- `Project instructions` lists project docs.
- `Local models/providers` appears only when there are provider/local-model capabilities.

No mutation controls in the new panel.

## Tests

### New File: `tests/capability-registry.test.ts`

Use `node:test`, `assert/strict`, temp directories, and direct scanner functions.

Test cases:

- `scanSkillCapabilities discovers global, project, agent, and pinned skills`
  - Create temp home and workspace.
  - Add `SKILL.md` under `.openclaw/workspace/skills`, `.codex/skills`, workspace `skills`, workspace `.claude/skills`, and pinned `.agents/skills`.
  - Assert source and `agentCompatibility` are correct.
- `skill metadata prefers H1 and frontmatter description`
  - Assert name/description extraction.
- `buildCapabilityRegistry dedupes duplicate skill paths/content`
  - Same skill reachable through duplicate roots should appear once.
- `scanWorkbenchMcpCapabilities redacts env secrets`
  - Input env includes `GITHUB_TOKEN`, `OPENAI_API_KEY`, and non-secret key.
  - Assert all values redacted for secret keys and no token literal appears in JSON stringified output.
- `scanExistingMcpConfigCapabilities parses Claude/OpenClaw/Codex/Hermes configs`
  - Use temp home files.
  - Assert server cards exist with source compatibility.
- `MCP status is disabled, needs_auth, broken, or available`
  - Disabled Workbench server -> `disabled`.
  - Missing command -> `broken`.
  - Blank secret env -> `needs_auth`.
  - Valid command -> `available`.
- `project instruction docs become project_doc capabilities`
  - Add `AGENTS.md`, `WORKBENCH.md`, `CLAUDE.md`, `.cursorrules`.
  - Assert no full file body is returned.
- `redaction catches token patterns in args and nested config`
  - Include `--token=ghp_xxx`, `Bearer abc`, and nested `client_secret`.
  - Assert output has `"[REDACTED]"` and no source token strings.

### Optional Endpoint Test

If `tests/pty-server-lifecycle.test.ts` already starts the PTY server in a reusable way, add a focused endpoint assertion there or in a new lifecycle test:

- Start PTY with temp `AW_DATA_DIR` and temp home if practical.
- Create workspace.
- Call `GET /workspaces/:id/capabilities`.
- Assert 200, `workspaceId`, `generatedAt`, `capabilities` array, and no secret strings.

### Verification Commands

- `npm test`
- `npm run typecheck`
- Manual UI smoke via `npm run dev` only after implementation, verifying the new tab loads and existing `skills`/`mcp` tabs still work.

## Acceptance Criteria

- `GET /workspaces/:id/capabilities` returns a read-only normalized registry for the active workspace.
- Registry includes global/project/agent skills from the scanner roots above.
- Registry includes Workbench MCP state and existing MCP config files as MCP server cards.
- Broken, disabled, and needs-auth MCP servers are visible instead of silently omitted.
- All env values and token-like args are redacted before leaving backend scanner code.
- New UI displays read-only capability cards grouped by product sections.
- Existing internal Workbench mode remains intact:
  - `Swarm Ops` header unchanged.
  - Spawn behavior unchanged.
  - Agent prompt injection unchanged.
  - Existing `skills` panel unchanged.
  - Existing mutable `mcp` panel unchanged.
  - Existing MCP import/add/delete/toggle behavior unchanged.
- Tests cover discovery, compatibility mapping, status inference, dedupe, and redaction.
- `npm test` and `npm run typecheck` pass.

## Implementation Order

1. Add `lib/capability-registry.ts` with pure scanner functions and types.
2. Add `tests/capability-registry.test.ts` and make scanner tests pass.
3. Add `GET /workspaces/:id/capabilities` in `server/pty-server.ts`.
4. Add `getCapabilities()` in `lib/pty-client.ts`.
5. Re-export or define registry types in `lib/types.ts`.
6. Add `components/CapabilityPanel.tsx`.
7. Add `capabilities` right-rail tab in `components/Workbench.tsx`.
8. Run `npm test` and `npm run typecheck`.
9. Manual UI smoke with `npm run dev`.

## Notes For Later Wedges

- Wedge 2 can replace or augment the separate `skills`/`mcp` tabs after the read-only panel proves stable.
- Route preview should consume the registry but must not depend on UI-only grouping logic.
- Run trace should log selected capability ids and redacted summaries, not raw config.
- Skill mirroring/conversion needs a separate approval-gated flow with diff preview and conflict handling.
