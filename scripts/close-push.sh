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

if git push >/dev/null 2>&1; then
    echo "close-push: pushed."
    exit 0
fi

echo "close-push: push rejected (remote advanced)."
echo "  Commit $(git rev-parse --short HEAD) is local and durable; the auto-sync"
echo "  daemon will merge + push it. NOT stashing/rebasing other sessions' work."
exit 0
