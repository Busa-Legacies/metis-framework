#!/usr/bin/env bash
# close-boundary-advance.sh — Race-safe rollup boundary writer.
#
# THE RACE: in a multi-session repo, a concurrent session can commit between
# the gap-check pass and the "closed-at: SHA" write, silently swallowing that
# commit from all future roll-ups (the boundary advances past it).
#
# THE FIX: loop the gap-check + auto-attribute cycle until it comes back clean,
# then immediately write closed-at. The tight check→write window (milliseconds)
# makes the residual race negligible; any commit that does sneak through will be
# caught on the very next iteration and attributed before the boundary moves.
#
# Usage:
#   scripts/close-boundary-advance.sh <daily-log-path>
#
# Example:
#   scripts/close-boundary-advance.sh Jay/memory/2026-06-06.md
#
# Exit 0 = boundary written (closed-at: SHA appended to log).
# Exit 1 = loop exceeded MAX_ITERS — prints what to do next.
# Exit 2 = daily log not found or bad arguments.

set -euo pipefail

LOG_FILE="${1:?Usage: $0 <daily-log-path>}"
MAX_ITERS=10

if [[ ! -f "$LOG_FILE" ]]; then
    echo "[boundary-advance] ERROR: $LOG_FILE not found" >&2
    exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
GAP_CHECK="$REPO_ROOT/scripts/rollup-gap-check.sh"

if [[ ! -x "$GAP_CHECK" ]]; then
    echo "[boundary-advance] ERROR: $GAP_CHECK not found or not executable" >&2
    exit 2
fi

iter=0
while [[ $iter -lt $MAX_ITERS ]]; do
    iter=$((iter + 1))

    if "$GAP_CHECK" 2>/dev/null; then
        # Clean — write boundary immediately (tight window minimises race).
        BOUNDARY_SHA="$(git rev-parse HEAD)"
        echo "closed-at: $BOUNDARY_SHA" >> "$LOG_FILE"
        echo "[boundary-advance] OK (iter $iter) — closed-at: $BOUNDARY_SHA written to $LOG_FILE"
        exit 0
    else
        # Gaps found — auto-attribute and loop.
        echo "[boundary-advance] iter $iter: gaps found — attributing and retrying..."
        "$GAP_CHECK" --append-to "$LOG_FILE"
    fi
done

echo "[boundary-advance] WARN: still not clean after $MAX_ITERS iterations." >&2
echo "  This likely means a very active repo with continuous commits." >&2
echo "  Run: scripts/rollup-gap-check.sh --append-to $LOG_FILE" >&2
echo "  then manually append: closed-at: \$(git rev-parse HEAD)" >&2
exit 1
