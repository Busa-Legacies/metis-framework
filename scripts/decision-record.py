#!/usr/bin/env python3
"""Manage Architecture Decision Records (DRs).

See docs/process/decisions/STANDARD.md for the standard this implements.

Commands:
  decision-record.py new "<title>" [--status accepted] [--supersedes DR-NNNN]
  decision-record.py list
  decision-record.py link DR-NNNN [<sha>...]
  decision-record.py index
"""
import argparse
import datetime
import re
import subprocess
import sys
from pathlib import Path

DR_RE = re.compile(r"^DR-(\d{4})-.*\.md$")
TITLE_RE = re.compile(r"^#\s*DR-\d{4}:\s*(.+?)\s*$", re.M)
STATUS_RE = re.compile(r"^(- \*\*Status:\*\*)\s*(.+?)\s*$", re.M)
SUPERSEDES_RE = re.compile(r"^(- \*\*Supersedes:\*\*)\s*(.+?)\s*$", re.M)
SUPERSEDED_BY_RE = re.compile(r"^(- \*\*Superseded-by:\*\*)\s*(.+?)\s*$", re.M)


def find_repo_root() -> Path:
    """Walk up from this file until we find docs/process/decisions."""
    for parent in [Path(__file__).resolve()] + list(Path(__file__).resolve().parents):
        if (parent / "docs" / "process" / "decisions").is_dir():
            return parent
    sys.exit("error: could not locate repo root (docs/process/decisions not found)")


REPO = find_repo_root()
DECISIONS = REPO / "docs" / "process" / "decisions"
TEMPLATE = DECISIONS / "TEMPLATE.md"
INDEX = DECISIONS / "README.md"


def dr_files() -> list[Path]:
    return sorted(p for p in DECISIONS.glob("DR-*.md") if DR_RE.match(p.name))


def dr_number(p: Path) -> int:
    m = DR_RE.match(p.name)
    return int(m.group(1)) if m else -1


def read_field(text: str, regex: re.Pattern) -> str:
    m = regex.search(text)
    return m.group(2).strip() if m else "—"


def title_of(text: str, fallback: str = "(untitled)") -> str:
    m = TITLE_RE.search(text)
    return m.group(1).strip() if m else fallback


def slugify(title: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return s or "untitled"


def file_for_id(dr_id: str) -> Path | None:
    num = dr_id.replace("DR-", "")
    for p in dr_files():
        if p.name.startswith(f"DR-{num}-"):
            return p
    return None


def cmd_new(args) -> None:
    if not TEMPLATE.is_file():
        sys.exit(f"error: template not found at {TEMPLATE}")
    existing = dr_files()
    next_num = (max((dr_number(p) for p in existing), default=0)) + 1
    dr_id = f"DR-{next_num:04d}"
    slug = slugify(args.title)
    today = datetime.date.today().isoformat()
    status = args.status.strip().capitalize() if args.status else "Accepted"

    text = TEMPLATE.read_text()
    text = text.replace("DR-NNNN", dr_id)
    text = text.replace("<Title>", args.title)
    text = text.replace("YYYY-MM-DD", today)
    text = STATUS_RE.sub(rf"\1 {status}", text, count=1)
    if args.supersedes:
        text = SUPERSEDES_RE.sub(rf"\1 {args.supersedes}", text, count=1)

    out = DECISIONS / f"{dr_id}-{slug}.md"
    if out.exists():
        sys.exit(f"error: {out.name} already exists")
    out.write_text(text)

    if args.supersedes:
        old = file_for_id(args.supersedes)
        if old:
            old_text = old.read_text()
            old_text = STATUS_RE.sub(rf"\1 Superseded by {dr_id}", old_text, count=1)
            old_text = SUPERSEDED_BY_RE.sub(rf"\1 {dr_id}", old_text, count=1)
            old.write_text(old_text)
            print(f"updated {old.name}: status -> Superseded by {dr_id}", file=sys.stderr)
        else:
            print(f"warning: --supersedes {args.supersedes} not found", file=sys.stderr)

    regenerate_index()
    print(out)  # stdout = path ONLY, so OUT=$(... new ...) is clean


def cmd_list(args) -> None:
    rows = []
    for p in dr_files():
        text = p.read_text()
        rows.append((p.name.split("-", 2)[0] + "-" + p.name.split("-")[1],
                     read_field(text, STATUS_RE), title_of(text)))
    if not rows:
        print("(no decision records yet)")
        return
    w_id = max(len(r[0]) for r in rows)
    w_st = max(len(r[1]) for r in rows + [("", "Status", "")])
    print(f"{'DR':<{w_id}}  {'Status':<{w_st}}  Title")
    for dr_id, status, title in rows:
        print(f"{dr_id:<{w_id}}  {status:<{w_st}}  {title}")


def _git(*args) -> str:
    res = subprocess.run(["git", "-C", str(REPO), *args],
                         capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip())
    return res.stdout.strip()


def cmd_link(args) -> None:
    target = file_for_id(args.dr)
    if not target:
        sys.exit(f"error: {args.dr} not found")
    try:
        if args.shas:
            commits = [_git("log", "-1", "--format=%h %s", sha) for sha in args.shas]
        else:
            out = _git("log", f"--grep={args.dr}", "--format=%h %s")
            commits = [ln for ln in out.splitlines() if ln.strip()]
    except RuntimeError as e:
        sys.exit(f"error: git failed: {e}")
    if not commits:
        sys.exit(f"no commits found for {args.dr} (try passing SHAs explicitly)")

    text = target.read_text()
    # tolerate both bare and backticked hashes already present
    existing_hashes = set(re.findall(r"^- `?([0-9a-f]{7,})", text, re.M))
    new = [c for c in commits if c.split()[0] not in existing_hashes]
    if not new:
        print(f"{target.name}: all commits already pinned")
        return

    def fmt(c: str) -> str:
        parts = c.split(" ", 1)
        return f"- `{parts[0]}` {parts[1]}" if len(parts) == 2 else f"- `{parts[0]}`"

    block = "\n".join(fmt(c) for c in new)
    if "Pinned commits:" in text:
        text = text.replace("Pinned commits:", "Pinned commits:\n" + block, 1)
    else:
        # append to the ## Changes section (before the next ## or EOF)
        m = re.search(r"(## Changes\n.*?)(\n## |\Z)", text, re.S)
        if m:
            insert = m.group(1).rstrip() + "\n\nPinned commits:\n" + block + "\n"
            text = text[:m.start(1)] + insert + text[m.end(1):]
        else:
            text = text.rstrip() + "\n\nPinned commits:\n" + block + "\n"
    target.write_text(text)
    print(f"{target.name}: pinned {len(new)} commit(s)")


def regenerate_index() -> None:
    header = (
        "# Decision Records\n\n"
        "Numbered, immutable records of *why* the system works the way it does — the rationale "
        "behind significant milestones, linked to the commits that implemented them.\n\n"
        "**Read [STANDARD.md](STANDARD.md) first** for what a DR is, when to create one, and how. "
        "New DRs are scaffolded with `scripts/decision-record.py new \"Title\"`. This index is "
        "regenerated by `scripts/decision-record.py index`.\n\n"
        "| DR | Status | Title |\n|---|---|---|\n"
    )
    rows = []
    for p in dr_files():
        text = p.read_text()
        num = f"DR-{dr_number(p):04d}"
        rows.append(f"| [{num}]({p.name}) | {read_field(text, STATUS_RE)} | {title_of(text)} |")
    INDEX.write_text(header + "\n".join(rows) + "\n")


def cmd_index(args) -> None:
    regenerate_index()
    print(f"regenerated {INDEX.relative_to(REPO)}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Manage Decision Records (DRs).")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_new = sub.add_parser("new", help="scaffold the next-numbered DR")
    p_new.add_argument("title")
    p_new.add_argument("--status", default="accepted")
    p_new.add_argument("--supersedes", metavar="DR-NNNN")
    p_new.set_defaults(func=cmd_new)

    sub.add_parser("list", help="list all DRs").set_defaults(func=cmd_list)

    p_link = sub.add_parser("link", help="pin commit SHAs into a DR's Changes section")
    p_link.add_argument("dr", metavar="DR-NNNN")
    p_link.add_argument("shas", nargs="*")
    p_link.set_defaults(func=cmd_link)

    sub.add_parser("index", help="regenerate README.md index").set_defaults(func=cmd_index)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
