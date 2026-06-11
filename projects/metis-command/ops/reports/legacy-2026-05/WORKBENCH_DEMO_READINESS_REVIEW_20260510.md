# Workbench Demo Readiness Review - 2026-05-10

## Reviewed Inputs

- `WORKBENCH_PRODUCT_VISIBILITY_BUILD_20260510.md`
- `WORKBENCH_TELEGRAM_DELIVERY_BUILD_20260510.md`
- Current changed tree, including:
  - `components/Workbench.tsx`
  - `components/AssistantPanel.tsx`
  - `bridge/telegram.cjs`
  - `server/pty-server.ts`
  - `lib/pty-client.ts`
  - `lib/workspace-activity.ts`
  - `lib/effort-level.ts`
  - `lib/runtime-guardrails.ts`
  - focused tests under `tests/`

No push, deploy, external Telegram send, or live gateway action was performed.

## Readiness Decision

Ready for local demo/review with sandbox caveats.

The product visibility and Telegram bridge changes are coherent enough to show locally. The best demo is a controlled Workbench walkthrough plus local/stubbed Telegram bridge verification. Do not frame this as a production Telegram delivery sign-off yet, because native OpenClaw Telegram delivery durability and any live Telegram send path remain outside this pass.

## What Is Demo-Ready

- Workspace visibility:
  - Selected workspace shows active agent count, exited agent count, and open task count in the top workspace switcher.
  - Left workspace rail shows per-workspace agent activity and task status chips.
  - Workspace switcher dropdown shows compact per-workspace status chips.
  - Agent tabs now expose explicit status labels such as `active`, `starting`, and `exited <code>`.

- Workspace management:
  - Creating a workspace with a blank name is supported.
  - Blank name plus cwd derives the workspace display name from the folder.
  - Blank name without cwd creates a temporary/default-home workspace shown as `temporary workspace`.
  - Workspace close/delete UI is guarded against closing the last workspace and confirms before removing a workspace.

- Telegram standalone bridge hardening:
  - Final reply send uses plain text, avoiding Telegram Markdown parsing failures.
  - Telegram API non-2xx and `ok: false` responses now throw instead of silently dropping delivery.
  - Final delivery status is logged as `ok`, `failed`, or `skipped`.
  - Chat IDs are redacted in logs/status.
  - `AW_TG_MIRROR_FINAL=0` disables final mirroring while preserving inbound polling behavior.
  - `/api/assistant` provenance marker now reflects the actual final-mirror decision.

## What To Show In Demo

1. Open Workbench with at least two workspaces.
2. Show the top workspace switcher:
   - active/exited agent badges
   - open task count
   - compact dropdown chips per workspace
3. Show the left workspace rail:
   - task buckets: `todo`, `build`, `review`, `done`
   - active/exited agent visibility
   - cwd shortened to `~`
4. Create a workspace:
   - blank name plus cwd derives a folder name
   - blank name without cwd displays as `temporary workspace`
5. Close a non-last workspace:
   - confirmation dialog
   - last-workspace delete guard
6. Show agent tab status labels on a running or exited pane.
7. For Telegram, show the local test output rather than a live send:
   - chunked plain-text send behavior
   - failure propagation
   - skipped final mirror when disabled
   - assistant request body carrying `telegramBridge.mirrorFinal`

Avoid showing a live Telegram message unless a separate non-sandbox environment has secrets/config and explicit approval to send externally.

## Sandbox / IPC Blockers

- `npx tsx --test tests/workspace-activity.test.ts` is blocked by sandbox IPC:
  - failure: `listen EPERM .../T/tsx-501/...pipe`
  - this occurs before test code executes.

- `npm run test:pty` is blocked by sandbox loopback listening:
  - failure: `listen EPERM: operation not permitted 127.0.0.1`
  - all PTY lifecycle tests fail at local server bind setup before exercising assertions.

These are environment blockers, not observed product assertion failures. They should be rerun outside this sandbox or in a runner that permits local IPC pipes and loopback listeners.

## Checks Run

- `node --check bridge/telegram.cjs`
  - Passed.

- `node --test tests/telegram-bridge.test.mjs`
  - Passed: 5 tests.
  - Uses stubbed `fetch`; no external Telegram or assistant calls.

- `npm run typecheck`
  - Passed.

- `node --import tsx --test tests/workspace-activity.test.ts`
  - Passed: 3 tests.

- `node --import tsx --test tests/effort-level.test.ts tests/runtime-guardrails.test.ts`
  - Passed: 22 tests.

- `npx tsx --test tests/workspace-activity.test.ts`
  - Blocked by sandbox IPC pipe permission.

- `npm run test:pty`
  - Blocked by sandbox loopback listen permission.

## Remaining Review Risks

- No visual browser pass was performed in this lane. The workspace switcher and left rail should still be checked at narrow and normal widths with multiple task buckets populated.
- PTY workspace create/delete lifecycle tests could not run in this sandbox due loopback bind restrictions.
- Native OpenClaw Telegram plugin delivery, retry, queue, and gateway behavior were not changed or verified.
- The standalone bridge tests are stubbed and prove request/response handling, not Telegram service reachability.
- Workspace deletion removes the workspace and stops agents, but persisted adjacent per-workspace data such as tasks/layout/notes may still need a cleanup policy review before release hardening.

## Recommendation

Proceed to local demo/review with the scope above. Label Telegram as "Workbench standalone bridge hardened, live/native delivery not yet signed off." Before broader release, rerun the PTY lifecycle suite and TSX CLI tests in an environment with local IPC and loopback permissions, then do one browser walkthrough of the workspace/task chips and workspace close flow.
