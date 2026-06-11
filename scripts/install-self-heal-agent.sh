#!/usr/bin/env bash
set -euo pipefail

# install-self-heal-agent.sh — install/refresh the daily self-heal LaunchAgent for THIS
# machine. Portable: derives $HOME + repo path at run time, so the same script wires Jay
# and Jarry correctly (the committed plist hardcodes Jay's paths and must NOT be copied
# verbatim to Jarry). Idempotent — safe to re-run; bootout then bootstrap.
#
# Usage: scripts/install-self-heal-agent.sh   (run on each machine; Jarry over SSH)

LABEL="ant.self-heal"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && git rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR/..")"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
SELF_HEAL="$REPO/scripts/self-heal.sh"
LOGDIR="$HOME/.openclaw/logs"

[ -f "$SELF_HEAL" ] || { echo "ERROR: $SELF_HEAL not found — is the repo synced here?" >&2; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents" "$LOGDIR"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${SELF_HEAL}</string>
        <string>--apply</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key><string>${HOME}</string>
        <key>PATH</key><string>${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key><false/>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>8</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>StandardOutPath</key><string>${LOGDIR}/self-heal.out.log</string>
    <key>StandardErrorPath</key><string>${LOGDIR}/self-heal.err.log</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    echo "✅ ${LABEL} installed on $(hostname -s) — daily 08:00, repo=$REPO"
else
    echo "⚠️ ${LABEL} written to $PLIST but not showing in launchctl list — check manually" >&2
    exit 1
fi
