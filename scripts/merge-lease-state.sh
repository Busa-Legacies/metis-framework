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
# Safety: both sides are JSON-validated first; if either is unparseable the driver exits
# non-zero and leaves the conflict for a human. It never emits a file that is not derived
# from two already-valid inputs.
#
# ACTIVE-LEASE UNION (#3725, 2026-08-18). The driver used to copy ONE side wholesale and
# its header called the cost "a lost concurrent lease (recoverable, re-checkout)". That is
# no longer true in either direction:
#   - Correctness: the losing side's leases belong to OTHER live sessions. Dropping them
#     silently unlocks files those sessions are actively editing, which is the collision
#     the lock-for-everyone rule exists to prevent.
#   - Availability: the #1605 push gate now audits this file and REFUSES any push where an
#     ACTIVE lease vanished with no explicit delete. So a wholesale pick doesn't just lose
#     a lease, it wedges the node — git-sync-unwedge.sh converged main cleanly and was then
#     blocked from pushing for exactly this reason, meaning the fleet's automatic divergence
#     recovery failed precisely when other sessions were busy.
# So: still resolve top-level authority (fenceCounter, updatedAt, presence) by the fencing
# token as before — that part was right — but then re-add any ACTIVE lease present on the
# other side and missing from the winner. Terminal-status entries (done/released/blocked/
# expired/stolen/reaped) are NOT re-added: pruning them is the intended forward progress,
# and resurrecting them would make the file grow without bound.
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

# Snapshot OURS before any overwrite: when the fence picks theirs, %A is clobbered by the
# cp below and our side's active leases would be unrecoverable inside this driver (git hands
# it paths, not stages). The union step needs whichever side LOST, so preserve it first.
_LOSER_TMP="$(mktemp "${TMPDIR:-/tmp}/leasemerge-loser-XXXXXX")"
trap 'rm -f "$_LOSER_TMP"' EXIT

if [ "$DECISION" = "theirs" ]; then
  cp "$OURS" "$_LOSER_TMP"      # ours is about to be overwritten -> it is the loser
  cp "$THEIRS" "$OURS"
else
  cp "$THEIRS" "$_LOSER_TMP"    # ours already holds authority -> theirs is the loser
fi

# Now union back the ACTIVE leases the losing side held (#3725). Writes atomically via a
# temp file so a failure here can never leave a half-written %A behind; on ANY error the
# fence-resolved file already in place stands, which is the old behaviour — this step can
# improve the result but must never make it worse.
python3 - "$OURS" "$_LOSER_TMP" <<'PY' || exit 0
import json, os, sys, tempfile

result_path, loser_path = sys.argv[1], sys.argv[2]

TERMINAL = {"done", "released", "blocked", "expired", "stolen", "reaped"}

def load(p):
    with open(p) as f:
        return json.load(f)

result, loser = load(result_path), load(loser_path)
if not isinstance(result.get("checkouts"), list) or not isinstance(loser.get("checkouts"), list):
    sys.exit(0)

def key(c):
    # claimId is the stable per-lease identity; fall back to the tuple that identifies a
    # checkout when an older entry predates claimId.
    return c.get("claimId") or (c.get("issue"), c.get("session"), c.get("leaseStartedAt"))

have = {key(c) for c in result["checkouts"]}
added = [c for c in loser["checkouts"]
         if c.get("status") not in TERMINAL and key(c) not in have]
if not added:
    sys.exit(0)

result["checkouts"].extend(added)
d = os.path.dirname(os.path.abspath(result_path)) or "."
fd, tmp = tempfile.mkstemp(dir=d, suffix=".leasemerge")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(result, f, indent=2)
        f.write("\n")
    os.replace(tmp, result_path)
except Exception:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    raise
PY
exit 0
