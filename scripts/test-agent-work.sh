#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STATE="$(mktemp "${TMPDIR:-/tmp}/agent-work-test-state.XXXXXX")"
rm -f "$STATE" "$STATE.lock"
DOCTOR_WT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-work-doctor-wt.XXXXXX")"
trap 'rm -f "$STATE" "$STATE.lock" /tmp/agent-work-test.out /tmp/agent-work-dupe.out /tmp/agent-work-dupe.err /tmp/agent-work-doctor.out; rm -rf "$DOCTOR_WT_ROOT"' EXIT

python3 -m py_compile scripts/agent-work.py
scripts/agent-doctor --state "$STATE" --worktree-root "$DOCTOR_WT_ROOT" --worktree-test --skip-network >/tmp/agent-work-doctor.out

scripts/agent-status --state "$STATE" | grep -q "no checkouts"

scripts/agent-checkout --state "$STATE" 999001 --agent codex --title "Reliability Test" --worktree /tmp/agent-work-test-wt --hours 1 --no-git >/tmp/agent-work-test.out
if scripts/agent-checkout --state "$STATE" 999001 --agent claude --title "Reliability Test" --worktree /tmp/agent-work-test-wt2 --hours 1 --no-git >/tmp/agent-work-dupe.out 2>/tmp/agent-work-dupe.err; then
  echo "duplicate checkout unexpectedly succeeded" >&2
  exit 1
fi
grep -q "already checked out" /tmp/agent-work-dupe.err

scripts/agent-work.py --state "$STATE" renew 999001 --hours 2 >/dev/null
scripts/agent-block --state "$STATE" 999001 "test blocker" >/dev/null
scripts/agent-status --state "$STATE" --all --json | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["checkouts"][-1]["status"]=="blocked"'

scripts/agent-checkout --state "$STATE" 999002 --agent jay --title "Expired Test" --worktree /tmp/agent-work-test-wt2 --hours -0.001 --no-git >/dev/null
scripts/agent-work.py --state "$STATE" reap >/dev/null
scripts/agent-status --state "$STATE" --all --json | python3 -c 'import sys,json; d=json.load(sys.stdin); r=[x for x in d["checkouts"] if x["issue"]==999002][-1]; assert r["status"]=="expired"'

scripts/agent-checkout --state "$STATE" 999003 --agent claude --title "Steal Test" --worktree /tmp/agent-work-test-wt3 --hours 1 --no-git >/dev/null
scripts/agent-checkout --state "$STATE" 999003 --agent codex --title "Steal Test" --worktree /tmp/agent-work-test-wt4 --hours 1 --steal --branch agent-codex-999003-steal-test --no-git >/dev/null
scripts/agent-status --state "$STATE" --all --json | python3 -c 'import sys,json; d=json.load(sys.stdin); xs=[x for x in d["checkouts"] if x["issue"]==999003]; assert xs[-2]["status"]=="stolen" and xs[-1]["agent"]=="codex"'

# --- fencing token (Kleppmann) ----------------------------------------------
# A steal must mint a strictly-higher token than the lease it supersedes.
scripts/agent-status --state "$STATE" --all --json | python3 -c 'import sys,json; d=json.load(sys.stdin); xs=[x for x in d["checkouts"] if x["issue"]==999003]; assert int(xs[-1]["fenceToken"])>int(xs[-2]["fenceToken"]), "steal must bump fence token"'
# Capture the stolen (stale) and current tokens.
STALE_TOK=$(scripts/agent-status --state "$STATE" --all --json | python3 -c 'import sys,json; d=json.load(sys.stdin); xs=[x for x in d["checkouts"] if x["issue"]==999003]; print(xs[-2]["fenceToken"])')
CUR_TOK=$(scripts/agent-status --state "$STATE" --all --json | python3 -c 'import sys,json; d=json.load(sys.stdin); xs=[x for x in d["checkouts"] if x["issue"]==999003]; print(xs[-1]["fenceToken"])')
# fence subcommand: stale token exits 1, current token exits 0.
if scripts/agent-work.py --state "$STATE" fence --issue 999003 --token "$STALE_TOK" >/dev/null 2>&1; then echo "stale fence check unexpectedly passed" >&2; exit 1; fi
scripts/agent-work.py --state "$STATE" fence --issue 999003 --token "$CUR_TOK" >/dev/null
# Strict fence: a stale-token writer must be rejected.
if scripts/agent-work.py --state "$STATE" release 999003 --fence-token "$STALE_TOK" >/tmp/agent-work-dupe.out 2>/tmp/agent-work-dupe.err; then
  echo "stale-token write unexpectedly succeeded" >&2; exit 1
fi
grep -q "FENCED OUT" /tmp/agent-work-dupe.err
# Legacy branch fence: renewing a stolen branch (no token) must also be rejected.
if scripts/agent-work.py --state "$STATE" renew 999003 --branch agent-claude-999003-steal-test >/tmp/agent-work-dupe.out 2>/tmp/agent-work-dupe.err; then
  echo "stolen-branch renew unexpectedly succeeded" >&2; exit 1
fi
grep -q "FENCED OUT" /tmp/agent-work-dupe.err
# Current holder writes successfully with the right token.
scripts/agent-work.py --state "$STATE" renew 999003 --fence-token "$CUR_TOK" --hours 1 >/dev/null

# --- claim-next: atomic, collision-free task pickup -------------------------
# Two concurrent claim-next calls must select DIFFERENT free tasks (the lock
# serialises select+claim, killing the read-then-claim race). Skip gracefully
# if the live free list has <2 items so the test never goes flaky.
CN_FREE=$(scripts/free-work.py --machine <<MACHINE_1_ID>> --json 2>/dev/null | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["free"]))')
if [ "$CN_FREE" -ge 2 ]; then
  CNSTATE="$(mktemp "${TMPDIR:-/tmp}/agent-work-cn-state.XXXXXX")"
  printf '{"version":1,"updatedAt":null,"checkouts":[]}\n' > "$CNSTATE"
  scripts/agent-work.py --state "$CNSTATE" claim-next --agent t1 --session sessA --machine <<MACHINE_1_ID>> --allow-multi --json >/tmp/agent-work-cn-a.out 2>/dev/null &
  CN_P1=$!
  scripts/agent-work.py --state "$CNSTATE" claim-next --agent t2 --session sessB --machine <<MACHINE_1_ID>> --allow-multi --json >/tmp/agent-work-cn-b.out 2>/dev/null &
  CN_P2=$!
  wait "$CN_P1" "$CN_P2"
  python3 - "$CNSTATE" <<'PY'
import json, sys
a = json.load(open('/tmp/agent-work-cn-a.out'))
b = json.load(open('/tmp/agent-work-cn-b.out'))
assert a['title'] != b['title'], f"concurrent claim-next collided on {a['title']!r}"
assert a['fenceToken'] != b['fenceToken'], "concurrent claims must mint distinct fence tokens"
live = [c for c in json.load(open(sys.argv[1]))['checkouts'] if c['status'] == 'checked-out']
assert len(live) == 2, f"expected 2 live claims after two claim-next, got {len(live)}"
PY
  # WIP guard: a further claim from the SAME session (no --allow-multi) must refuse.
  if scripts/agent-work.py --state "$CNSTATE" claim-next --agent t1 --session sessA --machine <<MACHINE_1_ID>> >/tmp/agent-work-dupe.out 2>/tmp/agent-work-dupe.err; then
    echo "claim-next WIP guard unexpectedly passed" >&2; exit 1
  fi
  grep -q "already holds" /tmp/agent-work-dupe.err
  # ...but a different session CAN still claim (multi-terminal flow must work).
  scripts/agent-work.py --state "$CNSTATE" claim-next --agent t3 --session sessC --machine <<MACHINE_1_ID>> --json >/dev/null 2>&1 || {
    echo "claim-next wrongly blocked a distinct session" >&2; exit 1; }
  rm -f "$CNSTATE" "$CNSTATE.lock" /tmp/agent-work-cn-a.out /tmp/agent-work-cn-b.out
else
  echo "claim-next concurrency test SKIPPED — <2 free items for <<MACHINE_1_ID>>" >&2
fi

# --- #750: terminal-row self-bounding on every mutation ---------------------
# Seed a bloated state (100 old terminal + 3 young terminal + 1 live, high
# fenceCounter), run a mutation through locked_state, and assert the file
# self-bounds without regressing the fence floor or dropping live/young rows.
PRUNESTATE="$(mktemp "${TMPDIR:-/tmp}/agent-work-prune-state.XXXXXX")"
python3 - "$PRUNESTATE" <<'PY'
import json, sys, datetime as dt
now = dt.datetime.now(dt.timezone.utc)
def iso(t): return t.replace(microsecond=0).isoformat().replace("+00:00", "Z")
rows = []
# 1 live lease, active for another hour — reap must not expire it.
rows.append({"issue": 999500, "agent": "claude", "status": "checked-out",
             "fenceToken": 5, "leaseStartedAt": iso(now - dt.timedelta(minutes=5)),
             "leaseExpiresAt": iso(now + dt.timedelta(hours=1)), "title": "live"})
# 100 old terminal rows (ended 5 days ago) — most should be pruned.
for i in range(100):
    rows.append({"issue": 999600 + i, "agent": "queue-runner", "status": "released",
                 "fenceToken": 100 + i, "endedAt": iso(now - dt.timedelta(days=5, seconds=i)),
                 "title": f"old-{i}"})
# 3 young terminal rows (ended 10 min ago) — protected by the min-age window.
for j, iss in enumerate((999700, 999701, 999702)):
    rows.append({"issue": iss, "agent": "queue-runner", "status": "released",
                 "fenceToken": 300 + j, "endedAt": iso(now - dt.timedelta(minutes=10)),
                 "title": f"young-{j}"})
json.dump({"version": 1, "updatedAt": iso(now), "fenceCounter": 99999, "checkouts": rows},
          open(sys.argv[1], "w"), indent=2)
PY
scripts/agent-work.py --state "$PRUNESTATE" reap >/dev/null
python3 - "$PRUNESTATE" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
cos = d["checkouts"]
term = [c for c in cos if c["status"] != "checked-out"]
live = [c for c in cos if c["status"] == "checked-out"]
assert d["fenceCounter"] == 99999, f"fence floor regressed: {d['fenceCounter']}"
assert len(live) == 1 and live[0]["issue"] == 999500, "live lease must survive prune"
assert len(term) <= 40, f"terminal rows not bounded: {len(term)}"
kept = {c["issue"] for c in term}
for iss in (999700, 999701, 999702):
    assert iss in kept, f"young terminal row {iss} wrongly pruned"
assert 999699 not in kept, "oldest terminal row should have been pruned"
PY
rm -f "$PRUNESTATE" "$PRUNESTATE.lock"
echo "  ✓ #750 terminal-row self-bounding"

echo "agent-work tests passed"
