#!/usr/bin/env python3
"""Context-budget regression guard.

Measures the *always-on* instruction surface each agent provider pays on every session and fails if it
regrows past budget. This locks in the tiered-context-architecture savings (docs/process/
tiered-context-architecture.md) the same way smoke-api-all.sh locks the dashboard /api contract.

"Always-on" = files a provider's harness auto-loads every session. Path-scoped `.claude/rules/*.md`
(those with a `paths:` frontmatter) are on-demand and deliberately NOT counted — moving content there is
how you stay under budget. Token estimate ≈ chars / 4.

Usage:
  python3 scripts/context-budget-check.py            # check; exit 1 on any over-budget group
  python3 scripts/context-budget-check.py --json      # machine-readable
Run from anywhere; paths resolve against the repo root.
"""
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Each group: the files a provider auto-loads + a char ceiling (current size + ~12% headroom).
# Bump a ceiling deliberately (with a commit message) only when new always-on content is justified —
# the point is that silent regrowth fails CI/close, forcing a conscious decision.
GROUPS = [
    {
        "name": "claude-code (auto-loaded)",
        "files": ["CLAUDE.md", "ClaudeCode/CLAUDE.md"],
        "rules_dir": ".claude/rules",  # count only UNSCOPED *.md (no `paths:`)
        "ceiling": 19_000,
    },
    {
        "name": "codex (auto-loaded)",
        "files": ["AGENTS.md", "ClaudeCode/codex/instructions.md"],
        "ceiling": 19_500,
    },
    {
        "name": "gateway/jay (workspace)",
        "files": ["workspace/AGENTS.md"],
        "ceiling": 3_500,
    },
    {
        "name": "shared identity (checklist-read)",
        "files": ["SOUL.md", "USER.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md", "HEARTBEAT.md"],
        "ceiling": 9_500,
    },
]


def _is_path_scoped(p: Path) -> bool:
    """A rule is on-demand (not always-on) if its YAML frontmatter declares `paths:`."""
    try:
        head = p.read_text(encoding="utf-8", errors="replace")[:800]
    except OSError:
        return False
    if not head.startswith("---"):
        return False
    fm = head.split("---", 2)
    return len(fm) >= 3 and any(line.strip().startswith("paths:") for line in fm[1].splitlines())


def measure(group: dict) -> dict:
    items = []
    total = 0
    for rel in group["files"]:
        p = REPO / rel
        n = p.stat().st_size if p.exists() else 0
        items.append({"file": rel, "chars": n, "missing": not p.exists()})
        total += n
    rules_dir = group.get("rules_dir")
    if rules_dir:
        for rp in sorted((REPO / rules_dir).glob("*.md")):
            if _is_path_scoped(rp):
                continue  # on-demand — not always-on
            n = rp.stat().st_size
            items.append({"file": str(rp.relative_to(REPO)), "chars": n, "missing": False})
            total += n
    return {
        "name": group["name"],
        "ceiling": group["ceiling"],
        "chars": total,
        "tokens_est": round(total / 4),
        "over": total > group["ceiling"],
        "items": items,
    }


def main() -> int:
    results = [measure(g) for g in GROUPS]
    if "--json" in sys.argv:
        print(json.dumps({"groups": results, "ok": not any(r["over"] for r in results)}, indent=2))
        return 1 if any(r["over"] for r in results) else 0

    print("context-budget check (always-on instruction surface per provider)\n")
    any_over = False
    for r in results:
        status = "OVER" if r["over"] else "ok"
        if r["over"]:
            any_over = True
        bar = f"{r['chars']:,} / {r['ceiling']:,} c  (~{r['tokens_est']:,} tok)"
        print(f"[{status:>4}] {r['name']:<34} {bar}")
        for it in r["items"]:
            tag = "  MISSING" if it.get("missing") else ""
            print(f"         · {it['file']:<40} {it['chars']:>7,} c{tag}")
        print()
    if any_over:
        print("FAIL: an always-on group exceeded its budget. Move content to an on-demand tier "
              "(skill / path-scoped rule / doc pointer) per docs/process/tiered-context-architecture.md, "
              "or bump the ceiling deliberately with a commit explaining why.")
        return 1
    print("PASS: all always-on groups within budget.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
