#!/usr/bin/env bash
# install-scripts.sh — Wire up ~/.local/bin symlinks on any device
#
# Run once after cloning metis-os on a new machine.
# The git-sync LaunchAgent (every 5 min) keeps the repo up to date,
# and symlinks mean updates are instant — no re-install needed.
#
# Usage:
#   ./scripts/install-scripts.sh
#   ./scripts/install-scripts.sh --dry-run

set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HOME/.local/bin"
DRY=false
[[ "${1:-}" == "--dry-run" ]] && DRY=true

mkdir -p "$BIN"

link() {
  local src="$REPO/scripts/$1"
  local dst="$BIN/$2"
  chmod +x "$src"
  if $DRY; then
    echo "[dry-run] $dst -> $src"
  else
    ln -sf "$src" "$dst"
    echo "linked: $dst -> $src"
  fi
}

echo "Repo: $REPO"
echo "Bin:  $BIN"
echo ""

link ccc.sh          ccc
link ccc-auto.sh     ccc-auto
link claude-task.sh  claude-task
link dispatch        dispatch
link jlane           jlane          # deprecated shim -> dispatch (PLAN §8)
link lane-health     lane-health
link lane-debug      lane-debug
link lane.sh         lane           # terminal GOAL lanes (hub+g1..g6) — NOT Ollama lanes
link session-pivot.sh session-pivot
link task-verify.sh   task-verify
link task-ready.sh    task-ready

echo ""
echo "Done. Verify with: ls -la $BIN | grep -E 'ccc|claude-task|jay|lane|pivot|verify|ready'"
