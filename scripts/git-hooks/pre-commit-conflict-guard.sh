#!/usr/bin/env bash
# pre-commit-conflict-guard.sh — block any commit whose STAGED content carries
# unresolved git conflict markers. (#058)
#
# WHY THIS EXISTS
# ---------------
# scripts/openclaw-git-sync.sh has a staged-diff conflict-marker guard (#023), but
# it only runs inside the auto-sync daemon's commit path. Manual commits — a
# `git stash pop` during /checkpoint racing the daemon, a hand `git commit`, an IDE
# commit — bypass it entirely. That gap let conflict markers in
# docs/process/state/active-checkouts.json get committed AND pushed to origin
# (41fef7d), leaving invalid lease JSON on the remote that broke every agent's
# lease read until repaired under lock (93c434c, a6f8453).
#
# A pre-commit hook closes the gap because git runs it on EVERY commit path —
# daemon, git-lock.sh run, /checkpoint, /end, manual, IDE. This is the universal
# backstop the sync-tick guard could never be.
#
# WHAT IT MATCHES
# ---------------
# Added lines (`^\+`) that begin with the UNAMBIGUOUS angle-bracket markers
# `<<<<<<< ` or `>>>>>>> `. We deliberately do NOT match a bare `=======` line:
# #023 proved that trips on legitimate markdown setext-heading underlines and
# `====` separators (the T-SYNC saga). A real conflict — including every
# `git stash pop` conflict (`<<<<<<< Updated upstream` / `>>>>>>> Stashed changes`)
# — always carries the angle brackets, so gating on those catches 100% of real
# conflicts with zero false positives on prose.
#
# Invokable two ways:
#   - as a git pre-commit hook (no args; inspects the staged index in CWD)
#   - standalone for tests: `pre-commit-conflict-guard.sh` from inside a repo with
#     a staged index. Exit 0 = clean, exit 1 = markers found (commit must abort).
set -u

# Limit to text the user is actually committing: added lines in the staged diff.
hits=$(git diff --cached -U0 --no-color 2>/dev/null | grep -nE '^\+(<<<<<<< |>>>>>>> )' || true)

if [ -n "$hits" ]; then
  echo "✗ COMMIT BLOCKED (#058): staged content contains unresolved conflict markers." >&2
  echo "" >&2
  # Name the offending files so the fix is one step away.
  files=$(git diff --cached --name-only -G'^(<<<<<<< |>>>>>>> )' 2>/dev/null)
  if [ -n "$files" ]; then
    echo "  Files with markers:" >&2
    printf '    %s\n' $files >&2
    echo "" >&2
  fi
  echo "  Resolve the conflict before committing. For lease/state files" >&2
  echo "  (active-checkouts.json) the rule is: keep the higher fenceCounter +" >&2
  echo "  newer updatedAt, validate JSON, commit under scripts/git-lock.sh run." >&2
  echo "  See ClaudeCode/memory/feedback_lease_conflict_resolution.md." >&2
  echo "" >&2
  echo "  To bypass for a deliberate commit OF marker text (rare): git commit --no-verify" >&2
  exit 1
fi

exit 0
