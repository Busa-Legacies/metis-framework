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
        # 19_000 -> 19_400 (2026-08-18): the craft-delegation routing doctrine (executors carry
        # Ant's calibrated stances; craft → fork or injected lane, never bare general-purpose) is
        # justified always-on content — it's a standing routing rule Ant directed this session and
        # the detail already lives in [[feedback_executor_stance_injection]]. Line trimmed to its
        # terse operative form + pointer; a modest deliberate bump covers the residual, per this
        # file's header (bump-with-justification is the sanctioned remedy for earned always-on content).
        # 19_400 -> 20_400 (2026-08-19): the review-surface rule Ant directed (review deliverables are
        # Metis artifacts, NEVER claude.ai — machine-level + metis-os) is mandatory always-on content;
        # both entries trimmed to terse operative form + a [[feedback_open_review_artifacts_in_browser]]
        # pointer holding the full mechanics. NOTE: two bumps in two days — the always-on surface is
        # trending hot; the next earned addition should pair with a real tier-down diet, not another bump.
        "ceiling": 20_400,
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
        # 9_500 -> 9_800 (#1099, 2026-07-28): these are identity/persona + curated-context files
        # (SOUL, IDENTITY, the main-session memory index) with no reference-tier fat to demote —
        # compressing them degrades meaning, so a small deliberate bump is the sanctioned remedy
        # (per this file's header) rather than dieting the soul file to reclaim ~83 chars.
        "ceiling": 9_800,
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


def measure(group: dict, overrides: dict | None = None) -> dict:
    """Size a group from on-disk file sizes. `overrides` maps a repo-relative path to a
    prospective byte size — used by the PreToolUse gate (#3424) to measure the group as it
    WOULD be after an unlanded edit, without touching disk."""
    overrides = overrides or {}
    items = []
    total = 0
    for rel in group["files"]:
        p = REPO / rel
        if rel in overrides:
            n = overrides[rel]
            missing = False
        else:
            n = p.stat().st_size if p.exists() else 0
            missing = not p.exists()
        items.append({"file": rel, "chars": n, "missing": missing})
        total += n
    rules_dir = group.get("rules_dir")
    if rules_dir:
        for rp in sorted((REPO / rules_dir).glob("*.md")):
            if _is_path_scoped(rp):
                continue  # on-demand — not always-on
            rel = str(rp.relative_to(REPO))
            n = overrides.get(rel, rp.stat().st_size)
            items.append({"file": rel, "chars": n, "missing": False})
            total += n
    return {
        "name": group["name"],
        "ceiling": group["ceiling"],
        "chars": total,
        "tokens_est": round(total / 4),
        "over": total > group["ceiling"],
        "items": items,
    }


def _groups_for_path(rel_path: str) -> list:
    """Groups whose always-on set includes rel_path (repo-relative). Used by --check-file."""
    hits = []
    for g in GROUPS:
        in_group = rel_path in set(g["files"])
        rd = g.get("rules_dir")
        if not in_group and rd and rel_path.startswith(rd + "/") and rel_path.endswith(".md"):
            p = REPO / rel_path
            if p.exists() and not _is_path_scoped(p):
                in_group = True
        if in_group:
            hits.append(g)
    return hits


def check_file(raw_path: str) -> int:
    """Write-time gate (#1099): exit 2 (+stderr) iff editing this file left its always-on group
    OVER budget; exit 0 for untracked files or an in-budget group. Keeps the recurring close-time
    FAIL (#528/#749/#1099) from ever reaching a commit. GROUPS lives here so the hook stays thin."""
    if not raw_path:
        return 0
    try:
        rel = str(Path(raw_path).resolve().relative_to(REPO))
    except (ValueError, OSError):
        return 0  # outside the repo — not a tracked surface
    over = [r for r in (measure(g) for g in _groups_for_path(rel)) if r["over"]]
    if not over:
        return 0
    for r in over:
        files = ", ".join(f"{it['file']} ({it['chars']:,})" for it in r["items"])
        sys.stderr.write(
            f"CONTEXT-BUDGET GATE (#1099): this edit left the always-on group '{r['name']}' at "
            f"{r['chars']:,}/{r['ceiling']:,} chars (+{r['chars'] - r['ceiling']:,}) — it is loaded "
            f"into every session. Before committing, EITHER demote reference content to an on-demand "
            f"tier (path-scoped `.claude/rules` with `paths:`, a skill, or a doc pointer), OR bump the "
            f"ceiling in scripts/context-budget-check.py with a commit comment justifying the new "
            f"always-on content. Group files: {files}.\n"
        )
    return 2


def check_prospective(raw_path: str, prospective_bytes: int) -> int:
    """PreToolUse gate (#3424): exit 2 (+stderr) iff applying an edit that makes `raw_path`
    `prospective_bytes` long WOULD leave its always-on group over budget; exit 0 otherwise.
    Blocks the over-budget edit BEFORE it lands (the PostToolUse --check-file only warned after)."""
    if not raw_path:
        return 0
    try:
        rel = str(Path(raw_path).resolve().relative_to(REPO))
    except (ValueError, OSError):
        return 0  # outside the repo — not a tracked surface
    groups = _groups_for_path(rel)
    if not groups:
        return 0  # untracked surface — never blocks a normal edit
    # RATCHET: block only an edit that GROWS an over-budget group. A group can already be over
    # (the PreToolUse gate was silently dead until 2026-10-05 while files grew to 27.6K/20.4K);
    # denying every edit then would also block the trims that bring it back under.
    over = []
    for g in groups:
        after = measure(g, overrides={rel: prospective_bytes})
        if after["over"] and after["chars"] > measure(g)["chars"]:
            over.append(after)
    if not over:
        return 0
    for r in over:
        files = ", ".join(f"{it['file']} ({it['chars']:,})" for it in r["items"])
        sys.stderr.write(
            f"CONTEXT-BUDGET GATE (#3424): this edit WOULD leave the always-on group '{r['name']}' at "
            f"{r['chars']:,}/{r['ceiling']:,} chars (+{r['chars'] - r['ceiling']:,}) — it is loaded into "
            f"every session, so the edit is BLOCKED before it lands. EITHER trim the edit / demote "
            f"reference content to an on-demand tier (path-scoped `.claude/rules` with `paths:`, a skill, "
            f"or a doc pointer), OR bump the ceiling in scripts/context-budget-check.py with a justifying "
            f"comment, OR set CONTEXT_BUDGET_GATE_OVERRIDE=1 for a deliberate one-off. Group files: {files}.\n"
        )
    return 2


def main() -> int:
    if "--check-file" in sys.argv:
        i = sys.argv.index("--check-file")
        return check_file(sys.argv[i + 1] if i + 1 < len(sys.argv) else "")
    if "--check-prospective" in sys.argv:
        i = sys.argv.index("--check-prospective")
        path = sys.argv[i + 1] if i + 1 < len(sys.argv) else ""
        content = sys.stdin.buffer.read()  # prospective full file content on stdin
        return check_prospective(path, len(content))
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
