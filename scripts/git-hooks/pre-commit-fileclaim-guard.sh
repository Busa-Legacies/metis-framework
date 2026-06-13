#!/usr/bin/env bash
# pre-commit-fileclaim-guard.sh (#308) — proactive cross-session source-edit warning.
#
# WHY THIS EXISTS
# ---------------
# Every existing source-clobber guard is REACTIVE: T-SYNC-11 refuses a pull-merge
# that deletes >N source files (then hard-resets), and file-guard.sh only sees
# same-machine sessions. None warn a second MACHINE that it is about to edit a
# source file another machine is already working — by the time the divergent
# commits meet at the merge, the clobber risk is already baked in.
#
# This hook closes that gap on the universal commit seam. On EVERY commit it:
#   1. WARNS (advisory, never blocks) if a staged source file carries a live claim
#      from a DIFFERENT session (file-claims.py check), and
#   2. CLAIMS the staged source files for THIS session (file-claims.py claim), so
#      the peer machine's NEXT commit of the same file is warned in turn.
# Claims live in docs/process/state/file-claims.jsonl (merge=union), so both
# machines' claims survive a cross-machine merge. The T-SYNC-11 reactive guard
# stays as the hard backstop; this is the early, friendly heads-up before it.
#
# Invokable two ways (like pre-commit-conflict-guard.sh):
#   - as a git pre-commit hook (no args; inspects the staged index in CWD)
#   - standalone for tests, from inside a repo with a staged index.
# Always exits 0 — advisory by design. (file-claims.py check --strict can block.)
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FC="$(dirname "$SCRIPT_DIR")/file-claims.py"   # scripts/git-hooks/ -> scripts/file-claims.py
[ -f "$FC" ] || exit 0                          # no claims tool present -> no-op

staged="$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null)"
[ -n "$staged" ] || exit 0

# Restrict to source files: skip the high-churn governed-state + projection + memory
# paths (their concurrent edits are handled by the leasestate/taskstate/union drivers,
# not by file claims) and skip markdown prose.
src=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    docs/process/state/*|docs/process/task-queue.md|docs/process/projects.md| \
    docs/process/live-status.md|Jay/state/*|Jay/memory/*|docs/process/lane-outputs/*|*.md)
      continue ;;
  esac
  src+=("$f")
done <<EOF
$staged
EOF
[ "${#src[@]}" -gt 0 ] || exit 0

# 1) warn on another session's live claim (advisory; never aborts the commit)
python3 "$FC" check ${src[@]+"${src[@]}"} || true
# 2) (re)claim these files for this session so a peer machine is warned next
python3 "$FC" claim --quiet ${src[@]+"${src[@]}"} >/dev/null 2>&1 || true
exit 0
