# Workbench Slice — EFFORT SELECTOR for spawn

**Date:** 2026-05-09 (CT)
**Forge:** Workbench Slice-#3 (effort-selector)
**Branch:** `slice/effort-selector` → pushed to origin
**Final HEAD:** `a6fd247 feat(spawn): per-pane effort level selector` (rebased onto `origin/slice/risk-tier-prompt-wrapper @ 7f967b3`)

## Summary

Adds an optional per-spawn `effortLevel` (`low | medium | high | extra-high | max`) to `POST /agents`, with backend-aware CLI flag mapping. `medium` is the default and intentionally produces zero flags, so existing spawn behavior is unchanged when callers omit the field.

## Changes

| File | Status | Lines |
|---|---|---|
| `lib/effort-level.ts` | new | 64 |
| `tests/effort-level.test.ts` | new | 113 |
| `server/pty-server.ts` | modified | +10 |

Net diff: 3 files, +187 insertions.

### `lib/effort-level.ts`
- `EffortLevel` union, `EFFORT_LEVELS` array, `DEFAULT_EFFORT_LEVEL = 'medium'`.
- `isEffortLevel(v)` and `coerceEffortLevel(v)` for safe input narrowing.
- `effortFlagsForKind(kind, level)` — pure function, returns CLI flags per backend:
  - **claude** → `['--append-system-prompt', '# Effort\n<budget hint>']` (no native effort flag)
  - **codex** → `['--effort', <level>]` (extra-high/max collapse to `high`; codex caps at high)
  - **shell / python / gemini / custom** → `[]`
  - **medium** → `[]` for every backend (baseline / no-op)

### `server/pty-server.ts`
- Imports `coerceEffortLevel`, `effortFlagsForKind`, `type EffortLevel`.
- `spawnAgent` input now accepts `effortLevel?: EffortLevel`; flags are appended to `args` after all existing manipulation (role/initialPrompt/notes/MCP/risk-tier).
- `POST /agents` body now reads `effortLevel` and passes it through `coerceEffortLevel(...)` (unknown values fall back to medium).

## Tests

`tests/effort-level.test.ts` — 13 cases across 5 describes:

| Suite | Cases |
|---|---|
| constants | 4 (canonical levels, default = medium, isEffortLevel narrowing, coerceEffortLevel fallback) |
| claude backend | 5 (one per level: low/medium/high/extra-high/max) |
| codex backend | 5 (one per level; verifies extra-high/max collapse to high) |
| no-op backends | 4 (shell/python/gemini/custom × all 5 levels each) |
| no-mutation | 1 (returns a fresh array per call) |

## Evidence

```
$ npm run typecheck
> tsc --noEmit
(exit 0)

$ npm test  (after rebase onto risk-tier branch)
ℹ tests 105
ℹ suites 23
ℹ pass 104
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1   (pre-existing TODO test, not introduced by this slice)
ℹ duration_ms 2297.262458
```

New effort-level suite excerpt:
```
▶ effort-level / constants                    ✔ (1.7ms)
▶ effort-level / claude backend               ✔ (0.5ms)
▶ effort-level / codex backend
  ✔ low → --effort low
  ✔ high → --effort high
  ✔ extra-high → --effort high (codex caps at high)
  ✔ max → --effort high (codex caps at high)
▶ effort-level / no-op backends
  ✔ shell → no flags for any effort level
  ✔ python → no flags for any effort level
  ✔ gemini → no flags for any effort level
  ✔ custom → no flags for any effort level
▶ effort-level / does not mutate caller args  ✔
```

## Coordination notes

1. Branched from `origin/init-snapshot-2026-05-09` per the no-collision spec.
2. A **third concurrent agent** (not the risk-tier one) had switched the shared working directory to `slice/summarize-portfolio-tool` mid-edit. To avoid corrupting either of their workstreams, I materialized `slice/effort-selector` in a separate `git worktree` at `/tmp/aw-effort-wt/effort`, copied my three files in, ran typecheck + tests there, committed, rebased, and pushed without touching the original working tree's modifications. Worktree cleaned up at end.
3. Because my edits land in `server/pty-server.ts` (the spawn handler), I rebased onto `origin/slice/risk-tier-prompt-wrapper`. Two textual conflicts in `server/pty-server.ts` — one in the import block, one in the `POST /agents` body — both clean to resolve (additive on both sides). Resolved, re-ran typecheck (clean) and tests (104 pass / 0 fail / 1 pre-existing skip), then pushed.

## Forbidden actions — confirmed avoided

- ❌ Did not edit `lib/risk-tier.ts`.
- ❌ Did not run `npm install`.
- ❌ Did not push to `main`.
- ❌ Did not disturb the concurrent agent's uncommitted work on `slice/summarize-portfolio-tool` (used isolated worktree).

## Follow-ups (out of scope for this slice)

- UI surface in the spawn panel: a 5-option select bound to `effortLevel`. Currently the field is server-accepted but no Workbench UI sends it.
- Persist `effortLevel` on the `Agent` meta and include it in `resumeSpecs` so reopening a workspace restores per-pane effort.
- Optional: extend codex mapping with `-c model_reasoning_effort=<level>` as a fallback if a future codex CLI version drops `--effort`.
