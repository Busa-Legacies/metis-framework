# Agent Workbench Main Cleanliness Review

Date: 2026-05-20
Lane: cleanliness review, `main` only
Scope: UI/product surfaces, PTY sidecar/client/types, validation, and repo organization after report consolidation.

## Repo State

- Branch: `main`.
- Worktree: clean before and after review.
- Latest commit: `f8c468a chore(workbench): align GitHub main with cleaned product tree`.
- Previous commits inspected: `73fb92d feat(workbench): consolidate cockpit primitives and organize reports`, `c97ff8a docs(workbench): report overnight agent state slice`.
- Local branch clutter remains: multiple `slice/*` and `worktree-agent-*` branches are still visible from `git branch --all`, including several branches marked as checked out in other worktrees.

## Validation

- `npm run typecheck`: passed.
- `npm run lint`: passed with 27 warnings. Main warning clusters are unused imports/vars, hook dependency issues, and one unused server catch binding.
- `npm test`: blocked by sandbox, not by a test assertion. `tsx --test` failed with `listen EPERM` while trying to create `/Users/jarvis/.openclaw/tmp/tsx-501/43697.pipe`.
- `npm run build`: blocked by sandbox/Turbopack. Build panicked while processing `@xterm/xterm/css/xterm.css`, caused by `creating new process -> binding to a port -> Operation not permitted`.

## Current Product Surface

Agent Workbench already has the raw cockpit primitives:

- Workspace switcher, workspace cards, git/task/evidence chips, and next-action snippets in `components/Workbench.tsx:88`, `components/Workbench.tsx:506`, and `components/Workbench.tsx:557`.
- Left rail tabs for workspaces, files, and tasks in `components/Workbench.tsx:476`.
- Main multi-pane terminal/browser grid in `components/Workbench.tsx:681` and `components/PaneGrid.tsx:45`.
- Right rail operator tabs for assistant, notes, knowledge, skills, and MCP in `components/Workbench.tsx:715`.
- Task board with build/review spawners and evidence counts in `components/TasksPanel.tsx:22`, `components/TasksPanel.tsx:57`, and `components/TasksPanel.tsx:178`.
- File browser with pinned roots in `components/FileTree.tsx:42` and `components/FileTree.tsx:86`.
- Settings for sign-in, assistant brain provider, OpenAI models, and bridge key in `components/SettingsDrawer.tsx:33`, `components/SettingsDrawer.tsx:145`, and `components/SettingsDrawer.tsx:169`.
- PTY sidecar persistence for workspaces, layouts, chats, notes, pinned roots, MCP servers, output tails, and tasks in `server/pty-server.ts:416`.
- Task/evidence/build/review endpoints in `server/pty-server.ts:1531` and `server/pty-server.ts:1660`.
- Assistant tools for spawn, cockpit summary, acknowledgement, reports, and portfolio summary in `app/api/assistant/route.ts:72`.

The gap is not absence of capability. The gap is productization: the current app still exposes developer primitives first, while ADE needs a non-coder cockpit that guides project selection, lane preview, approval, monitoring, artifact review, and model/cost routing.

## Punch-List

### P0: Non-Coder ADE Cockpit Shell

1. Replace the first-screen mental model from "Swarm Ops terminal grid" to "ADE product cockpit".
   - Current header says `Swarm Ops`, spawn button says `spawn`, and the empty pane says "drop a tab here" in `components/Workbench.tsx:424`, `components/Workbench.tsx:627`, and `components/PaneGrid.tsx:251`.
   - Product target: user lands on "Projects", "Plan", "Approve", "In progress", "Artifacts", and "Costs" rather than agents, tabs, panes, and CLIs.

2. Add a guided command surface above raw operator chat.
   - Current right rail defaults to a chat assistant in `components/Workbench.tsx:740`, with an example prompt about opening agents in `components/AssistantPanel.tsx:779`.
   - Product target: natural-language goal entry should produce a visible proposed plan, selected project, lanes, files, risks, estimated model usage, and required approvals before running.

3. Separate "advanced terminal mode" from the default cockpit.
   - `PaneGrid` is a strong engineer surface, but the non-coder default should summarize lane state and show terminal details behind "inspect logs" or "advanced".
   - Keep `components/PaneGrid.tsx:117` as the drill-down implementation, but make cockpit cards the default view for non-coder operations.

### P0: Project Picker and Folder Organization

1. Promote workspace creation into a project picker with discovery.
   - Current `WorkspaceDialog` requires manually typing a path in `components/Workbench.tsx:1096`.
   - Add a project picker backed by known roots: OpenClaw workspace projects, pinned memory/report roots, recent repos, and git repos.
   - Show project health before opening: cwd, branch, dirty count, last activity, open tasks, reports, and active agents.

2. Validate and normalize project paths at creation/update time.
   - Server currently stores POST/PATCH workspace `cwd` after expanding `~`, but does not validate existence until agent spawn in `server/pty-server.ts:1103` and `server/pty-server.ts:1123`.
   - Add server-side workspace cwd validation for create/update so broken projects are caught before a user starts a lane.

3. Add first-class project metadata.
   - `Workspace` only has `id`, `name`, `cwd`, and `createdAt` in `lib/types.ts:5`.
   - Add product fields such as `description`, `kind`, `repoRemote`, `defaultBranch`, `artifactRoots`, `memoryRoots`, `riskPolicy`, and `archivedAt`.

### P0: Lane Preview and Approval

1. Create a lane proposal object before spawning agents.
   - Current manual spawn menu directly creates an agent with kind/role/name/directive in `components/Workbench.tsx:1046`.
   - Current assistant `spawn_agents` tool can spawn immediately from action blocks in `app/api/assistant/route.ts:72`.
   - Add an intermediate `LanePlan`/`DispatchPlan` type: goal, lane name, role, model/backend, files in scope, commands allowed, write permissions, expected artifacts, risk tier, estimated cost, and approval status.

2. Add approval gates to assistant dispatch.
   - `execTool` starts durable dispatch actions immediately for mutating tools in `app/api/assistant/route.ts:308`.
   - For non-coder ADE, mutating actions should default to preview unless the request is explicitly low-risk or the user has enabled an approved autopilot mode.

3. Replace task build/review buttons with "Preview lane" then "Approve".
   - Current `TasksPanel` buttons call `ptyApi.buildTask` and `ptyApi.reviewTask` directly in `components/TasksPanel.tsx:79` and `components/TasksPanel.tsx:89`.
   - Product target: clicking build/review opens a lane preview with scope, model, prompt, files, and expected evidence; approval creates the agent.

4. Store approval evidence.
   - Evidence kinds include `commit_approval` and `push_approval` in `lib/types.ts:33`, but lane approval itself is not modeled.
   - Add `lane_approval`, `plan_preview`, and `scope_change` evidence kinds, or add an explicit approval ledger.

### P0: Artifact Browser and Evidence Ledger

1. Build an Artifact Browser as a top-level cockpit panel.
   - Reports exist under `ops/reports/legacy-2026-05`, and assistant tools can list report artifacts via `list_workspace_reports` in `app/api/assistant/route.ts:85`.
   - Current UI buries reports in cockpit drawers and file links; there is no artifact inventory by project/task/lane.

2. Unify artifacts across reports, tests, diffs, screenshots, logs, and approvals.
   - `EvidenceRow` is already present in `lib/types.ts:42`, and task evidence endpoints exist in `server/pty-server.ts:1597`.
   - Add a cross-workspace artifact index with filters: unread, needs approval, failed test, shipped, generated report, screenshot, diff, model transcript.

3. Make "done" evidence visible before status changes.
   - Done gating exists in `TasksPanel.move` and `doneStatusBlock` in `components/TasksPanel.tsx:57` and `server/pty-server.ts:1038`.
   - The current UX prompts for override only after failure. Add a visible checklist on each task/lane: report evidence, review evidence, test evidence, owner, file scope, approvals.

4. Add artifact open strategy that works in desktop and browser.
   - `openReport` uses `window.open(file://...)` in `components/AssistantPanel.tsx:222`.
   - File URLs may fail in browser mode. Add a sidecar endpoint for safe artifact reads/previews from approved roots.

### P0: Usage and Model Routing

1. Move model routing from Settings into lane planning.
   - Settings has global assistant provider/model controls in `components/SettingsDrawer.tsx:145` and `components/SettingsDrawer.tsx:193`.
   - `server/pty-server.ts:791` supports per-pane effort flags, but `lib/pty-client.ts:141` does not expose `effortLevel`, so the UI cannot send it.
   - Add lane-level model/effort selection and show estimated tradeoffs: fastest, balanced, deep review, max audit.

2. Track usage per lane and project.
   - There is no usage/cost type in `lib/types.ts`, no usage endpoint in `lib/pty-client.ts`, and no persisted usage bucket in `server/pty-server.ts:416`.
   - Add `UsageEvent` records: provider, model/backend, effort, startedAt/completedAt, tokens if available, wall time, exit code, tool calls, estimated cost, and linked task/lane.

3. Add routing policies.
   - Current provider resolution is global and persona-driven in `app/api/assistant/route.ts:370`.
   - Product target: route by task class and risk. Example: cheap scout for discovery, Codex high effort for code edits, Claude reviewer for final review, OpenClaw Jarvis for coordination.

4. Surface budget controls.
   - Settings has `autonomousHopCap` in state but no visible control in `components/SettingsDrawer.tsx:7`.
   - Add budget caps per run: max lanes, max minutes, max model spend, max autonomous hops, require approval above threshold.

### P1: Task and Lane Model

1. Split task status from lane execution status.
   - Current `TaskStatus` is `todo | building | review | done` in `lib/types.ts:31`.
   - ADE needs task lifecycle plus lane lifecycle: proposed, approved, queued, running, waiting, blocked, reviewing, complete, failed, archived.

2. Add lane entities.
   - `Agent` has optional `role` and `taskId` in `lib/types.ts:12`, but there is no lane record.
   - Add `Lane`: id, project/workspace, task, role, goal, scope, assigned agent(s), model route, approval, artifact outputs, current status, timestamps.

3. Make file ownership part of lane planning.
   - File claims are text lines in the task edit dialog in `components/TasksPanel.tsx:237`.
   - Move file scopes into lane plan preview with conflict detection before approval.

### P1: Cockpit Queue and Approval UX

1. Consolidate cockpit summary locations.
   - `Workbench` polls cockpit summary every 5 seconds in `components/Workbench.tsx:115`.
   - `AssistantPanel` independently polls cockpit and dispatch status every 5 seconds in `components/AssistantPanel.tsx:522`.
   - Add one cockpit data provider/cache to avoid duplicated requests and inconsistent states.

2. Promote next actions to the center of the app.
   - Next actions are currently small workspace-card snippets in `components/Workbench.tsx:557` and a drawer inside assistant.
   - Make the first viewport a triage board: "Needs approval", "Blocked", "Ready to review", "In flight", "Unread artifacts".

3. Add explicit approval buttons for risky actions.
   - Current cockpit can acknowledge exited agents in `app/api/assistant/route.ts:165`, but acknowledgement is not approval.
   - Add approve/reject/request-changes controls with persisted reason and downstream effect.

### P1: File Browser

1. Replace prompt-based pinning with a picker.
   - Current `addPin` asks for an absolute path with `window.prompt` in `components/FileTree.tsx:86`.
   - Add browse/search for common roots, recent projects, memory, reports, and repo folders.

2. Add artifact affordances to FileTree.
   - Current file click sends a quoted path into the active agent or copies to clipboard in `components/Workbench.tsx:583`.
   - Add open preview, attach to lane, mark as artifact, add to task scope, and compare diff.

3. Server-side pinned root validation.
   - `/pinned-roots` stores any string list in `server/pty-server.ts:1442`.
   - Validate roots exist, are directories, are not secret/system directories, and are display-safe.

### P1: Repo Hygiene

1. Remove or relocate root-level legacy files.
   - Root still contains `HIGHROI_WORKBENCH_MVP_VISIBILITY_FIX_CODEX_20260509.md`.
   - Root also contains backup files: `components/Workbench.tsx.bak-20260509-visibility-incident`, `server/pty-server.ts.bak-20260509-bridge-output-cap`, and `server/pty-server.ts.bak-20260509-codex-initialprompt`.
   - Move these under `ops/reports/legacy-2026-05` or delete after confirming they are obsolete.

2. Decide what to do with `_archive`, `data/workbench-state.json`, `mydatabase.db`, `dist-app`, `.next`, and `tsconfig.tsbuildinfo`.
   - `du -sh` shows the repo tree is about 2.5G, with `node_modules` at 1.2G and `.next` at 204M.
   - Generated state/build artifacts should be ignored or moved out of the product repo if they are not release assets.

3. Prune merged local branches and stale worktrees.
   - `git branch --all` still shows many slice/worktree branches after consolidation.
   - Keep branch state clean so the ADE cockpit is not bootstrapped on stale lane residue.

4. Make lint warnings actionable.
   - Lint exits 0 but warnings include unused imports/vars and hook dependency issues in `Workbench`, `AssistantPanel`, `FileTree`, `PaneGrid`, `McpPanel`, and `server/pty-server.ts`.
   - Set a target of zero warnings before calling this a clean product baseline.

### P1: Server/API Hardening

1. Break up `server/pty-server.ts`.
   - The PTY server now combines git, knowledge search, skill discovery, state, agents, files, MCP, tasks, evidence, and websocket logic.
   - Split into route modules/services: workspace store, agent runtime, task/evidence service, file service, knowledge service, MCP service, HTTP router.

2. Add schema validation.
   - Many endpoints parse `any` JSON directly, for example `readJson` in `server/pty-server.ts:1005` and task creation in `server/pty-server.ts:1537`.
   - Use shared schemas for client/server types to reduce silent bad state.

3. Add optimistic concurrency/state versioning.
   - State is a single JSON file at `~/.openclaw/agent-workbench/state.json` in `server/pty-server.ts:443`.
   - Add versions or write guards for tasks/layouts/settings so concurrent UI actions do not overwrite each other.

4. Move CORS from wildcard to local-only policy.
   - `send` uses `access-control-allow-origin: *` in `server/pty-server.ts:1018`.
   - For ADE productization, restrict by host/origin and require bridge auth for non-local flows.

### P2: UI Polish and Accessibility

1. Replace hover-only critical controls.
   - Workspace edit/delete and task edit/delete controls are hidden until hover in `components/Workbench.tsx:536` and `components/TasksPanel.tsx:194`.
   - Non-coder UX should make safe actions discoverable and risky actions explicit.

2. Reduce abbreviations.
   - Current chips include `ws`, `ev`, `bld`, `rev`, and agent kind badges.
   - For ADE, use plain labels by default and compact labels only in advanced/dense mode.

3. Improve mobile/narrow behavior.
   - The app is a fixed three-column grid in `components/Workbench.tsx:465`.
   - Add responsive collapse: project/cockpit first, panes second, context drawer third.

## Suggested Delivery Order

1. Define `Project`, `LanePlan`, `Lane`, `Artifact`, `UsageEvent`, and `Approval` types and shared schemas.
2. Add project picker/discovery and workspace create/update validation.
3. Add lane preview endpoint and modal; route existing spawn/task build/review through preview.
4. Add approval ledger and approval-gated dispatch.
5. Add artifact browser backed by evidence/report/log roots.
6. Add usage/model route selection per lane.
7. Clean repo residue and reduce lint warnings to zero.
8. Split `pty-server.ts` into services once product contracts stabilize.

## Acceptance Bar For ADE Cockpit

- A non-coder can select a project without typing a path.
- A user can describe a goal and see a proposed lane plan before anything runs.
- Risk, file scope, model route, estimated effort/cost, and approval requirement are visible before dispatch.
- Running work is summarized as lanes, not terminals; terminals are drill-down.
- Artifacts are browsable by project/task/lane and can be marked read/approved.
- Done state requires visible evidence, not only a hidden server gate.
- Usage is visible by run/project and constrained by user-set budgets.
- Repo root contains only source/product files; generated state, backups, and legacy reports are outside the root.
