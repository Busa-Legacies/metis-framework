# Workbench Telegram Final Delivery Fix - 2026-05-10

## Scope

Implemented the smallest safe Agent Workbench-side fix for Telegram response reliability in the standalone bridge at `bridge/telegram.cjs`.

No gateway config was changed. No tokens or chat ids are recorded here. No external Telegram sends were made during verification; tests stubbed `fetch`.

## Workbench-Side Fix

### Standalone bridge final delivery is now observable

`bridge/telegram.cjs` now records an explicit final-delivery result for assistant replies sent by the Workbench Telegram bridge:

- `final_delivery status=ok ... chunks=N`
- `final_delivery status=failed ... chunk=X/Y ...`
- `final_delivery status=skipped ... reason=mirror_final_disabled`

The bridge redacts chat ids in logs and status objects.

### Telegram send failures are no longer silently dropped

The bridge now treats Telegram API failures as delivery failures:

- non-2xx HTTP responses throw
- Telegram JSON responses with `ok: false` throw
- failed chunks include chunk position metadata
- arbitrary assistant output is sent as plain text, not Telegram Markdown

This closes the Workbench bridge failure mode described in the investigation where `sendMessage` errors could be caught and ignored.

### Final mirroring is explicit for this bridge path

Running the standalone bridge is the explicit Workbench-side opt-in to Telegram final delivery. It remains enabled by default for backward compatibility, because the bridge's purpose is to reply to Telegram-origin messages.

Operators can disable final reply mirroring without disabling inbound polling:

```bash
AW_TG_MIRROR_FINAL=0 node bridge/telegram.cjs
```

When disabled, assistant replies are not sent to Telegram and the bridge logs `final_delivery status=skipped`.

The bridge also sends an explicit `telegramBridge` marker in the `/api/assistant` request body:

- `source: "telegram"`
- `mirrorFinal: true`
- `finalDelivery: "standalone-bridge"`

Current Workbench assistant handling ignores unknown request fields, so this is a non-breaking provenance marker rather than a core routing change.

## Files Changed

- `bridge/telegram.cjs`
- `tests/telegram-bridge.test.mjs`

## Verification

Commands run:

```bash
node --check bridge/telegram.cjs
node --test tests/telegram-bridge.test.mjs
```

Result:

- syntax check passed
- 3 focused bridge delivery tests passed
- tests used stubbed `fetch`; no external sends occurred

## What Still Requires Core OpenClaw Changes

This Workbench-side fix only covers the standalone Workbench Telegram bridge. It does not fix native OpenClaw Telegram plugin failures or implicit Control UI mirroring.

Precise core patch plan:

1. In the OpenClaw Telegram plugin send path, wrap every final/block reply send in a durable delivery operation that records:
   - channel
   - redacted target id
   - reply type
   - attempt count
   - final status: `ok`, `retrying`, `failed`, or `queued`
   - last error class/message

2. Replace direct one-shot `sendMessage` calls for final replies with retry/queue semantics:
   - retry transient network failures with the configured backoff
   - persist unsent final replies to an outbound Telegram queue before marking the run complete
   - replay queued replies when polling/send connectivity recovers

3. Make Control UI / WebChat Telegram mirroring explicit:
   - preserve Telegram-origin target metadata on sessions that are opened in Control UI
   - add an operator action or request flag such as `mirrorFinalToTelegram: true`
   - send through the Telegram channel only when that flag is present
   - keep Workbench `workbench:*` sessions isolated and `deliver:false` by default

4. Add acceptance tests:
   - simulate one transient Telegram `sendMessage` failure and verify retry or queue status
   - continue a Telegram-origin session in Control UI and verify no send occurs without explicit mirror opt-in
   - verify explicit mirror opt-in sends once and records final delivery status
