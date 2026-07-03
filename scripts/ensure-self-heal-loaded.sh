#!/usr/bin/env bash
# ensure-self-heal-loaded.sh — make the daily self-heal LaunchAgent self-wire on EVERY
# machine. Called from hook-session-init.sh (once per session). If the agent is already
# loaded, does nothing and stays silent. If it's absent, installs it via the portable
# installer — so <<MACHINE_2_ID>> (and any new machine) gets self-heal parity automatically the next
# time a session starts there, with no manual SSH step.
#
# Output contract: silent when healthy; one line when it just installed (or failed to).
# Always exits 0 — a wiring guard must never block session start.
set -u
LABEL="ant.self-heal"
REPO="$(cd "$(dirname "$0")/.." && git rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$0")/..")"
INSTALLER="$REPO/scripts/install-self-heal-agent.sh"

launchctl list 2>/dev/null | grep -q "$LABEL" && exit 0   # already wired → silent
[ -x "$INSTALLER" ] || exit 0                              # installer not synced here yet

if out=$(bash "$INSTALLER" 2>&1); then
    echo "self-heal agent ($LABEL) was not loaded on $(hostname -s) — installed it (daily 08:00)."
else
    echo "self-heal agent ($LABEL) not loaded and install FAILED: $out"
fi
exit 0
