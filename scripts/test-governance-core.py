#!/usr/bin/env python3
"""test-governance-core.py — guard the governance machinery.

Covers the two safety-critical cores that keep multi-session work honest:

  1. The forward-only task state DAG + done-gate (update-tier1-state.py) — the
     rules that stop a task from skipping verification or rewinding silently.
  2. Kleppmann fencing tokens + leases (agent-work.py) — the monotonic-token
     invariant that lets a resource reject a stale writer.

Pure-function level: no git, no gh, no live tasks.json. Plain asserts collected
into a failure list; exits 0 on pass / 1 on failure, so it runs in CI exactly
like test-self-heal.py. Registered nowhere else — it is its own gate.
"""
import importlib.util
import json
import os
import sys
import tempfile

REPO = os.path.realpath(os.path.join(os.path.dirname(__file__), ".."))


def _load(mod_name, filename):
    path = os.path.join(REPO, "scripts", filename)
    spec = importlib.util.spec_from_file_location(mod_name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

S = _load("u1state", "update-tier1-state.py")   # state DAG
A = _load("agentwork", "agent-work.py")          # fencing / leases

fails = []


def check(cond, msg):
    if not cond:
        fails.append(msg)


def raises(fn, *a, **k):
    """True iff fn(*a, **k) raises ValueError (the module's validation signal)."""
    try:
        fn(*a, **k)
        return False
    except ValueError:
        return True
    except Exception as e:                       # wrong exception type is a failure
        fails.append(f"unexpected {type(e).__name__} from {getattr(fn,'__name__','?')}: {e}")
        return False


# ---------------------------------------------------------------------------
# 1. State DAG structural invariants
# ---------------------------------------------------------------------------

# Every declared state has an outgoing-edge entry (no state is a dead key).
for st in S.VALID_TASK_STATES:
    check(st in S.ALLOWED_STATE_TRANSITIONS, f"DAG: state {st!r} missing from transition table")

# No edge points at a non-existent state (catches typos in the table).
for src, dests in S.ALLOWED_STATE_TRANSITIONS.items():
    check(src in S.VALID_TASK_STATES, f"DAG: source {src!r} not a valid state")
    for d in dests:
        check(d in S.VALID_TASK_STATES, f"DAG: edge {src!r}->{d!r} targets non-state {d!r}")

# done is terminal in the sense that matters: no path leads back to unfinished work. #887
# deliberately added done -> archived so a completed task can be filed off the hot board, and
# archived is itself terminal. The original assertion demanded an empty set and went stale the
# moment #887 landed — invisibly, because nothing ran this suite. Assert the invariant instead
# of the literal: the only way out of done is deeper into terminal.
check(S.ALLOWED_STATE_TRANSITIONS["done"] <= {"archived"},
      f"DAG: done escapes to {sorted(S.ALLOWED_STATE_TRANSITIONS['done'] - {'archived'})} — "
      "the forward-only model rests on done never returning to unfinished work")
check(S.ALLOWED_STATE_TRANSITIONS["archived"] == set(), "DAG: archived must be terminal")

# The verification path cannot be skipped: once work has STARTED, done is reachable only from
# needs_verification. The intake tier is the documented exception — a task that was never worked
# can be closed outright — and it is enumerated here rather than special-cased inline, because
# that is exactly how this drifted: the assertion exempted "inbox" by name, then #191e0b1db
# introduced the `open` state with the same shortcut and this suite (run by nothing at the time)
# never saw it. Adding a state to the intake tier must be a deliberate edit to this list.
INTAKE_STATES = {"inbox", "open"}
into_done = sorted(src for src, dests in S.ALLOWED_STATE_TRANSITIONS.items()
                   if "done" in dests and src not in INTAKE_STATES)
check(into_done == ["needs_verification"],
      f"DAG: done reachable from {into_done} outside the intake tier {sorted(INTAKE_STATES)}, "
      "expected only needs_verification")
# And the intake shortcut must not have crept into a state where work has actually begun.
check(not (INTAKE_STATES & {"in_progress", "execution_finished", "blocked", "failed", "waiting"}),
      "DAG: an intake-tier exemption now covers a state where work has started")

# execution_finished must funnel through needs_verification (no direct-to-done).
check("done" not in S.ALLOWED_STATE_TRANSITIONS["execution_finished"],
      "DAG: execution_finished must not jump straight to done")


# ---------------------------------------------------------------------------
# 2. validate_state_transition
# ---------------------------------------------------------------------------

# Same-state is always a no-op (revision bumps without a move).
check(not raises(S.validate_state_transition, "x", "done", "done"),
      "transition: same-state should be allowed")

# Every declared edge is accepted.
for src, dests in S.ALLOWED_STATE_TRANSITIONS.items():
    for d in dests:
        check(not raises(S.validate_state_transition, "x", src, d),
              f"transition: declared edge {src}->{d} rejected")

# Representative illegal moves are rejected.
for src, d in [("queued", "done"), ("done", "in_progress"), ("in_progress", "done"),
               ("blocked", "done"), ("inbox", "in_progress")]:
    check(raises(S.validate_state_transition, "x", src, d),
          f"transition: illegal edge {src}->{d} should be rejected")


# ---------------------------------------------------------------------------
# 3. done-gate (validate_done_gate)
# ---------------------------------------------------------------------------

def done_task(**over):
    t = {"state": "done", "blockerOrNone": "none", "nextAction": "none",
         "expectedArtifact": "an artifact", "verificationMethod": "ran it"}
    t.update(over)
    return t

# Clean done from needs_verification passes.
check(not raises(S.validate_done_gate, "x", "needs_verification", done_task()),
      "done-gate: clean needs_verification->done rejected")

# Wrong predecessor rejected.
check(raises(S.validate_done_gate, "x", "in_progress", done_task()),
      "done-gate: done from in_progress should be rejected")

# Lingering blocker / nextAction rejected.
check(raises(S.validate_done_gate, "x", "needs_verification", done_task(blockerOrNone="still stuck")),
      "done-gate: meaningful blocker should block done")
check(raises(S.validate_done_gate, "x", "needs_verification", done_task(nextAction="do more")),
      "done-gate: pending nextAction should block done")

# Missing evidence rejected.
check(raises(S.validate_done_gate, "x", "needs_verification", done_task(expectedArtifact="")),
      "done-gate: missing expectedArtifact should block done")
check(raises(S.validate_done_gate, "x", "needs_verification", done_task(verificationMethod="")),
      "done-gate: missing verificationMethod should block done")

# Already-done task being patched (old==done) must NOT re-trip the gate
# (the #immutability fix: done tasks stay editable for refiles).
check(not raises(S.validate_done_gate, "x", "done", done_task(blockerOrNone="none")),
      "done-gate: editing an already-done task should not re-trip the gate")


# ---------------------------------------------------------------------------
# 4. validate_task_shape + board fields
# ---------------------------------------------------------------------------
# Isolate from live state: point the area/project sources at non-existent files
# so their enum checks degrade to the documented no-op fallback. This tests the
# board-field LOGIC hermetically, independent of whatever projects.json ships.
from pathlib import Path as _P
# After the #6460 split, validate_board_fields lives in tier1_state_ops and reads
# AREAS_PATH/PROJECTS_PATH in THAT module's namespace -- redirect them there, since patching
# the uts CLI shell's re-exported copies would not reach the validator.
_OPS = sys.modules[S.validate_board_fields.__module__]
_OPS.AREAS_PATH = _P(REPO) / "scripts" / "__no_such_areas__.json"
_OPS.PROJECTS_PATH = _P(REPO) / "scripts" / "__no_such_projects__.json"

# Rich states demand rich fields.
check(raises(S.validate_task_shape, "x", {"state": "in_progress"}, True),
      "shape: in_progress without rich fields should fail")
rich = {"state": "in_progress", "currentStep": "a", "expectedArtifact": "b",
        "verificationMethod": "c", "blockerOrNone": "none", "nextAction": "d"}
check(not raises(S.validate_task_shape, "x", rich, True),
      "shape: complete in_progress task should pass")

# execution_finished must preserve verificationMethod even past the rich check.
ef = dict(rich, state="execution_finished", verificationMethod="")
check(raises(S.validate_task_shape, "x", ef, True),
      "shape: execution_finished without verificationMethod should fail")

# Invalid enum values are rejected; valid ones pass.
check(raises(S.validate_board_fields, "x", {"agent": "nobody"}, False),
      "board: invalid agent should be rejected")
check(raises(S.validate_board_fields, "x", {"machine": "mars"}, False),
      "board: invalid machine should be rejected")
check(raises(S.validate_board_fields, "x", {"origin": "aliens"}, False),
      "board: invalid origin should be rejected")
check(not raises(S.validate_board_fields, "x", {"agent": "smith", "machine": "either", "origin": "ant"}, False),
      "board: valid agent/machine/origin should pass")

# Unknown patch fields are rejected (governed write surface is closed).
check(raises(S.validate_task_patch, "x", {"bogusField": 1}), "patch: unknown field should be rejected")
check(not raises(S.validate_task_patch, "x", {"state": "done", "nextAction": "none"}),
      "patch: known fields should pass")


# ---------------------------------------------------------------------------
# 5. Fencing tokens (the Kleppmann invariant)
# ---------------------------------------------------------------------------

# next_fence is strictly monotonic and persists the counter.
d = {"fenceCounter": 0, "checkouts": []}
t1 = A.next_fence(d)
t2 = A.next_fence(d)
check(t1 == 1 and t2 == 2 and d["fenceCounter"] == 2, "fence: next_fence must be strictly increasing + persisted")

# load_json never lets the counter regress below the max existing token.
with tempfile.TemporaryDirectory() as tmp:
    p = os.path.join(tmp, "state.json")
    with open(p, "w") as f:
        json.dump({"version": 1, "fenceCounter": 3,
                   "checkouts": [{"issue": 7, "fenceToken": 9}]}, f)
    from pathlib import Path
    loaded = A.load_json(Path(p))
    check(loaded["fenceCounter"] == 9,
          f"fence: counter must backfill to max token (got {loaded['fenceCounter']}, want 9)")

# A freshly minted token always exceeds the current max for an issue -> a stale
# writer (token < max) is always fenced out. This is the safety property.
data = {"fenceCounter": 9, "checkouts": [{"issue": 7, "fenceToken": 9}]}
fresh = A.next_fence(data)
data["checkouts"].append({"issue": 7, "fenceToken": fresh})
mx = A.max_token_for(data, 7)
check(fresh > 9 and mx == fresh, "fence: new grant must outrank prior max (stale-writer rejection holds)")
check(9 < mx, "fence: an old token (9) is now below max -> would be fenced out")
check(A.max_token_for(data, 999) == 0, "fence: max_token_for unknown issue should be 0")


# ---------------------------------------------------------------------------
# 6. Lease activeness (active)
# ---------------------------------------------------------------------------
now = A.utcnow()
future = A.iso(now + __import__("datetime").timedelta(hours=1))
past = A.iso(now - __import__("datetime").timedelta(hours=1))

check(A.active({"status": "in_progress", "leaseExpiresAt": future}, now) is True,
      "lease: non-terminal + future expiry should be active")
check(A.active({"status": "in_progress", "leaseExpiresAt": past}, now) is False,
      "lease: expired lease should be inactive")
check(A.active({"status": "done", "leaseExpiresAt": future}, now) is False,
      "lease: terminal status should be inactive even with future expiry")
check(A.active({"status": "in_progress"}, now) is False,
      "lease: missing expiry should be treated as inactive, not crash")

# 6b. ONE definition of "live lease". free-work.filter_live_leases is what the picker
# shows as FREE and what reconcile runs its whole invariant battery on, so if it and
# active() disagree about a record, reconcile can requeue a task another session is
# holding. The two were drawn on opposite axes: active() denylists TERMINAL statuses
# (an unknown status is LIVE — fails safe), the filter allowlisted the single literal
# "checked-out" (an unknown status is FREE — fails unsafe). Same question, opposite
# default, and the unsafe one drove the reconciler. Assert they agree case by case.
FW = _load("freework", "free-work.py")

_lease_cases = [
    ({"status": "checked-out", "leaseExpiresAt": future}, True, "ordinary held lease"),
    ({"status": "checked-out", "leaseExpiresAt": past}, False, "ordinary expired lease"),
    ({"status": "done", "leaseExpiresAt": future}, False, "terminal status"),
    ({"status": "released", "leaseExpiresAt": future}, False, "terminal status"),
    ({"status": "expired", "leaseExpiresAt": future}, False, "terminal status"),
    ({"status": "stolen", "leaseExpiresAt": future}, False, "terminal status"),
    ({"status": "blocked", "leaseExpiresAt": future}, False, "terminal status"),
    # The discriminating pair: a non-terminal status that is not the literal
    # "checked-out", and a record with no status at all. Both are HELD.
    ({"status": "in_progress", "leaseExpiresAt": future}, True, "unknown non-terminal status"),
    ({"leaseExpiresAt": future}, True, "record with no status field"),
    ({"status": "in_progress"}, False, "unknown status, no expiry"),
]
for rec, want_live, why in _lease_cases:
    check(A.active(rec, now) is want_live,
          f"lease: active() should say live={want_live} for {why}")
    got = bool(FW.filter_live_leases([dict(rec)]))
    check(got is want_live,
          f"lease: filter_live_leases should say live={want_live} for {why} (got {got})")

check(A.TERMINAL == FW.LEASE_TERMINAL,
      "lease: the terminal-status set must have exactly one definition")

# find_records filters by issue and tolerates malformed issue values.
recs = {"checkouts": [{"issue": 7}, {"issue": "bad"}, {"issue": 7}, {"issue": 8}]}
check(len(A.find_records(recs, 7)) == 2, "find_records: should return only matching issue rows")
label = {"checkouts": [{"issue": None, "taskId": "#7"}, {"issue": None, "taskId": "#70"}, {"issue": None}]}
check(len(A.find_records(label, 7)) == 1, "find_records: should match a label lease by its taskId")

# Titles must stand alone — a "#NNN" task-number reference in a title is rejected at
# create time (Ant 2026-06-29); clean and hashtag-free titles pass.
check(raises(S.validate_title, "x", {"title": "follow-up to #434 config seam"}),
      "title: a '#NNN' task-number reference should be rejected")
check(raises(S.validate_title, "x", {"title": "#367 arbiter decoder JSON"}),
      "title: a leading '#NNN' self-number should be rejected")
check(not raises(S.validate_title, "x", {"title": "migrate live persona-named artifacts + enable CI guard"}),
      "title: a self-descriptive title should pass")
check(not raises(S.validate_title, "x", {"title": "top 100 producers dashboard"}),
      "title: a bare number (no '#') is fine — only '#NNN' refs are rejected")


# ---------------------------------------------------------------------------
if fails:
    print("GOVERNANCE-CORE SELFTEST FAILED:")
    for f in fails:
        print("  - " + f)
    raise SystemExit(1)
print("GOVERNANCE-CORE SELFTEST OK — state DAG, done-gate, shape/board, fencing, leases all hold")
