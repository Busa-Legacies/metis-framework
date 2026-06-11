#!/usr/bin/env python3
"""backfill-task-projects.py — propose and optionally write project slugs onto tasks.json.

Usage:
    python3 scripts/backfill-task-projects.py          # dry-run: print proposed + review list
    python3 scripts/backfill-task-projects.py --write  # apply confirmed mappings to tasks.json

Emit a review list for any uncertain/ambiguous mappings. Ant or claude eyeballs it before
passing --write. Field is optional at this stage — tasks without a project get ops as default.
"""

import json
import sys
import argparse
import re
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
TASKS_FILE = REPO_ROOT / "docs/process/state/tasks.json"
PROJECTS_FILE = REPO_ROOT / "docs/process/state/projects.json"

# ── canonical slug list (validated against projects.json at runtime) ──────────
VALID_SLUGS = set()  # populated from projects.json

# ── area → primary slug (for tasks where area is unambiguous) ─────────────────
AREA_PRIMARY: dict[str, str] = {
    "Dashboard": "dashboard-core",
    # Personal & Life splits: consulting-practice tasks vs personal (P17) —
    # see the area branch in classify(); this entry is the non-consulting default.
    "Personal & Life": "personal",
    "Uncategorized": "ops",
    "": "ops",
}

# ── keyword rules: applied in order; first match wins ─────────────────────────
# Each rule: (slug, [keywords...]) — match against slug + title (lowercased, combined)
KEYWORD_RULES: list[tuple[str, list[str]]] = [
    # queue-runner
    ("queue-runner", ["queue-runner", "curator-infra", "queue_runner", "dispatch-mode"]),
    # trading-backend (check before trading-bot — more specific)
    ("trading-backend", ["trading-backend", "build-trading", "cscv", "pbo", "dsr", "psr", "config-search", "paper-week", "paper_week"]),
    # trading-bot
    ("trading-bot", ["trading-bot", "kraken", "koinly", "trading-paper", "trading-flip", "trading-telegram", "per-trade", "test-harness"]),
    # sync-integrity
    ("sync-integrity", ["autosync", "sync-guard", "rerere", "git-sync", "rollup-boundary", "rollup-gap", "merge-driver", "conflict-marker", "sync-open-tasks", "sync_integrity", "close-lock", "close_lock"]),
    # lane-reliability
    ("lane-reliability", ["lane-health", "lane-verify", "lane-verification", "jlane", "ollama", "vram", "warmup-boot", "boot-pin", "forge-sandbox", "jarry-lane"]),
    # agent-coordination
    ("agent-coordination", ["discord-token", "discord-session", "handoff"]),
    # discord-workforce
    ("discord-workforce", ["weekly-ops"]),
    # command-center
    ("command-center", ["metis-os", "rebrand-to-metis", "dispatch-framework", "table-view-suggested"]),
    # portfolio-social
    ("portfolio-social", ["portfolio-social", "social-automation"]),
    # writing-system
    ("writing-system", ["voice-seed", "fold-back", "writing-system"]),
    # portfolio-site
    ("portfolio-site", ["portfolio-site", "portfolio-build", "public-repo-launch", "legacies-repo", "decks-public", "busa-legacies"]),
    # navore-brief
    ("navore-brief", ["navore-", "vora-"]),
    # dashboard-core
    ("dashboard-core", ["dashboard-", "finance-net-worth", "silent-except-logging", "heartbeat-http"]),
    # ops (explicit slugs that are infra one-offs)
    ("ops", [
        "sync-open-tasks",  # drift reconciliation
        "prune-checkouts",
        "orphaned-background",
        "robinhood-mcp",
        "tailscale-ip",
        "task-archive",
        "system-audit",
        "atomic-task-id",
        "gitignore-tracking",
        "repo-structure",
        "migrate-auto-close",
        "reconcile-",
        "integrity-check",
        "fix-repo-root",
        "verify-warmup",  # if not caught by lane keyword
        "limiter",
        "cross-machine",
        "parity-check",
        "task-domain",
        "session-final-output",
        "polymarket",
        "playwright-mcp",
        "skilljar",
        "skill-reference",
        "bug-protocol",
        "file-triage",
        "qa-ui-skill",
        "plan-skill",
        "add-task-capture",
        "session-persistence",
        "monitor-qwen",
        "verify-memory",
        "jarry-hook",
        "hook-symlink",
        "memory-hash",
        "stray-nested-git",
        "personal-work-capture",
        "auto-checkpoint",
        "path-replica",
        "decide.py",
        "weighted-decision",
        "leases",
        "free-work-lease",
        "free-work-released",
        "systemic-drift",
        "task-system",
        "union-merge",
        "unify-task-system",
        "render-open-tasks",
        "project-oriented-pickup",
        "tasks-json",
        "task-queue",
        "id-collision",
    ]),
]

# ── area + keyword overrides for Trading Bot area ─────────────────────────────
TRADING_BOT_AREA_RULES: list[tuple[str, list[str]]] = [
    ("trading-backend", ["trading-backend", "build-trading", "cscv", "pbo", "config-search"]),
    ("trading-bot", []),  # default for Trading Bot area
]

# ── area + keyword overrides for Personal Site area ───────────────────────────
PERSONAL_SITE_AREA_RULES: list[tuple[str, list[str]]] = [
    ("writing-system", ["voice-seed", "fold-back", "voice-profile"]),
    ("portfolio-social", ["social-automation"]),
    ("ops", ["session-persistence", "tmux"]),  # #010 session-persistence-tmux
    ("portfolio-site", []),  # default for Personal Site area
]

# ── area + keyword overrides for Automation area ──────────────────────────────
AUTOMATION_AREA_RULES: list[tuple[str, list[str]]] = [
    ("queue-runner", ["curator-infra"]),
    ("sync-integrity", ["auto-author-intent", "autosync-frontrun"]),
    ("ops", []),  # default for Automation area
]

# ── area + keyword overrides for Navore Market area ──────────────────────────
NAVORE_AREA_RULES: list[tuple[str, list[str]]] = [
    ("navore-brief", []),  # all Navore tasks → navore-brief
]


def load_json(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def slug_text(task: dict) -> str:
    """Combined text to match keywords against."""
    parts = [
        task.get("taskId", ""),
        task.get("slug", ""),
        task.get("title", ""),
    ]
    return " ".join(p for p in parts if p).lower()


def apply_keyword_rules(
    rules: list[tuple[str, list[str]]], text: str, default: str
) -> tuple[str, bool]:
    """Return (slug, is_confident). Confident = keyword matched; uncertain = fell through to default."""
    for slug, keywords in rules:
        if not keywords:
            return slug, True  # explicit default with no keywords = confident for that area
        if any(kw.lower() in text for kw in keywords):
            return slug, True
    return default, False


def compute_project(task: dict) -> tuple[str, str]:
    """
    Return (proposed_slug, confidence).
    confidence: 'confirmed' | 'review'
    """
    area = task.get("area", "")
    text = slug_text(task)

    # Area-specific routing tables (override global keyword rules)
    if area == "Trading Bot":
        slug, ok = apply_keyword_rules(TRADING_BOT_AREA_RULES, text, "trading-bot")
        return slug, "confirmed" if ok else "confirmed"  # all trading-bot tasks are unambiguous

    if area == "Personal Site":
        slug, ok = apply_keyword_rules(PERSONAL_SITE_AREA_RULES, text, "portfolio-site")
        return slug, "confirmed" if ok else "confirmed"

    if area == "Automation":
        slug, ok = apply_keyword_rules(AUTOMATION_AREA_RULES, text, "ops")
        return slug, "confirmed" if ok else "confirmed"

    if area == "Navore Market":
        slug, ok = apply_keyword_rules(NAVORE_AREA_RULES, text, "navore-brief")
        return slug, "confirmed"

    if area == "Personal & Life":
        # Split (2026-06-06): consulting-practice work stays in `consulting`;
        # personal finance/tax/retirement and life admin belong to `personal`
        # (P17). The original blanket consulting mapping predated P17 and
        # silently reverted judgment refiles whenever this script was re-run.
        if "consulting" in text:
            return "consulting", "confirmed"
        return "personal", "confirmed"

    if area == "Dashboard":
        return "dashboard-core", "confirmed"

    if area in ("Uncategorized", ""):
        return "ops", "confirmed"

    # OpenClaw Infrastructure — use global keyword rules
    if area == "OpenClaw Infrastructure":
        for slug, keywords in KEYWORD_RULES:
            if not keywords:
                continue
            if any(kw.lower() in text for kw in keywords):
                return slug, "confirmed"
        # No keyword matched — needs review
        return "ops", "review"

    # Unknown area — flag for review
    return "ops", "review"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Apply confirmed mappings to tasks.json")
    parser.add_argument("--all", action="store_true", help="Show all mappings, not just review items")
    args = parser.parse_args()

    projects = load_json(PROJECTS_FILE)
    valid_slugs = {p["slug"] for p in projects["projects"]}

    data = load_json(TASKS_FILE)
    tasks = data["tasks"]

    confirmed: list[tuple[dict, str]] = []  # (task, slug)
    review: list[tuple[dict, str]] = []     # (task, proposed_slug)
    already_set: list[tuple[dict, str]] = []

    for task in tasks:
        tid = task.get("taskId", "?")
        existing = task.get("project")
        if existing:
            already_set.append((task, existing))
            continue

        slug, confidence = compute_project(task)
        if slug not in valid_slugs:
            slug = "ops"
            confidence = "review"

        if confidence == "review":
            review.append((task, slug))
        else:
            confirmed.append((task, slug))

    # ── print summary ─────────────────────────────────────────────────────────
    print(f"tasks.json: {len(tasks)} total, {len(already_set)} already have project, "
          f"{len(confirmed)} auto-mapped, {len(review)} need review")
    print()

    if args.all:
        print(f"=== CONFIRMED ({len(confirmed)}) ===")
        for task, slug in confirmed:
            tid = task.get("taskId", "?")
            title = task.get("title", "")[:55]
            state = task.get("state", "?")
            area = task.get("area", "")
            print(f"  {tid:30s}  →  {slug:25s}  [{state}] [{area}]")
        print()

    print(f"=== REVIEW ({len(review)}) ===")
    if not review:
        print("  (none — all OpenClaw Infrastructure tasks matched a keyword)")
    for task, slug in review:
        tid = task.get("taskId", "?")
        title = task.get("title", task.get("slug", ""))[:55]
        state = task.get("state", "?")
        area = task.get("area", "")
        print(f"  {tid:30s}  →  {slug:25s}  [{state}]  {title}")
    print()

    if args.write:
        count = 0
        for task, slug in confirmed:
            task["project"] = slug
            count += 1
        with open(TASKS_FILE, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        print(f"Wrote {count} project fields to tasks.json.")
        print(f"Review items ({len(review)}) NOT written — handle manually.")
    else:
        print("Dry run. Pass --write to apply confirmed mappings.")
        print(f"Review items will still need manual project assignment after --write.")


if __name__ == "__main__":
    main()
