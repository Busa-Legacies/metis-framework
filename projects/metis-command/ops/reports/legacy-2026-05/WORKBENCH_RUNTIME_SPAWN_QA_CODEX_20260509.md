# Workbench Runtime Spawn QA - Codex - 2026-05-09

## Verdict

PASS with one environment-blocked runtime test lane.

## Scope

- Repo: `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`
- Files inspected:
  - `server/pty-server.ts`
  - `lib/cockpit-summary.ts`
  - `lib/cockpit-ui-state.ts`
  - `tests/tool-routing.test.ts`
  - `WORKBENCH_STALE_AGENT_WATCHDOG_CODEX_20260509.md`
- Constraints honored: no commit, push, deploy, installs, or edits outside repo.

## Evidence

### Runtime Spawn Hardening

PASS.

- `server/pty-server.ts:226-239` only changes default Codex launch behavior when `initialPrompt` is non-empty:
  - `codex exec --sandbox workspace-write <prompt>`
  - Codex resume remains `codex resume --last`.
  - Codex without an initial prompt remains the default interactive `codex` command.
- `server/pty-server.ts:438-467` keeps Claude prompt injection on the existing `--append-system-prompt` path and only applies it when `input.kind === 'claude' && !input.cmd`.
- `server/pty-server.ts:241-247` leaves Gemini, Python, and shell defaults unchanged:
  - Python: `python3 -i`
  - Shell: `$SHELL -l` or `/bin/zsh -l`
- `server/pty-server.ts:470-475` adds `NO_UPDATE_NOTIFIER=1` to spawned env without removing caller-provided env, `TERM`, or PATH hardening.
- `server/pty-server.ts:495-501` still launches all agent kinds through `nodePty.spawn(cmd, args, { cwd, env })`; no kind-specific PTY behavior was removed.

No source-consistency issue found for Claude/shell/python agents.

### Stale-Agent Watchdog

PASS.

- `lib/cockpit-summary.ts:12-30` adds `CockpitStaleRunningAgent[]` while preserving the existing `staleRunningAgentIds` array.
- `lib/cockpit-summary.ts:301-314` computes stale details additively from existing agent metadata: `lastOutputAt`, `createdAt`, `outputBytes`, and attributed reports.
- `lib/cockpit-summary.ts:358-368` preserves stale next-action derivation from `staleRunningAgentIds` and enriches the reason text.
- `lib/cockpit-ui-state.ts:76-82` keeps older summaries compatible by falling back to the original `stale` label when `staleRunningAgents` is absent.
- `tests/tool-routing.test.ts:555-587` covers stale detail rows and threshold behavior.
- `tests/tool-routing.test.ts:817-848` covers the pane badge label `stale 1h` alongside report-ready and acknowledged states.

The implementation is additive and backward-compatible at the data-shape and UI-helper levels.

## Tests

- `npm run typecheck`
  - PASS

- `node --import tsx --test tests/tool-routing.test.ts tests/cockpit-continuity.test.ts`
  - PASS: 46 passed, 1 existing skipped placeholder, 0 failed

- `npm run test:pty`
  - BLOCKED by sandbox before app code:
  - `listen EPERM: operation not permitted 127.0.0.1`
  - All 7 PTY lifecycle tests failed at the same local socket bind step.

## Risks / Gaps

- No runtime PTY spawn test could execute in this sandbox, so the actual `node-pty` launch behavior was verified by source inspection plus pure tests only.
- `defaultCommandFor()` is not exported, so the Codex exec command construction is not directly unit-tested. Current coverage is indirect.
- The inline `initialPrompt` comment on `spawnAgent()` still says it is injected as `--append-system-prompt` for Claude. That is accurate for Claude, but now incomplete for Codex because Codex initial prompts use `codex exec`.

## Exact Next Fixes

1. Add a pure unit seam for agent command construction, or export a narrowly scoped helper, then test:
   - Codex with `initialPrompt` -> `codex exec --sandbox workspace-write <prompt>`
   - Codex without prompt -> `codex`
   - Codex resume -> `codex resume --last`
   - Claude with prompt still receives `--append-system-prompt`
   - Python and shell defaults remain unchanged
2. Update the `spawnAgent()` `initialPrompt` comment to mention Codex exec mode as well as Claude prompt injection.
3. Re-run `npm run test:pty` in an environment that permits binding `127.0.0.1`.

