# Dev Review

Standalone **frontend review console** for Metis OS: render the UI under review,
click-to-annotate it, and drive a coding agent on those annotations, one window.
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

- **Same-origin proxy** (`middleware.ts`): localhost ports are *cross*-origin, so
  the target is proxied through this app's own origin: `/__preview` → target root,
  any other path falls through to the target (`dr-target` cookie holds the origin).
  That makes `iframe.contentDocument` legally touchable.
- **Overlay** (`lib/overlay-controller.ts`): parent-side controller on the iframe
  DOM (no script injection): element picker with hover outline, uniqueness-verified
  selector generation (id → data-attr → stable classes → nth-of-type; hashed-class
  filter), numbered pins, MutationObserver re-anchor. Pins whose selector stops
  matching go **orphaned** explicitly, never silently wrong.
- **Annotations** (`lib/review-store.ts`): `{selector, comment, rect, styles, url,
  severity, status}`; autosaved to `~/.openclaw/dev-review/sessions/<slug>.json`
  (also the agent-readable artifact).
- **Agent handoff**: "to agent" types a structured prompt (numbered items +
  selectors + session-file path) into a real claude PTY via the sidecar.
- **Orphan re-pick (#257)**: orphaned pins aren't dead ends: the crosshair on
  an orphaned card arms re-pick; the next element you click in the preview
  re-anchors that annotation (comment/severity preserved, selector/rect/styles/
  text/crop refreshed, status back to open).
- **Pin-time crops (#256)**: pinning fire-and-forgets a sidecar capture
  (playwright-core headless Chrome): an element PNG lands beside the session
  file, shows as a rail thumbnail, and is cited as `crop:` in the agent prompt,
  visual ground truth that survives selector orphaning. The sidecar also exposes
  `POST /preview/verify` for headless selector checks.
- **Round-trip verify (#258)**: sending arms a run-complete watcher (polls the
  sidecar's output byte counter; output-then-quiet ≥10s = done). On completion
  the preview auto-reloads and every pin re-verifies: `changed` (style/text
  diff vs pin-time baseline, surfaced in the rail for the human call), `open`
  (untouched), or `orphaned`. The rail's summary strip shows the last pass;
  review is done when pins verify, not when the agent says done.
- **Sidecar trust gate (#259)**: the PTY sidecar (it spawns real shells) is
  default-deny: every HTTP route *and* the WS upgrade require a shared-secret
  token (`x-dev-review-token` header; for browser WS the token rides the
  `Sec-WebSocket-Protocol` field, never the URL). Token comes from
  `DEV_REVIEW_SIDECAR_TOKEN` or is auto-minted 0600 at
  `~/.openclaw/dev-review/sidecar-token`; the console serves it to its own
  pages via same-origin `/api/sidecar-token`, and crop thumbnails load through
  authenticated fetch → object URLs. The sidecar never serves its own token.

## Run

```bash
npm install
npm run dev    # web :3760 + pty :3761
npm run app    # desktop (Electron)
npm test       # pty lifecycle + selector heuristics + sidecar auth
python3 scripts/e2e-verify.py   # full interaction chain vs a live target (25 checks)
```

## Known limits

- Target WS/HMR isn't proxied; reload the preview after target rebuilds.
- Pages sending `X-Frame-Options`/`frame-ancestors` won't iframe (not our targets).
- The proxied page's links to its own `/` collide with the console shell; deep
  links work, root navigation belongs in the URL bar.
- The console origin (:3760) is the trust boundary: any client that can load
  the console can fetch the sidecar token from `/api/sidecar-token`. The #259
  gate makes :3761 independently safe; exposing the console beyond the tailnet
  still requires auth in front of :3760 (out of scope until then).
