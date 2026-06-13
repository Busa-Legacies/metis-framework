#!/usr/bin/env bash
# Git merge driver for docs/process/state/active-checkouts.json (agent lease state).
#
# Why: two machines bump this file every ~5 min (updatedAt + fenceCounter). A normal
# 3-way merge conflicts on those lines every tick, and the auto-sync daemon's
# abort-on-conflict policy then never pushes — the repo diverges unboundedly
# (T-SYNC-07, 2026-06-04: <<MACHINE_1_ID>> reached 156-ahead/175-behind, dashboard stuck on old code).
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

# Field extraction is real JSON parsing (#269) — the old grep/sed pulled the first
# textual "fenceCounter" match, so reformatted/minified JSON (or a fenceCounter-shaped
# string inside a lease title) could silently extract 0 and the merge would pick the
# wrong side of a live lease. json.load reads the actual top-level fields; a missing
# or non-integer fenceCounter is treated as 0 explicitly, and either side failing to
# parse exits 1 (human conflict), same contract as before.
DECISION="$(python3 -c '
import json, sys
from datetime import datetime, timezone


def load(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def fence(d):
    v = d.get("fenceCounter", 0)
    return v if isinstance(v, int) and not isinstance(v, bool) else 0


def ts(d):
    s = d.get("updatedAt", "")
    if not isinstance(s, str) or not s:
        return None
    if s.endswith(("Z", "z")):
        s = s[:-1] + "+00:00"
    try:
        t = datetime.fromisoformat(s)
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


ours, theirs = load(sys.argv[1]), load(sys.argv[2])
if not isinstance(ours, dict) or not isinstance(theirs, dict):
    sys.exit(1)

of, tf = fence(ours), fence(theirs)
if tf > of:
    print("theirs"); sys.exit(0)
if tf < of:
    print("ours"); sys.exit(0)

# Fence tie -> newer updatedAt wins. Real datetime compare (handles Z vs +00:00 vs
# naive-assumed-UTC); falls back to lexical ISO compare only if a side is unparseable.
ot, tt = ts(ours), ts(theirs)
if ot is not None and tt is not None:
    print("theirs" if tt > ot else "ours")
else:
    ou = ours.get("updatedAt", "") if isinstance(ours.get("updatedAt"), str) else ""
    tu = theirs.get("updatedAt", "") if isinstance(theirs.get("updatedAt"), str) else ""
    print("theirs" if tu > ou else "ours")
' "$OURS" "$THEIRS")" || exit 1

if [ "$DECISION" = "theirs" ]; then
  cp "$THEIRS" "$OURS"
fi
# else ours already holds authority -> keep ours (no copy needed)
exit 0
