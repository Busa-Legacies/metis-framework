#!/usr/bin/env bash
# Set up standard git worktrees for parallel Claude/Jay sessions.
# Run once per machine. Worktrees are local — not committed to the repo.
#
# Creates:
#   .claude/worktrees/a  — primary parallel session
#   .claude/worktrees/b  — secondary session / queue-runner isolation
#   .claude/worktrees/c  — experimental / throwaway
#
# Then add aliases to your shell (already in dotfiles/shell.zsh if sourced):
#   za  — switch to worktree a + launch claude
#   zb  — switch to worktree b + launch claude
#   zc  — switch to worktree c + launch claude

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
WORKTREE_DIR="$REPO_ROOT/.claude/worktrees"

cd "$REPO_ROOT"

echo "Setting up worktrees in $WORKTREE_DIR"
mkdir -p "$WORKTREE_DIR"

for SLOT in a b c; do
    BRANCH="worktree-$SLOT"
    TARGET="$WORKTREE_DIR/$SLOT"

    if [ -d "$TARGET" ]; then
        echo "  ✓ $SLOT already exists ($TARGET)"
        continue
    fi

    # Create branch from current HEAD if it doesn't exist
    if ! git show-ref --quiet "refs/heads/$BRANCH"; then
        git branch "$BRANCH"
        echo "  + created branch $BRANCH"
    fi

    git worktree add "$TARGET" "$BRANCH"
    echo "  + worktree $SLOT → $TARGET (branch: $BRANCH)"
done

echo ""
echo "Done. Worktrees:"
git worktree list
echo ""
echo "Aliases (za/zb/zc) are in dotfiles/shell.zsh — source it or restart your shell."
