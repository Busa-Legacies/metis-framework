# Dev Review

Standalone **frontend review console** for Metis OS: render the UI under review,
click-to-annotate it, and drive a coding agent on those annotations — one window.
Spun off from [Metis Command](../metis-command/) (same Electron + Next.js + PTY
sidecar skeleton) as a dedicated app. Plan + decisions:
`docs/plans/PLAN-dev-review-console.md` (#185).

## Layout

```
┌─ preview (:3760 same-origin proxy) ─┬─ annotations ─┬─ agent PTY ─┐
│  iframe of the app under review     │  pins, sever- │  real claude │
│  + picker overlay (hover/click)     │  ity, resolve │  process     │
│  + numbered pin badges              │  send-to-agent│  (:3761)     │
└─────────────────────────────────────┴───────────────┴──────────────┘
```

## How it works

- **Same-origin proxy** (`middleware.ts`) — localhost ports are *cross*-origin, so
  the target is proxied through this app's own origin: `/__preview` → target root,
  any other path falls through to the target (`dr-target` cookie holds the origin).
  That makes `iframe.contentDocument` legally touchable.
- **Overlay** (`lib/overlay-controller.ts`) — parent-side controller on the iframe
  DOM (no script injection): element picker with hover outline, uniqueness-verified
  selector generation (id → data-attr → stable classes → nth-of-type; hashed-class
  filter), numbered pins, MutationObserver re-anchor. Pins whose selector stops
  matching go **orphaned** explicitly — never silently wrong.
- **Annotations** (`lib/review-store.ts`) — `{selector, comment, rect, styles, url,
  severity, status}`; autosaved to `~/.openclaw/dev-review/sessions/<slug>.json`
  (also the agent-readable artifact).
- **Agent handoff** — "to agent" types a structured prompt (numbered items +
  selectors + session-file path) into a real claude PTY via the sidecar.

## Run

```bash
npm install
npm run dev    # web :3760 + pty :3761
npm run app    # desktop (Electron)
npm test       # pty lifecycle + selector heuristics
python3 scripts/e2e-verify.py   # full interaction chain vs a live target (8 checks)
```

## Known limits

- Target WS/HMR isn't proxied — reload the preview after target rebuilds.
- Pages sending `X-Frame-Options`/`frame-ancestors` won't iframe (not our targets).
- The proxied page's links to its own `/` collide with the console shell — deep
  links work, root navigation belongs in the URL bar.
