# Workbench Telegram Delivery Build - 2026-05-10

## Scope

Inspected and hardened the Agent Workbench-side Telegram final-delivery path. This pass did not change OpenClaw gateway config, did not push, did not deploy, and did not perform any external Telegram sends.

Secrets remain redacted. No bot tokens, bridge keys, or raw chat ids are recorded in this report.

## Inspection Findings

The current Workbench-owned Telegram delivery path is the standalone bridge at `bridge/telegram.cjs`.

Already-present hardening in this working tree:

- Telegram `sendMessage` responses are checked for non-2xx HTTP status and Telegram JSON `ok: false`.
- Final reply sends go through `deliverFinalReply`.
- Final delivery is logged as `status=ok`, `status=failed`, or `status=skipped`.
- Chat ids in bridge logs and status objects are redacted as `chat:****NNNN`.
- Assistant output is sent as plain text, avoiding Telegram Markdown parse failures for arbitrary model output.
- `AW_TG_MIRROR_FINAL=0` disables final reply mirroring while leaving inbound polling available.

The remaining Workbench-side gap was in the bridge-to-assistant provenance marker: `/api/assistant` was always called with `telegramBridge.mirrorFinal: true`, even when final mirroring was disabled locally.

## Changes Made

### Mirror marker now matches the actual opt-in state

`bridge/telegram.cjs` now lets `callAssistant` accept an optional `mirrorFinal` override and defaults it to the bridge-level `AW_TG_MIRROR_FINAL` setting.

The request body sent to `/api/assistant` now carries:

- `telegramBridge.source: "telegram"`
- `telegramBridge.mirrorFinal: <actual mirror decision>`
- `telegramBridge.finalDelivery: "standalone-bridge"`

This is intentionally a provenance/status marker for the Workbench bridge path. The Workbench assistant endpoint currently ignores unknown fields, so this remains non-breaking.

### Testability hardened without live sends

`callAssistant` now accepts optional `fetchImpl` and `awUrl` overrides. The focused tests can verify the assistant request body without making network calls.

## Tests Added

Added focused bridge tests in `tests/telegram-bridge.test.mjs`:

- explicit mirror opt-in is included in the assistant request body
- disabled mirror state is included as `mirrorFinal: false`

Existing focused tests also cover:

- plain-text chunked Telegram sends with delivery status
- Telegram API failures throwing instead of being silently dropped
- explicit final-mirror skip returning a skipped status without calling `fetch`

## Verification

Commands run:

```bash
node --check bridge/telegram.cjs
node --test tests/telegram-bridge.test.mjs
```

Result:

- syntax check passed
- 5 focused Telegram bridge tests passed
- all Telegram and assistant calls in tests used stubbed `fetch`
- no external sends occurred

## Files Changed

- `bridge/telegram.cjs`
- `tests/telegram-bridge.test.mjs`
- `WORKBENCH_TELEGRAM_DELIVERY_BUILD_20260510.md`

## Boundaries

This build hardens the standalone Workbench Telegram bridge only.

Not changed in this pass:

- Native OpenClaw Telegram plugin send/retry/queue behavior
- Control UI automatic Telegram mirroring
- Gateway config, channel config, tokens, chat ids, deployment state, or remote services

The native OpenClaw Telegram path still needs core-side delivery durability if final/block replies must survive transient Telegram send failures.
