# Workbench Telegram Routing Investigation - 2026-05-10

## Scope

Read-only investigation of why user-facing replies from Telegram-origin and Control UI sessions are not consistently arriving in Telegram. I inspected OpenClaw logs/config and Agent Workbench bridge/docs/source evidence only. I did not change gateway config.

## Verdict

Primary cause: **Telegram plugin send failure**, with a separate **UI mirror gap** for Control UI / Agent Workbench sessions.

Not the primary cause: source-surface routing alone. Workbench and Control UI are intentionally isolated from Telegram delivery unless a caller explicitly asks OpenClaw to send to Telegram or uses the standalone Workbench Telegram bridge.

Not proven: deliveryContext mismatch as a runtime bug. The evidence shows Workbench sends `deliver: false` with `surface: agent-workbench`, so Telegram delivery is absent by design for Workbench-origin replies. That becomes a product gap only when a Telegram-origin session is continued from Control UI and the operator expects the final answer to mirror back to Telegram.

## Evidence

### OpenClaw config has Telegram enabled

Source: `/Users/jarvis/.openclaw/openclaw.json` read-only snapshot.

- `plugins.allow` includes `telegram`.
- `plugins.entries.telegram.enabled` is `true`.
- `channels.telegram.enabled` is `true`.
- `channels.telegram.commands.native` and `nativeSkills` are `false`.
- `channels.telegram.streaming.mode` is `off`.
- `channels.telegram.retry` is configured with 8 attempts, 750ms minimum delay, 12000ms maximum delay, jitter 0.35.
- `channels.telegram.timeoutSeconds` is 90.
- `channels.telegram.pollingStallThresholdMs` is 45000.
- Bot token and allowlisted chat id exist but are redacted here.

This means Telegram delivery is expected to be available through the native OpenClaw Telegram channel, but command registration is intentionally disabled and streaming is off.

### The logs show explicit Telegram send failures

Source: `/Users/jarvis/.openclaw/logs/gateway.err.log`.

Recent failures on 2026-05-10:

- line 15998: `2026-05-10T13:25:00.728-05:00 [telegram] sendMessage failed: Network request for 'sendMessage' failed!`
- line 15999: `2026-05-10T13:25:00.731-05:00 [telegram] final reply failed: HttpError: Network request for 'sendMessage' failed!`
- lines 16000-16007: repeated `sendMessage failed`, `final reply failed`, and `message processing failed`.
- line 16044: `2026-05-10T17:17:10.356-05:00 [telegram] sendMessage failed: Network request for 'sendMessage' failed!`
- line 16045: `2026-05-10T17:17:10.356-05:00 [telegram] block reply failed: HttpError: Network request for 'sendMessage' failed!`
- lines 16056-16057: another `sendMessage failed` / `final reply failed`.
- lines 16085-16090: repeated `sendMessage failed`, `final reply failed`, and `message processing failed`.

The same file also shows polling instability around those failures:

- line 16032: `Polling stall detected (no completed getUpdates for 51.83s); forcing restart.`
- line 16058: `Polling stall detected (no completed getUpdates for 47.37s); forcing restart.`
- line 16072: `Polling stall detected (no completed getUpdates for 77.37s); forcing restart.`

This is direct evidence that some replies are generated but fail at Telegram channel delivery.

### The logs also show Telegram can succeed

Source: `/Users/jarvis/.openclaw/logs/gateway.log`.

- line 24203: `2026-05-10T17:14:11.263-05:00 [telegram] sendMessage ok ... message=17085`
- line 24210: `2026-05-10T17:16:11.913-05:00 [telegram] sendMessage ok ... message=17087`
- line 24233: `2026-05-10T17:22:46.634-05:00 [telegram] sendMessage ok ... message=17090`

So the Telegram plugin is not globally disabled. Delivery is intermittent.

### Control UI webchat is a separate surface

Source: `/Users/jarvis/.openclaw/logs/gateway.log`.

- line 24212: `2026-05-10T17:17:07.660-05:00 [ws] webchat connected ... client=openclaw-control-ui webchat vcontrol-ui`
- lines 24213-24218: Control UI requested commands/models/node/device/session/chat history.
- lines 24227, 24231-24232, 24247, 24253, 24258, 24266, 24273-24274: repeated `chat.history` responses for that webchat connection.

Only explicit Telegram actions are logged as Telegram channel sends:

- line 24230: `message.action ... channel=telegram`
- line 24275: `message.action ... channel=telegram`

This supports the UI mirror gap: Control UI activity is visible in webchat history, but it is not automatically mirrored to Telegram unless a Telegram channel action is invoked.

### Agent Workbench explicitly suppresses gateway delivery

Source: `lib/openclaw-gateway.ts`.

- lines 223-230 call `chat.send` with `sessionKey`, `message`, `metadata`, `deliver: false`, `timeoutMs`, and `idempotencyKey`.
- lines 223-226 comment that Workbench must not default to `main` because `main` can carry Telegram/WebChat delivery context.

Source: `app/api/assistant/route.ts`.

- lines 505-512 build gateway metadata with `surface: 'agent-workbench'` and workspace/pane context.
- lines 727 and 735 use `buildWorkbenchSessionKey(activeWorkspaceId)` for gateway chat.
- lines 683-684 tell Jarvis this is an isolated Agent Workbench session and not to route Workbench directives to Telegram.

Source: `lib/workbench-session.ts`.

- lines 9-12 build `workbench:<workspaceId>` / `workbench:global`.
- lines 14-16 reserve `main`, `default`, `telegram`, and `telegram:*` as non-Workbench keys.

This is not a broken deliveryContext by itself. It is an explicit isolation design: Workbench-origin assistant replies return to the Workbench HTTP caller and UI, not to Telegram.

### Agent Workbench UI stores replies locally, not to Telegram

Source: `components/AssistantPanel.tsx`.

- lines 584-592 POST to `/api/assistant` with `activeWorkspaceId`, `messages`, `persona`, and `auto`.
- lines 598-604 append the returned assistant reply to local UI state.
- lines 527-535 persist chat locally through `ptyApi.putChat`.

There is no Telegram mirror call in this UI path.

### The standalone Workbench Telegram bridge can silently drop sends

Source: `bridge/telegram.cjs`.

- lines 52-62 chunk text and call Telegram `sendMessage`.
- line 61 catches and ignores send errors: `await tg('sendMessage', ...).catch(() => {})`.
- lines 136-138 log that a reply is being sent and then call `sendMessage`.

If this standalone bridge is the path used for Telegram-origin Workbench sessions, Telegram API/network/Markdown failures can result in no Telegram arrival while the bridge reports no actionable send error.

## Classification

| Candidate | Finding |
| --- | --- |
| Source-surface routing | Partial contributor. Workbench and Control UI are distinct surfaces and do not auto-mirror to Telegram. This is intentional isolation, not the primary failure in the native Telegram channel. |
| deliveryContext mismatch | Not proven as a bug. Workbench deliberately sends `deliver: false` and `surface: agent-workbench`; there is no Telegram delivery context to preserve. For Telegram-origin sessions continued from Control UI, the missing mirror is a product contract gap. |
| Plugin send failure | Confirmed. OpenClaw logs show repeated `sendMessage failed` and `final reply failed` during 2026-05-10 incidents, with polling stalls and chat-action failures nearby. |
| UI mirror gap | Confirmed. Control UI webchat and Agent Workbench local assistant replies are not automatically sent to Telegram; only explicit `message.action channel=telegram` appears in gateway logs. |

## Recommended Fix

1. Fix Telegram delivery reliability in the OpenClaw Telegram plugin first.
   - Treat `sendMessage failed` and `final reply failed` as delivery incidents with structured retry/backoff result logging.
   - Add a durable outbound Telegram queue or retry ledger for final/block replies so generated replies are not lost when Telegram network calls fail.
   - Keep current gateway config unchanged until the plugin failure mode is fixed and observable.

2. Add an explicit mirror contract for Control UI / Workbench sessions.
   - Add an opt-in "mirror this reply to Telegram" action from Control UI / Workbench rather than relying on implicit source-surface routing.
   - If a Control UI operator is acting on a Telegram-origin session, preserve the original Telegram channel target as explicit metadata and call a Telegram send action at final response time.
   - Keep Workbench default isolation (`workbench:*`, `deliver:false`) for non-Telegram workbench sessions.

3. Harden the standalone `bridge/telegram.cjs` send path.
   - Stop swallowing `sendMessage` errors.
   - Log Telegram API response failures, including parse-mode errors.
   - Consider plain text or escaped Markdown, because the bridge currently sends `parse_mode: 'Markdown'` for arbitrary assistant output.

## Minimal Acceptance Test

- Native Telegram path: force or simulate one transient `sendMessage` failure and verify the final reply is retried or queued, with a visible delivery status.
- Control UI path: continue a Telegram-origin session in Control UI and verify that no Telegram send occurs unless explicit mirror metadata/action is present.
- Workbench path: send a Workbench-only assistant turn and verify it remains local (`workbench:*`, `deliver:false`) unless explicit mirror is requested.
