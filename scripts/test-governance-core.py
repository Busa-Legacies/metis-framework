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

# done is terminal — the whole forward-only model rests on this.
check(S.ALLOWED_STATE_TRANSITIONS["done"] == set(), "DAG: done must be terminal (no outgoing edges)")

# The verification path cannot be skipped: done is reachable ONLY from needs_verification.
into_done = [src for src, dests in S.ALLOWED_STATE_TRANSITIONS.items() if "done" in dests and src != "inbox"]
check(into_done == ["needs_verification"],
      f"DAG: done reachable from {into_done}, expected only needs_verification (+inbox shortcut)")

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
S.AREAS_PATH = _P(REPO) / "scripts" / "__no_such_areas__.json"
S.PROJECTS_PATH = _P(REPO) / "scripts" / "__no_such_projects__.json"

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

# find_records filters by issue and tolerates malformed issue values.
recs = {"checkouts": [{"issue": 7}, {"issue": "bad"}, {"issue": 7}, {"issue": 8}]}
check(len(A.find_records(recs, 7)) == 2, "find_records: should return only matching issue rows")


# ---------------------------------------------------------------------------
if fails:
    print("GOVERNANCE-CORE SELFTEST FAILED:")
    for f in fails:
        print("  - " + f)
    raise SystemExit(1)
print("GOVERNANCE-CORE SELFTEST OK — state DAG, done-gate, shape/board, fencing, leases all hold")
