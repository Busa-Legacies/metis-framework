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
  git add -A; git commit -qm seed; git push -q origin HEAD:main 2>/dev/null
  git branch -q -M main 2>/dev/null || true
  # Point the bare origin's HEAD at main. Without this it stays on the init-default
  # 'master' (which never gets a commit), so every later `git clone "$SBX/origin.git"`
  # (clobber/pusher fixtures) checks out an empty 'master' and the fixture's
  # rm/conflict setup silently no-ops — the second env-drift bug behind the stale
  # harness (alongside the METIS_HOME repo-path fix in run_sync).
  git -C "$SBX/origin.git" symbolic-ref HEAD refs/heads/main 2>/dev/null || true
  LOG="$SBX/.openclaw/logs/git-sync.log"
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
printf 'local-side change\n' > file1.txt   # conflicts with origin: script auto-commits, then pull conflicts
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
printf 'local-novel\n' > file1.txt   # conflicts, but rerere has NEVER seen this preimage
ec=$(run_sync)
# Daemon now routes a novel conflict through the Tier-3 AI resolver before the soft
# abort; when rerere has no replay AND Tier-3 declines/fails it logs "unresolved
# conflict" (line 440). Grep the stable substring, not the retired "(no rerere" wording.
log_has "unresolved conflict" && r=0 || r=1; check "novel conflict logged as unresolved (no rerere/Tier-3 replay)" "$r"
[ "$ec" = "1" ] && r=0 || r=1; check "novel conflict still exits 1 (fail-soft, no regression)" "$r"
teardown

# ================================================================================
# #058: pre-commit conflict-marker guard — fires on EVERY commit path, not just the
# sync tick. Drives the guard directly against a staged index (the way git's
# pre-commit hook invokes it).
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
git commit -qm "should be blocked" 2>/dev/null && r=1 || r=0; check "real 'git commit' with markers is blocked by the hook" "$r"
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
# Machine A (antfox, session sessA) claims src1.ts
METIS_HOME="$PWD" python3 "$FC" claim src1.ts --machine antfox --session sessA --agent claude --quiet
# Machine B (jarry, session sessB) stages an edit to the SAME file and runs the guard
printf 'export const A = 2\n' > src1.ts; git add src1.ts
out=$(METIS_HOME="$PWD" CLAUDE_CODE_SESSION_ID=sessB METIS_MACHINE=jarry bash "$FCGUARD" 2>&1); rc=$?
r=0
printf '%s' "$out" | grep -q "FILE-CLAIM WARNING" || r=1   # warned
printf '%s' "$out" | grep -q "src1.ts" || r=1              # named the file
printf '%s' "$out" | grep -q "antfox" || r=1              # named the peer machine
[ "$rc" -eq 0 ] || r=1                                     # advisory: never blocks the commit
check "cross-session same-file edit warns pre-merge (T-SYNC-14)" "$r"
# the guard claimed src1.ts for sessB too (union keeps both -> A is warned next)
METIS_HOME="$PWD" python3 "$FC" list 2>/dev/null | grep -q sessB && r=0 || r=1
check "T-SYNC-14 committing session also records its own claim" "$r"
# no false positive: an unclaimed file draws no warning
git reset -q 2>/dev/null
printf 'export const B = 1\n' > src2.ts; git add src2.ts
out2=$(METIS_HOME="$PWD" CLAUDE_CODE_SESSION_ID=sessB METIS_MACHINE=jarry bash "$FCGUARD" 2>&1)
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
ec=$(TEST_SPLIT=1 TEST_MACHINE=antfox; run_sync)
log_has "sync complete" && r=0 || r=1; check "state-only tick completes" "$r"
git show --stat HEAD 2>/dev/null | grep -q "workspace/memory/working-context.md" && r=0 || r=1
check "state file landed on main HEAD" "$r"
unset TEST_SPLIT TEST_MACHINE
teardown

echo "=== SPLIT-2 (#234): source-only change does NOT hit main, lands on autosync/<machine> ==="
make_sandbox
printf 'source edit\n' >> file1.txt   # SOURCE path (root file, not in allowlist)
PRE=$(git rev-parse HEAD)
ec=$(TEST_SPLIT=1 TEST_MACHINE=antfox; run_sync)
log_has "source-only tick" && r=0 || r=1; check "source-only tick logged (nothing staged for main)" "$r"
[ "$(git rev-parse HEAD)" = "$PRE" ] && r=0 || r=1; check "main HEAD unchanged (source kept off main)" "$r"
git rev-parse --verify refs/heads/autosync/antfox >/dev/null 2>&1 && r=0 || r=1
check "autosync/antfox branch created" "$r"
git show autosync/antfox:file1.txt 2>/dev/null | grep -q "source edit" && r=0 || r=1
check "source change captured on autosync/antfox" "$r"
git ls-remote "$SBX/origin.git" refs/heads/autosync/antfox 2>/dev/null | grep -q . && r=0 || r=1
check "autosync/antfox pushed to origin" "$r"
grep -q "source edit" file1.txt && r=0 || r=1; check "source left dirty in working tree (checkpointable)" "$r"
unset TEST_SPLIT TEST_MACHINE
teardown

echo "=== SPLIT-3 (#234): mixed tick splits — state→main, source→autosync, source stays dirty ==="
make_sandbox
printf 'state edit\n' >> workspace/state/OPEN_TASKS.md   # STATE
printf 'source edit\n' >> file2.txt                 # SOURCE
ec=$(TEST_SPLIT=1 TEST_MACHINE=antfox; run_sync)
git show --stat HEAD 2>/dev/null | grep -q "workspace/state/OPEN_TASKS.md" && r=0 || r=1
check "state file landed on main HEAD" "$r"
git show --stat HEAD 2>/dev/null | grep -q "file2.txt" && r=1 || r=0
check "source file NOT on main HEAD" "$r"
git show autosync/antfox:file2.txt 2>/dev/null | grep -q "source edit" && r=0 || r=1
check "source change on autosync/antfox" "$r"
git status --porcelain 2>/dev/null | grep -q "file2.txt" && r=0 || r=1
check "source still dirty in working tree after the split tick" "$r"
unset TEST_SPLIT TEST_MACHINE
teardown

echo "=== SPLIT-4 (#234): kill-switch (SPLIT=0) → legacy blanket-add puts source on main ==="
make_sandbox
printf 'source edit\n' >> file3.txt
ec=$(TEST_SPLIT=0 TEST_MACHINE=antfox; run_sync)
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

echo ""
echo "================ $PASS passed, $FAIL failed ================"
[ "$FAIL" -eq 0 ] && { green "ALL GUARDS OK — safe to deploy"; exit 0; } || { red "GUARD REGRESSION — do NOT deploy"; exit 1; }
