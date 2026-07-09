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

echo "agent-work tests passed"
