#!/usr/bin/env bash
# Purpose: Wire Claude Code's per-machine config into the repo-tracked ClaudeCode/
# dir via symlinks, so Claude Code's durable memory AND its global CLAUDE.md
# instructions are shared and backed up via git across every machine.
#
# Links created:
#   ~/.claude/projects/<encoded-cwd>/memory  ->  ClaudeCode/memory              (per-project memory dir)
#   ~/.claude/CLAUDE.md                      ->  ClaudeCode/CLAUDE.md            (global instructions)
#   ~/.claude/commands                       ->  ClaudeCode/commands             (slash commands / skills)
#   ~/.claude/skills                         ->  ClaudeCode/skills               (Agent Skills)
#   ~/.claude/agents                         ->  ClaudeCode/agents/<machine>     (Claude Code subagent personas)
#   ~/.claude/hook-alerts.sh                 ->  ClaudeCode/hooks/...            (Stop hook)
#   ~/.claude/hook-prompt-guard.sh           ->  ClaudeCode/hooks/...            (UserPromptSubmit guard)
#   ~/.claude/hook-session-init.sh           ->  ClaudeCode/hooks/...            (orientation + git-sync drift check)
#   ~/.claude/hook-plan-nudge.sh             ->  ClaudeCode/hooks/...            (plan-mode nudge)
#   ~/.claude/hook-redaction-guard.sh        ->  ClaudeCode/hooks/...            (PreToolUse redaction guard)
#   ~/.claude/hook-signoff-gate.sh           ->  ClaudeCode/hooks/...            (Stop sign-off gate)
#   ~/.claude/statusline.sh                  ->  ClaudeCode/hooks/...            (statusLine command)
#   ~/.codex/AGENTS.md                       ->  AGENTS.md                       (neutral workspace contract)
#   ~/.codex/instructions.md                 ->  ClaudeCode/codex/instructions.md (Codex CLI global context)
#   ~/.codex/prompts                         ->  .codex/prompts                  (generated slash adapters)
#   ~/.codex/memories                        ->  ClaudeCode/memory               (shared cross-provider memory)
#   ~/.codex/hooks.json                      ->  .codex/hooks.json               (Codex native hook registrations)
#   ~/.agents/skills                         ->  .agents/skills                  (Codex repo/user skills)
# The hook/statusline paths in ~/.claude/settings.json are absolute and unchanged —
# the symlinks sit at the same paths, so settings.json needs no edits.
#
# Idempotent and non-destructive: a real file/dir in the way is backed up to
# <link>.pre-bootstrap.<timestamp>, never silently overwritten.
#
# Usage: ./scripts/bootstrap-claude-memory.sh [project_dir]
#        (project_dir defaults to $HOME — the cwd Claude Code sessions launch from)

set -euo pipefail

# Derive repo root from script location
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel 2>/dev/null || dirname "$SCRIPT_DIR")

# link_file <target_in_repo> <link_path>
# Idempotently points <link_path> at <target_in_repo>.
link_file() {
    local target="$1" link="$2" link_dir
    link_dir=$(dirname "$link")

    if [[ ! -e "$target" ]]; then
        echo "[bootstrap] Error: target $target does not exist. Is the repo cloned correctly?"
        return 1
    fi

    mkdir -p "$link_dir"

    # Check symlink before -e/-d (a symlink to a dir/file also passes those)
    if [[ -L "$link" ]]; then
        local current
        current=$(readlink "$link")
        if [[ "$current" == "$target" ]]; then
            echo "[bootstrap] Already linked: $link"
            return 0
        fi
        echo "[bootstrap] $link points elsewhere ($current). Recreating..."
        rm "$link"
    elif [[ -d "$link" && -z "$(ls -A "$link" 2>/dev/null)" ]]; then
        echo "[bootstrap] Removing empty directory $link."
        rmdir "$link"
    elif [[ -e "$link" ]]; then
        local backup="${link}.pre-bootstrap.$(date +%Y%m%d-%H%M%S)"
        echo "[bootstrap] $link is a real file/dir. Backing up to $backup — review and merge into the repo manually."
        mv "$link" "$backup"
    fi

    ln -s "$target" "$link"

    if [[ "$(readlink "$link")" == "$target" ]]; then
        echo "[bootstrap] Linked: $link -> $target"
    else
        echo "[bootstrap] Error: verification failed for $link."
        return 1
    fi
}

# 1. Per-project memory dir — path is machine-specific, so encode it the way
#    Claude Code does: replace every / with -  ($HOME -> -Users-Ant)
PROJECT_DIR="${1:-$HOME}"
PROJECT_DIR="${PROJECT_DIR%/}"  # strip trailing slash for consistent encoding
ENCODED_PATH=$(echo "$PROJECT_DIR" | sed 's/\//-/g')
MEM_LINK="$HOME/.claude/projects/${ENCODED_PATH}/memory"
link_file "$REPO_ROOT/ClaudeCode/memory" "$MEM_LINK"

# 2. Global instructions — single fixed location, identical on every machine
link_file "$REPO_ROOT/ClaudeCode/CLAUDE.md" "$HOME/.claude/CLAUDE.md"

# 2b. Slash-command / skill dir — repo-back the whole dir so /free-work, /end,
#     /close survive a wipe and reach every machine (Jarry included).
link_file "$REPO_ROOT/ClaudeCode/commands" "$HOME/.claude/commands"

# 2b2. Agent Skills directory — directory-format skills (SKILL.md + bundled reference files).
#      Skills take precedence over same-name commands, enabling progressive disclosure.
link_file "$REPO_ROOT/ClaudeCode/skills" "$HOME/.claude/skills"

# 2c. Claude Code subagent personas — per-machine target (jay vs jarry identity headers differ).
MACHINE_AGENTS_DIR=""
case "$(id -un)" in
  Ant)   MACHINE_AGENTS_DIR="$REPO_ROOT/ClaudeCode/agents/jay" ;;
  abusa) MACHINE_AGENTS_DIR="$REPO_ROOT/ClaudeCode/agents/jarry" ;;
esac
if [[ -n "$MACHINE_AGENTS_DIR" ]]; then
    link_file "$MACHINE_AGENTS_DIR" "$HOME/.claude/agents"
else
    echo "[bootstrap] Skipping ~/.claude/agents — unknown user '$(id -un)'. Add case to bootstrap-claude-memory.sh."
fi

# 2d. Codex CLI global context + command/skill surface — machine-agnostic,
#     shared across Jay and Jarry. The sync script preserves hand-written Codex
#     prompt adapters and generates missing adapters from ClaudeCode/skills.
if [[ -d "$HOME/.codex" ]]; then
    python3 "$REPO_ROOT/scripts/sync-codex-surface.py"
    link_file "$REPO_ROOT/AGENTS.md" "$HOME/.codex/AGENTS.md"
    link_file "$REPO_ROOT/ClaudeCode/codex/instructions.md" "$HOME/.codex/instructions.md"
    link_file "$REPO_ROOT/.codex/prompts" "$HOME/.codex/prompts"
    link_file "$REPO_ROOT/ClaudeCode/memory" "$HOME/.codex/memories"
    link_file "$REPO_ROOT/.codex/hooks.json" "$HOME/.codex/hooks.json"
    link_file "$REPO_ROOT/.agents/skills" "$HOME/.agents/skills"
else
    echo "[bootstrap] Skipping Codex links — ~/.codex/ not found (Codex CLI not installed)."
fi

# 2e. Home dotfiles — repo-backed dotfiles that must live at a fixed ~ path because
#     the consuming tool reads only that path (unlike shell.zsh, which ~/.zshrc
#     sources). tmux.conf gives every Claude tmux session (claude-<N> / ccc) mouse-on
#     + smooth scroll; without it new tmux servers revert to steppy mouse-off scroll.
link_file "$REPO_ROOT/dotfiles/tmux.conf" "$HOME/.tmux.conf"

# 3. Hook + statusline scripts — machine-local Claude Code config, now repo-backed
#    so behavioral wiring (e.g. the git-sync drift check) is shared and version-tracked.
for hook in hook-alerts.sh hook-prompt-guard.sh hook-session-init.sh hook-plan-nudge.sh hook-redaction-guard.sh hook-signoff-gate.sh restart-stop-hook.sh statusline.sh; do
    link_file "$REPO_ROOT/ClaudeCode/hooks/$hook" "$HOME/.claude/$hook"
done

# 4. Git hooks that re-link ~/.claude symlinks after operations that strip them.
#    git pull (merge) fires post-merge; git rebase / commit --amend fire post-rewrite.
#    #007: a `git pull --rebase` once stripped the symlinks, but post-merge never fires
#    on rebase, so they stayed broken until the Stop hook failed — post-rewrite closes that.
#    Both skip linked worktrees (--git-dir != --git-common-dir) so a rebase inside an
#    agent-checkout worktree never re-points ~/.claude at that ephemeral ClaudeCode/ dir.
GIT_HOOKS_DIR="$REPO_ROOT/.git/hooks"
if [[ -d "$GIT_HOOKS_DIR" ]]; then
    for hookname in post-merge post-rewrite; do
        hookpath="$GIT_HOOKS_DIR/$hookname"
        # Re-install if missing or pre-#007 (older hooks lack post-rewrite + the worktree guard).
        if [[ ! -f "$hookpath" ]] || ! grep -q '#007' "$hookpath" 2>/dev/null; then
            cat > "$hookpath" << 'HOOKEOF'
#!/usr/bin/env bash
# Auto-installed by bootstrap-claude-memory.sh (#007)
# Re-link ~/.claude hook symlinks after a git op strips them
# (post-merge=pull, post-rewrite=rebase/amend). Skip linked worktrees so we never
# point ~/.claude at an ephemeral worktree's ClaudeCode/ dir.
[ "$(git rev-parse --git-dir)" -ef "$(git rev-parse --git-common-dir)" ] || exit 0
bash "$(git rev-parse --show-toplevel)/scripts/bootstrap-claude-memory.sh" >/dev/null 2>&1 || true
HOOKEOF
            chmod +x "$hookpath"
            echo "[bootstrap] Installed git $hookname hook (#007): $hookpath"
        else
            echo "[bootstrap] Git $hookname hook already current (#007)."
        fi
    done
fi

# 5. Git pre-commit hook — block any commit carrying unresolved conflict markers (#058).
#    Universal backstop: fires on every commit path (daemon, /checkpoint, /end, manual,
#    IDE), closing the gap the sync-tick-only #023 guard left open. Delegates to the
#    tracked guard so the logic stays version-controlled; re-installed on every bootstrap
#    (incl. post-merge) so it self-heals after a pull strips .git/hooks.
PRE_COMMIT="$GIT_HOOKS_DIR/pre-commit"
if [[ -d "$GIT_HOOKS_DIR" ]]; then
    if [[ ! -f "$PRE_COMMIT" ]] || ! grep -q 'pre-commit-conflict-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-path-replica-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-bash32-portability-guard' "$PRE_COMMIT" 2>/dev/null; then
        cat > "$PRE_COMMIT" << 'HOOKEOF'
#!/usr/bin/env bash
# Auto-installed by bootstrap-claude-memory.sh (#058, #076, #264)
# Runs all pre-commit guard scripts; any non-zero exit blocks the commit.
ROOT="$(git rev-parse --show-toplevel)"

bash "$ROOT/scripts/git-hooks/pre-commit-conflict-guard.sh" || exit 1
bash "$ROOT/scripts/git-hooks/pre-commit-path-replica-guard.sh" || exit 1
bash "$ROOT/scripts/git-hooks/pre-commit-bash32-portability-guard.sh" || exit 1

exit 0
HOOKEOF
        chmod +x "$PRE_COMMIT"
        echo "[bootstrap] Installed git pre-commit guards (conflict-marker + path-replica + bash32-portability): $PRE_COMMIT"
    else
        echo "[bootstrap] Git pre-commit guards already present."
    fi
fi

# 5b. Git commit-msg hook — born-governed guard (#248). WARN-ONLY: flags a commit
#     referencing #NNN that has no governed tasks.json entry (#098). Never blocks.
#     Re-installed on every bootstrap so it self-heals after a pull strips .git/hooks.
COMMIT_MSG="$GIT_HOOKS_DIR/commit-msg"
if [[ -d "$GIT_HOOKS_DIR" ]]; then
    if [[ ! -f "$COMMIT_MSG" ]] || ! grep -q 'commit-msg-born-governed-guard' "$COMMIT_MSG" 2>/dev/null; then
        cat > "$COMMIT_MSG" << 'HOOKEOF'
#!/usr/bin/env bash
# Auto-installed by bootstrap-claude-memory.sh (#248)
# Runs commit-msg guard scripts. Born-governed guard is WARN-ONLY (never blocks).
ROOT="$(git rev-parse --show-toplevel)"

bash "$ROOT/scripts/git-hooks/commit-msg-born-governed-guard.sh" "$1" || true

exit 0
HOOKEOF
        chmod +x "$COMMIT_MSG"
        echo "[bootstrap] Installed git commit-msg guard (born-governed): $COMMIT_MSG"
    else
        echo "[bootstrap] Git commit-msg guard already present."
    fi
fi

# Final sanity check: memory link resolves to a populated dir
if [[ -f "$MEM_LINK/MEMORY.md" ]] && [[ -f "$HOME/.claude/CLAUDE.md" ]]; then
    echo "[bootstrap] Success: Claude Code memory + global CLAUDE.md are wired to the repo."
else
    echo "[bootstrap] Error: post-link verification failed."
    echo "[bootstrap]   $MEM_LINK/MEMORY.md present: $(test -f "$MEM_LINK/MEMORY.md" && echo yes || echo no)"
    echo "[bootstrap]   ~/.claude/CLAUDE.md present: $(test -f "$HOME/.claude/CLAUDE.md" && echo yes || echo no)"
    exit 1
fi
