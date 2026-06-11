#!/usr/bin/env python3
"""task-domain.py — Map a task label to its project domain and high-level concern.

Usage:
  python3 scripts/task-domain.py "Curator patch-vs-plan gate"
  python3 scripts/task-domain.py "dashboard-terminal-verify"
  python3 scripts/task-domain.py --concern "Curator patch-vs-plan gate"

Default output: raw section name from OPEN_TASKS.md (e.g. "Automation")
--concern flag: high-level bucket (e.g. "infrastructure") — use THIS for pivot comparison

Concern buckets (what actually triggers a pivot recommendation):
  infrastructure  → OpenClaw Infrastructure, Automation, Remote Access, Self-Review
  product         → Dashboard, Navore Market
  trading         → Trading Bot

Exits 0 always — "unknown" on no match so callers can proceed.
"""

import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).parent.parent
OPEN_TASKS = ROOT / "Jay" / "state" / "OPEN_TASKS.md"

# High-level concern groupings — pivot is triggered by crossing these buckets.
# These are illustrative defaults; a consuming org replaces the bucket->area and
# keyword->area maps below with its own projects/areas (areas should match
# config/infrastructure.json `domains` and the org's task-areas config).
CONCERN_MAP = {
    "infrastructure": {"Infrastructure", "Automation"},
    "uncategorized":  {"Uncategorized"},
}

# Keyword fallback for tasks not yet in the board projection. Extend per org.
KEYWORD_TO_SECTION = {
    "Infrastructure": [
        "lane", "gateway", "forge", "scout", "shield", "echo", "agent", "lease",
        "handoff", "bootstrap", "hermes", "checkout", "free-work", "fencing",
        "protocol", "session-lifecycle", "close-lock", "mirror", "reconcile",
        "projection", "task-domain", "workstream", "dispatch", "queue-runner",
        "working-context", "task-system",
    ],
    "Automation": [
        "curator", "git-sync", "auto-sync", "cron", "sync-guard", "sync-health",
        "self-review", "guard", "conflict-marker", "pre-commit", "autosync",
    ],
}


def section_lookup(label: str) -> str | None:
    """Walk OPEN_TASKS.md and return the section a task lives under."""
    if not OPEN_TASKS.exists():
        return None
    label_norm = re.sub(r"^#\d+\s*", "", label.lower().strip())
    current_section = None
    with open(OPEN_TASKS) as f:
        for line in f:
            m = re.match(r"^## (.+?)\s*\|", line)
            if m:
                current_section = m.group(1).strip()
                continue
            # Skip completed tasks — they may have moved sections since they were done
            if re.search(r"\[x\]", line, re.IGNORECASE):
                continue
            task_m = re.search(r"\*\*([^*]+)\*\*", line)
            if task_m and current_section:
                task_label = re.sub(r"^#\d+\s*", "", task_m.group(1).strip().lower())
                if label_norm in task_label or task_label in label_norm:
                    return current_section
    return None


def keyword_lookup(label: str) -> str:
    label_norm = label.lower()
    for section, keywords in KEYWORD_TO_SECTION.items():
        if any(kw in label_norm for kw in keywords):
            return section
    return "unknown"


def get_section(label: str) -> str:
    return section_lookup(label) or keyword_lookup(label)


def get_concern(label: str) -> str:
    section = get_section(label)
    for concern, sections in CONCERN_MAP.items():
        if section in sections:
            return concern
    return "unknown"


if __name__ == "__main__":
    args = sys.argv[1:]
    use_concern = "--concern" in args
    args = [a for a in args if not a.startswith("--")]
    label = " ".join(args) if args else ""
    if not label:
        print("unknown")
        sys.exit(0)
    print(get_concern(label) if use_concern else get_section(label))
