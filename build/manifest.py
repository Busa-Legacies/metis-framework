#!/usr/bin/env python3
"""metis-core assembly manifest + builder.

Reads CORE content FROM ~/metis-os (never modifies it) and assembles a clean
~/metis-core working tree mirroring metis-os's layout (so a later git-subtree
sync maps path-for-path). Run: python3 manifest.py build   (or `plan` for dry-run)

Classification source: a full 5-region exploration of metis-os (2026-06-10).
Principle: include only genuinely portable architecture; exclude anything tied to
a specific machine (Jay/Jarry/Tailscale), personal integration (Discord/Notion/
MS365), personal project, or business IP. Ambiguous-but-personal → EXCLUDE from
the seed (safer to add later than to leak).
"""
import os
import shutil
import sys
from pathlib import Path

# SRC defaults to the live metis-os tree, but is env-overridable so a publish can
# read from a CLEAN, committed checkout (e.g. a `git worktree add origin/main`)
# instead of a working tree that may carry another session's uncommitted WIP — the
# reproducibility invariant is "same metis-os *committed* state -> same metis-core".
SRC = Path(os.environ.get("METIS_PUBLISH_SRC") or (Path.home() / "metis-os"))
DST = Path.home() / "metis-core"

# ── whole directories copied as-is (portable, no personal content) ───────────
CORE_DIRS = [
    "ClaudeCode/hooks",
    "ClaudeCode/bin",
    "ClaudeCode/skills/start", "ClaudeCode/skills/checkpoint", "ClaudeCode/skills/end",
    "ClaudeCode/skills/close", "ClaudeCode/skills/add-task", "ClaudeCode/skills/next",
    "ClaudeCode/skills/free-work", "ClaudeCode/skills/gap-analysis",
    "ClaudeCode/skills/sync-tasks", "ClaudeCode/skills/plan", "ClaudeCode/skills/build",
    "ClaudeCode/skills/fix", "ClaudeCode/skills/qa-ui", "ClaudeCode/skills/file",
    "ClaudeCode/skills/study",
    "scripts/lib", "scripts/git-hooks", "scripts/tests",
    "docs/design",
    "projects/dev-review", "projects/metis-command", "projects/agent-workbench",
    "decks/assets", "decks/metis",
    ".github",
]

# ── individual files copied as-is ────────────────────────────────────────────
CORE_FILES = [
    # root config (org-agnostic)
    ".gitattributes", "pyproject.toml", ".prettierrc",
    ".codex/hooks.json",
    # architecture kernel (portable; AGENTS ~95% already generic)
    "AGENTS.md",
    # design
    "docs/design-guidelines.md",
    # settings/config patterns (templated separately if needed, copied as base)
    "ClaudeCode/settings.shared.json", "ClaudeCode/mirror-manifest.json",
]

# ── scripts: CORE (portable governance/sync/session/close machinery) ─────────
CORE_SCRIPTS = [
    # task governance + state
    "agent-work.py", "update-tier1-state.py", "render-tier1-state.py", "reconcile.py",
    "archive-done-tasks.py", "archive-tasks.py", "link-milestones.py",
    "backfill-task-board-fields.py", "backfill-task-origins.py", "backfill-task-projects.py",
    "migrate-nnn-to-governed.py", "priorities.py", "priorities-selftest.py",
    "coverage-lint.py", "context-budget-check.py", "run-task.py",
    "task-ready-blockers.py", "task-ready.sh", "task-verify.sh", "decide.py",
    "decision-record.py",
    # git sync + locking + merge drivers
    "openclaw-git-sync.sh", "check-sync-drift.sh", "ensure-autosync-loaded.sh",
    "merge-lease-state.sh", "merge-taskstate.py", "git-lock.sh", "sync-session.sh",
    # session lifecycle
    "session-registry.py", "session-lifecycle.py", "session-idle.py",
    "session-workstreams.py", "working-context-update.py", "run-session-lifecycle.sh",
    "session-pivot.sh", "reap-bg-tasks.sh",
    # close / checkpoint
    "close-integrity-check.sh", "close-push.sh", "close-tasks.sh", "close-lock.sh",
    "close-boundary-advance.sh", "commit-or-intent.sh", "auto-checkpoint-on-close.sh",
    "send-handoff.sh", "rollup-gap-check.sh",
    # mirror / codex surface
    "mirror.py", "sync-codex-surface.py",
    # self-heal framework
    "self-heal.py", "self-heal.sh", "add-healthcheck.py", "test-self-heal.py",
    "ensure-self-heal-loaded.sh", "install-self-heal-agent.sh",
    # sync Tier-3 merge resolver + governance tests
    "ai-merge-resolver.py", "test-ai-merge-resolver.py", "test-governance-core.py",
    # bootstrap / setup
    "bootstrap-claude-memory.sh", "setup-worktrees.sh", "install-scripts.sh",
    # quality / audit / tests
    "system-audit.sh", "gitignore-lint.sh", "test-git-sync-guards.sh",
    "test-agent-work.sh", "test-working-context-update.sh", "test-taskstate-archive.py",
    "check-memory-limits.sh", "self-review.py", "review.sh",
    # templates
    "launchagent-claude-task.plist.template",
]

# ── scripts: PARAMETERIZE (CORE logic, hardcoded enums → read config) ────────
# Copied here, then patched by parameterize() to read config/infrastructure.json.
PARAM_SCRIPTS = [
    "free-work.py",      # MACHINE_AGENTS dict
    "queue-runner.py",   # DISPATCHABLE_AGENTS / DISPATCHABLE_MACHINES
    "task-domain.py",    # domain list incl navore/trading/consulting
]

# Everything else in scripts/ is intentionally EXCLUDED from the seed:
#   discord_*, notion_*, ms365-sync, setup-google-sa, google-workspace-doctor,
#   jay-*, bootstrap-jay-lanes, heartbeat*, lease-heartbeat, tailscale-watchdog,
#   ttyd-shell, navore_stakeholder_report, copilot-*, restart-dashboard/workbench,
#   weekly-ops-summary, run-insights, smoke-*, dispatch, jlane, lane-*, caddy/,
#   jay/, metis-move*, metis-sudo*, jarry-*, ccc*, claude-tmux, claude-task,
#   spin-task-agent, notion-run-poller, test-cc-roundtrip, content-capture.mjs,
#   ant.*.plist, launchagents/, run-detached*, setup-agent-labels, run-registry.yaml
# These are machine-specific, personal-integration, or personal-project bound.

# ── docs/process: CORE protocol/doctrine docs (the architectural spine) ──────
CORE_PROCESS_DOCS = [
    "decision-doctrine.md", "correction-protocol.md", "session-output-standard.md",
    "tiered-context-architecture.md", "task-pickup-and-lifecycle-standard.md",
    "task-writing-protocol.md", "tier1-governed-state-model.md",
    "surgical-delivery-protocol.md", "gap-analysis-standard.md",
    "multi-provider-agent-framework.md", "command-center-standard.md",
    "public-repo-playbook.md", "offline-autopilot-protocol.md",
    "dispatch-protocol.md", "doctrine-to-operations-bridge.md",
    "future-agent-scaffold-template.md",
    "task-naming-convention.md", "session-output-standard.md",
    "platform-registry.json",
]
# docs/process/decisions/ (DR template + standard) handled as a dir if present.

def rm_dst():
    if DST.exists():
        shutil.rmtree(DST)

def cp(rel, *, src_root=SRC, dst_root=DST):
    s = src_root / rel
    d = dst_root / rel
    if not s.exists():
        return f"MISS {rel}"
    d.parent.mkdir(parents=True, exist_ok=True)
    if s.is_dir():
        shutil.copytree(
            s, d, dirs_exist_ok=True, ignore_dangling_symlinks=True,
            ignore=shutil.ignore_patterns(
                "__pycache__", "*.pyc", ".DS_Store", "node_modules", ".next",
                "dist", "build", ".turbo", "*.log", "playwright-report",
                ".venv", "venv", "*.db", "*.db-wal", "*.db-shm", ".env",
                "out", "coverage", ".cache", "dist-app", "release",
            ),
        )
    else:
        shutil.copy2(s, d)
    return f"OK   {rel}"

def build(plan_only=False):
    results = []
    items = []
    items += [("dir", d) for d in CORE_DIRS]
    items += [("file", f) for f in CORE_FILES]
    items += [("file", f"scripts/{s}") for s in CORE_SCRIPTS]
    items += [("file", f"scripts/{s}") for s in PARAM_SCRIPTS]
    items += [("file", f"docs/process/{d}") for d in CORE_PROCESS_DOCS]
    # decisions dir (DR template + standard) if it exists
    if (SRC / "docs/process/decisions").exists():
        items.append(("dir", "docs/process/decisions"))
    # forge3d lib + tooling only (not personal models)
    for f in ["projects/forge3d/lib", "projects/forge3d/scripts",
              "projects/forge3d/README.md"]:
        items.append(("any", f))
    # navore portable seed kit + templates only
    for f in ["projects/navore/sandbox-agent-template", "projects/navore/templates"]:
        items.append(("any", f))

    if plan_only:
        for _, rel in items:
            exists = (SRC / rel).exists()
            print(f"{'✓' if exists else '✗'} {rel}")
        print(f"\n{len(items)} items planned")
        return

    rm_dst()
    seen = set()
    for _, rel in items:
        if rel in seen:
            continue
        seen.add(rel)
        results.append(cp(rel))
    miss = [r for r in results if r.startswith("MISS")]
    print(f"copied {len(results)-len(miss)} ok, {len(miss)} missing")
    for m in miss:
        print("  " + m)

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "plan"
    build(plan_only=(mode == "plan"))
