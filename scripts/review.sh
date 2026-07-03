#!/usr/bin/env bash
# review.sh — screenshot a URL or local file so Claude Code can SEE it.
# Auto-installs the browser tooling on first use (npm, ~6s). No paid service,
# no Playwright CDN (firewalled) — chromium ships inside the npm package.
#
#   scripts/review.sh <url|path> [out.png] [width=.. height=.. advance=.. full=1]
#
# Examples:
#   scripts/review.sh decks/metis/index.html /tmp/metis.png
#   scripts/review.sh decks/example/index.html /tmp/n.png advance=2
#   scripts/review.sh https://busa-legacies.github.io/decks/ /tmp/live.png
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$ROOT/tools/browser"
if [ ! -d "$DIR/node_modules/@sparticuz/chromium" ]; then
  echo "[review] installing browser tooling (first run)…" >&2
  ( cd "$DIR" && npm i --silent )
fi
node "$DIR/shot.mjs" "$@"
