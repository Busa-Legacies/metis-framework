"""lease_state.py — the one canonical answer to "is this lease still held?".

There were two, drawn on opposite axes, and they disagreed on the unknown case:

  agent-work.active()          status NOT IN a terminal DENYLIST  -> unknown status is HELD
  free-work.filter_live_leases status == the literal "checked-out" -> unknown status is FREE

Same question, opposite default, and the unsafe one is the one with reach:
filter_live_leases is what the picker presents as FREE work and what reconcile.py
runs its whole I1-I17 invariant battery on, so a record either predicate calls held
and the other calls free is a task reconcile can requeue out from under a live
session. (agent-work's claim-next was accidentally safe: it re-filters candidates
against active() a few lines after ranking on the free-work view.)

A lease is HELD when nothing has retired it and its clock has not run out. That is a
denylist by nature — the retiring events are the enumerable set, not the states of
being alive — so an unrecognised status means "something is going on here that this
code does not model", and the only safe reading of that is HELD. Which is the axis
the reason was always on.

Pure and stdlib-only: the caller parses its own timestamps (the two callers have
their own ISO parsers with their own tolerances) and passes the decision inputs in.
"""

# The retiring events. Every one of these is written by agent-work.py when a lease
# ends: done/released by the holder, expired by the sweep, stolen by a takeover,
# blocked by a hard stop. Anything not in here has not been retired.
TERMINAL = {"done", "released", "blocked", "expired", "stolen"}


def is_live(status, expires, now) -> bool:
    """True iff `status` is not a retiring event and `expires` is still ahead of `now`.

    status:  the record's status field, or None/missing
    expires: an aware datetime, or None if absent/unparseable (treated as expired —
             a lease with no readable expiry cannot be shown to still hold)
    """
    if str(status or "").lower() in TERMINAL:
        return False
    if expires is None:
        return False
    return expires > now
