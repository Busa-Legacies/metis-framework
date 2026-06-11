# Workbench P1 Product Build — Codex — 2026-05-09

## Scope

Implemented one small P1 productization improvement from
`WORKBENCH_NEXT_LANE_QA_CLAUDE_20260509.md`: atomic persistence for
dispatch-run ledger files.

This helps Nick supervise product builds/agents by protecting
`data/dispatch-runs/<workspace>.json`, the durable record behind
dispatch status, spawned agent ids, retryable failures, and cockpit
summary visibility, from direct-write truncation if the process dies
mid-write.

No push, deploy, install, or outside-repo changes.

## Files Changed

- `lib/dispatch-runs.ts`
  - Replaced direct `fs.writeFileSync(file, ...)` persistence with a
    same-directory temp write followed by `fs.renameSync(tmp, file)`.
  - Temp file names include process id, wall-clock time, and monotonic
    `hrtime` suffix to avoid same-millisecond collisions.
  - Failed/interrupted writes attempt to remove only the temp file,
    leaving the previous final JSON file untouched.

- `tests/tool-routing.test.ts`
  - Added focused coverage that dispatch-run persistence goes through a
    same-directory atomic rename.
  - Verifies no temp file residue remains and the final workspace JSON
    is parseable.

- `memory/working-context.md`
  - Checkpointed the lane, changed files, verification, and remaining
    risks for compaction-safe continuity.

## Tests

Passed:

```bash
node --import tsx --test tests/tool-routing.test.ts
```

Result: 41 pass / 1 existing skipped placeholder / 0 fail.

Passed:

```bash
npm run typecheck
```

Result: clean `tsc --noEmit`.

## Remaining Risks

- Host-only real-browser acceptance remains unchanged and still needs a
  host with loopback bind permission.
- This lane intentionally did not implement the other P1s from the QA
  note: cockpit GET auth-parity test and close-pane scrollback policy.
- Atomic rename protects against partial final-file writes on the same
  filesystem. It does not add cross-process locking; concurrent writes
  still follow the existing last-writer-wins model.

## Verdict

P1 dispatch-run atomic persistence is implemented and source-tested.
