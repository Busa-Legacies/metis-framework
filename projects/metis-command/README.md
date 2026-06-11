# Metis Command

Desktop **multi-agent command cockpit** for Metis OS. Spawn, label, and steer real `claude`, `codex`, `gemini`, shell, and Python REPL processes from one window, track workspace git state, keep exited output available for review, and decide the next lane from live swarm status. Each CLI authenticates via its own OAuth flow; the cockpit exposes sign-in shortcuts.

Part of the [Metis OS](https://github.com/Busa-Legacies/metis-os) framework. Connects to the shared task/lease spine, lane entity model, and dispatch protocol.

## Architecture

```
┌──── Electron (main process) ──────────────────────────────────────┐
│  electron/main.cjs                                                 │
│  spawns:                                                           │
│   ├─ Next.js dev/start  → http://127.0.0.1:3747  (renderer URL)    │
│   └─ PTY sidecar        → http://127.0.0.1:3748  (REST + WS)       │
│  opens BrowserWindow → loadURL(http://127.0.0.1:3747)              │
└────────────────────────────────────────────────────────────────────┘
```

Every agent is a real PTY-backed child process. State persists at `~/.openclaw/metis-command/state.json`; per-agent logs at `~/.openclaw/metis-command/logs/<id>.log`. Settings (OpenAI key, model) at `~/.openclaw/metis-command/settings.json`.

## Run as a desktop app

```bash
npm install
npm run app           # boots Electron + servers in one shot
```

A native window opens with a splash, then Metis Command loads as soon as Next.js comes up.

> First run takes ~5s to start Next.js dev. The window shows a splash until ready.

### Run in browser instead (dev convenience)

```bash
npm run dev           # next + pty sidecar via concurrently
# open http://127.0.0.1:3747 in Chrome/Edge
```

### Smoke the browser renderer

```bash
npm run smoke:browser
```

The smoke script starts the Next.js renderer on a free loopback port and verifies the root page responds. Use `AW_NEXT_PORT` or `AW_SMOKE_PORT` to force a deterministic port; the script fails before probing if that port is already occupied. Use `AW_SMOKE_HOST` or `AW_SMOKE_TIMEOUT_MS` to override host or timeout.

### Build a `.dmg`

```bash
npm run app:dist
# → dist-app/Metis Command-0.1.0-arm64.dmg
```

## Authentication

| Tool | How |
|---|---|
| **Claude CLI** | Click *Settings → Sign in to Claude*. A tab spawns running `claude login`; complete OAuth in your browser. |
| **Codex CLI** | Click *Settings → Sign in to Codex*. Spawns `codex login`. Uses your ChatGPT account. |
| **Gemini CLI** | Click *Settings → Sign in to Gemini*. Spawns `gemini auth login`. |
| **Operator panel** | Settings → paste an OpenAI API key if you want tool-calling. Stored locally, never touches `.env`. |

You don't need an OpenAI key to use the cockpit. It is only for the operator panel that can auto-spawn agents; CLIs work fine on their own once signed in.

## Voice

Hold **Space** anywhere to dictate (Chromium SpeechRecognition). Releasing sends the transcript to the operator panel.

## What the operator panel can do

| tool | effect |
|---|---|
| `spawn_agents` | open one or many CLIs — accepts an array, so *"open 2 claude code, 1 codex"* is one tool call |
| `kill_agent` | terminate by id |
| `rename_agent` | change a tab label |
| `send_to_agent` | type text into a specific terminal |
| `list_agents` / `list_workspaces` | enumerate state |
| `create_workspace` | new workspace lane with a `cwd` |

Try: *"open 2 claude code, 1 codex; name them frontend, api, deploy."*

## Configuration env vars (optional)

| env | default | purpose |
|---|---|---|
| `AW_NEXT_PORT` | `3747` | renderer port |
| `AW_PTY_PORT` | `3748` | sidecar port |
| `AW_DATA_DIR` | `~/.openclaw/metis-command` | state + logs root |
| `AW_ASSISTANT_MODEL` | `gpt-5.5` | overridable in Settings UI |
| `AW_FALLBACK_MODEL` | `gpt-4o` | overridable in Settings UI |
| `AW_CLAUDE_CMD` / `AW_CODEX_CMD` / `AW_GEMINI_CMD` | `claude` / `codex` / `gemini` | binary used for each kind |

## Files

```
electron/main.cjs           Electron main — owns child lifecycles
electron/preload.cjs        contextBridge exposing window.aw.*
electron/splash.html        loading screen
server/pty-server.ts        sidecar (node-pty + ws + http)
app/api/assistant/route.ts  operator tool-calling proxy
app/api/settings/route.ts   GET/PATCH ~/.openclaw/metis-command/settings.json
components/Workbench.tsx    shell (workspaces, tabs, terminal, operator panel)
components/AgentTerminal.tsx xterm.js + WebSocket
components/AssistantPanel.tsx operator chat + push-to-talk
components/SettingsDrawer.tsx OAuth sign-in shortcuts + key field
lib/pty-client.ts           fetch/WS helpers
lib/settings.ts             server-side settings reader/writer
_archive/                   prior static dashboard mockup
```

## Related docs

- [`docs/process/lane-entity-standard.md`](../../docs/process/lane-entity-standard.md) — lane lifecycle, risk tiers, evidence model
- [`docs/process/dispatch-protocol.md`](../../docs/process/dispatch-protocol.md) — plan-before-dispatch, approval gates
- [`docs/process/multi-provider-agent-framework.md`](../../docs/process/multi-provider-agent-framework.md) — framework architecture
