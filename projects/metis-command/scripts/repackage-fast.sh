#!/usr/bin/env bash
# Fast repackage: rebuild Next from source and swap the bundle into the
# already-installed Electron .app. Avoids a full electron-builder run.
#
# Use after editing TSX/TS files to push UI/server changes into the running app.
# Usage:  npm run repackage:fast
#
# After running, restart the workbench app (Cmd+Q + reopen, or
#   pkill -f "Agent Workbench.app/Contents/MacOS/Agent Workbench" && \
#   open "dist-app/mac-arm64/Agent Workbench.app")
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP_DIR="$ROOT/dist-app/mac-arm64/Agent Workbench.app/Contents/Resources/app"

if [[ ! -d "$APP_DIR" ]]; then
  echo "✗ packaged app not found at:" >&2
  echo "  $APP_DIR" >&2
  echo "  Run a full build first: npm run app:dist:dir" >&2
  exit 1
fi

echo "→ next build (source repo)"
npm run build

TS="$(date +%Y%m%d-%H%M%S)"

# 1. Swap compiled UI bundle
echo "→ swapping .next bundle"
mv "$APP_DIR/.next" "$APP_DIR/.next.bak-$TS"
cp -R "$ROOT/.next" "$APP_DIR/.next"

# 2. Mirror runtime TS files (loaded via --experimental-strip-types at startup)
echo "→ mirroring server/ and lib/"
cp -R "$ROOT/server"/* "$APP_DIR/server/" 2>/dev/null || true
mkdir -p "$APP_DIR/lib"
cp -R "$ROOT/lib"/* "$APP_DIR/lib/" 2>/dev/null || true

# 3. Mirror Electron main + preload (rare but possible)
if [[ -d "$ROOT/electron" ]]; then
  cp -R "$ROOT/electron"/* "$APP_DIR/electron/" 2>/dev/null || true
fi

# 4. Cleanup old backups (keep last 3)
ls -1dt "$APP_DIR"/.next.bak-* 2>/dev/null | tail -n +4 | xargs -I {} rm -rf {} 2>/dev/null || true

echo
echo "✓ repackaged at $TS"
echo "  Restart the app:"
echo "    pkill -f 'Agent Workbench.app/Contents/MacOS/Agent Workbench'"
echo "    open \"dist-app/mac-arm64/Agent Workbench.app\""
