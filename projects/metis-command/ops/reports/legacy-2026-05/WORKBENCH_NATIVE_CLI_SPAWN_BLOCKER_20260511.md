# Workbench Native CLI Spawn Blocker
Date: 2026-05-11

## Goal
Spawn visible Workbench-native Claude/Codex CLI lanes for the BridgeMind-style ADE build:

- ADE UI task/evidence lane
- mission dispatch lane
- PTY mailbox/command-block lane
- shared memory/knowledge lane
- Claude product QA lane

## What Worked
- The Electron-owned PTY sidecar was found listening on port `3748`.
- `lsof -nP -iTCP:3748 -sTCP:LISTEN` showed the `Agent Workbench` process listening.
- `GET /health` intermittently returned:
  - `ok: true`
  - `agents: 4`
  - `running: 4`
  - `workspaces: 8`
- The target workspace was identified:
  - `ws_9ayirdlyo9`
  - `Agent Workbench — Swarm Ops Control Plane`
  - `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`

## What Failed
- Repeated `POST /workspaces/ws_9ayirdlyo9/tasks` attempts failed with:
  - `curl: (7) Failed to connect to localhost port 3748`
  - `curl: (7) Failed to connect to ::1 port 3748`
- The failure was intermittent: health checks sometimes succeeded immediately before or after failed task/spawn requests.
- Verbose curl showed sandbox-level local network denial in some cases:
  - `Immediate connect fail for ::1: Operation not permitted`
  - `Immediate connect fail for 127.0.0.1: Operation not permitted`
- Single sequential requests from `/usr/bin/curl --noproxy '*'` sometimes succeeded, including a probe task create. Parallel or rapid tool-side connections were unreliable from this Codex sandbox.
- Starting a replacement sidecar from this sandbox failed:
  - `npm run dev:pty` failed on `tsx` IPC pipe bind: `listen EPERM .../tsx-501/...pipe`
  - `node --import tsx server/pty-server.ts` failed on socket bind: `listen EPERM 0.0.0.0:3748`

## Findings
- The pane model is correct: panes are real terminal/PTTY-backed child processes owned by the sidecar.
- The running app is the packaged Electron app under `dist-app/.../Agent Workbench.app`, not a fresh source dev server.
- `lsof` confirmed the packaged app is listening on port `3748` and has live PTY/log file handles for current agents.
- The source sidecar previously used `server.listen(PORT)`, which binds all interfaces even though logs said `127.0.0.1`.
- Source has now been patched to bind explicitly to `AW_PTY_HOST` defaulting to `127.0.0.1`, and Electron now passes `AW_PTY_HOST` to the sidecar.
- This patch requires app restart/rebuild before the packaged app uses it.

## Impact
This blocks reliable Workbench-native spawning of visible agent CLI panes from this Codex sandbox. It also identifies a product hardening gap: the ADE should have explicit loopback binding, visible sidecar health, and retry/degraded-state handling so operators never have to reason about the control plane.

## Required Fix Lane
Create a reliability lane focused on the Electron/PTY bridge:

1. Make the sidecar bind target explicit and stable.
2. Add sidecar readiness and restart detection in Electron.
3. Add renderer-visible sidecar degraded state.
4. Add retry/backoff around task/spawn actions in the app, not just caller scripts.
5. Add a `/debug/connections` or `/healthz/deep` endpoint reporting event-loop status, active requests, agents, and last error.
6. Add a smoke test that creates a task and spawns a harmless shell/codex lane through the same API path the UI uses.

## Patch Applied
- `server/pty-server.ts`: bind with `server.listen(PORT, HOST)` where `HOST = AW_PTY_HOST || 127.0.0.1`.
- `electron/main.cjs`: define `PTY_HOST`, pass `AW_PTY_HOST` to the sidecar, expose it in `aw:get-config`.

Verification:
- `./node_modules/.bin/tsc --noEmit --pretty false` passed.
- `TMPDIR=/private/tmp node --import tsx --test tests/mission-packet.test.ts tests/lane-advisor.test.ts tests/workbench-memory.test.ts tests/swarm-mailbox.test.ts tests/terminal-command-blocks.test.ts tests/evidence-ledger.test.ts` passed 37/37.

## Native Spawn Commands Prepared
The planned lane prompts are in the conversation history and can be replayed once the sidecar accepts stable POST requests. Do not treat the CLI lanes as spawned unless new agents appear in `GET /agents?include=exited`.
