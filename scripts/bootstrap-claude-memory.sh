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
#   ~/.claude/hook-memory-domain-tag-guard.sh ->  ClaudeCode/hooks/...           (PreToolUse memory domain-tag guard)
#   ~/.claude/hook-signoff-gate.sh           ->  ClaudeCode/hooks/...            (Stop sign-off gate)
#   ~/.claude/statusline.sh                  ->  ClaudeCode/hooks/...            (statusLine command)
#   ~/.codex/AGENTS.md                       ->  AGENTS.md                       (neutral workspace contract)
#   ~/.codex/instructions.md                 ->  ClaudeCode/codex/instructions.md (Codex CLI global context)
#   ~/.codex/prompts                         ->  .codex/prompts                  (generated slash adapters)
#   ~/.codex/memories                        ->  ClaudeCode/memory               (shared cross-provider memory)
#   ~/.codex/hooks.json                      ->  .codex/hooks.json               (Codex native hook registrations)
#   ~/.agents/skills                         ->  .agents/skills                  (Codex repo/user skills)
#   ~/.tmux.conf                             ->  dotfiles/tmux.conf              (tmux mouse/scroll config)
#   Fleet dotfile layer (#4956, OPT-IN per machine — only when dotfiles/hosts/<host>/ exists):
#   ~/.wezterm.lua                           ->  dotfiles/wezterm.lua            (shared WezTerm base)
#   ~/.wezterm.local.lua                     ->  dotfiles/hosts/<host>/wezterm.local.lua (overlay, if present)
#   ~/.zshrc                                 ->  dotfiles/zshrc                  (shared zsh base)
#   ~/.zshrc.local                           ->  dotfiles/hosts/<host>/zshrc.local (overlay, if present)
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
# Refuse to wire ~/.claude into a LINKED WORKTREE (2026-10-08 incident, git-sync self-heal audit
# finding 9: "a heal that trusts its own location"). A session in a per-task worktree ran this
# script and every ~/.claude hook, CLAUDE.md, commands and statusline symlink on <<MACHINE_1_ID>> was
# retargeted into a throwaway directory that is removed when the task lands, which would have
# dangled every hook for every session on the machine. The canonical checkout is the only valid
# target; a worktree is never it. Explicit opt-in for the rare deliberate case.
if [[ "${BOOTSTRAP_ALLOW_WORKTREE:-0}" != "1" ]] \
   && _gd="$(git -C "$REPO_ROOT" rev-parse --git-dir 2>/dev/null)" \
   && _gcd="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)" \
   && [[ -n "$_gd" && -n "$_gcd" ]] \
   && [[ "$(cd "$REPO_ROOT" && cd "$_gd" && pwd -P)" != "$(cd "$REPO_ROOT" && cd "$_gcd" && pwd -P)" ]]; then
  echo "bootstrap-claude-memory: REFUSING to run from a linked git worktree ($REPO_ROOT)." >&2
  echo "  ~/.claude symlinks must point at the canonical checkout; run this script from there" >&2
  echo "  (or set BOOTSTRAP_ALLOW_WORKTREE=1 if you really mean to link into this worktree)." >&2
  exit 1
fi

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
#     /close survive a wipe and reach every machine (<<MACHINE_2_ID>> included).
link_file "$REPO_ROOT/ClaudeCode/commands" "$HOME/.claude/commands"

# 2b2. Agent Skills directory — directory-format skills (SKILL.md + bundled reference files).
#      Skills take precedence over same-name commands, enabling progressive disclosure.
link_file "$REPO_ROOT/ClaudeCode/skills" "$HOME/.claude/skills"

# 2c. Claude Code subagent personas — per-machine dir resolved through the config seam
#     (detect_machine -> declared label -> agents/<label-lowercased>), not a hardcoded
#     persona case (#509). Dirs stay role-named (<<MACHINE_1_ID>>/<<MACHINE_2_ID>>), never persona-named.
#
#     Resolve against a CANDIDATE LIST, not the bare lowercased label. Labels became
#     DESCRIPTIVE on 2026-07-29 ("Air · M2 16GB · light-lane node"), which silently broke
#     the single-lookup form for ALL THREE machines at once — every one resolved to a
#     non-existent dir, so this step skipped and ~/.claude/agents went unwired on any
#     fresh bootstrap. It survived only on boxes that already had the symlink, because
#     the skip branch leaves an existing link alone. Candidates, in order:
#       1. the machine id            — matches m2air, <<MACHINE_2_ID>>
#       2. the label's leading token — matches <<MACHINE_1_ID>>, whose dir ("<<MACHINE_1_ID>>") is named for
#                                      its label rather than its id
#     A plain one-word label still slugifies to itself, so pre-2026-07-29 configs and
#     any consuming org's overlay keep resolving exactly as before.
_agents_id=$(python3 "$REPO_ROOT/scripts/lib/infra_config.py" detect-machine 2>/dev/null | tr '[:upper:]' '[:lower:]')
_agents_slug=$(python3 "$REPO_ROOT/scripts/lib/infra_config.py" machine-label 2>/dev/null \
    | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9].*//')
MACHINE_AGENTS_DIR=""
for _agents_cand in "$_agents_id" "$_agents_slug"; do
    if [[ -n "$_agents_cand" && -d "$REPO_ROOT/ClaudeCode/agents/$_agents_cand" ]]; then
        MACHINE_AGENTS_DIR="$REPO_ROOT/ClaudeCode/agents/$_agents_cand"
        break
    fi
done
if [[ -n "$MACHINE_AGENTS_DIR" ]]; then
    link_file "$MACHINE_AGENTS_DIR" "$HOME/.claude/agents"
else
    echo "[bootstrap] Skipping ~/.claude/agents — no agents dir for machine '$_agents_id' (tried candidates: '$_agents_id', '$_agents_slug')."
fi

# 2d. Codex CLI global context + command/skill surface — machine-agnostic,
#     shared across <<MACHINE_1_ID>> and <<MACHINE_2_ID>>. The sync script preserves hand-written Codex
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

# 2e2. Fleet-aware dotfile layer (#4956): dotfiles/ shared base + dotfiles/hosts/<host>/ overlay.
#      OPT-IN PER MACHINE: these links fire only when the host's overlay dir exists in the repo,
#      so merging a new shared dotfile never rewires a machine that hasn't been deliberately
#      onboarded (notify-don't-fix — each machine's own session creates its hosts/ dir when it
#      joins the layer). The host dir resolves through the same candidate list as the agents dir
#      above: machine id first (<<MACHINE_2_ID>>, m2air), then label slug (<<MACHINE_1_ID>>'s dir is "<<MACHINE_1_ID>>").
#      Shared bases are identical fleet-wide; per-machine deltas live ONLY in the overlay files,
#      which the shared bases load LAST via fixed ~ paths (~/.zshrc.local, ~/.wezterm.local.lua).
#      A machine may keep a real never-committed file at an overlay path instead — link_file's
#      backup branch protects it if a repo overlay later appears. Layering + filing rules:
#      docs/process/dotfile-filing-standard.md.
HOST_DOTFILES_DIR=""
for _host_cand in "$_agents_id" "$_agents_slug"; do
    if [[ -n "$_host_cand" && -d "$REPO_ROOT/dotfiles/hosts/$_host_cand" ]]; then
        HOST_DOTFILES_DIR="$REPO_ROOT/dotfiles/hosts/$_host_cand"
        break
    fi
done
if [[ -n "$HOST_DOTFILES_DIR" ]]; then
    link_file "$REPO_ROOT/dotfiles/wezterm.lua" "$HOME/.wezterm.lua"
    link_file "$REPO_ROOT/dotfiles/zshrc" "$HOME/.zshrc"
    if [[ -f "$HOST_DOTFILES_DIR/wezterm.local.lua" ]]; then
        link_file "$HOST_DOTFILES_DIR/wezterm.local.lua" "$HOME/.wezterm.local.lua"
    fi
    # Ghostty config (per-host, opt-in): only hosts committed to Ghostty ship a
    # hosts/<host>/ghostty.config — so this never clobbers a host that keeps WezTerm or
    # its own Ghostty config. Ghostty reads only ~/.config/ghostty/config (XDG), unlike
    # ~/.wezterm.lua at $HOME. <<MACHINE_1_ID>> is the first committed host (2026-09-08).
    if [[ -f "$HOST_DOTFILES_DIR/ghostty.config" ]]; then
        mkdir -p "$HOME/.config/ghostty"
        link_file "$HOST_DOTFILES_DIR/ghostty.config" "$HOME/.config/ghostty/config"
    fi
    if [[ -f "$HOST_DOTFILES_DIR/zshrc.local" ]]; then
        link_file "$HOST_DOTFILES_DIR/zshrc.local" "$HOME/.zshrc.local"
    fi
else
    echo "[bootstrap] Skipping fleet dotfile layer — no dotfiles/hosts/ overlay dir for machine '$_agents_id' (opt-in; see docs/process/dotfile-filing-standard.md)."
fi

# 3. Hook + statusline scripts — machine-local Claude Code config, repo-backed.
#    DERIVED from ClaudeCode/settings.shared.json (every ~/.claude/<script> it references), never a
#    hand list: the hand list drifted 3 times (task-naming-gate 2026-07-28, ask-gate 2026-08-03, and
#    5 hooks incl. sendfeedback-block/feasibility-gate silently exit-127 on <<MACHINE_2_ID>>, found 2026-10-05).
#    A registered hook whose symlink is missing fails OPEN with no error surfaced, so drift = a
#    disabled guard. Source is ClaudeCode/hooks/ or ClaudeCode/scripts/, whichever holds it.
_registered=$(python3 - "$REPO_ROOT/ClaudeCode/settings.shared.json" <<'PYEOF'
import json, re, sys
s = json.load(open(sys.argv[1]))
names = {"statusline.sh"}
for blob in [json.dumps(s.get("hooks", {})), json.dumps(s.get("statusLine", {}))]:
    names.update(re.findall(r"~/\.claude/([\w.-]+\.(?:sh|py))", blob))
print("\n".join(sorted(names)))
PYEOF
)
while IFS= read -r hook; do
    [[ -z "$hook" ]] && continue
    if [[ -f "$REPO_ROOT/ClaudeCode/hooks/$hook" ]]; then
        link_file "$REPO_ROOT/ClaudeCode/hooks/$hook" "$HOME/.claude/$hook"
    elif [[ -f "$REPO_ROOT/ClaudeCode/scripts/$hook" ]]; then
        link_file "$REPO_ROOT/ClaudeCode/scripts/$hook" "$HOME/.claude/$hook"
    else
        echo "[bootstrap] WARNING: settings.shared.json registers ~/.claude/$hook but no source in ClaudeCode/hooks or ClaudeCode/scripts — that hook is DEAD" >&2
    fi
done <<< "$_registered"
# Output styles (Metis style carries the sign-off/stop spec; settings.shared.json outputStyle: "Metis").
for _style in "$REPO_ROOT"/ClaudeCode/output-styles/*.md; do
    [[ -f "$_style" ]] && link_file "$_style" "$HOME/.claude/output-styles/$(basename "$_style")"
done
# hook-inline-image.sh is invoked via PostToolUse but its python helper must sit beside it.
[[ -f "$REPO_ROOT/ClaudeCode/hooks/hook-inline-image.py" ]] && link_file "$REPO_ROOT/ClaudeCode/hooks/hook-inline-image.py" "$HOME/.claude/hook-inline-image.py"

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
        # Re-install if missing or pre-#8483 (older hooks lack the post-merge projection
        # re-render; pre-#007 ones also lack post-rewrite + the worktree guard).
        if [[ ! -f "$hookpath" ]] || ! grep -q '#8483' "$hookpath" 2>/dev/null; then
            cat > "$hookpath" << 'HOOKEOF'
#!/usr/bin/env bash
# Auto-installed by bootstrap-claude-memory.sh (#007, #8483)
# Re-link ~/.claude hook symlinks after a git op strips them
# (post-merge=pull, post-rewrite=rebase/amend). Skip linked worktrees so we never
# point ~/.claude at an ephemeral worktree's ClaudeCode/ dir.
ROOT="$(git rev-parse --show-toplevel)"
# #8483: after a merge, re-render the keepours Tier-1 projections (main tree AND worktrees).
if [ "$(basename "$0")" = post-merge ] && [ -f "$ROOT/scripts/git-hooks/post-merge-render-projections.sh" ]; then
    bash "$ROOT/scripts/git-hooks/post-merge-render-projections.sh" "$@" || true
fi
[ "$(git rev-parse --git-dir)" -ef "$(git rev-parse --git-common-dir)" ] || exit 0
bash "$ROOT/scripts/bootstrap-claude-memory.sh" >/dev/null 2>&1 || true
HOOKEOF
            chmod +x "$hookpath"
            echo "[bootstrap] Installed git $hookname hook (#007, #8483): $hookpath"
        else
            echo "[bootstrap] Git $hookname hook already current (#8483)."
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
    if [[ ! -f "$PRE_COMMIT" ]] || ! grep -q 'pre-commit-conflict-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-path-replica-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-bash32-portability-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-fileclaim-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-governed-branch-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-memory-domain-tag-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-index-sweep-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-state-driver-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-suite-coverage-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-projection-drift-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-safe-area-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'pre-commit-door-route-guard' "$PRE_COMMIT" 2>/dev/null || ! grep -q 'opensrc-leak-scan' "$PRE_COMMIT" 2>/dev/null; then
        cat > "$PRE_COMMIT" << 'HOOKEOF'
#!/usr/bin/env bash
# Auto-installed by bootstrap-claude-memory.sh (#058, #076, #264, #3420)
# Runs all pre-commit guard scripts; any non-zero exit blocks the commit.
ROOT="$(git rev-parse --show-toplevel)"

bash "$ROOT/scripts/git-hooks/pre-commit-conflict-guard.sh" || exit 1
bash "$ROOT/scripts/git-hooks/pre-commit-path-replica-guard.sh" || exit 1
bash "$ROOT/scripts/git-hooks/pre-commit-bash32-portability-guard.sh" || exit 1
# #3420: universal backstop for the memory domain-tag rule — covers lane/daemon/manual
# commits the interactive Write/Edit-only hook (hook-memory-domain-tag-guard.sh, #1344)
# never sees.
bash "$ROOT/scripts/git-hooks/pre-commit-memory-domain-tag-guard.sh" || exit 1
# Block a pathspec-less commit from sweeping the sync daemon's pre-staged STATE into a SOURCE
# commit (2026-08-23 incident). Fires only on the high-confidence source+bulk-state signature;
# fails open; daemon-exempt (OPENCLAW_GIT_SYNC=1); override OPENCLAW_ALLOW_MIXED_COMMIT=1.
bash "$ROOT/scripts/git-hooks/pre-commit-index-sweep-guard.sh" || exit 1
# Lever I (reliability-substrate review): block a NEW governed-state file (.json/.yaml/.jsonl under
# a STATE_PATHSPEC) committed with NO merge driver — the add/add silent-drop wedge class. Fails
# open; daemon-exempt; escape OPENCLAW_ALLOW_UNDRIVEN_STATE=1 or the .merge-driver-allowlist.
bash "$ROOT/scripts/git-hooks/pre-commit-state-driver-guard.sh" || exit 1
# #4609 root-cause: block a NEW self-test suite added without coverage, so the author registers
# it instead of the daemon's pre-push suite-coverage gate going RED and wedging every machine's
# push. Scoped to this commit's added files; fails open; daemon-exempt; OPENCLAW_ALLOW_UNCOVERED_SUITE=1.
bash "$ROOT/scripts/git-hooks/pre-commit-suite-coverage-guard.sh" || exit 1
# #803 root-cause of main-health projection-drift flapping: block a commit that stages governed
# state (tasks.json et al.) without its re-rendered Tier-1 projections — the Source-A pathspec
# commit that bakes new state with an old projection and RED-flaps `render-tier1-state diff` on
# main. Only engages when a governed SOURCE is staged; fails open (render absent / no yaml-python);
# daemon-exempt (OPENCLAW_GIT_SYNC=1 / METIS_SKIP_PROJECTION_GUARD=1); merge-exempt.
bash "$ROOT/scripts/git-hooks/pre-commit-projection-drift-guard.sh" || exit 1
# Metis Command notch/safe-area guard: block a NEW mobile bottom sheet (full-width rounded-top
# panel, viewport-capped or sm:rounded) that omits env(safe-area-inset-bottom) — the overflow
# class swept twice in Sep 2026. Scoped to staged metis-command *.tsx; fails open; daemon-exempt
# (OPENCLAW_GIT_SYNC=1); per-line `safe-area-exempt` or OPENCLAW_ALLOW_UNSAFE_SHEET=1 escapes.
bash "$ROOT/scripts/git-hooks/pre-commit-safe-area-guard.sh" || exit 1
# Front-door route guard: block a Caddyfile change that reopens the /dashws bypass. That path
# forwards straight to the FastAPI data plane PAST the Next app gate, so a prefix/wildcard
# matcher there exposes every router on :8080 (2026-10-01 tenant-auth audit, finding 2). Exact
# paths only. Scoped to staged Caddyfiles; fails open; daemon-exempt (OPENCLAW_GIT_SYNC=1);
# escape OPENCLAW_ALLOW_DOOR_PREFIX=1.
bash "$ROOT/scripts/git-hooks/pre-commit-door-route-guard.sh" || exit 1
# Opensrc leak scan (#303): a staged file the public framework export ships
# (config/opensrc-allowlist.txt) may not carry a personal detail that survives the export
# scrubs. Fails open; daemon-exempt (OPENCLAW_GIT_SYNC=1); escape OPENCLAW_ALLOW_OPENSRC_LEAK=1.
# Older branches/worktrees predate the scan: skip when the script is absent, never block.
[ -f "$ROOT/scripts/opensrc-leak-scan.py" ] && { python3 "$ROOT/scripts/opensrc-leak-scan.py" --staged || exit 1; }
# #308 advisory (never blocks): warn on a cross-session source-file edit, then claim it.
bash "$ROOT/scripts/git-hooks/pre-commit-fileclaim-guard.sh" || true
# #910 advisory (never blocks): warn when governed task state (tasks.json) is committed off main.
bash "$ROOT/scripts/git-hooks/pre-commit-governed-branch-guard.sh" || true

exit 0
HOOKEOF
        chmod +x "$PRE_COMMIT"
        echo "[bootstrap] Installed git pre-commit guards (conflict-marker + path-replica + bash32-portability + memory-domain-tag + index-sweep + state-driver + suite-coverage + projection-drift + safe-area + fileclaim + governed-branch): $PRE_COMMIT"
    else
        echo "[bootstrap] Git pre-commit guards already present."
    fi
fi

# 5b. Git commit-msg hook — born-governed guard (#248) + AI-attribution strip
#     (Ant 2026-07-09: no Claude co-author trailers/session links in any history).
#     Re-installed on every bootstrap so it self-heals after a pull strips .git/hooks.
COMMIT_MSG="$GIT_HOOKS_DIR/commit-msg"
if [[ -d "$GIT_HOOKS_DIR" ]]; then
    if [[ ! -f "$COMMIT_MSG" ]] || ! grep -q 'commit-msg-strip-ai-attribution' "$COMMIT_MSG" 2>/dev/null; then
        cat > "$COMMIT_MSG" << 'HOOKEOF'
#!/usr/bin/env bash
# Auto-installed by bootstrap-claude-memory.sh (#248)
# Runs commit-msg guard scripts. Born-governed guard is WARN-ONLY (never blocks).
ROOT="$(git rev-parse --show-toplevel)"

# Strip AI co-authorship attribution first (rewrites the message file in place).
bash "$ROOT/scripts/git-hooks/commit-msg-strip-ai-attribution.sh" "$1" || true
bash "$ROOT/scripts/git-hooks/commit-msg-born-governed-guard.sh" "$1" || true

exit 0
HOOKEOF
        chmod +x "$COMMIT_MSG"
        echo "[bootstrap] Installed git commit-msg guards (attribution-strip + born-governed): $COMMIT_MSG"
    else
        echo "[bootstrap] Git commit-msg guard already present."
    fi
fi

# 5c. Git pre-push hook — secrets guard (#312) + silent-drop guard (#1605 follow-on).
#     BLOCKS: (a) credential patterns (Anthropic/OpenAI keys, GitHub PATs, AWS keys)
#     reaching origin; (b) pushes to main that silently drop tracked content with no
#     explicit delete commit (take-theirs/delete-vs-unmodified merge artifacts — the
#     class two out-of-daemon convergence merges leaked on 2026-08-01). Covers push
#     ranges missed by pre-commit and merges done outside the auto-sync daemon.
#     Re-installed on every bootstrap so it self-heals after a pull strips .git/hooks;
#     the grep-check requires BOTH guards so an old secrets-only hook gets upgraded.
PRE_PUSH="$GIT_HOOKS_DIR/pre-push"
if [[ -d "$GIT_HOOKS_DIR" ]]; then
    if [[ ! -f "$PRE_PUSH" ]] || ! grep -q 'pre-push-secrets-guard' "$PRE_PUSH" 2>/dev/null \
       || ! grep -q 'pre-push-drop-guard' "$PRE_PUSH" 2>/dev/null \
       || ! grep -q 'pre-push-design-lint-guard' "$PRE_PUSH" 2>/dev/null \
       || ! grep -q 'REFS="\$(cat)"' "$PRE_PUSH" 2>/dev/null; then
        cat > "$PRE_PUSH" << 'HOOKEOF'
#!/usr/bin/env bash
# Auto-installed by bootstrap-claude-memory.sh (#312 + #1605 + design-lint)
# Runs pre-push guard scripts; any non-zero exit blocks the push.
# git feeds the ref lines ("<localref> <localsha> <remoteref> <remotesha>") on stdin
# exactly ONCE. The guards run as sequential `bash guard` calls that share this hook's
# stdin, so the FIRST guard's `while read` drains the pipe and every later guard sees EOF
# (the drop-guard silently no-op'd this way — it never saw a ref). Capture stdin once and
# feed the same lines to each guard via a here-string so all of them get the refs.
ROOT="$(git rev-parse --show-toplevel)"
REFS="$(cat)"

bash "$ROOT/scripts/git-hooks/pre-push-secrets-guard.sh"     <<<"$REFS" || exit 1
bash "$ROOT/scripts/git-hooks/pre-push-drop-guard.sh"        <<<"$REFS" || exit 1
bash "$ROOT/scripts/git-hooks/pre-push-design-lint-guard.sh" <<<"$REFS" || exit 1

exit 0
HOOKEOF
        chmod +x "$PRE_PUSH"
        echo "[bootstrap] Installed git pre-push guards (secrets + silent-drop + design-lint; stdin-fanned): $PRE_PUSH"
    else
        echo "[bootstrap] Git pre-push guards already present."
    fi
fi

# 5d. Git reference-transaction hook — auto-rescue commits orphaned by ANY rewind of
#     main/master (#3548). The invocation-agnostic safety net: fires on every ref move
#     regardless of who does it (session/script/daemon/human), so a raw
#     `git reset --hard origin/main` that the PreToolUse deny-hook (interactive Claude
#     only) and pre-push-drop-guard (pushes only) can't see still can't cause
#     unrecoverable loss — every commit the rewind would orphan is tagged autorescue/<sha>
#     first. Delegates to the tracked script; re-installed on every bootstrap so it
#     self-heals after a pull strips .git/hooks (grep-gate upgrades a direct-copy install).
REF_TXN="$GIT_HOOKS_DIR/reference-transaction"
if [[ -d "$GIT_HOOKS_DIR" ]]; then
    if [[ ! -f "$REF_TXN" ]] || ! grep -q 'reference-transaction-autorescue' "$REF_TXN" 2>/dev/null; then
        cat > "$REF_TXN" << 'HOOKEOF'
#!/usr/bin/env bash
# Auto-installed by bootstrap-claude-memory.sh (#3548)
# Delegate to the tracked auto-rescue script. SAFETY: only the `committed` phase does any
# work and git IGNORES a committed-phase hook's exit code; for every other phase
# (prepared/aborted) we exit 0 INSTANTLY before resolving any path, so this wrapper can
# never abort a ref transaction. Forwards the phase arg ($1) + ref lines on stdin.
[ "$1" = committed ] || exit 0
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
SCRIPT="$ROOT/scripts/git-hooks/reference-transaction-autorescue.sh"
[ -f "$SCRIPT" ] && exec bash "$SCRIPT" "$@"
exit 0
HOOKEOF
        chmod +x "$REF_TXN"
        echo "[bootstrap] Installed git reference-transaction auto-rescue hook (#3548): $REF_TXN"
    else
        echo "[bootstrap] Git reference-transaction auto-rescue hook already current (#3548)."
    fi
fi

# Register the custom git merge drivers in THIS clone (#3733). Without them, a fresh clone's first
# `git merge origin/main` default-resolves governed/index state — for the memory index that means a
# take-one-side TRUNCATION (a stale 324-line MEMORY-archive.md overwriting a 641-line superset),
# which the #1605 drop-guard then correctly refuses, wedging the node until manual recovery. The
# daemon self-registers a subset each run, but a node merging before its first daemon tick (or an
# ephemeral clone that never runs the daemon) has none. Registering here at bootstrap closes that
# gap for every clone. Idempotent; non-fatal if the helper is absent.
REG_DRIVERS="$REPO_ROOT/scripts/register-merge-drivers.sh"
if [[ -f "$REG_DRIVERS" ]]; then
    if bash "$REG_DRIVERS" >/dev/null 2>&1; then
        echo "[bootstrap] Registered custom git merge drivers (taskstate, leasestate, memindex, etc.)."
    else
        echo "[bootstrap] WARN: merge-driver registration failed (non-fatal); run $REG_DRIVERS manually."
    fi
fi

# Provision the fleet reboot-survival reattach artifacts (#5235) — WezTerm autostart LaunchAgent +
# the ~/.no-apple-terminal cutover marker — from the repo, so a reimage/cutover can't silently drop
# them (the Air was found missing both). Per-host: no-ops on Terminal.app boxes (only cutover hosts
# in the script's allowlist get them). Idempotent; non-fatal if it can't fully apply.
PROV_REATTACH="$REPO_ROOT/scripts/provision-reattach-survival.sh"
if [[ -f "$PROV_REATTACH" ]]; then
    bash "$PROV_REATTACH" || echo "[bootstrap] WARN: reattach-survival provisioning reported drift (non-fatal); run $PROV_REATTACH manually."
fi

# 5e. GLOBAL persona/attribution pre-push guard — blocks agent personas
#     (<<MACHINE_2_ID>>/<<MACHINE_1_ID>>/partner-seat) and claude/gpt/openclaw/anthropic/codex mentions in the
#     commit author, branch name, or commit message on any push to a NON-metis-os
#     (external) remote. Installed via a GLOBAL core.hooksPath so it covers EVERY
#     repo on the machine, including ad-hoc external clones (e.g. ExampleCustomer)
#     that the per-repo hook above never touches. The guard self-chains to each
#     repo's own .git/hooks/pre-push and .husky/pre-push so existing guards + husky
#     still run. Root cause it prevents (2026-09-17): a stale global
#     user.name="<<MACHINE_2_ID>>" + Claude Code's default "claude/<slug>" branch prefix
#     leaked to a Example PR and tripped Vercel's COMMIT_AUTHOR_REQUIRED, notifying
#     the team owner. See reference_example_persona_leak_external_push_guard.
GLOBAL_HOOKS_LINK="$HOME/.claude/git-hooks"
GLOBAL_HOOKS_TARGET="$REPO_ROOT/ClaudeCode/git-hooks"
if [[ -d "$GLOBAL_HOOKS_TARGET" ]]; then
    ln -sfn "$GLOBAL_HOOKS_TARGET" "$GLOBAL_HOOKS_LINK"
    git config --global core.hooksPath "$GLOBAL_HOOKS_LINK"
    echo "[bootstrap] Global persona pre-push guard wired: core.hooksPath -> $GLOBAL_HOOKS_LINK"
    # A global hooksPath REPLACES every repo's .git/hooks. Every other hook name in that dir is
    # a symlink to chain-repo-hook, which execs the repo's own hook (#8483: from 2026-09-17 to
    # 2026-10-12 the metis-os pre-commit/commit-msg/post-merge/reference-transaction hooks were
    # silently dormant fleet-wide because only pre-push chained).
fi
# The git author must be a REAL human name on every surface — never a fleet persona
# (the exact leak vector above). Heal a persona global user.name automatically.
_gname="$(git config --global --get user.name 2>/dev/null || true)"
if printf '%s' "$_gname" | grep -qiE '<<MACHINE_2_ID>>|<<MACHINE_1_ID>>|partner-seat|claude|openclaw|anthropic|codex'; then
    git config --global user.name "<<OWNER_NAME>>"
    echo "[bootstrap] Global git user.name was a persona ('$_gname') -> reset to '<<OWNER_NAME>>'."
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
