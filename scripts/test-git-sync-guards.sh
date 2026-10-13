#!/usr/bin/env bash
# Pre-deploy test harness for scripts/openclaw-git-sync.sh.
#
# Why this exists: the sync script has regressed FOUR times (T-SYNC-04/05/06/07),
# each shipped live to the always-on LaunchAgent and caught only by accident. This
# harness runs the REAL script against throwaway sandbox repos (isolated via a temp
# $HOME), exercising every guard, so a regression is caught BEFORE redeploy.
#
# Run before any deploy:  scripts/test-git-sync-guards.sh
# Exit 0 = all guards behave; non-zero = a guard regressed (do NOT deploy).

set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CANONICAL="$SCRIPT_DIR/openclaw-git-sync.sh"
PRECOMMIT_GUARD="$SCRIPT_DIR/git-hooks/pre-commit-conflict-guard.sh"
PASS=0; FAIL=0

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }

# --- sandbox: a self-contained fake $HOME with a repo + bare origin -------------
make_sandbox() {
  SBX=$(mktemp -d)
  export SBX
  mkdir -p "$SBX/.openclaw/logs" "$SBX/.openclaw/locks"
  git init -q --bare "$SBX/origin.git"
  git clone -q "$SBX/origin.git" "$SBX/Ant-openclaw-framework" 2>/dev/null
  cd "$SBX/Ant-openclaw-framework"
  git config user.email "test@test"; git config user.name "test"
  git config commit.gpgsign false
  # seed the protected paths so deletion guards have something to delete
  mkdir -p workspace/memory workspace/state
  printf 'seed\n' > workspace/memory/working-context.md
  printf 'seed\n' > workspace/state/OPEN_TASKS.md
  printf 'seed\n' > workspace/.gitignore
  for i in 1 2 3 4 5 6 7 8; do printf 'f%s\n' "$i" > "file$i.txt"; done
  # The daemon resolves its repo as $METIS_HOME (= this sandbox) and sources the
  # shared lock helper from $REPO/scripts/lib (#452). Production's REPO always has
  # it; mirror that here so the sandbox daemon can find holder_is_leaked.
  mkdir -p scripts/lib
  cp "$SCRIPT_DIR/lib/git-sync-lock.sh" scripts/lib/git-sync-lock.sh
  # #234 Slice 3: the daemon now sources the canonical STATE/SOURCE pathspec split from a
  # shared lib (also used by close-push.sh). Mirror the production tree so the sandbox
  # daemon finds it — without this the split-lane arrays are unset and SPLIT-1..4 regress.
  cp "$SCRIPT_DIR/lib/source-pathspec.sh" scripts/lib/source-pathspec.sh
  # #1605: the daemon sources the silent-drop audit lib; mirror it so the sandbox daemon's
  # guard is armed (absent → the guard fail-opens to a no-op and the drop scenarios pass
  # for the wrong reason).
  cp "$SCRIPT_DIR/lib/sync-drop-audit.sh" scripts/lib/sync-drop-audit.sh
  # Tier-3 (#342): the daemon invokes $REPO/scripts/ai-merge-resolver.py. It was NEVER mirrored
  # here, so every Tier-3 assertion in this suite passed because the interpreter could not find the
  # file — the daemon fell to its defer branch for a missing-file reason, not for the eligibility
  # reason being asserted. Mirror it so the real gate runs, and default Tier-3 OFF in run_sync so
  # only a scenario that asks for it gets it.
  cp "$SCRIPT_DIR/ai-merge-resolver.py" scripts/ai-merge-resolver.py
  chmod +x scripts/ai-merge-resolver.py
  # Seed a known-good pre-push gate (#719). The daemon runs $REPO/scripts/autosync_prepush_gate.py
  # before every push (openclaw-git-sync.sh:731); a MISSING gate exits non-zero, so the daemon
  # refuses the push and every "tick completes / origin advanced" assertion failed as environmental
  # red (10 of them, masking real guard regressions). We can't seed the REAL gate here: it runs
  # render-tier1-state.py + knowledge-map.py, which this sandbox doesn't have, so it would
  # fail-closed. This harness tests the DAEMON's push mechanics, not the gate's own check logic
  # (that has tests/test_autosync_prepush_gate.py). Stub it to a known-good exit 0 so the push path
  # runs end-to-end. GATE_STUB_RC lets a scenario force RED to exercise the daemon's
  # refuse-push-on-red branch (openclaw-git-sync.sh:734).
  cat > scripts/autosync_prepush_gate.py <<'GATE_STUB'
#!/usr/bin/env python3
# Fixture stub — NOT the real gate. See scripts/test-git-sync-guards.sh make_sandbox() for why.
import os, sys
rc = int(os.environ.get("GATE_STUB_RC", "0"))
sys.stderr.write("gate-stub: %s\n" % ("clean" if rc == 0 else "RED"))
sys.exit(rc)
GATE_STUB
  chmod +x scripts/autosync_prepush_gate.py
  # Alerts were unobservable here, so nothing could assert how OFTEN the daemon pages — which is
  # how the #1605 refusal came to alert on every single tick unnoticed (#4621). Stub the notifier
  # to append one line per alert; scenarios then count them.
  cat > scripts/discord_notify.py <<'DISCORD_STUB'
#!/usr/bin/env python3
# Fixture stub — NOT the real notifier. See scripts/test-git-sync-guards.sh make_sandbox().
import os, sys
with open(os.path.join(os.environ["HOME"], ".openclaw", "discord-alerts.log"), "a") as fh:
    fh.write(" ".join(sys.argv[1:]).replace("\n", " ") + "\n")
DISCORD_STUB
  chmod +x scripts/discord_notify.py
  git add -A; git commit -qm seed; git push -q origin HEAD:main 2>/dev/null
  git branch -q -M main 2>/dev/null || true
  # Point the bare origin's HEAD at main. Without this it stays on the init-default
  # 'master' (which never gets a commit), so every later `git clone "$SBX/origin.git"`
  # (clobber/pusher fixtures) checks out an empty 'master' and the fixture's
  # rm/conflict setup silently no-ops — the second env-drift bug behind the stale
  # harness (alongside the METIS_HOME repo-path fix in run_sync).
  git -C "$SBX/origin.git" symbolic-ref HEAD refs/heads/main 2>/dev/null || true
  LOG="$SBX/.openclaw/logs/git-sync.log"
  ALERTS="$SBX/.openclaw/discord-alerts.log"
  mkdir -p "$SBX/.openclaw"
}
teardown() { cd /; rm -rf "$SBX"; }

# run the real script with HOME + METIS_HOME pointed at the sandbox. METIS_HOME is
# REQUIRED: the script resolves its repo as ${METIS_HOME:-$HOME/metis-os}; without
# it every scenario `cd`s to a nonexistent $SBX/metis-os and exits 1 (the post-rename
# drift that silently failed all 18 functional tests until 2026-06-09).
# TEST_SPLIT / TEST_MACHINE let a scenario drive the #234 split-sync behavior
# (OPENCLAW_SPLIT_LANES / OPENCLAW_SYNC_MACHINE) without exporting globally. Default
# off (0) so every legacy scenario above runs against the kill-switch/legacy path.
run_sync() { HOME="$SBX" METIS_HOME="$SBX/Ant-openclaw-framework" \
  OPENCLAW_SPLIT_LANES="${TEST_SPLIT:-0}" OPENCLAW_SYNC_MACHINE="${TEST_MACHINE:-testbox}" \
  METIS_AI_MERGE="${TEST_AI_MERGE:-0}" \
  OPENCLAW_HEAL_FORWARD_NODE="${TEST_HEAL_NODE:-definitely-not-this-host}" \
  "$CANONICAL" >/dev/null 2>&1; echo $?; }
log_has()  { grep -q "$1" "$LOG" 2>/dev/null; }

check() { # check <description> <expect: pass|fail-condition already evaluated>
  if [ "$2" = "0" ]; then PASS=$((PASS+1)); green "  PASS: $1"; else FAIL=$((FAIL+1)); red "  FAIL: $1"; fi
}

# NOTE ON FIXTURES: the sync script's change-detector (`git diff --quiet`) and
# guard-3 (`git grep`) both ignore UNTRACKED files. So a fixture must MODIFY a
# tracked file to actually drive the staging path — a brand-new untracked file
# never reaches the guards (and would silently pass for the wrong reason).
# ================================================================================
echo "=== T-SYNC-07: trailing whitespace must NOT be treated as a conflict marker ==="
make_sandbox
printf 'tags: \n' >> file1.txt          # trailing space on a TRACKED file — the recurring bug
run_sync >/dev/null
log_has "sync complete" && r=0 || r=1; check "tick with trailing-ws change completes" "$r"
log_has "conflict markers" && r=1 || r=0; check "trailing-ws NOT mislabeled as conflict markers" "$r"
teardown

echo "=== untracked sync: a lone brand-new file must get committed ==="
make_sandbox
printf 'fresh memory file\n' > brand-new.md   # untracked, otherwise-clean tree
run_sync >/dev/null
log_has "sync complete" && r=0 || r=1; check "lone untracked file triggers a sync" "$r"
git ls-files --error-unmatch brand-new.md >/dev/null 2>&1 && r=0 || r=1; check "lone untracked file is now committed/tracked" "$r"
teardown

echo "=== guard-3 + staged-check: a markdown '=======' underline must NOT trip ==="
make_sandbox
printf 'Heading\n=======\nbody\n' >> file1.txt   # setext underline added to a tracked file
run_sync >/dev/null
log_has "sync complete" && r=0 || r=1; check "added markdown '=======' completes (no false conflict)" "$r"
log_has "conflict markers" && r=1 || r=0; check "markdown '=======' not flagged by tree OR staged check" "$r"
teardown

echo "=== guard-3 still works: a REAL conflict triplet in a tracked file must abort ==="
make_sandbox
printf '<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> branch\n' > file1.txt   # overwrite TRACKED file
ec=$(run_sync)
log_has "conflict markers present in tree" && r=0 || r=1; check "real conflict triplet refused" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "real conflict triplet exits non-zero" "$r"
teardown

echo "=== staged-marker belt-and-suspenders: lone added '<<<<<<< ' caught ==="
make_sandbox
# A lone opening marker (no closer) passes guard-3 (which needs the PAIR) but must
# be caught by the staged-diff check. Append to a tracked file so staging runs.
printf '<<<<<<< HEAD\nonly an opening marker, no closer\n' >> file1.txt
ec=$(run_sync)
log_has "staged conflict markers" && r=0 || r=1; check "lone opening marker caught by staged check" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "lone opening marker exits non-zero" "$r"
teardown

echo "=== guard-4: > DELETE_LIMIT deletions aborts (partial-tree wipe) ==="
make_sandbox
rm -f file1.txt file2.txt file3.txt file4.txt file5.txt file6.txt   # 6 > limit of 5
ec=$(run_sync)
log_has "partial-tree wipe" && r=0 || r=1; check "6 deletions refused as partial-tree wipe" "$r"
teardown

echo "=== guard-4: deleting a PROTECTED path aborts ==="
make_sandbox
rm -f workspace/memory/working-context.md
ec=$(run_sync)
log_has "protected path staged for deletion" && r=0 || r=1; check "protected-path deletion refused" "$r"
teardown

echo "=== #448: a bulk deletion must NOT strand a coincident state addition ==="
# Regression for the clobber class: the old guard-4 did `git reset` (whole index) on a
# >LIMIT deletion, throwing away legit additions/modifications staged the same tick — so
# a freshly created task could vanish if unrelated churn tripped the delete limit. The fix
# unstages ONLY the deletions; the addition must still commit. Wipe protection is intact
# (the deletions are NOT auto-committed). Complements the #447 caller-side atomic commit.
make_sandbox
rm -f file1.txt file2.txt file3.txt file4.txt file5.txt file6.txt   # 6 > limit → held back
printf 'TASK_ADDITION_MARKER\n' >> file7.txt                        # legit change (e.g. a new task)
ec=$(run_sync)
log_has "Unstaging the DELETIONS ONLY" && r=0 || r=1; check "#448 bulk deletion holds deletions only (not whole index)" "$r"
git show HEAD:file7.txt 2>/dev/null | grep -q TASK_ADDITION_MARKER && r=0 || r=1; check "#448 coincident modification IS committed (not stranded)" "$r"
git cat-file -e HEAD:file1.txt 2>/dev/null && r=0 || r=1; check "#448 bulk deletion NOT auto-committed (wipe protection intact)" "$r"
teardown

echo "=== T-SYNC-11: a pull-merge that deletes >LIMIT source files is refused (clobber guard) ==="
make_sandbox
# both sides start with 6 tracked SOURCE files
for i in 1 2 3 4 5 6; do printf 'export const x%s = %s\n' "$i" "$i" > "src$i.ts"; done
git add -A; git commit -qm "add source"; git push -q origin HEAD:main
# another machine deletes ALL of them and pushes — the cross-session clobber
git clone -q "$SBX/origin.git" "$SBX/clobber" 2>/dev/null
( cd "$SBX/clobber"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  git rm -q src1.ts src2.ts src3.ts src4.ts src5.ts src6.ts; git commit -qm "clobber"; git push -q origin HEAD:main ) 2>/dev/null
# local makes an unrelated change so the daemon commits, then pulls the clobber merge
printf 'local note\n' >> file1.txt
PRE_LOCAL=$(git rev-parse HEAD)
ec=$(run_sync)
log_has "suspected cross-session clobber" && r=0 || r=1; check "pull-merge source-deletion refused (T-SYNC-11)" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "T-SYNC-11 clobber exits 1 (alert edge)" "$r"
[ -f src1.ts ] && [ -f src6.ts ] && r=0 || r=1; check "T-SYNC-11 reset-hard restored the deleted source files" "$r"
git fetch -q origin 2>/dev/null; git merge-base --is-ancestor "$(git rev-parse @{u} 2>/dev/null || echo HEAD)" HEAD 2>/dev/null && r=1 || r=0; check "T-SYNC-11 did NOT push the clobber merge to origin" "$r"
teardown

echo "=== T-SYNC-11: a bulk GOVERNED-STATE deletion is NOT counted as source (no false trip) ==="
# The scenarios around this one vary the SIZE of the deletion. This varies the KIND, which is the
# dimension that actually broke: on 2026-08-17 a routine cleanup of 8
# docs/process/state/relay-requests/*.json read as "8 source files deleted (> 5)", so <<MACHINE_2_ID>>
# refused the pull and reset on EVERY tick — 106 resets in one day, unable to land its own 22
# commits or durably receive any, and silent throughout. A guard that resets the tree has to
# measure the thing it claims to measure, and nothing was checking that it still does.
make_sandbox
mkdir -p docs/process/state/relay-requests
for i in $(seq 1 8); do printf '{"status":"pending"}\n' > "docs/process/state/relay-requests/r$i.json"; done
git add docs/process/state; git commit -qm "seed 8 governed-state json files"; git push -q origin HEAD:main
git clone -q "$SBX/origin.git" "$SBX/peerts11" 2>/dev/null
( cd "$SBX/peerts11"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  git rm -q docs/process/state/relay-requests/*.json
  git commit -qm "routine cleanup of completed relay requests"
  git push -q origin HEAD:main ) 2>/dev/null
printf 'note\n' >> file2.txt
ec=$(run_sync)
log_has "suspected cross-session clobber" && r=1 || r=0; check "T-SYNC-11 8 governed-state deletions do NOT trip the source guard" "$r"
log_has "sync complete" && r=0 || r=1; check "T-SYNC-11 the governed-state cleanup syncs through" "$r"
[ "$ec" = "0" ] && r=0 || r=1; check "T-SYNC-11 governed-state cleanup exits 0 (node not reset)" "$r"
teardown

echo "=== T-SYNC-11: a small (<=LIMIT) legit source deletion still syncs (no false trip) ==="
make_sandbox
for i in 1 2 3; do printf 'export const y%s = %s\n' "$i" "$i" > "keep$i.ts"; done
git add -A; git commit -qm "add few source"; git push -q origin HEAD:main
git clone -q "$SBX/origin.git" "$SBX/smalldel" 2>/dev/null
( cd "$SBX/smalldel"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  git rm -q keep1.ts; git commit -qm "remove one (legit refactor)"; git push -q origin HEAD:main ) 2>/dev/null
printf 'note\n' >> file2.txt
ec=$(run_sync)
log_has "sync complete" && r=0 || r=1; check "1 source deletion (<= limit) completes normally" "$r"
log_has "suspected cross-session clobber" && r=1 || r=0; check "small legit deletion NOT flagged as clobber" "$r"
teardown

echo "=== guard-1: a non-main branch is skipped ==="
make_sandbox
git checkout -q -b feature
printf 'x\n' > onfeature.txt
ec=$(run_sync)
log_has "not 'main' — skip" && r=0 || r=1; check "non-main branch skipped" "$r"
teardown

echo "=== #4197: an off-main clone alerts past the skip threshold (never silent-loops forever) ==="
make_sandbox
git checkout -q -b stranded-dispatch          # simulate a headless dispatch that branched and never returned
printf 'branch work\n' > stranded.txt
# below threshold (3): each tick skips + counts, but stays quiet (no alert)
OPENCLAW_SYNC_OFFMAIN_ALERT_TICKS=3 run_sync >/dev/null
OPENCLAW_SYNC_OFFMAIN_ALERT_TICKS=3 run_sync >/dev/null
log_has "alert threshold" && r=1 || r=0; check "#4197 off-main skips stay quiet below the threshold" "$r"
[ "$(cat "$SBX/.openclaw/locks/git-sync-offmain.count" 2>/dev/null)" = "2" ] && r=0 || r=1
check "#4197 consecutive off-main skips are counted" "$r"
# crossing the threshold fires the fleet alert exactly once (edge-triggered)
OPENCLAW_SYNC_OFFMAIN_ALERT_TICKS=3 run_sync >/dev/null
log_has "alert threshold" && r=0 || r=1; check "#4197 off-main alert fires at the threshold crossing" "$r"
# returning to main clears the streak so a later divergence alerts fresh
git checkout -q main
printf 'tick\n' >> file1.txt
run_sync >/dev/null
[ -f "$SBX/.openclaw/locks/git-sync-offmain.count" ] && r=1 || r=0
check "#4197 returning to main clears the off-main skip counter" "$r"
teardown
unset OPENCLAW_SYNC_OFFMAIN_ALERT_TICKS

echo "=== T-SYNC-06: portable mkdir lock — live holder blocks, dead PID reclaims ==="
make_sandbox
mkdir -p "$SBX/.openclaw/locks/git-sync.lock.d"; echo $$ > "$SBX/.openclaw/locks/git-sync.lock.d/pid"  # live holder (this test proc)
printf 'y\n' > locked.txt
run_sync >/dev/null
log_has "lock held by another process" && r=0 || r=1; check "live lock holder blocks the sync" "$r"
echo 999999 > "$SBX/.openclaw/locks/git-sync.lock.d/pid"   # dead PID
run_sync >/dev/null
log_has "sync complete" && r=0 || r=1; check "dead-PID lock is reclaimed; sync proceeds" "$r"
teardown

echo "=== git-sync: offline pull is benign (exit 0, no alert, no spurious abort) ==="
make_sandbox
# RFC-6761 .invalid is guaranteed never to resolve -> real 'Could not resolve host'
# output without depending on live network state (hermetic online or offline).
git remote set-url origin "https://offline.invalid/repo.git"
printf 'edit while offline\n' >> file1.txt   # tracked change: commits locally, then pull fails offline
ec=$(run_sync)
log_has "remote unreachable (offline)" && r=0 || r=1; check "offline pull classified as benign" "$r"
[ "$ec" = "0" ] && r=0 || r=1; check "offline pull exits 0 (no false failure)" "$r"
[ -f "$SBX/.openclaw/locks/git-sync.failing" ] && r=1 || r=0; check "offline does NOT set fail-marker (no alert edge)" "$r"
log_has "There is no merge to abort" && r=1 || r=0; check "offline does NOT spew 'no merge to abort'" "$r"
teardown

echo "=== git-sync: a REAL merge conflict still exits 1 (offline-fix must not mask it) ==="
make_sandbox
git clone -q "$SBX/origin.git" "$SBX/pusher"
( cd "$SBX/pusher"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  printf 'origin-side change\n' > file1.txt; git commit -qam origin-change; git push -q origin HEAD:main )
# A REAL LOCAL COMMIT, not a dirty file (#4613). ff-first (#3561) defers the auto-commit whenever
# the node is behind with NO local commits, stashing the edit so the pull fast-forwards — so a
# dirty-file version of this scenario produces a stash-pop conflict and never reaches the pull-merge
# path this guard exists to cover. That is covered separately by the #354 stash-pop scenarios; here
# we need the merge itself, exactly as the rerere scenario above sets it up.
printf 'local-side change\n' > file1.txt; git commit -qam local-change   # conflicts with origin at pull
ec=$(run_sync)
log_has "pull failed" && r=0 || r=1; check "real conflict -> 'pull failed' (not misread as offline)" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "real conflict exits 1 (alert stays meaningful)" "$r"
log_has "There is no merge to abort" && r=1 || r=0; check "no spurious 'no merge to abort' (merge truly started)" "$r"
teardown

echo "=== #122: a rerere-recorded resolution lets the daemon push through a conflict ==="
make_sandbox
git config rerere.enabled true
git config rerere.autoupdate true
# advance origin with a conflicting add of a fresh file (add/add → conflict on next pull)
git clone -q "$SBX/origin.git" "$SBX/pusher122"
( cd "$SBX/pusher122"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  printf 'origin-side\n' > conflictme.txt; git add conflictme.txt; git commit -qm o122; git push -q origin HEAD:main )
printf 'local-side\n' > conflictme.txt; git add conflictme.txt; git commit -qm l122
# TRAIN rerere: do the merge once, resolve, commit (records the resolution), then roll
# the local branch back so the daemon faces the IDENTICAL conflict (origin unchanged).
TRAIN_BASE=$(git rev-parse HEAD)
git pull --no-rebase -q origin main 2>/dev/null || true   # conflicts; rerere records the preimage
printf 'RESOLVED-merged\n' > conflictme.txt; git add conflictme.txt; git commit -q --no-edit   # stores resolution
git reset --hard "$TRAIN_BASE" >/dev/null 2>&1            # undo merge; back to the pre-merge local commit
# now the daemon should replay the resolution, complete the merge, and push (exit 0)
ec=$(run_sync)
log_has "auto-resolved (rerere" && r=0 || r=1; check "daemon completes a rerere-resolvable pull conflict" "$r"
[ "$ec" = "0" ] && r=0 || r=1; check "rerere-resolved conflict exits 0 (pushed, not aborted)" "$r"
grep -q 'RESOLVED-merged' conflictme.txt && r=0 || r=1; check "working tree carries the replayed resolution" "$r"
git fetch -q origin 2>/dev/null
git merge-base --is-ancestor "$TRAIN_BASE" origin/main 2>/dev/null && r=0 || r=1; check "merge pushed to origin" "$r"
teardown

echo "=== #122: a NOVEL conflict (no recorded resolution) still fails soft (exit 1) ==="
make_sandbox
git clone -q "$SBX/origin.git" "$SBX/pusher122b"
( cd "$SBX/pusher122b"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  printf 'origin-novel\n' > file1.txt; git commit -qam o122b; git push -q origin HEAD:main )
# Committed locally for the same reason as the scenario above (#4613): without a local commit
# ff-first defers and the daemon never attempts the merge, so neither rerere replay nor the
# Tier-3 decline this asserts would ever be exercised.
printf 'local-novel\n' > file1.txt; git commit -qam l122b   # conflicts, but rerere has NEVER seen this preimage
# (#342) Pin METIS_AI_MERGE=0 so Tier-3 is deterministically OFF for this scenario.
# This guard asserts the FAIL-SOFT floor: no rerere record + no AI ⇒ exit 1, clean tree.
# Without the pin the daemon inherits METIS_AI_MERGE=1 and routes file1.txt (a .txt, an
# AI-RESOLVABLE_EXT) through the smith lane via `dispatch` — so the result flipped on
# whether <<MACHINE_1_ID>>'s lane happened to be reachable and resolved the trivial conflict
# (→ "Tier-3 AI-resolved", exit 0, test FAILS) vs. declined (→ exit 1, test passes).
# That env-dependence is the #342 flake. Tier-3's success path is its own concern;
# this scenario is the deterministic no-regression floor, so we hold Tier-3 out of it.
ec=$(METIS_AI_MERGE=0 run_sync)
# With Tier-3 off, rerere has no replay either, so the daemon logs the stable
# "unresolved conflict" substring (not the retired "(no rerere" wording).
log_has "unresolved conflict" && r=0 || r=1; check "novel conflict logged as unresolved (no rerere/Tier-3 replay)" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "novel conflict still exits 1 (fail-soft, no regression)" "$r"
teardown

# ================================================================================
# #058: pre-commit conflict-marker guard — fires on EVERY commit path, not just the
# sync tick. Drives the guard directly against a staged index (the way git's
# pre-commit hook invokes it).
echo "=== Tier-3: a GOVERNED-STATE json conflict is deferred to a human, never AI-resolved ==="
# ai-merge-resolver.py deliberately leaves governed-state JSON out of RESOLVABLE_EXT: those paths
# have dedicated merge drivers, so one arriving here unresolved is a driver gap for a human rather
# than something to guess at. Nothing was checking that, and the scenario alongside this one pins
# Tier-3 with METIS_AI_MERGE=0 — so every existing assertion holds with the resolver switched OFF
# and none of them would notice it starting to accept governed state. This runs with it ON.
# No lane is dispatched: the ineligibility check returns before any resolve attempt, so this stays
# deterministic on a box with no <<MACHINE_1_ID>>.
make_sandbox
mkdir -p docs/process/state
printf '{"tasks":[{"taskId":"#1","revision":1}]}\n' > docs/process/state/tasks.json
git add docs/process/state; git commit -qm "seed governed tasks.json"; git push -q origin HEAD:main
git clone -q "$SBX/origin.git" "$SBX/peert3" 2>/dev/null
( cd "$SBX/peert3"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  printf '{"tasks":[{"taskId":"#1","revision":2}]}\n' > docs/process/state/tasks.json
  git commit -qam "origin-side task edit"; git push -q origin HEAD:main ) 2>/dev/null
printf '{"tasks":[{"taskId":"#1","revision":3}]}\n' > docs/process/state/tasks.json
git commit -qam "local-side task edit"          # a real local commit, so the pull is a true merge
ec=$(TEST_AI_MERGE=1 run_sync)
log_has "ineligible files present" && r=0 || r=1
check "Tier-3 the resolver RAN and declined on eligibility (not on a missing file)" "$r"
log_has "AI-resolved" && r=1 || r=0; check "Tier-3 did NOT AI-resolve a governed-state json conflict" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "Tier-3 governed-state conflict fails soft (exit 1)" "$r"
grep -q '<<<<<<<' docs/process/state/tasks.json 2>/dev/null && r=1 || r=0
check "Tier-3 governed-state defer leaves no conflict markers in the tree" "$r"
teardown

echo "=== Tier-3: a path DECLARING a merge driver is deferred even when its type is resolvable ==="
# The eligibility question is whether the repo already decided how a path converges, not what its
# extension is (#4661). .md is resolvable, so before this every governed .md was eligible —
# including workspace/memory/working-context.md, the shared cross-session board that exists to be
# merged by an ops-based driver precisely so nobody guesses at intent, and ClaudeCode/memory/
# MEMORY.md with its memindex driver. A declared driver arriving here unresolved is a driver gap.
# Authored content with NO declared driver stays resolvable; that half is asserted below.
make_sandbox
printf 'workspace/memory/working-context.md merge=workingcontext\n' > .gitattributes
git add .gitattributes; git commit -qm "declare the workingcontext driver"; git push -q origin HEAD:main
git clone -q "$SBX/origin.git" "$SBX/peert3b" 2>/dev/null
( cd "$SBX/peert3b"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  printf 'origin board state\n' > workspace/memory/working-context.md
  git commit -qam "origin-side board edit"; git push -q origin HEAD:main ) 2>/dev/null
printf 'local board state\n' > workspace/memory/working-context.md
git commit -qam "local-side board edit"
ec=$(TEST_AI_MERGE=1 run_sync)
log_has "declares merge driver 'workingcontext'" && r=0 || r=1
check "Tier-3 defers a driver-declared .md and says WHY (driver gap, not an AI guess)" "$r"
log_has "AI-resolved" && r=1 || r=0; check "Tier-3 did NOT AI-resolve the shared board" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "Tier-3 driver-declared conflict fails soft (exit 1)" "$r"
teardown

echo "=== Tier-3: authored content with NO declared driver stays eligible (toil-saving preserved) ==="
# The other half of #4661, and the reason it was not simply "exclude all governed paths": an
# individual memory note, a decision record and taxonomy.yaml declare no driver, and those are
# exactly where cross-machine conflicts are common and auto-resolution earns its keep. This asserts
# the resolver ATTEMPTS them — it gets as far as resolving, rather than declining on eligibility.
make_sandbox
mkdir -p ClaudeCode/memory
printf 'workspace/memory/working-context.md merge=workingcontext\n' > .gitattributes
printf 'a note\n' > ClaudeCode/memory/note.md
git add .gitattributes ClaudeCode/memory; git commit -qm "seed an undriven memory note"; git push -q origin HEAD:main
git clone -q "$SBX/origin.git" "$SBX/peert3c" 2>/dev/null
( cd "$SBX/peert3c"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  printf 'origin note\n' > ClaudeCode/memory/note.md
  git commit -qam "origin-side note edit"; git push -q origin HEAD:main ) 2>/dev/null
printf 'local note\n' > ClaudeCode/memory/note.md
git commit -qam "local-side note edit"
ec=$(TEST_AI_MERGE=1 run_sync)
log_has "ineligible files present" && r=1 || r=0
check "Tier-3 does NOT decline an undriven memory note on eligibility" "$r"
log_has "resolving 1 conflicted file" && r=0 || r=1
check "Tier-3 reaches the resolve step for undriven authored content" "$r"
teardown

echo "=== #058: pre-commit guard blocks a STAGED stash-pop conflict marker ==="
make_sandbox
# Simulate the exact failure: stash-pop markers in a tracked state file, staged.
printf '{\n<<<<<<< Updated upstream\n  "fenceCounter": 19\n=======\n  "fenceCounter": 16\n>>>>>>> Stashed changes\n}\n' > file1.txt
git add file1.txt
bash "$PRECOMMIT_GUARD" >/dev/null 2>&1 && r=1 || r=0; check "staged stash-pop markers rejected (exit non-zero)" "$r"
teardown

echo "=== #058: pre-commit guard ALLOWS a clean staged change ==="
make_sandbox
printf 'a clean line, no markers\n' >> file1.txt
git add file1.txt
bash "$PRECOMMIT_GUARD" >/dev/null 2>&1 && r=0 || r=1; check "clean staged change allowed (exit 0)" "$r"
teardown

echo "=== #058: pre-commit guard does NOT false-trip on a markdown '=======' underline ==="
make_sandbox
printf 'Heading\n=======\nbody\n' >> file1.txt   # setext underline — legit, must pass
git add file1.txt
bash "$PRECOMMIT_GUARD" >/dev/null 2>&1 && r=0 || r=1; check "markdown '=======' underline allowed (no false positive)" "$r"
teardown

echo "=== #058: pre-commit guard wired live via .git/hooks blocks an actual commit ==="
make_sandbox
# Install the hook the way bootstrap does, then attempt a real marker commit.
cat > .git/hooks/pre-commit <<HOOKEOF
#!/usr/bin/env bash
exec bash "$PRECOMMIT_GUARD"
HOOKEOF
chmod +x .git/hooks/pre-commit
printf '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> branch\n' >> file1.txt
git add file1.txt
# -c core.hooksPath pins the sandbox hook dir: a developer's GLOBAL core.hooksPath (set on <<MACHINE_1_ID>>)
# otherwise silently bypasses .git/hooks and this scenario fails for an environmental reason.
git -c core.hooksPath=.git/hooks commit -qm "should be blocked" 2>/dev/null && r=1 || r=0; check "real 'git commit' with markers is blocked by the hook" "$r"
teardown

echo "=== #099: close-push.sh leaves commit local on rejected push — never stashes shared tree ==="
make_sandbox
git branch --set-upstream-to=origin/main >/dev/null 2>&1
# advance origin/main from a second clone so our push is guaranteed non-fast-forward
OTHER=$(mktemp -d)
git clone -q "$SBX/origin.git" "$OTHER/repo" 2>/dev/null
( cd "$OTHER/repo" && git config user.email t@t && git config user.name t && git config commit.gpgsign false \
  && printf 'remote-advance\n' >> file2.txt && git add file2.txt && git commit -qm "remote advance" \
  && git push -q origin HEAD:main ) 2>/dev/null
# another session's UNCOMMITTED work in the shared tree — must survive untouched
printf 'OTHER SESSION WIP\n' >> file8.txt
# our own committed close work (only our file staged)
printf 'our work\n' >> file3.txt; git add file3.txt; git commit -qm "our close commit" 2>/dev/null
OUR_SHA=$(git rev-parse HEAD)
"$SCRIPT_DIR/close-push.sh" >/dev/null 2>&1; rc=$?
git fetch -q origin 2>/dev/null
r=0
[ "$rc" -eq 0 ] || r=1                                                       # exits 0 even when push rejected
[ "$(git rev-parse HEAD)" = "$OUR_SHA" ] || r=1                             # our commit still HEAD, intact
git merge-base --is-ancestor "$OUR_SHA" origin/main 2>/dev/null && r=1      # must NOT be on origin (push rejected)
grep -q 'OTHER SESSION WIP' file8.txt || r=1                                # shared dirty work untouched
[ -z "$(git stash list)" ] || r=1                                          # NEVER stashed
check "rejected push: commit stays local, shared dirty tree untouched, no stash" "$r"
rm -rf "$OTHER"; teardown

echo "=== #101: ensure-autosync-loaded.sh — daemon liveness guard ==="
GUARD="$SCRIPT_DIR/ensure-autosync-loaded.sh"
r=0
[ -x "$GUARD" ] || r=1                                                       # exists + executable
check "ensure-autosync-loaded.sh is present and executable" "$r"
# Silent-when-healthy contract: only assertable when the real daemon is loaded.
# (The destructive unload→reload path is verified live, not in this suite, so it
# can't disrupt the always-on daemon on the machine running the tests.)
if launchctl list 2>/dev/null | grep -q ant.openclaw-git-sync; then
  out=$("$GUARD" 2>&1); rc=$?
  r=0
  [ "$rc" -eq 0 ] || r=1                                                     # never blocks session start
  [ -z "$out" ] || r=1                                                       # silent when already loaded
  check "guard is silent + exits 0 when daemon already loaded" "$r"
else
  echo "  SKIP: daemon not loaded on this host — silent-path assertion skipped"
fi

# ================================================================================
echo "=== T-SYNC-14 (#308): cross-session file-claim warns before a same-file edit diverges ==="
make_sandbox
FC="$SCRIPT_DIR/file-claims.py"
FCGUARD="$SCRIPT_DIR/git-hooks/pre-commit-fileclaim-guard.sh"
printf 'export const A = 1\n' > src1.ts; git add src1.ts; git commit -qm seed-src
# Machine A (<<MACHINE_1_ID>>, session sessA) claims src1.ts
METIS_HOME="$PWD" python3 "$FC" claim src1.ts --machine <<MACHINE_1_ID>> --session sessA --agent claude --quiet
# Machine B (<<MACHINE_2_ID>>, session sessB) stages an edit to the SAME file and runs the guard
printf 'export const A = 2\n' > src1.ts; git add src1.ts
out=$(METIS_HOME="$PWD" CLAUDE_CODE_SESSION_ID=sessB METIS_MACHINE=<<MACHINE_2_ID>> bash "$FCGUARD" 2>&1); rc=$?
r=0
printf '%s' "$out" | grep -q "FILE-CLAIM WARNING" || r=1   # warned
printf '%s' "$out" | grep -q "src1.ts" || r=1              # named the file
printf '%s' "$out" | grep -q "<<MACHINE_1_ID>>" || r=1              # named the peer machine
[ "$rc" -eq 0 ] || r=1                                     # advisory: never blocks the commit
check "cross-session same-file edit warns pre-merge (T-SYNC-14)" "$r"
# the guard claimed src1.ts for sessB too (union keeps both -> A is warned next)
METIS_HOME="$PWD" python3 "$FC" list 2>/dev/null | grep -q sessB && r=0 || r=1
check "T-SYNC-14 committing session also records its own claim" "$r"
# no false positive: an unclaimed file draws no warning
git reset -q 2>/dev/null
printf 'export const B = 1\n' > src2.ts; git add src2.ts
out2=$(METIS_HOME="$PWD" CLAUDE_CODE_SESSION_ID=sessB METIS_MACHINE=<<MACHINE_2_ID>> bash "$FCGUARD" 2>&1)
printf '%s' "$out2" | grep -q "FILE-CLAIM WARNING" && r=1 || r=0
check "T-SYNC-14 no false warning on an unclaimed file" "$r"
teardown

# ================================================================================
# #234 split-sync: with OPENCLAW_SPLIT_LANES=1 the daemon commits ONLY state files to
# main and snapshots SOURCE to autosync/<machine> (never main), leaving source dirty.
# STATE = the allowlist (workspace/memory, workspace/state, ClaudeCode/memory, docs/process/state…);
# SOURCE = everything else (root *.txt in the sandbox stands in for scripts/projects).
echo "=== SPLIT-1 (#234): state-only change is committed to main ==="
make_sandbox
printf 'state edit\n' >> workspace/memory/working-context.md   # STATE path
ec=$(TEST_SPLIT=1 TEST_MACHINE=<<MACHINE_1_ID>>; run_sync)
log_has "sync complete" && r=0 || r=1; check "state-only tick completes" "$r"
git show --stat HEAD 2>/dev/null | grep -q "workspace/memory/working-context.md" && r=0 || r=1
check "state file landed on main HEAD" "$r"
unset TEST_SPLIT TEST_MACHINE
teardown

echo "=== SPLIT-2 (#234): source-only change does NOT hit main, lands on autosync/<machine> ==="
make_sandbox
printf 'source edit\n' >> file1.txt   # SOURCE path (root file, not in allowlist)
PRE=$(git rev-parse HEAD)
ec=$(TEST_SPLIT=1 TEST_MACHINE=<<MACHINE_1_ID>>; run_sync)
log_has "source-only tick" && r=0 || r=1; check "source-only tick logged (nothing staged for main)" "$r"
[ "$(git rev-parse HEAD)" = "$PRE" ] && r=0 || r=1; check "main HEAD unchanged (source kept off main)" "$r"
git rev-parse --verify refs/heads/autosync/<<MACHINE_1_ID>> >/dev/null 2>&1 && r=0 || r=1
check "autosync/<<MACHINE_1_ID>> branch created" "$r"
git show autosync/<<MACHINE_1_ID>>:file1.txt 2>/dev/null | grep -q "source edit" && r=0 || r=1
check "source change captured on autosync/<<MACHINE_1_ID>>" "$r"
git ls-remote "$SBX/origin.git" refs/heads/autosync/<<MACHINE_1_ID>> 2>/dev/null | grep -q . && r=0 || r=1
check "autosync/<<MACHINE_1_ID>> pushed to origin" "$r"
grep -q "source edit" file1.txt && r=0 || r=1; check "source left dirty in working tree (checkpointable)" "$r"
unset TEST_SPLIT TEST_MACHINE
teardown

echo "=== SPLIT-3 (#234): mixed tick splits — state→main, source→autosync, source stays dirty ==="
make_sandbox
printf 'state edit\n' >> workspace/state/OPEN_TASKS.md   # STATE
printf 'source edit\n' >> file2.txt                 # SOURCE
ec=$(TEST_SPLIT=1 TEST_MACHINE=<<MACHINE_1_ID>>; run_sync)
git show --stat HEAD 2>/dev/null | grep -q "workspace/state/OPEN_TASKS.md" && r=0 || r=1
check "state file landed on main HEAD" "$r"
git show --stat HEAD 2>/dev/null | grep -q "file2.txt" && r=1 || r=0
check "source file NOT on main HEAD" "$r"
git show autosync/<<MACHINE_1_ID>>:file2.txt 2>/dev/null | grep -q "source edit" && r=0 || r=1
check "source change on autosync/<<MACHINE_1_ID>>" "$r"
git status --porcelain 2>/dev/null | grep -q "file2.txt" && r=0 || r=1
check "source still dirty in working tree after the split tick" "$r"
unset TEST_SPLIT TEST_MACHINE
teardown

echo "=== SPLIT-4 (#234): kill-switch (SPLIT=0) → legacy blanket-add puts source on main ==="
make_sandbox
printf 'source edit\n' >> file3.txt
ec=$(TEST_SPLIT=0 TEST_MACHINE=<<MACHINE_1_ID>>; run_sync)
log_has "sync complete" && r=0 || r=1; check "legacy tick completes" "$r"
git show --stat HEAD 2>/dev/null | grep -q "file3.txt" && r=0 || r=1
check "kill-switch keeps source on main (legacy behavior intact)" "$r"
unset TEST_SPLIT TEST_MACHINE
teardown

echo "=== T-SYNC-15 (#234-adjacent): daemon self-registers diff.ignoreSubmodules=dirty ==="
make_sandbox
printf 'tick\n' >> file1.txt
run_sync >/dev/null
[ "$(git config --get diff.ignoreSubmodules)" = "dirty" ] && r=0 || r=1
check "daemon self-registered diff.ignoreSubmodules=dirty (orphaned-gitlink wedge fix)" "$r"
teardown

# ================================================================================
# #354: pre-pull stash robustness — pop by ref, abort-clean on conflict, cap strays.
# workspace/lanes is excluded from the daemon's commit, so a modified tracked file there
# stays dirty after commit and is exactly what gets stashed before the pull.
echo "=== #354: stash-pop conflict leaves a CLEAN tree + preserves the stash (no wedge) ==="
make_sandbox
mkdir -p workspace/lanes
printf 'base\n' > workspace/lanes/work.txt
git add -A; git commit -qm "add lane file"; git push -q origin HEAD:main
# origin advances the SAME excluded file from another clone (will conflict on pop)
git clone -q "$SBX/origin.git" "$SBX/pusher354" 2>/dev/null
( cd "$SBX/pusher354"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  printf 'origin-side\n' > workspace/lanes/work.txt; git commit -qam o354; git push -q origin HEAD:main ) 2>/dev/null
# local: conflicting edit to the excluded file (gets stashed) + a committable change
printf 'local-side\n' > workspace/lanes/work.txt
printf 'tick\n' >> file1.txt
ec=$(run_sync)
log_has "stash pop conflict" && r=0 || r=1; check "pop conflict detected + logged" "$r"
# Scope to the tree under test: scripts/ holds mirrored fixture tooling, and
# ai-merge-resolver.py contains conflict-marker patterns in its own source.
git grep -I -l -e '<<<<<<<' -e '>>>>>>>' -- . ':(exclude)scripts' >/dev/null 2>&1 && r=1 || r=0
check "NO conflict markers left in the working tree (wedge fixed)" "$r"
git stash list | grep -q "auto-sync pre-pull stash" && r=0 || r=1
check "local edits preserved in the stash (not lost)" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "pop conflict exits 1 (does not push)" "$r"
teardown

echo "=== #354: daemon caps its OWN pre-pull stashes; never prunes a foreign stash ==="
make_sandbox
# plant 7 stale auto-sync stashes (cap default is 5) — each needs a real change
for i in 1 2 3 4 5 6 7; do
  printf 'stale %s\n' "$i" >> file8.txt
  git stash push -m "auto-sync pre-pull stash 2026-06-13 0$i:00:00" -- file8.txt >/dev/null 2>&1
done
# a foreign stash that must NEVER be pruned
printf 'precious\n' >> file7.txt
git stash push -m "human keep — do not touch" -- file7.txt >/dev/null 2>&1
printf 'tick\n' >> file1.txt   # committable change drives a normal tick (runs prune)
run_sync >/dev/null
n=$(git stash list | grep -c "auto-sync pre-pull stash")
[ "$n" -le 5 ] && r=0 || r=1; check "auto-sync stashes capped to <=5 (kept newest)" "$r"
git stash list | grep -q "human keep" && r=0 || r=1; check "foreign stash never pruned" "$r"
teardown

echo "=== #354: a committable-only tick strands no auto-sync stash ==="
make_sandbox
printf 'committable\n' >> file1.txt
run_sync >/dev/null
git stash list | grep -q "auto-sync pre-pull stash" && r=1 || r=0
check "no auto-sync stash lingers after a clean commit tick" "$r"
teardown

# ================================================================================
# #452: leaked-orphan lock reclaim. A bare `sleep` reparented to PID 1 (the orphaned
# child of a SIGKILLed lock holder) stays ALIVE, so pid-liveness reclaim never fires
# and it wedges auto-sync for up to its sleep duration. holder_is_leaked() must catch
# it WITHOUT false-stealing a live, legitimate holder.
echo "=== #452: holder_is_leaked() classifies lock holders (both directions) ==="
. "$SCRIPT_DIR/lib/git-sync-lock.sh"   # pure-function lib — safe to source directly

# orphan-maker: background a cmd in a sub-bash that exits, so the child reparents to PID 1
orphan_sleep=$(bash -c 'sleep 300 >/dev/null 2>&1 & echo $!')
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pp=$(ps -o ppid= -p "$orphan_sleep" 2>/dev/null | awk '{print $1}')
  [ "$pp" = "1" ] && break; sleep 0.2
done
holder_is_leaked "$orphan_sleep" && r=0 || r=1
check "orphaned bare sleep (PPID=1) detected as leaked" "$r"

sleep 300 & live_sleep=$!   # alive, but parent (this shell) is alive -> PPID != 1
holder_is_leaked "$live_sleep" && r=1 || r=0
check "live sleep with a living parent is NOT leaked (no false steal)" "$r"
kill "$live_sleep" 2>/dev/null

orphan_tail=$(bash -c 'tail -f /dev/null >/dev/null 2>&1 & echo $!')
for _ in 1 2 3 4 5; do
  pp=$(ps -o ppid= -p "$orphan_tail" 2>/dev/null | awk '{print $1}')
  [ "$pp" = "1" ] && break; sleep 0.2
done
holder_is_leaked "$orphan_tail" && r=1 || r=0
check "orphaned NON-sleep process is NOT reclaimed (conservative)" "$r"
kill "$orphan_tail" 2>/dev/null

holder_is_leaked 999999 && r=1 || r=0
check "non-existent pid is NOT leaked (dead-pid path owns that case)" "$r"

echo "=== #452: daemon RECLAIMS a leaked-orphan lock and completes the sync ==="
make_sandbox
orphan=$(bash -c 'sleep 300 >/dev/null 2>&1 & echo $!')
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pp=$(ps -o ppid= -p "$orphan" 2>/dev/null | awk '{print $1}')
  [ "$pp" = "1" ] && break; sleep 0.2
done
mkdir -p "$SBX/.openclaw/locks/git-sync.lock.d"
echo "$orphan" > "$SBX/.openclaw/locks/git-sync.lock.d/pid"
printf 'tick\n' >> file1.txt   # committable change so a successful tick really commits
run_sync >/dev/null
log_has "reclaimed leaked orphan lock holder" && r=0 || r=1
check "daemon logs the leaked-orphan reclaim" "$r"
log_has "lock held by another process" && r=1 || r=0
check "daemon did NOT skip on the leaked lock" "$r"
# origin must have ADVANCED past the seed (>=2 commits) — proves the tick really pushed
oc=$(git -C "$SBX/origin.git" rev-list --count main 2>/dev/null || echo 0)
[ "${oc:-0}" -ge 2 ] && r=0 || r=1
check "daemon pushed its tick after reclaiming the leaked lock (origin advanced)" "$r"
kill "$orphan" 2>/dev/null
teardown

echo "=== #452: daemon still SKIPS for a live legitimate (non-leaked) holder ==="
make_sandbox
sleep 300 & live=$!   # living parent -> genuine holder, must NOT be stolen
mkdir -p "$SBX/.openclaw/locks/git-sync.lock.d"
echo "$live" > "$SBX/.openclaw/locks/git-sync.lock.d/pid"
printf 'tick\n' >> file1.txt
run_sync >/dev/null
log_has "lock held by another process" && r=0 || r=1
check "daemon skips (does NOT steal) a live legitimate holder" "$r"
kill "$live" 2>/dev/null
teardown

echo "=== T-SYNC-13: a STALE orphaned HEAD.lock is reclaimed so the tick still syncs ==="
make_sandbox
: > .git/HEAD.lock                        # orphaned lock, nothing holding it
touch -t 202001010000 .git/HEAD.lock      # backdate well past the 60s grace floor
printf 'tick\n' >> file1.txt              # a real tracked change to drive a full tick
run_sync >/dev/null
log_has "reclaimed stale orphaned HEAD.lock" && r=0 || r=1
check "daemon reclaims a stale orphaned HEAD.lock" "$r"
[ ! -f .git/HEAD.lock ] && r=0 || r=1
check "stale HEAD.lock is gone after the tick" "$r"
# Assert the tick COMMITTED (local HEAD advanced). A local commit is the tight proof that
# the reclaim actually unblocked git; the fixture now seeds a known-good gate (#719) so the
# push would also succeed, but asserting the commit keeps this scenario about the reclaim.
lc=$(git rev-list --count HEAD 2>/dev/null || echo 0)
[ "${lc:-0}" -ge 2 ] && r=0 || r=1
check "tick committed locally after reclaiming HEAD.lock (HEAD advanced)" "$r"
teardown

echo "=== T-SYNC-13: a FRESH HEAD.lock (< grace) is left for the presumed in-flight op ==="
make_sandbox
: > .git/HEAD.lock                        # just created -> younger than the grace floor
printf 'tick\n' >> file1.txt
run_sync >/dev/null
log_has "is fresh" && r=0 || r=1
check "daemon leaves a fresh HEAD.lock alone (skips the cycle)" "$r"
[ -f .git/HEAD.lock ] && r=0 || r=1
check "fresh HEAD.lock is NOT removed" "$r"
rm -f .git/HEAD.lock
teardown

echo "=== T-SYNC-13: an OLD but live-HELD HEAD.lock is NOT stolen (lsof holder wins) ==="
make_sandbox
: > .git/HEAD.lock
touch -t 202001010000 .git/HEAD.lock      # old enough to clear the grace floor...
sleep 300 < .git/HEAD.lock & holder=$!     # ...but a live process holds an fd on it
run_sync >/dev/null
log_has "HEAD.lock held by live pid" && r=0 || r=1
check "daemon does NOT steal an old lock a live process still holds" "$r"
[ -f .git/HEAD.lock ] && r=0 || r=1
check "live-held HEAD.lock is preserved" "$r"
kill "$holder" 2>/dev/null
rm -f .git/HEAD.lock
teardown

echo "=== #886 defer: fresh edit-marker + uncommitted (excluded) working edits -> DEFER, no stash ==="
make_sandbox
mkdir -p workspace/lanes
printf 'in-flight work\n' > workspace/lanes/wip.txt        # excluded from auto-commit -> stays in DIRTY_AFTER_COMMIT
touch "$SBX/.openclaw/session-editing"                  # marker fresh (age ~0 << TTL)
ec=$(run_sync)
log_has "deferring stash/pull" && r=0 || r=1; check "fresh marker + dirty -> daemon defers" "$r"
[ "$ec" = "0" ] && r=0 || r=1;                          check "defer is a benign skip (exit 0)" "$r"
log_has "stashed .* file" && r=1 || r=0;                check "defer did NOT stash the in-flight work" "$r"
[ -f workspace/lanes/wip.txt ] && r=0 || r=1;              check "in-flight file still present after defer" "$r"
teardown

echo "=== #886 defer: STALE marker + same dirty tree -> proceeds (no defer) ==="
make_sandbox
mkdir -p workspace/lanes
printf 'in-flight work\n' > workspace/lanes/wip.txt
touch -t 202001010000 "$SBX/.openclaw/session-editing" # ancient mtime -> stale (age >> TTL)
run_sync >/dev/null
log_has "deferring stash/pull" && r=1 || r=0; check "stale marker -> daemon does NOT defer" "$r"
teardown

echo "=== #886 defer: NO marker + dirty tree -> proceeds (no defer) ==="
make_sandbox
mkdir -p workspace/lanes
printf 'in-flight work\n' > workspace/lanes/wip.txt
rm -f "$SBX/.openclaw/session-editing"
run_sync >/dev/null
log_has "deferring stash/pull" && r=1 || r=0; check "no marker -> daemon does NOT defer" "$r"
teardown

echo "=== #886b: the defer CEILING forces a reconcile past MAX_DRIFT (anti-starvation) ==="
# The three scenarios above pin when the daemon DEFERS. None pinned when it must stop deferring,
# which is the half with a scar attached: an edit marker refreshed every turn never goes stale, so
# a node with in-flight work deferred every tick and drifted 298 ahead / 73 behind over 39h before
# anyone noticed. The ceiling is the only thing that ends that, and nothing was checking it.
make_sandbox
mkdir -p workspace/lanes
printf 'in-flight work\n' > workspace/lanes/wip.txt
touch "$SBX/.openclaw/session-editing"                  # marker fresh — would defer, unmodified
git clone -q "$SBX/origin.git" "$SBX/peer886" 2>/dev/null
( cd "$SBX/peer886"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  printf 'p1\n' >> file3.txt; git commit -qam p886a
  printf 'p2\n' >> file3.txt; git commit -qam p886b
  git push -q origin HEAD:main ) 2>/dev/null
ec=$(OPENCLAW_SYNC_MAX_DRIFT=1 run_sync)
log_has "defer CEILING hit" && r=0 || r=1; check "#886b past the drift ceiling the daemon stops deferring" "$r"
log_has "deferring stash/pull" && r=1 || r=0; check "#886b the ceiling tick did NOT take the defer path" "$r"
[ -f workspace/lanes/wip.txt ] && r=0 || r=1; check "#886b forcing the reconcile still preserves in-flight work" "$r"
teardown

echo "=== #886b: BELOW the ceiling the same tree still defers (the ceiling is the only difference) ==="
make_sandbox
mkdir -p workspace/lanes
printf 'in-flight work\n' > workspace/lanes/wip.txt
touch "$SBX/.openclaw/session-editing"
git clone -q "$SBX/origin.git" "$SBX/peer886b" 2>/dev/null
( cd "$SBX/peer886b"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  printf 'p1\n' >> file3.txt; git commit -qam p886c
  printf 'p2\n' >> file3.txt; git commit -qam p886d
  git push -q origin HEAD:main ) 2>/dev/null
ec=$(OPENCLAW_SYNC_MAX_DRIFT=99 run_sync)
log_has "deferring stash/pull" && r=0 || r=1; check "#886b below the ceiling the identical tree defers" "$r"
log_has "defer CEILING hit" && r=1 || r=0; check "#886b below the ceiling no ceiling message" "$r"
teardown

echo "=== #354 follow-on: over-cap prune ARCHIVES stashes losslessly (never blind-drops real WIP) ==="
make_sandbox
export OPENCLAW_SYNC_STASH_KEEP=2
# 4 daemon-pattern stashes; the OLDEST (created first -> highest stash index -> pruned) carries
# unique content that must survive the prune. Each git-stash resets the tree, so the stashes are
# distinct single-line additions and the tree is clean before run_sync (no daemon stash added).
for n in 1 2 3 4; do
  printf 'stash-content-%s\n' "$n" >> file1.txt
  [ "$n" = "1" ] && printf 'UNIQ-PRUNE-MARKER-42\n' >> file2.txt
  git stash push --include-untracked -m "auto-sync pre-pull stash 2026-07-27 0${n}:00:00" >/dev/null 2>&1
done
before=$(git stash list 2>/dev/null | grep -c 'auto-sync pre-pull stash')
run_sync >/dev/null
after=$(git stash list 2>/dev/null | grep -c 'auto-sync pre-pull stash')
{ [ "$before" = "4" ] && [ "$after" -le 2 ]; } && r=0 || r=1; check "over-cap stashes pruned to <= KEEP (was $before, now $after)" "$r"
git branch --list 'stash-archive/*' | grep -q . && r=0 || r=1; check "pruned stashes archived to stash-archive/* branches (not blind-dropped)" "$r"
found=0
while IFS= read -r b; do
  b="${b#\*}"; b="${b//[[:space:]]/}"
  git show "$b:file2.txt" 2>/dev/null | grep -q 'UNIQ-PRUNE-MARKER-42' && { found=1; break; }
done < <(git branch --list 'stash-archive/*')
[ "$found" = "1" ] && r=0 || r=1; check "unique content from a pruned stash recoverable from an archive branch (LOSSLESS)" "$r"
log_has "archived over-cap stash" && r=0 || r=1; check "prune logged a lossless archive line" "$r"
unset OPENCLAW_SYNC_STASH_KEEP
teardown

# ================================================================================
# #1605: silent delete-vs-unmodified / merge-artifact drop protection. git resolves a
# delete-vs-unmodified 3-way as delete-wins with NO conflict, so a file/block removed only
# by merge resolution (no explicit non-merge delete commit) vanishes silently — past the
# conflict-marker guards, past the Tier-3 resolver, and (single/spread/block) past T-SYNC-11.
# audit_silent_drops attributes each removal: intentional deletes (a non-merge delete commit
# in range) pass; merge-artifact drops are refused+reset+alerted. Reproduced with a peer
# MERGE commit whose tree omits/shortens a file neither parent removed — the exact artifact.
# ================================================================================
# #3685 stranded-source alerting, under repetition. One conflicted stash pop is a discrete
# incident and pages once, which is correct. The question this pins is what happens when the
# condition PERSISTS — a session actively editing a source file that another machine is also
# changing — because each tick then produces a NEW stash sha, a new recover/* branch on origin,
# and (before the fix) a new page. The stash sha is why the obvious dedup key does not work:
# it is different every tick by construction. The stable identity of the incident is the SET OF
# STRANDED PATHS, so that is what the marker holds.
echo "=== #3685: a PERSISTENT stranding pages once, not every tick ==="
make_sandbox
git clone -q "$SBX/pusher3685x" 2>/dev/null || true
git clone -q "$SBX/origin.git" "$SBX/pusher3685" 2>/dev/null
# tick 1: origin moves file1.txt, local holds a conflicting UNCOMMITTED edit -> stash, ff, pop conflicts
( cd "$SBX/pusher3685"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  printf 'origin one\n' > file1.txt; git commit -qam o1; git push -q origin HEAD:main ) 2>/dev/null
printf 'local one\n' > file1.txt
ec1=$(run_sync)
strand1=$(grep -c 'stash pop conflicted and stranded' "$ALERTS" 2>/dev/null || echo 0)
log_has "STRANDED SOURCE" && r=0 || r=1; check "#3685 a conflicted stash pop strands and reports" "$r"
# Load-bearing for the marker's lifetime, not just for alerting: the clean-sync path clears
# STRAND_MARKER unconditionally, which is safe only while a stranding tick exits BEFORE the push.
# Make stranding non-fatal and the marker is cleared by the very tick that set it.
[ "$ec1" = "1" ] && r=0 || r=1; check "#3685 a stranding tick exits 1 (the strand marker outlives the tick)" "$r"
[ "$strand1" = "1" ] && r=0 || r=1; check "#3685 the first stranding pages exactly once (got $strand1)" "$r"
# tick 2: same story again — the session re-edits the same file, origin moves it again
( cd "$SBX/pusher3685"; git pull -q --no-rebase origin main 2>/dev/null
  printf 'origin two\n' > file1.txt; git commit -qam o2; git push -q origin HEAD:main ) 2>/dev/null
printf 'local two\n' > file1.txt
ec2=$(run_sync)
strand2=$(grep -c 'stash pop conflicted and stranded' "$ALERTS" 2>/dev/null || echo 0)
[ "$strand2" = "$strand1" ] && r=0 || r=1; check "#3685 the repeat stranding of the SAME path does not re-page (was $strand1, now $strand2)" "$r"
log_has "same path(s) as the previous stranding" && r=0 || r=1; check "#3685 the suppressed repeat is logged, not silent" "$r"
# a DIFFERENT path must still page — dedup must not swallow a new incident
( cd "$SBX/pusher3685"; git pull -q --no-rebase origin main 2>/dev/null
  printf 'origin three\n' > file2.txt; git commit -qam o3; git push -q origin HEAD:main ) 2>/dev/null
printf 'local three\n' > file2.txt
ec3=$(run_sync)
strand3=$(grep -c 'stash pop conflicted and stranded' "$ALERTS" 2>/dev/null || echo 0)
[ "$strand3" -gt "$strand2" ] && r=0 || r=1; check "#3685 a stranding of a DIFFERENT path still pages (was $strand2, now $strand3)" "$r"
teardown

echo "=== #1605: a merge that SILENTLY drops a whole file (no delete commit) is refused ==="
make_sandbox
# both sides start with the file; commit + push it as the shared base
printf 'export const KEEPME = 1\nline2\nline3\n' > victim.ts
git add victim.ts; git commit -qm "add victim.ts"; git push -q origin HEAD:main
# peer builds a MERGE commit whose tree OMITS victim.ts, with NO explicit rm on either parent
git clone -q "$SBX/origin.git" "$SBX/peer1605" 2>/dev/null
( cd "$SBX/peer1605"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  BASE=$(git rev-parse HEAD)
  git checkout -q -b pmod
  printf 'other change\n' >> file3.txt; git commit -qam "peer unrelated mod"   # unrelated, victim untouched
  CMOD=$(git rev-parse HEAD)
  git checkout -q main
  # merge tree = current tree MINUS victim.ts; parents = [main(base), pmod] — a resolver-style artifact
  BADTREE=$(git ls-tree HEAD | grep -v 'victim.ts' | git mktree)
  MP=$(git commit-tree "$BADTREE" -p "$BASE" -p "$CMOD" -m "[auto-sync] merge (silently drops victim.ts)")
  git reset -q --hard "$MP"
  git push -q origin HEAD:main ) 2>/dev/null
# local makes an unrelated committable change, then pulls the silent-drop merge
printf 'local note\n' >> file1.txt
PRE_LOCAL=$(git rev-parse HEAD)
ec=$(run_sync)
log_has "SILENTLY dropped" && r=0 || r=1; check "silent whole-file drop detected + refused (#1605)" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "#1605 silent drop exits 1 (alert edge)" "$r"
[ -f victim.ts ] && grep -q KEEPME victim.ts && r=0 || r=1; check "#1605 reset-hard restored the silently-dropped file" "$r"
git fetch -q origin 2>/dev/null
git merge-base --is-ancestor "$(git rev-parse origin/main 2>/dev/null || echo HEAD)" HEAD 2>/dev/null && r=1 || r=0
check "#1605 did NOT push the silent-drop merge to origin" "$r"
# The drop is on origin, so resetting cannot clear it and the NEXT tick pulls the identical merge
# back. It must refuse again — and must not page again (#4621). Counting alerts across both ticks
# is the only assertion that can tell a deduped incident from a per-tick storm.
alerts_after_1=$(grep -c . "$ALERTS" 2>/dev/null || echo 0)
ec2=$(run_sync)
alerts_after_2=$(grep -c . "$ALERTS" 2>/dev/null || echo 0)
[ "$ec2" = "1" ] && r=0 || r=1; check "#4621 the repeat tick still REFUSES the same drop" "$r"
[ "$alerts_after_2" = "$alerts_after_1" ] && r=0 || r=1; check "#4621 the repeat tick raises no new alert (was $alerts_after_1, now $alerts_after_2)" "$r"
[ "$(grep -c 'BLOCKED a silent' "$ALERTS" 2>/dev/null || echo 0)" = "1" ] && r=0 || r=1; check "#4621 exactly one silent-drop page across both ticks" "$r"
log_has "already alerted, staying quiet" && r=0 || r=1; check "#4621 the suppressed repeat is logged, not silent" "$r"
log_has "already published on origin/main, so a reset cannot clear it" && r=0 || r=1; check "#4621 a received drop is told to heal forward, not to reset-and-merge" "$r"
teardown

# ================================================================================
# #4861 finding 6: a PUBLISHED silent drop is a fleet livelock — a reset cannot clear it, so
# every node refuses on every tick until someone heals forward. The ONE designated node
# (OPENCLAW_HEAL_FORWARD_NODE == hostname) does that heal automatically: restore the dropped
# paths on top of the published merge and push, ending the livelock. A NON-designated node must
# still refuse+reset (it waits for the heal to arrive via origin). Both halves are asserted.
build_published_drop() { # <peerdir> — leaves a published merge on origin that silently drops victim.ts
  printf 'export const KEEPME = 1\nline2\nline3\n' > victim.ts
  git add victim.ts; git commit -qm "add victim.ts"; git push -q origin HEAD:main
  git clone -q "$SBX/origin.git" "$SBX/$1" 2>/dev/null
  ( cd "$SBX/$1"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
    BASE=$(git rev-parse HEAD)
    git checkout -q -b pmod
    printf 'other change\n' >> file3.txt; git commit -qam "peer unrelated mod"
    CMOD=$(git rev-parse HEAD)
    git checkout -q main
    BADTREE=$(git ls-tree HEAD | grep -v 'victim.ts' | git mktree)
    MP=$(git commit-tree "$BADTREE" -p "$BASE" -p "$CMOD" -m "[auto-sync] merge (silently drops victim.ts)")
    git reset -q --hard "$MP"
    git push -q origin HEAD:main ) 2>/dev/null
  printf 'local note\n' >> file1.txt
}

echo "=== #4861: the DESIGNATED node HEALS a published silent drop forward (ends the livelock) ==="
make_sandbox
build_published_drop peerheal
ec=$(TEST_HEAL_NODE="$(hostname -s)" run_sync)
log_has "HEAL-FORWARD" && r=0 || r=1; check "#4861 designated node heals forward (not refuse)" "$r"
[ "$ec" = "0" ] && r=0 || r=1; check "#4861 heal-forward tick exits 0 (pushes the fix, not a failure edge)" "$r"
{ [ -f victim.ts ] && grep -q KEEPME victim.ts; } && r=0 || r=1; check "#4861 heal-forward restored the dropped file in the working tree" "$r"
git fetch -q origin 2>/dev/null
git cat-file -e "origin/main:victim.ts" 2>/dev/null && r=0 || r=1; check "#4861 heal-forward PUSHED victim.ts back onto origin/main (livelock ended)" "$r"
[ "$(grep -c 'HEAL-FORWARD' "$ALERTS" 2>/dev/null || echo 0)" -ge 1 ] && r=0 || r=1; check "#4861 heal-forward pages the incident" "$r"
teardown

echo "=== #4861: a NON-designated node does NOT heal — still refuses+resets ==="
make_sandbox
build_published_drop peerheal2
ec=$(TEST_HEAL_NODE="definitely-not-this-host" run_sync)
log_has "SILENTLY dropped" && r=0 || r=1; check "#4861 non-designated node still REFUSES the drop" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "#4861 non-designated node exits 1 (waits for the heal via origin, no auto-mutation)" "$r"
{ [ -f victim.ts ] && grep -q KEEPME victim.ts; } && r=0 || r=1; check "#4861 non-designated node reset-restored victim.ts locally (unchanged behavior)" "$r"
teardown

# ================================================================================
# A keep-ours path can still VANISH. The keep-ours exemption exists for #2900: .gitattributes
# declares merge=keepours on nine patterns of derived state so a cross-machine convergence
# resolves them deterministically instead of conflicting, and the guard was then refusing every
# push over content the declared policy had discarded ON PURPOSE. Correct — for CONTENT.
#
# But the `true` driver only ever runs on a content-level 3-way merge of a path both sides have.
# A delete-vs-unmodified resolves to delete with NO conflict and NO driver invocation, so a
# keep-ours path can disappear without the declared policy having been consulted at all — and
# the whole-file check skipped it anyway, because the exemption was applied to both halves of the
# audit rather than to the half the rationale covers. Several of these paths are date- or
# key-stamped and are never regenerated once past: an older audits/<date>.md, a completed
# run-results/<key>.md the relay design guarantees will never re-run.
echo "=== keep-ours: a path that VANISHES is still flagged (exemption is content-only) ==="
make_sandbox
printf 'workspace/state/audits/** merge=keepours\n' > .gitattributes
mkdir -p workspace/state/audits
printf 'audit body\nline2\n' > workspace/state/audits/2026-01-01.md
git add .gitattributes workspace/state/audits/2026-01-01.md
git commit -qm "add a keep-ours audit artifact"; git push -q origin HEAD:main
git clone -q "$SBX/origin.git" "$SBX/peerko" 2>/dev/null
( cd "$SBX/peerko"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  BASE=$(git rev-parse HEAD)
  git checkout -q -b pko
  printf 'other change\n' >> file3.txt; git commit -qam "peer unrelated mod"
  CMOD=$(git rev-parse HEAD)
  git checkout -q main
  # merge tree omits the audit file; neither parent removed it. Build it via the index rather
  # than `ls-tree | mktree`: mktree reads a FLAT listing, so a nested path silently produces a
  # tree that does not drop what you meant to drop (it produced a passing test here first).
  git read-tree HEAD
  git update-index --force-remove workspace/state/audits/2026-01-01.md
  BADTREE=$(git write-tree)
  MP=$(git commit-tree "$BADTREE" -p "$BASE" -p "$CMOD" -m "[auto-sync] merge (silently drops a keep-ours audit)")
  git update-ref refs/heads/main "$MP"
  git push -q origin main ) 2>/dev/null
printf 'local note\n' >> file1.txt
ec=$(run_sync)
log_has "SILENTLY dropped" && r=0 || r=1; check "keep-ours path that VANISHED is flagged (driver never ran)" "$r"
[ -f workspace/state/audits/2026-01-01.md ] && r=0 || r=1; check "keep-ours vanish: reset-hard restored the file" "$r"
teardown

# The #2900 no-regression alongside it: a keep-ours path whose CONTENT the declared resolution
# discarded must still pass, or the convergence livelock returns (31 commits stranded, every
# push refused while every merge succeeded).
echo "=== keep-ours: content discarded by the DECLARED resolution is still NOT flagged (#2900) ==="
make_sandbox
printf 'workspace/state/audits/** merge=keepours\n' > .gitattributes
mkdir -p workspace/state/audits
{ echo "audit header"; for i in $(seq 1 80); do echo "row $i"; done; } > workspace/state/audits/2026-02-02.md
git add .gitattributes workspace/state/audits/2026-02-02.md
git commit -qm "add a long keep-ours audit artifact"; git push -q origin HEAD:main
git clone -q "$SBX/origin.git" "$SBX/peerko2" 2>/dev/null
( cd "$SBX/peerko2"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  BASE=$(git rev-parse HEAD)
  git checkout -q -b pko2
  printf 'other change\n' >> file3.txt; git commit -qam "peer unrelated mod"
  CMOD=$(git rev-parse HEAD)
  git checkout -q main
  # the merge keeps a much SHORTER regenerated render of the same artifact — the keep-ours outcome
  { echo "audit header"; echo "row 1"; } > workspace/state/audits/2026-02-02.md
  git add workspace/state/audits/2026-02-02.md
  SHORT=$(git write-tree)
  MP=$(git commit-tree "$SHORT" -p "$BASE" -p "$CMOD" -m "[auto-sync] merge (keep-ours regenerated render)")
  git update-ref refs/heads/main "$MP"
  git push -q origin main ) 2>/dev/null
printf 'local note\n' >> file1.txt
ec=$(run_sync)
log_has "SILENTLY dropped" && r=1 || r=0; check "keep-ours content loss NOT flagged (#2900 stays fixed)" "$r"
log_has "sync complete" && r=0 || r=1; check "keep-ours content loss syncs through" "$r"
teardown

echo "=== #1605: an INTENTIONAL explicit delete (has a delete commit) is NOT flagged ==="
make_sandbox
printf 'export const GOODBYE = 1\n' > removable.ts
git add removable.ts; git commit -qm "add removable.ts"; git push -q origin HEAD:main
git clone -q "$SBX/origin.git" "$SBX/peer1605b" 2>/dev/null
( cd "$SBX/peer1605b"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  git rm -q removable.ts; git commit -qm "intentional removal (real delete commit)"; git push -q origin HEAD:main ) 2>/dev/null
printf 'note\n' >> file2.txt
ec=$(run_sync)
log_has "SILENTLY dropped" && r=1 || r=0; check "intentional delete NOT flagged as silent drop (no false positive)" "$r"
log_has "sync complete" && r=0 || r=1; check "intentional delete syncs through normally" "$r"
[ -f removable.ts ] && r=1 || r=0; check "intentional delete is honored (file stays deleted, not resurrected)" "$r"
teardown

echo "=== #1605: a merge that SILENTLY drops a large BLOCK from a surviving file is refused ==="
make_sandbox
# a substantive file; the block-drop must exceed SYNC_DROP_BLOCK_LINES (default 40)
{ echo "// header"; for i in $(seq 1 80); do echo "const line$i = $i;"; done; } > big.ts
git add big.ts; git commit -qm "add big.ts (81 lines)"; git push -q origin HEAD:main
git clone -q "$SBX/origin.git" "$SBX/peer1605c" 2>/dev/null
( cd "$SBX/peer1605c"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  BASE=$(git rev-parse HEAD)
  git checkout -q -b pmod
  printf 'x\n' >> file3.txt; git commit -qam "peer unrelated"   # big.ts untouched on this parent
  CMOD=$(git rev-parse HEAD)
  git checkout -q main
  # merge tree = big.ts TRUNCATED to its first 10 lines (a ~70-line block only the merge removed)
  { echo "// header"; for i in $(seq 1 9); do echo "const line$i = $i;"; done; } > big.ts
  BLOB=$(git hash-object -w big.ts)
  git checkout -q -- big.ts   # restore working copy; we only want the blob in the synthetic tree
  BADTREE=$(git ls-tree HEAD | sed "s#blob [0-9a-f]*\tbig.ts#blob $BLOB\tbig.ts#" | git mktree)
  MP=$(git commit-tree "$BADTREE" -p "$BASE" -p "$CMOD" -m "[auto-sync] merge (silently truncates big.ts)")
  git reset -q --hard "$MP"
  git push -q origin HEAD:main ) 2>/dev/null
printf 'local note\n' >> file1.txt
ec=$(run_sync)
log_has "SILENTLY dropped" && r=0 || r=1; check "silent content-block drop detected + refused (#1605)" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "#1605 block drop exits 1" "$r"
lines=$(wc -l < big.ts | tr -d ' '); [ "$lines" -ge 80 ] && r=0 || r=1; check "#1605 reset-hard restored the truncated block (>=80 lines)" "$r"
teardown

echo "=== #1605: a LEGIT large deletion via an explicit commit is NOT flagged (block heuristic) ==="
make_sandbox
{ echo "// header"; for i in $(seq 1 80); do echo "const line$i = $i;"; done; } > refactor.ts
git add refactor.ts; git commit -qm "add refactor.ts"; git push -q origin HEAD:main
git clone -q "$SBX/origin.git" "$SBX/peer1605d" 2>/dev/null
( cd "$SBX/peer1605d"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  { echo "// header"; for i in $(seq 1 9); do echo "const line$i = $i;"; done; } > refactor.ts   # remove ~70 lines
  git commit -qam "legit refactor: trim refactor.ts (real commit, attributable)"; git push -q origin HEAD:main ) 2>/dev/null
printf 'note\n' >> file2.txt
ec=$(run_sync)
log_has "SILENTLY dropped" && r=1 || r=0; check "attributable large deletion NOT flagged (no false positive on refactors)" "$r"
log_has "sync complete" && r=0 || r=1; check "legit refactor syncs through normally" "$r"
teardown

# ================================================================================
# #4613 regression: the fast-forward FALSE POSITIVE that the old blanket early-return was
# covering for. Content already present at PRE whose original commit is still unmerged
# (cherry-pick, restore-to-last-green) makes the numstat PROXY baseline count the same lines
# twice, so `expected` overshoots by a whole file and the node refuses its own push. That is
# what held <<MACHINE_2_ID>> at ahead=0/behind=23 for hours on 2026-08-18 over two files that were
# byte-for-byte correct on either side.
#
# The blanket "already published -> return 0" fixed it by switching the entire audit off,
# which also switched off the whole-file check and let a peer's silent drop propagate
# unguarded (the whole-file scenario above). The audit now stays ON here and uses the EXACT
# merge-tree baseline, which cannot double-count; the proxy is declined rather than guessed.
# This scenario pins that: reproduce the double-count shape and assert it does NOT flag.
echo "=== #4613: a fast-forward over duplicated content is NOT flagged (proxy double-count) ==="
make_sandbox
{ echo "// header"; for i in $(seq 1 3); do echo "const base$i = $i;"; done; } > dup.ts
git add dup.ts; git commit -qm "add dup.ts"; git push -q origin HEAD:main
# peer authors the 60-line block on a side branch and leaves it UNMERGED for now
git clone -q "$SBX/origin.git" "$SBX/peer4613" 2>/dev/null
( cd "$SBX/peer4613"; git config user.email t@t; git config user.name t; git config commit.gpgsign false
  git checkout -q -b dup
  for i in $(seq 1 60); do echo "const added$i = $i;"; done >> dup.ts
  git commit -qam "author the block (still unmerged)" ) 2>/dev/null
# local lands the IDENTICAL content first — the cherry-pick / restore-to-last-green shape
for i in $(seq 1 60); do echo "const added$i = $i;"; done >> dup.ts
git commit -qam "same block, landed locally first"; git push -q origin HEAD:main
# peer merges its now-duplicate branch into main and publishes the merge. The merge must
# resolve to something OTHER than its first parent for this path, and the tip must then move
# past the merge: a merge that is TREESAME to parent 1 is simplified out of a path-limited
# `git log`, which prunes the side branch and hides the very double-count being reproduced —
# the first draft of this scenario passed against provably broken code for exactly that reason.
( cd "$SBX/peer4613"; git fetch -q origin; git checkout -q -B main origin/main
  git merge -q --no-commit --no-ff dup 2>/dev/null || true
  echo "// resolved-extra" >> dup.ts; git add dup.ts
  git commit -qm "merge dup (resolution differs from first parent)"
  printf '// trailing touch\n' >> dup.ts; git commit -qam "touch: HEAD is a non-merge tip, so no merge-tree baseline exists"
  git push -q origin HEAD:main ) 2>/dev/null
# local fast-forwards onto it: pre..head carries the peer's +60 commit, but that content is
# already at PRE, so the proxy would compute expected = pre_len + 60 and report a -60 loss.
printf 'note\n' >> file2.txt
ec=$(run_sync)
log_has "SILENTLY dropped" && r=1 || r=0; check "#4613 fast-forward over duplicated content NOT flagged" "$r"
log_has "sync complete" && r=0 || r=1; check "#4613 duplicated-content fast-forward syncs through" "$r"
[ "$ec" = "0" ] && r=0 || r=1; check "#4613 duplicated-content fast-forward exits 0 (node not wedged)" "$r"
teardown

# ================================================================================
# #1605 follow-on: the pre-push DROP GUARD (scripts/git-hooks/pre-push-drop-guard.sh).
# The daemon's audit_silent_drops only protects the daemon's OWN merge. A take-theirs /
# manual convergence merge done OUTSIDE the daemon pushes straight to origin and drops
# content silently (2026-08-01: #1256 canvas, #1503 copy, #1596 swipe, the device-linked
# typography §0.3 spec, 5 docs). `git push` is the one choke point every path shares, so
# the hook runs the SAME audit on every push to main. These tests drive the hook directly
# (stdin: <local_ref> <local_sha> <remote_ref> <remote_sha>, exactly as git invokes it).
run_pushguard() { # <local_ref> <local_sha> <remote_ref> <remote_sha> -> prints exit code
  ( cd "$SBX/Ant-openclaw-framework" \
    && printf '%s %s %s %s\n' "$1" "$2" "$3" "$4" \
       | bash "$SCRIPT_DIR/git-hooks/pre-push-drop-guard.sh" >"$SBX/pushguard.out" 2>&1 )
  echo $?
}

# Run the REAL installed pre-push hook, all guards in their real order, over one real push.
# run_pushguard above invokes the drop guard DIRECTLY, which cannot see the failure mode the hook
# itself documents: git feeds the ref lines on stdin exactly once, so when the guards were plain
# sequential calls sharing that stdin, the FIRST guard's `while read` drained the pipe and every
# later guard saw EOF. The drop guard silently no-op'd that way — it never saw a ref — and all
# three direct-invocation scenarios below would have kept passing throughout.
run_pushhook() { # -> prints exit code; output in $SBX/pushhook.out
  ( cd "$SBX/Ant-openclaw-framework" && git push origin main >"$SBX/pushhook.out" 2>&1 )
  echo $?
}

echo "=== pre-push HOOK: the drop guard still fires when it is not first to read stdin ==="
make_sandbox
mkdir -p scripts/git-hooks
cp "$SCRIPT_DIR/git-hooks/"*.sh scripts/git-hooks/ 2>/dev/null || true
cp "$SCRIPT_DIR/../.git/hooks/pre-push" .git/hooks/pre-push 2>/dev/null \
  || cp "$SCRIPT_DIR/git-hooks/pre-push" .git/hooks/pre-push 2>/dev/null || true
chmod +x .git/hooks/pre-push scripts/git-hooks/*.sh 2>/dev/null || true
git add scripts/git-hooks; git commit -qm "mirror the pre-push guards"
printf 'export const KEEPME = 1\n' > victim.ts
git add victim.ts; git commit -qm "add victim.ts"; git push -q origin HEAD:main
REMOTE=$(git rev-parse HEAD)
git checkout -q -b side; printf 'x\n' >> file3.txt; git commit -qam "unrelated side change"; SIDE=$(git rev-parse HEAD)
git checkout -q main
BADTREE=$(git ls-tree HEAD | grep -v 'victim.ts' | git mktree)
BADMERGE=$(git commit-tree "$BADTREE" -p "$REMOTE" -p "$SIDE" -m "[auto-sync] merge (drops victim.ts)")
git reset -q --hard "$BADMERGE"
if [ -x .git/hooks/pre-push ]; then
  ec=$(run_pushhook)
  [ "$ec" != "0" ] && r=0 || r=1; check "pre-push HOOK blocks the silent-drop push end-to-end" "$r"
  grep -q "PUSH BLOCKED (#1605)" "$SBX/pushhook.out" && r=0 || r=1
  check "pre-push HOOK: the drop guard received the refs (not an EOF stdin)" "$r"
  git fetch -q origin 2>/dev/null
  [ "$(git rev-parse origin/main)" = "$REMOTE" ] && r=0 || r=1
  check "pre-push HOOK: origin/main did not move" "$r"
else
  echo "  SKIP: no pre-push hook available to mirror"
fi
teardown

echo "=== pre-push drop-guard: a merge that SILENTLY drops a file is BLOCKED on push to main ==="
make_sandbox
printf 'export const KEEPME = 1\n' > victim.ts
git add victim.ts; git commit -qm "add victim.ts"; git push -q origin HEAD:main
REMOTE=$(git rev-parse HEAD)
# a local merge whose tree OMITS victim.ts; parents=[remote, unrelated] — NO delete commit
git checkout -q -b side; printf 'x\n' >> file3.txt; git commit -qam "unrelated side change"; SIDE=$(git rev-parse HEAD)
git checkout -q main
BADTREE=$(git ls-tree HEAD | grep -v 'victim.ts' | git mktree)
BADMERGE=$(git commit-tree "$BADTREE" -p "$REMOTE" -p "$SIDE" -m "[auto-sync] merge (drops victim.ts)")
git reset -q --hard "$BADMERGE"
ec=$(run_pushguard refs/heads/main "$BADMERGE" refs/heads/main "$REMOTE")
[ "$ec" = "1" ] && r=0 || r=1; check "pre-push guard BLOCKS a silent-drop push to main (exit 1)" "$r"
grep -q "PUSH BLOCKED (#1605)" "$SBX/pushguard.out" && r=0 || r=1; check "pre-push guard names the #1605 block reason" "$r"
grep -q "victim.ts" "$SBX/pushguard.out" && r=0 || r=1; check "pre-push guard lists the dropped path" "$r"
teardown

echo "=== pre-push drop-guard: an INTENTIONAL delete commit is NOT blocked ==="
make_sandbox
printf 'export const BYE = 1\n' > removable.ts
git add removable.ts; git commit -qm "add removable.ts"; git push -q origin HEAD:main
REMOTE=$(git rev-parse HEAD)
git rm -q removable.ts; git commit -qm "intentional removal (real delete commit)"; LOCAL=$(git rev-parse HEAD)
ec=$(run_pushguard refs/heads/main "$LOCAL" refs/heads/main "$REMOTE")
[ "$ec" = "0" ] && r=0 || r=1; check "pre-push guard ALLOWS an attributable intentional delete (exit 0)" "$r"
teardown

echo "=== pre-push drop-guard: a drop on a FEATURE branch (not main) is NOT gated ==="
make_sandbox
printf 'export const KEEP2 = 1\n' > v2.ts
git add v2.ts; git commit -qm "add v2.ts"; git push -q origin HEAD:main
REMOTE=$(git rev-parse HEAD)
git checkout -q -b sidef; printf 'x\n' >> file4.txt; git commit -qam "unrelated"; SIDEF=$(git rev-parse HEAD)
git checkout -q main
BADTREE=$(git ls-tree HEAD | grep -v 'v2.ts' | git mktree)
BADMERGE=$(git commit-tree "$BADTREE" -p "$REMOTE" -p "$SIDEF" -m "merge drops v2.ts")
ec=$(run_pushguard refs/heads/feature-x "$BADMERGE" refs/heads/feature-x "$REMOTE")
[ "$ec" = "0" ] && r=0 || r=1; check "pre-push guard does NOT gate feature-branch pushes (PR/CI-reviewed)" "$r"
teardown

# ================================================================================
# Audit 2026-10-01 (git-sync daemon + self-heal) regression scenarios. Each pins one of the
# fixes landed under the board task "git-sync daemon and self-heal audit findings".
# ================================================================================
echo "=== audit-14: a FRESH ownerless index.lock is left alone (grace), an OLD one is healed ==="
make_sandbox
: > .git/index.lock                         # age ~0s, nobody holds it
run_sync >/dev/null
log_has "index.lock at .* is fresh" && r=0 || r=1; check "fresh index.lock -> daemon skips the cycle instead of deleting" "$r"
[ -f .git/index.lock ] && r=0 || r=1;              check "fresh index.lock is NOT removed" "$r"
touch -t 202001010000 .git/index.lock       # now provably stale
run_sync >/dev/null
log_has "removed stale index.lock" && r=0 || r=1;  check "old ownerless index.lock IS healed" "$r"
[ -f .git/index.lock ] && r=1 || r=0;              check "stale index.lock removed" "$r"
teardown

echo "=== audit-24: a FRESH merge state is a live session's — defer; an OLD one is aborted ==="
make_sandbox
git rev-parse HEAD > .git/MERGE_HEAD        # looks like a merge in progress, started just now
ec=$(run_sync)
log_has "merge/rebase in progress at .* is fresh" && r=0 || r=1; check "fresh MERGE_HEAD -> daemon steps aside" "$r"
[ "$ec" = "0" ] && r=0 || r=1;                     check "stepping aside is a benign skip (exit 0)" "$r"
[ -f .git/MERGE_HEAD ] && r=0 || r=1;              check "the live merge state is preserved" "$r"
touch -t 202001010000 .git/MERGE_HEAD       # a leftover from a prior run
run_sync >/dev/null
log_has "aborting to clean tree" && r=0 || r=1;    check "old MERGE_HEAD -> aborted as before" "$r"
rm -f .git/MERGE_HEAD
teardown

echo "=== audit-16: failure accounting counts each RED tick ONCE; page fires after 3, not 2 ==="
make_sandbox
printf 'x\n' >> file1.txt; git commit -qam "local work"      # one outgoing commit -> gate runs
ec=$(export GATE_STUB_RC=1; run_sync); [ "$ec" = "1" ] && r=0 || r=1; check "RED gate tick exits 1" "$r"
ec=$(export GATE_STUB_RC=1; run_sync)
fc=$(cat "$SBX/.openclaw/locks/git-sync.failcount" 2>/dev/null || echo 0)
[ "$fc" = "2" ] && r=0 || r=1;                     check "failcount == 2 after two RED ticks (was 4: double-counted)" "$r"
[ -f "$SBX/.openclaw/locks/git-sync.failing" ] && r=1 || r=0; check "no page yet inside the 3-tick grace" "$r"
ec=$(export GATE_STUB_RC=1; run_sync)
n=$(grep -c 'FAILING' "$ALERTS" 2>/dev/null || echo 0)
[ "$n" = "1" ] && r=0 || r=1;                      check "exactly one FAILING page after the third RED tick (got $n)" "$r"
# #7515: a RED gate must NEVER convert into a reset over commits that are not on origin. On
# 2026-10-02 08:20 two RED gates ended in 'reset: moving to origin/main', dropping the 08:15
# auto-sync commit + a checkpoint merge. After the three RED ticks above, the unpushed "local
# work" commit must STILL be on HEAD and still ahead of origin/main (refuse-and-strand, never
# reset-to-origin). This asserts the loss path is structurally gone, not just that push refused.
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
head_subj=$(git log -1 --format=%s HEAD 2>/dev/null)
[ "${ahead:-0}" -ge 1 ] && [ "$head_subj" = "local work" ] && r=0 || r=1
check "#7515 RED gate leaves the unpushed local commit on HEAD, ahead of origin (no reset-to-origin)" "$r"
teardown

echo "=== audit-21: the #886c(A) active-edit state ff-push is GATED (never ungated) ==="
make_sandbox
printf 'bump\n' >> workspace/state/OPEN_TASKS.md; git commit -qam "[auto-sync] state"   # own state commit, ahead=1
printf 'in-flight\n' >> file1.txt                  # dirty SOURCE -> the defer branch
touch "$SBX/.openclaw/session-editing"             # fresh edit marker
BEFORE=$(git -C "$SBX/origin.git" rev-parse main)
ec=$(export GATE_STUB_RC=1 TEST_SPLIT=1; run_sync)
AFTER=$(git -C "$SBX/origin.git" rev-parse main)
log_has "NOT pushing ungated" && r=0 || r=1;       check "RED gate -> #886c(A) refuses the ungated ff-push" "$r"
[ "$BEFORE" = "$AFTER" ] && r=0 || r=1;            check "origin/main unchanged by the RED active-edit tick" "$r"
[ "$ec" = "0" ] && r=0 || r=1;                     check "active-edit defer still exits 0 (benign)" "$r"
unset TEST_SPLIT
ec=$(export GATE_STUB_RC=0 TEST_SPLIT=1; run_sync)
AFTER2=$(git -C "$SBX/origin.git" rev-parse main)
[ "$BEFORE" != "$AFTER2" ] && r=0 || r=1;          check "clean gate -> the same state commit IS ff-pushed (#886c(A) still works)" "$r"
log_has "#886c(A): pushed" && r=0 || r=1;          check "logged the gated push" "$r"
unset TEST_SPLIT
teardown

echo "=== audit-15: the heartbeat marker follows the COMMIT, not the decision ==="
make_sandbox
cp "$SCRIPT_DIR/autosync-commit-decision.py" scripts/autosync-commit-decision.py
mkdir -p docs/process/state
printf '{"checkouts":[],"fenceCounter":1}\n' > docs/process/state/active-checkouts.json
git add -A; git commit -qm "seed lease file"; git push -q origin HEAD:main 2>/dev/null
MARKER="$SBX/.openclaw/last-autosync-commit"
M0=$(( $(date +%s) - 60 )); printf '%s\n' "$M0" > "$MARKER"     # heartbeat NOT due (1 min ago)
printf '{"checkouts":[],"fenceCounter":2}\n' > docs/process/state/active-checkouts.json   # churn only
ec=$(export OPENCLAW_AUTOSYNC_BATCH=1; run_sync)
log_has "autosync-batch\] defer" && r=0 || r=1;    check "churn-only + fresh heartbeat -> classifier defers" "$r"
[ "$(cat "$MARKER")" = "$M0" ] && r=0 || r=1;      check "marker NOT advanced on a deferred (no-commit) tick" "$r"
printf '%s\n' "$(( $(date +%s) - 2400 ))" > "$MARKER"   # heartbeat due (40 min ago)
T0=$(date +%s)
ec=$(export OPENCLAW_AUTOSYNC_BATCH=1; run_sync)
m2=$(cat "$MARKER")
git log --format=%s -1 | grep -q '^\[auto-sync\]' && r=0 || r=1; check "heartbeat due -> churn committed" "$r"
[ "$m2" -ge "$T0" ] && r=0 || r=1;                 check "marker advanced AFTER the real commit (ts >= tick start)" "$r"
teardown

echo "=== audit-26: self-redeploy refuses a HEAD script that does not parse, keeps the old binary ==="
make_sandbox
mkdir -p "$SBX/.local/bin"
cp "$CANONICAL" "$SBX/.local/bin/openclaw-git-sync.sh"      # "deployed" == canonical
mkdir -p scripts; printf '#!/usr/bin/env bash\necho hi\nif [ then fi\n' > scripts/openclaw-git-sync.sh   # broken HEAD copy
git add -A; git commit -qm "broken daemon commit"
HOME="$SBX" METIS_HOME="$SBX/Ant-openclaw-framework" OPENCLAW_SYNC_MACHINE=testbox bash "$SBX/.local/bin/openclaw-git-sync.sh" >/dev/null 2>&1
log_has "self-redeploy REFUSED" && r=0 || r=1;     check "unparseable HEAD daemon is refused" "$r"
diff -q "$CANONICAL" "$SBX/.local/bin/openclaw-git-sync.sh" >/dev/null && r=0 || r=1; check "deployed binary untouched" "$r"
printf '#!/usr/bin/env bash\necho "[$(date)] stub daemon ran" >> "$HOME/.openclaw/logs/git-sync.log"\n' > scripts/openclaw-git-sync.sh
git commit -qam "good daemon commit"
printf 'uncommitted edit\n' >> scripts/openclaw-git-sync.sh    # working tree differs from HEAD
HOME="$SBX" METIS_HOME="$SBX/Ant-openclaw-framework" OPENCLAW_SYNC_MACHINE=testbox bash "$SBX/.local/bin/openclaw-git-sync.sh" >/dev/null 2>&1
log_has "updated deployed binary from HEAD" && r=0 || r=1; check "parseable HEAD daemon is deployed" "$r"
grep -q 'uncommitted edit' "$SBX/.local/bin/openclaw-git-sync.sh" && r=1 || r=0; check "deployed from HEAD, not the dirty working tree" "$r"
[ -f "$SBX/.local/bin/openclaw-git-sync.sh.prev" ] && r=0 || r=1; check "previous binary kept at .prev" "$r"
teardown

echo ""
echo "================ $PASS passed, $FAIL failed ================"
[ "$FAIL" -eq 0 ] && { green "ALL GUARDS OK — safe to deploy"; exit 0; } || { red "GUARD REGRESSION — do NOT deploy"; exit 1; }
