#!/usr/bin/env bash
# Liveness guard for the auto-sync daemon (ant.openclaw-git-sync).
#
# Why this exists (#101): the daemon is the backstop that pushes commits left
# local by close-push.sh's "defer on rejected push" strategy (#099). On 2026-06-04
# it was found fully UNLOADED on Jarry — gone from `launchctl list` entirely, not
# just exited — so every session's deferred commits stranded with no failure edge
# for #074's alert to catch. KeepAlive does NOT fix this: it only restarts an
# exited-but-loaded job, and on a StartInterval-300 sync-then-exit job it would
# instead spin a tight loop. The robust fix is to assert the agent is loaded at
# session start and reload it if absent.
#
# Output contract: prints nothing when healthy. Prints a one-line notice when it
# reloaded the agent (or failed to). Callers (hook-session-init.sh, /syscheck)
# surface stdout when non-empty. Always exits 0 — a liveness check must never
# block session start.

set -u

LABEL="ant.openclaw-git-sync"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Best-effort Discord ping via the #074 alert path. A notify failure must never
# change this guard's exit status — a liveness check stays exit-0 and non-blocking.
alert_discord() {
  python3 "$REPO/scripts/discord_notify.py" "$1" >/dev/null 2>&1 || true
}

# Already loaded? launchctl list prints a line per loaded label.
if launchctl list 2>/dev/null | grep -q "$LABEL"; then
  exit 0
fi

# Not loaded. If the plist is missing, this machine doesn't run the daemon — stay quiet.
[ -f "$PLIST" ] || exit 0

if launchctl load -w "$PLIST" 2>/dev/null && launchctl list 2>/dev/null | grep -q "$LABEL"; then
  echo "auto-sync daemon ($LABEL) was UNLOADED — reloaded it. Deferred commits will now sync; investigate why it dropped if this recurs."
  alert_discord "🟠 auto-sync daemon was UNLOADED on $(hostname -s) — reloaded by ensure-autosync-loaded.sh. Deferred commits will sync now; investigate if this recurs."
else
  echo "auto-sync daemon ($LABEL) is UNLOADED and reload FAILED — close-push.sh-deferred commits will strand. Reload manually: launchctl load -w $PLIST"
  alert_discord "🔴 auto-sync daemon is UNLOADED on $(hostname -s) and RELOAD FAILED — deferred commits will strand. Reload manually: launchctl load -w $PLIST"
fi
exit 0
