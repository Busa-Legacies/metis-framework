#!/usr/bin/env bash
# Wrapper for LaunchAgent — ensures homebrew Python and user env are available.
export HOME="$HOME"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec /opt/homebrew/bin/python3 ${METIS_HOME}/scripts/session-lifecycle.py
