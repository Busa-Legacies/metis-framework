#!/usr/bin/env bash
# Fires on every Stop event. If /restart left the pending-restart marker, relaunch
# this Claude session by respawning its tmux pane into the supervised launcher.
# Uses `respawn-pane -k` (deterministic) instead of injecting Ctrl+D (TUI-dependent),
# decoupled via `run-shell -b` so the relaunch survives this hook's own teardown.
MARKER="$HOME/.openclaw/pending-restart"
[[ -f "$MARKER" ]] || exit 0            # normal stop: nothing to do
rm -f "$MARKER"
: "${METIS_HOME:=$HOME/metis-os}"

# Reap orphaned background tasks before restarting — prevents stale dispatch/Lane
# notifications from bleeding into the new session.
if [[ -x "$METIS_HOME/scripts/reap-bg-tasks.sh" ]]; then
    bash "$METIS_HOME/scripts/reap-bg-tasks.sh" --kill --quiet 2>/dev/null || true
fi
LAUNCHER="$METIS_HOME/scripts/claude-tmux.sh"

if [[ -n "$TMUX_PANE" ]]; then
    cwd=$(tmux display-message -p -t "$TMUX_PANE" '#{pane_current_path}' 2>/dev/null)
    tmux run-shell -b -d 0.3 \
        "tmux respawn-pane -k -c '${cwd:-$HOME}' -t '$TMUX_PANE' '$LAUNCHER'"
    exit 0
fi

# Restart requested but there's no supervising tmux pane (session started as bare
# `claude`), so nothing can relaunch it. Report honestly rather than failing opaquely.
printf '%s\n' '{"systemMessage":"Restart requested but this session was started as bare `claude`, not via the tmux launcher (claude-tmux.sh / ccc) — cannot auto-restart. Relaunch through the launcher for /restart to work."}'
exit 0
