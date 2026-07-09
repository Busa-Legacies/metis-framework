# Multi-Provider Agent Framework

> Status: **active** · Owner: orchestration layer · Created 2026-06-06
> Machine-readable source of truth: [`platform-registry.json`](./platform-registry.json)
> Enforcement: [`scripts/platform-parity-check.py`](../../scripts/platform-parity-check.py)

## 1. What this is

Metis OS was built Claude-Code-first. This document defines how the system becomes
**provider-neutral** — so Codex, the OpenClaw local lanes, and any future agent platform
(Gemini CLI, Cursor, Aider, …) can drive the repo with the *same* effectiveness, the *same*
governance, and run **in parallel** without colliding.

The model is **neutral core + thin per-platform adapters**, with a machine-readable
**platform registry** and a **parity check** that fails loudly when any platform drifts out
of sync with the canonical command/lifecycle surface.

## 2. Why it matters

A single-provider system is a single point of failure and a single quota ceiling. The
infrastructure already routes *generation* across engines (the engine ladder: Ollama,
codex/GPT, Anthropic). But the **driver** layer — the thing that runs sessions, claims work,
keeps memory, and closes out — was Claude-only. Pointing Codex at the repo today gives a
degraded, second-class session: no command surface, stale instructions, a forked memory silo,
and no place in the lease/fencing scheme.

The goal: **any registered platform is a first-class driver.** Parallel sessions across
Claude Code, Codex, and OpenClaw lanes share one task store, one lease/fencing protocol, one
memory spine, and one lifecycle — and the system can prove they're in sync.

## 3. Core concepts / mental model

### 3.1 Four layers

```
┌─────────────────────────────────────────────────────────────────┐
│ NEUTRAL CORE  (provider-agnostic — one copy, the source of truth) │
│  • Identity:   AGENTS.md · SOUL.md · USER.md · IDENTITY.md         │
│  • Protocol:   the lifecycle (start → next → checkpoint → end)     │
│  • Scripts:    scripts/*  (agent-work, free-work, dispatch, git-…) │
│  • State:      active-checkouts.json · tasks.json · OPEN_TASKS.md  │
│  • Memory:     ClaudeCode/memory/  (shared agent RAG — see §6)     │
│  • Docs:       docs/ · docs/process/                               │
├─────────────────────────────────────────────────────────────────┤
│ LANES  (bounded execution contexts — goal × role × engine × scope) │
│  • Each lane has its own lifecycle, independent of task status      │
│  • Risk tiers + approval gates before any high/critical dispatch   │
│  • Evidence ledger: done requires linked artifacts                 │
│  • Usage tracking: tokens/cost per lane, per project               │
│  → lane-entity-standard.md · dispatch-protocol.md                 │
├─────────────────────────────────────────────────────────────────┤
│ ADAPTERS  (thin, per-platform — map the core to each tool's shape) │
│  • Claude Code: ClaudeCode/skills/ · .claude/agents/ · hooks       │
│  • Codex:       .codex/prompts/ · .codex/agents/ · instructions.md │
│  • OpenClaw:    ClaudeCode/agents/{jay,<<MACHINE_2_ID>>}/ · dispatch lanes     │
│  • Metis Command: projects/metis-command/ — control center         │
│  • <new tool>:  one adapter dir, declared in the registry          │
├─────────────────────────────────────────────────────────────────┤
│ ENGINES  (interchangeable generation backends — the engine ladder) │
│  ollama/qwen · openai/gpt-5.x (codex) · anthropic/claude-*         │
└─────────────────────────────────────────────────────────────────┘
```

The **driver** is whatever agent runs the session loop. The **lane** is the atomic unit of
work dispatched to an executor. The **engine** is the model behind a given turn (already
abstracted by the engine ladder in `ClaudeCode/CLAUDE.md`). A platform can
be a driver, an executor, or both.

### 3.2 Platform roles

| Role | Meaning | Examples |
|---|---|---|
| `driver` | Runs interactive/agentic sessions: claims work, edits, commits, closes | Claude Code, Codex CLI |
| `executor` | Receives dispatched sub-tasks, returns output; does not own session lifecycle | OpenClaw lanes (smith/scout/warden/echo/arbiter/steward) |
| `engine` | A model endpoint behind a driver/executor turn | ollama/qwen, openai/gpt-5.x, anthropic/claude-* |

A platform can hold more than one role (Codex is a `driver` *and* an `engine` on the ladder).

### 3.3 The registry is the source of truth

[`platform-registry.json`](./platform-registry.json) enumerates every platform with its role,
status, entrypoint, command-surface location, persona dir, memory wiring, and session-id env
var. Humans read this doc; tooling reads the JSON. Adding a platform = one registry entry plus
its adapter files. The parity check (§7) validates the two never diverge.

## 4. The canonical lifecycle (provider-neutral)

Every driver implements the same four-verb loop. The *protocol* is neutral; only the *surface*
(how it's invoked) is per-platform.

| Verb | Canonical script(s) | What it does |
|---|---|---|
| `start` | `free-work.py`, `agent-work.py reconcile`, `session-workstreams.py` | Orient: git continuity, system health, ranked free work |
| `next` | `agent-work.py claim-next` | Atomically claim the top free task for this machine (collision-free) |
| `checkpoint` | `working-context-update.py`, `git-lock.sh`, `close-push.sh` | Bank a finished task mid-session; keep working |
| `end` | full close sequence (commit → push → context → memory → handoff) | Synthesize + terminate the session |

These scripts are **provider-neutral** — they take an `--agent <name>` and a session id and
know nothing about which driver called them. That is what makes the surface swappable.

## 5. Parallel-safety: how multiple drivers share the repo

Concurrent sessions — a Claude Code terminal, a Codex session, and a <<MACHINE_1_ID>> lane — can all touch
the repo at once. Three mechanisms keep them from colliding; **all are already provider-neutral
and apply to every driver:**

1. **Leases + fencing tokens** (`agent-work.py`). Every claim records `{agent, session,
   fenceToken}` under an exclusive `flock` on `active-checkouts.json`. A monotonic fence token
   (Kleppmann-style) means a superseded writer is rejected, not silently merged. `claim-next`
   selects *and* claims inside one lock, so two drivers calling it at the same instant get
   **different** tasks.
2. **The sync lock** (`git-lock.sh`). Commits/pushes wrap in a lock so the auto-sync daemon and
   any other session can't interleave a partial write.
3. **Session identity** (§5.1). The WIP guard ("one task per session") keys on a *session id*,
   not the agent name — so two Codex sessions, or a Codex and a Claude session, each get their
   own one-task budget instead of blocking each other.

### 5.1 Provider-neutral session identity

`agent-work.py::default_session()` resolves the session id from, in order:

```
AGENT_SESSION_ID          # provider-neutral override — set by any driver/wrapper
  → CLAUDE_CODE_SESSION_ID # Claude Code
  → CODEX_SESSION_ID       # Codex CLI
  → OPENCLAW_SESSION       # OpenClaw lanes
  → "manual"               # unknown — disables the per-session WIP guard (lock still protects)
```

Any new driver either exports `AGENT_SESSION_ID=<stable-unique-per-session>` or adds its native
env var to this chain. The machine/agent map in `free-work.py` (`<<MACHINE_1_ID>>`/`<<MACHINE_2_USER>>` → known agent
names incl. `codex`, `claude`) classifies which leases count as "this machine's WIP."

## 6. Unified, compounding memory

The whole point of the memory spine is that the system gets *sharper over time*. A per-provider
memory silo (the old `~/.codex/memories/` path) breaks that — Codex would learn in a corner
Claude never reads.

**Contract:** `ClaudeCode/memory/` is the **shared agent memory store** (a historical name; it
is not Claude-private). All drivers:

- **Read** it for durable cross-session context (the RAG surface the dashboard indexes).
- **Write** durable, cross-session, non-obvious lessons there using the frontmatter standard in
  `ClaudeCode/CLAUDE.md` (`name`/`description`/`metadata.type`/`tags`/`updated`), and add the
  one-line index entry to `MEMORY.md`.
- Keep raw daily logs in `workspace/memory/YYYY-MM-DD.md` (the Scribe-owned narrative layer).

Adapters wire their native memory path to this dir (Codex: `~/.codex/memories` → symlink into
`ClaudeCode/memory/`, declared in `mirror-manifest.json`). The physical rename of the dir to a
neutral name (`agent-memory/`) is **staged but not yet run** — it touches both live machines'
symlinks, so it must be done as one atomic per-machine flip. Tooling + procedure are ready:
[`scripts/migrate-shared-memory.sh`](../../scripts/migrate-shared-memory.sh) (idempotent, two-mode,
dry-run by default) and the runbook [`shared-memory-migration-runbook.md`](./shared-memory-migration-runbook.md).
Run it when at both machines.

## 7. Parity & drift enforcement

[`scripts/platform-parity-check.py`](../../scripts/platform-parity-check.py) is the
cross-platform analogue of `mirror-check` (which keeps the two *machines* in sync). It reads the
registry and asserts, for every `driver`:

- the entrypoint file exists;
- every **canonical command** has an adapter file in the platform's command surface;
- the persona dir and memory dir exist;
- a session-id env var is declared.

Exit non-zero on any missing required adapter. Run it:

```bash
python3 scripts/platform-parity-check.py            # human report
python3 scripts/platform-parity-check.py --json     # machine-readable
```

Wire it into `start` and into the close integrity gate so a half-added platform can't drift
silently. It is read-only and zero-dependency (stdlib JSON only).

## 8. Adding a new platform (the adapter checklist)

To bring up `<tool>` as a first-class driver:

1. **Registry** — add a `platforms[]` entry to `platform-registry.json` (role, status,
   entrypoint, command surface dir/ext, personas dir, memory dir, `sessionIdEnv`, `agentName`).
2. **Entrypoint** — a global-context file the tool reads on launch, pointing at `AGENTS.md` as
   the neutral identity and at this framework. (Codex: `instructions.md`; most tools support an
   `AGENTS.md` natively and need little else.)
3. **Command surface** — create the adapter dir and add one file per canonical command
   (`start`, `next`, `checkpoint`, `end`, `free-work`). Keep them *thin*: call the neutral
   scripts, don't re-implement the protocol.
4. **Session identity** — export `AGENT_SESSION_ID` from the tool's session, or add its env var
   to `default_session()` and the agent map in `free-work.py`.
5. **Memory** — point the tool's memory path at `ClaudeCode/memory/` (symlink via the mirror
   manifest); follow the frontmatter standard.
6. **Mirror** — add any symlinks to `ClaudeCode/mirror-manifest.json` so both machines stay
   wired.
7. **Verify** — `python3 scripts/platform-parity-check.py` must pass.

## 9. Current state (2026-06-06)

| Platform | Role | Status | Notes |
|---|---|---|---|
| Claude Code | driver, engine | **live** | reference implementation |
| Codex CLI | driver, engine | **live** | command surface (`.codex/prompts/`), fixed instructions, shared memory, session id |
| OpenClaw lanes | executor, engine | **live** | documented as a role in the registry |
| Antigravity CLI (ex-Gemini) | driver, engine | **on-hold** | Google deprecates **Gemini CLI** for free/Pro/Ultra individual tiers on **2026-06-18** → don't build against it. Antigravity CLI is the successor and runs on the existing Google AI tier, **but** only adopt if usage is *bundled* in that tier (not metered pay-per-API). Not open-source. |
| GitHub Copilot | driver | **blocked** | CLI + cloud agent, both read `AGENTS.md`; cheapest paid agent ($10/mo) and best GitHub-native fit. New Pro/Pro+/Max **signups paused since 2026-04-20** → `scripts/copilot-signup-watch.py` (daily) alerts when they reopen; build the adapter then. |
| Cursor | driver | **declined** | $20/mo agentic IDE w/ headless CLI; editor surface is redundant with Claude Code + Codex for a headless framework. Revisit only if an IDE surface is wanted. |

### What this pass delivered
- This framework doc + the machine-readable `platform-registry.json`.
- `platform-parity-check.py` — drift/sync enforcement across platforms.
- `.agents/skills/` — Codex's repo skill surface, symlinked to `ClaudeCode/skills/`.
- `.codex/prompts/` — Codex's legacy slash adapter surface, generated from Claude skills/commands
  by `scripts/sync-codex-surface.py`.
- Corrected `ClaudeCode/codex/instructions.md` (removed the dead Google-Drive commit path; use
  the repo-native `git-lock.sh`/`close-push.sh` flow; synced model guidance; shared memory).
- Provider-neutral session identity in `agent-work.py` (`AGENT_SESSION_ID` + `CODEX_SESSION_ID`).
- `mirror-manifest.json` wiring for `.codex/prompts` and shared Codex memory.

## 10. Common pitfalls

- **Re-implementing the protocol in an adapter.** Adapters must stay thin — call the neutral
  scripts. Duplicated step-lists drift; the parity check only catches *missing* files, not
  semantic divergence.
- **Forking memory.** Writing to a tool-private memory dir breaks compounding. Always land in
  `ClaudeCode/memory/`.
- **Unstable session ids.** If a driver can't produce a stable-unique-per-session id, the WIP
  guard degrades to "manual" (lock still protects correctness, but two of that tool's sessions
  can each hold a task). Prefer a real id.
- **Renaming `ClaudeCode/`.** Tempting for neutrality, but it breaks live symlinks on both
  machines and the project-memory symlink. Treat it as a planned, atomic mirror migration — not
  a casual rename.

## 11. Related docs
- [`platform-registry.json`](./platform-registry.json) — machine-readable registry
- [`../../ClaudeCode/CLAUDE.md`](../../ClaudeCode/CLAUDE.md) — engine ladder + <<MACHINE_1_ID>>-lane routing
- [`../../ClaudeCode/codex/instructions.md`](../../ClaudeCode/codex/instructions.md) — Codex entrypoint
- [`./hearth-lanes.md`](./hearth-lanes.md) — the executor lanes (dispatch; formerly jay-lanes)
- [`../../ClaudeCode/mirror-manifest.json`](../../ClaudeCode/mirror-manifest.json) — two-machine sync contract
- [`../../AGENTS.md`](../../AGENTS.md) — the neutral identity/workspace entrypoint every driver reads
