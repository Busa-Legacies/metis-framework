# Workbench Visual UX QA Exec - 2026-05-10

## Verdict

Overall execution gate: **FAIL**

Implementation review for workspace close-X and unnamed workspace UX: **PASS**.

The gate is marked FAIL because `npm run typecheck` currently fails in `tests/runtime-guardrails.test.ts` on `ProcessEnv.NODE_ENV` typing, and the PTY lifecycle suite cannot execute in this sandbox because binding `127.0.0.1` returns `EPERM`. The reviewed close-X / unnamed workspace implementation itself has direct source evidence, passes lint with warnings only, passes `next build`, and passes the non-PTY focused test subset.

No push or deploy was performed.

## Environment And Repo State

- `pwd`: `/Users/jarvis/.openclaw/workspace/Projects/agent-workbench`
- `node --version`: `v25.8.0`
- `npm --version`: `11.11.0`
- `git status --short --branch`: branch `slice/summarize-portfolio-tool...origin/slice/summarize-portfolio-tool`
- Existing dirty worktree observed before this report:
  - Modified: `.gitignore`, `bridge/telegram.cjs`, `components/AssistantPanel.tsx`, `components/Workbench.tsx`, `eslint.config.mjs`, `lib/pty-client.ts`, `server/pty-server.ts`, `tests/pty-server-lifecycle.test.ts`
  - Multiple untracked `WORKBENCH_*`, `PM_*`, `WB_*`, `lib/*`, and `tests/*` files were already present.

Changed-file stat for reviewed UX paths:

```text
components/Workbench.tsx           | 92 +++++++++++++++++++++++++++++++++-----
lib/pty-client.ts                  |  2 +-
server/pty-server.ts               | 52 ++++++++++++---------
tests/pty-server-lifecycle.test.ts | 67 +++++++++++++++++++++++++++
4 files changed, 180 insertions(+), 33 deletions(-)
```

## Source Evidence

### PASS - unnamed workspace label is visually distinct

- `components/Workbench.tsx:29-31` defines `workspaceDisplayName()` as trimmed name or `temporary workspace`.
- `components/Workbench.tsx:479` renders blank names in the left workspace list with `italic text-slate-500`.
- `components/Workbench.tsx:851` renders the active workspace switcher label italic/muted when the active name is blank.
- `components/Workbench.tsx:863` renders blank-name entries in the top workspace menu with `italic text-slate-500`.

### PASS - create workspace permits blank names

- `components/Workbench.tsx:256-264` sends `name: name.trim() || null`, so blank UI input is allowed.
- `components/Workbench.tsx:990-1003` uses placeholder/help copy for optional name and the Create button has no disabled requirement tied to name.
- `lib/pty-client.ts:18-23` accepts `{ name?: string | null; cwd?: string }` for `createWorkspace`.

### PASS - server persists intended blank/cwd-derived names

- `server/pty-server.ts:186-193` trims explicit nonblank names, derives basename when cwd was provided, and returns `''` otherwise.
- `server/pty-server.ts:750-763` applies that helper in `POST /workspaces`, defaulting cwd to `os.homedir()` when no cwd is provided.
- `tests/pty-server-lifecycle.test.ts:346-381` covers blank-name temporary workspace, cwd-derived basename, and explicit-name trimming.

### PASS - close-X controls are present in both workspace surfaces

- `components/Workbench.tsx:497-502` adds the left rail close-X button with hover visibility, stopPropagation, last-workspace disabled state, and `close workspace` title.
- `components/Workbench.tsx:866-873` adds the top workspace switcher close-X button with the same disabled/hover behavior.
- `components/Workbench.tsx:267-296` implements the shared delete flow.

### PASS - close flow is guarded and non-destructive to files

- `components/Workbench.tsx:270-276` blocks closing the last workspace in UI and confirmation text says files on disk are not deleted.
- `lib/pty-client.ts:30-31` calls `DELETE /workspaces/:id`.
- `server/pty-server.ts:777-782` rejects deleting the last workspace, removes the workspace record, kills in-memory agents for that workspace, saves state, and does not call filesystem delete APIs for workspace cwd.
- `tests/pty-server-lifecycle.test.ts:383-408` covers rejection of last-workspace deletion and deletion of a non-last workspace record.

## Command Results

### PASS - whitespace/conflict check

Command:

```sh
git diff --check -- components/Workbench.tsx lib/pty-client.ts server/pty-server.ts tests/pty-server-lifecycle.test.ts
```

Result: **PASS**, exit code `0`, no output.

### PASS - lint

Command:

```sh
npm run lint
```

Result: **PASS**, exit code `0`.

Evidence: ESLint reported `28 problems (0 errors, 28 warnings)`. Warnings include existing unused vars / hook dependency warnings in multiple files, including `components/Workbench.tsx`, but no errors.

### PASS - non-PTY focused tests

Command:

```sh
node --import tsx --test tests/tool-routing.test.ts tests/workbench-layout.test.ts tests/effort-level.test.ts tests/runtime-guardrails.test.ts
```

Result: **PASS**, exit code `0`.

Evidence: `tests 67`, `pass 66`, `fail 0`, `skipped 1`, duration `196.698708ms`.

### PASS - production build

Command:

```sh
npm run build
```

Result: **PASS**, exit code `0`.

Evidence: `✓ Compiled successfully`, `Finished TypeScript`, generated static pages, and finalized route output. Build emitted one known Turbopack NFT warning for `./next.config.ts -> ./lib/dispatch-runs.ts -> ./app/api/assistant/route.ts`.

### FAIL - full typecheck

Command:

```sh
npm run typecheck
```

Result: **FAIL**, exit code `1`.

Exact errors:

```text
tests/runtime-guardrails.test.ts(12,48): error TS2345: Argument of type '{}' is not assignable to parameter of type 'ProcessEnv'.
  Property 'NODE_ENV' is missing in type '{}' but required in type 'ProcessEnv'.
tests/runtime-guardrails.test.ts(22,46): error TS2345: Argument of type '{ AW_OUTPUT_TAIL_LINES: string; AW_OUTPUT_TAIL_BYTES: string; AW_OUTPUT_LINE_CHARS: string; AW_CHAT_TURNS_MAX: string; AW_CHAT_TURN_CHARS: string; AW_RESUME_SPECS_MAX: string; }' is not assignable to parameter of type 'ProcessEnv'.
  Property 'NODE_ENV' is missing in type '{ AW_OUTPUT_TAIL_LINES: string; AW_OUTPUT_TAIL_BYTES: string; AW_OUTPUT_LINE_CHARS: string; AW_CHAT_TURNS_MAX: string; AW_CHAT_TURN_CHARS: string; AW_RESUME_SPECS_MAX: string; }' but required in type 'ProcessEnv'.
```

Assessment: unrelated to the workspace close-X / unnamed workspace UX paths, but it is still a repo-level execution gate failure.

### BLOCKED - PTY lifecycle tests

Command:

```sh
npm run test:pty
```

Result: **BLOCKED/FAIL in sandbox**, exit code `1`.

Exact blocker repeated across all 9 tests:

```text
Error: listen EPERM: operation not permitted 127.0.0.1
code: 'EPERM',
syscall: 'listen',
address: '127.0.0.1'
```

Evidence: `tests 9`, `pass 0`, `fail 9`; failures occur before behavioral assertions because the test server cannot bind localhost in this sandbox.

## QA Notes

- The UI provides two close-X entry points: left workspace rail and top workspace switcher.
- Last-workspace deletion is guarded in both UI and server.
- The close confirmation copy states that files on disk are not deleted.
- Blank workspace names are rendered as `temporary workspace`, muted and italicized.
- Blank create with no cwd persists an empty name and home cwd; blank create with cwd derives the folder basename.
- No local browser/dev-server visual run was performed because this environment rejected localhost binding during PTY tests; `next build` did validate the frontend compile path.
