#!/usr/bin/env bash
# Git merge driver for docs/process/state/active-checkouts.json (agent lease state).
#
# Why: two machines bump this file every ~5 min (updatedAt + fenceCounter). A normal
# 3-way merge conflicts on those lines every tick, and the auto-sync daemon's
# abort-on-conflict policy then never pushes — the repo diverges unboundedly
# (T-SYNC-07, 2026-06-04: Jay reached 156-ahead/175-behind, dashboard stuck on old code).
#
# Rule: resolve by fenceCounter — a Kleppmann fencing token, monotonic, so the higher
# value is the newer authority. Ties broken by updatedAt (newer ISO-8601 wins). This is
# the SAME rule a human applies manually today (feedback_lease_conflict_resolution),
# just automated so the unattended daemon can self-heal.
#
# Safety: the driver only ever copies one of the two *already-valid* input files
# wholesale — it never synthesizes JSON. Both sides are JSON-validated first; if either
# is unparseable it exits non-zero and leaves the conflict for a human. Worst case is a
# lost concurrent lease (recoverable, re-checkout), never a corrupt file.
#
# Registered via .gitattributes (merge=leasestate) + per-repo git config
# (merge.leasestate.driver), which openclaw-git-sync.sh self-registers idempotently.
# Invoked by git as: merge-lease-state.sh %O %A %B %P
#   %O ancestor (unused)  %A ours -> RESULT goes here  %B theirs  %P path
# Exit 0 = resolved (git stages %A); non-zero = unresolved (human handles it).
set -euo pipefail

OURS="${2:?ours path required}"
THEIRS="${3:?theirs path required}"

_fence() {
  grep -oE '"fenceCounter"[[:space:]]*:[[:space:]]*[0-9]+' "$1" 2>/dev/null \
    | grep -oE '[0-9]+$' | head -1
}
_updated() {
  grep -oE '"updatedAt"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null \
    | sed -E 's/.*"([^"]*)"$/\1/' | head -1
}
_valid_json() {
  python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null
}

# If either side is not valid JSON, refuse — safer to leave a human conflict than to
# pick a half-written file.
if ! _valid_json "$OURS" || ! _valid_json "$THEIRS"; then
  exit 1
fi

OF="$(_fence "$OURS")"; OF="${OF:-0}"
TF="$(_fence "$THEIRS")"; TF="${TF:-0}"

if [ "$TF" -gt "$OF" ]; then
  cp "$THEIRS" "$OURS"
elif [ "$TF" -eq "$OF" ]; then
  OU="$(_updated "$OURS")"; TU="$(_updated "$THEIRS")"
  if [[ "$TU" > "$OU" ]]; then cp "$THEIRS" "$OURS"; fi
fi
# else ours already holds the higher fence -> keep ours (no copy needed)
exit 0
