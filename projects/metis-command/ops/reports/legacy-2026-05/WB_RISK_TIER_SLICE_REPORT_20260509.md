# Workbench Risk-Tier Prompt Wrapper — Slice Report
**Date:** 2026-05-09 (CT)
**Branch:** `slice/risk-tier-prompt-wrapper`
**Base:** `origin/init-snapshot-2026-05-09`
**Commit:** `7f967b3` — `feat(spawn): risk-tier prompt wrapper (deep-dive + plan for high-risk tasks)`
**Pushed:** yes (`origin/slice/risk-tier-prompt-wrapper`)

## Slice scope (Vibecademy-inspired #2)
Add a `riskTier: "low" | "high"` tag on agent spawn. When `high`, wrap the
operator-supplied `initialPrompt` with a deep-dive + plan-first preamble and a
stop-and-replan postamble before forwarding it into `spawnAgent`. `low` is the
default and pass-through.

No new dependencies. No edits to the cockpit-rollup files reserved for the
adjacent agent (`lib/cockpit-summary.ts`, `lib/portfolio-render.ts`,
`lib/cockpit-to-rollup.ts`, `tests/cockpit-to-rollup.test.ts`).

## Diffstat
```
 lib/risk-tier.ts        | 34 +++++++++++++++++++++++++
 server/pty-server.ts    |  8 +++++-
 tests/risk-tier.test.ts | 68 +++++++++++++++++++++++++++++++++++++++++++++++++
 3 files changed, 109 insertions(+), 1 deletion(-)
```

## Wrapper template (verbatim)
The wrapper produces, for `tier === "high"` and a non-empty trimmed prompt:

```
Do a deep dive with 2-3 sub-agents and create a structured plan first. DO NOT break existing functionality. Then implement the plan.

<original prompt>

If at any point you discover the change is riskier than expected, stop and write a plan rather than continue.
```

Constants (exported from `lib/risk-tier.ts`):
- `HIGH_RISK_PREAMBLE = "Do a deep dive with 2-3 sub-agents and create a structured plan first. DO NOT break existing functionality. Then implement the plan."`
- `HIGH_RISK_POSTAMBLE = "If at any point you discover the change is riskier than expected, stop and write a plan rather than continue."`

Edge behavior:
- `tier === "low"` → returns the input prompt **unchanged** (whitespace and empty preserved).
- `tier === "high"` with empty/whitespace-only prompt → returns `${PREAMBLE}\n\n${POSTAMBLE}` (no triple blank lines, no `undefined`).
- `tier === "high"` and the prompt already begins with `HIGH_RISK_PREAMBLE` → returns the prompt unchanged. **Idempotent** — re-wrapping does not stack the template.

## Server wiring (`server/pty-server.ts` POST `/agents`)
```ts
const riskTier = isRiskTier(body.riskTier) ? body.riskTier : 'low'
const rawPrompt = typeof body.initialPrompt === 'string' ? body.initialPrompt : undefined
const initialPrompt = rawPrompt && riskTier === 'high'
  ? wrapPromptForRiskTier(rawPrompt, 'high')
  : rawPrompt
// …spawnAgent({ …, initialPrompt })
```
- Optional `riskTier` field in the request body (default `low`).
- Wrapping happens **before** `spawnAgent`, so the existing claude
  `--append-system-prompt` and codex `exec` flows receive the wrapped text
  without further changes.
- Invalid tier values fall back to `low` (no 400) — keeps the contract
  forward-compatible if a future tier is added.

## Test results
`npm run typecheck` → exit 0.

`npm test` summary:
```
ℹ tests 86
ℹ suites 18
ℹ pass 85
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 2284.15
```
The single skipped test (`surfaces originWorkspaceId once session-metadata propagation lands`) is pre-existing and unrelated to this slice. Six new cases under `wrapPromptForRiskTier` and `isRiskTier` all pass.

New cases (`tests/risk-tier.test.ts`):
1. low passes through unchanged
2. low preserves whitespace and empty input
3. high prepends preamble + appends postamble + preserves original
4. high wrap is idempotent (preamble appears exactly once on re-wrap)
5. high handles empty/whitespace prompts without producing junk
6. `isRiskTier` accepts `"low"`/`"high"` and rejects everything else

## No-collision audit
Files touched:
- `lib/risk-tier.ts` (new)
- `tests/risk-tier.test.ts` (new)
- `server/pty-server.ts` (added one import + 4-line block in POST `/agents`)

Reserved files **not** touched:
- `lib/cockpit-summary.ts`
- `lib/portfolio-render.ts`
- `lib/cockpit-to-rollup.ts`
- `tests/cockpit-to-rollup.test.ts`

`git diff origin/init-snapshot-2026-05-09 -- lib/cockpit-summary.ts lib/portfolio-render.ts lib/cockpit-to-rollup.ts tests/cockpit-to-rollup.test.ts` → empty.

## Constraints honored
- Branch from `origin/init-snapshot-2026-05-09`: ✅
- No `npm install` / new deps: ✅ (only `node:test`/`node:assert`, already in repo)
- No push to `main`: ✅ (pushed to `slice/risk-tier-prompt-wrapper`)
- No deploy: ✅
- Cap budget $1.50: respected (single-shot implementation, no agent fan-out).

## Suggested follow-ups (not in this slice)
- Surface `riskTier` in the spawn UI (chip/dropdown) so operators can flag
  high-risk tasks without hand-editing API calls.
- Persist the chosen tier on the agent metadata so it shows up in the cockpit
  rollup (could feed Vibecademy-style "deep-dive completed" telemetry).
- Add a "medium" tier later if Nick wants a softer wrapper (caution-only,
  no sub-agent mandate).
