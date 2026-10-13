#!/usr/bin/env bash
# Push a close/checkpoint commit safely on a SHARED, possibly-dirty working tree.
#
# Why this exists (#099, 2026-06-04): other sessions leave uncommitted work in the
# tree. A close must NEVER stash or rebase across that work — `git stash pop` after
# a rebase produces conflicts in files the close never touched (a ~1000-line
# main.py clash lost a close cycle this way). Instead: the caller commits only its
# OWN files, then calls this. We try to push; if the remote has advanced, we LEAVE
# the commit local. The auto-sync daemon (openclaw-git-sync.sh: add-A -> commit ->
# pull --no-rebase -> push) commits the whole tree clean and reconciles + pushes it
# on its next run. The commit is durable on disk either way — nothing is lost.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || exit 1

# --- #234 Slice 3c: soft branch-discipline warning (WARN-ONLY, NEVER blocks) ------
# When >N source files are about to be pushed directly to `main` (outside a task/* branch
# or isolated worktree), print a one-time nudge toward the already-built isolation path
# (`agent-work.py checkout --auto-worktree`). This is the "soft enforcement" step of the
# multi-session sync-hardening plan (docs/process/multi-session-sync-hardening.md, Slice 3):
# concurrent direct-to-main source commits are what still produce the divergence /
# silent-clobber classes the T-SYNC-11 + AI-resolver guards exist to CATCH after the fact.
#
# It is structurally impossible for this to change the exit code or abort the push:
# branch_warn only ever prints to stderr and `return 0`s, and it runs in its own function
# so a `set -e`-style abort can't leak out (there is no `set -e` here anyway). Promote to a
# hard block only after a quiet period proves no false-positives (spec Slice 3c).
# Kill-switch: OPENCLAW_BRANCH_WARN=0. Threshold: OPENCLAW_BRANCH_WARN_THRESHOLD (default 3).
branch_warn() {
  [ "${OPENCLAW_BRANCH_WARN:-1}" = "1" ] || return 0            # kill-switch
  local cur; cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
  [ "$cur" = "main" ] || return 0                               # only nudge on direct-to-main
  # Reuse the daemon's exact STATE-vs-SOURCE split — do NOT duplicate the list (#234 Slice 3).
  local lib; lib="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/lib/source-pathspec.sh"
  [ -f "$lib" ] || return 0                                     # lib absent -> silently skip
  # shellcheck source=lib/source-pathspec.sh
  . "$lib" || return 0
  local threshold="${OPENCLAW_BRANCH_WARN_THRESHOLD:-3}"
  # What is about to reach main = SOURCE files in local commits ahead of origin/main, plus any
  # still-uncommitted SOURCE changes in the tree. `-- "${SOURCE_EXCLUDES[@]}"` excludes every
  # STATE path, so only SOURCE files remain. Fail-soft: no known base -> just the dirty tree.
  local base; base=$(git rev-parse --verify -q origin/main 2>/dev/null \
                     || git rev-parse --verify -q '@{upstream}' 2>/dev/null || echo "")
  local files
  files=$(
    { [ -n "$base" ] && git diff --name-only "$base"..HEAD -- "${SOURCE_EXCLUDES[@]}" 2>/dev/null
      git diff --name-only HEAD -- "${SOURCE_EXCLUDES[@]}" 2>/dev/null
    } | sort -u
  )
  local count; count=$(printf '%s\n' "$files" | grep -c .)
  [ "$count" -gt "$threshold" ] || return 0
  {
    echo "⚠ BRANCH-DISCIPLINE WARNING (#234 Slice 3c): about to push $count source files"
    echo "  directly to 'main' (threshold $threshold). Multi-file source work is safer on an"
    echo "  isolated per-task branch/worktree so concurrent sessions can't silently clobber it:"
    echo "      python3 scripts/agent-work.py checkout <issue> --auto-worktree"
    echo "  ...then merge back via scripts/pre-merge-check.sh. (advisory — NOT blocking; push proceeds.)"
    echo "  Silence: OPENCLAW_BRANCH_WARN=0  ·  tune: OPENCLAW_BRANCH_WARN_THRESHOLD=$threshold"
  } >&2
  return 0
}
branch_warn || true   # belt-and-suspenders: a warning must never affect close-push's exit status

if git push >/dev/null 2>&1; then
    echo "close-push: pushed."
    exit 0
fi

# #516: this used to label EVERY push failure "remote advanced" and always exit 0
# — masking auth/network/config failures as the benign divergence case, so a
# persistent real problem never surfaced (nothing ever looked like a failure).
# Re-run to capture stderr and discriminate: an actual non-fast-forward rejection
# gets the original benign message (exit 0, the daemon reconciles); anything else
# is a genuine failure worth surfacing (non-zero exit, error text shown).
push_err="$(git push 2>&1 >/dev/null)"
if printf '%s' "$push_err" | grep -qiE 'rejected|non-fast-forward|fetch first|stale info'; then
    echo "close-push: push rejected (remote advanced)."
    echo "  Commit $(git rev-parse --short HEAD) is local and durable; the auto-sync"
    echo "  daemon will merge + push it. NOT stashing/rebasing other sessions' work."
    exit 0
fi

echo "close-push: push FAILED for a reason other than remote-advanced (auth/network/config?):" >&2
printf '%s\n' "$push_err" | sed 's/^/  /' >&2
echo "  Commit $(git rev-parse --short HEAD) is still local — nothing is lost, but the" >&2
echo "  auto-sync daemon will hit the same error and this needs a look." >&2
exit 1
