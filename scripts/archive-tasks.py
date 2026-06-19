#!/usr/bin/env python3
"""Archive terminal tasks out of the active queue + board (#089).

The active queue grew past the Read-tool's 25k token ceiling because every
done/cancelled/rejected #NNN entry stays inline forever. This moves terminal
entries into a separate, never-pruned archive so the active view stays scannable.

What it does (a view/projection cleanup — NO task data is deleted):
  1. task-queue.md  — moves Inbox `#NNN` blocks whose fields line is terminal
     (status:done/complete/cancelled/rejected/archived) into docs/process/task-archive.md.
     The GOVERNED section (<<MACHINE_2_ID>>/tasks.json territory) is never touched.
  2. OPEN_TASKS.md  — moves `[x]` board entries from the project sections into the
     existing `## Resolved` section. The auto-managed SELF-REVIEW block is left alone.

Idempotent: a second run finds nothing terminal in the active view and is a no-op.
Default is a DRY RUN (prints the plan). Pass --apply to write.
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "docs/process/task-queue.md"
ARCHIVE = ROOT / "docs/process/task-archive.md"
BOARD = ROOT / "workspace/state/OPEN_TASKS.md"

# Non-terminal statuses stay in the active queue (per #089):
#   open, in-progress, blocked, needs-review, monitoring, partially-fixed
TERMINAL = {"done", "complete", "cancelled", "canceled", "rejected", "archived"}

INBOX_HDR = "## Inbox"
GOVERNED = "<!-- GOVERNED:START -->"
RESOLVED_HDR = "## Resolved"
SELFREVIEW = "<!-- SELF-REVIEW:START -->"

ENTRY_RE = re.compile(r"^- \*\*#(\d+)\b")
STATUS_RE = re.compile(r"\bstatus:([a-z-]+)")
BOARD_ENTRY_RE = re.compile(r"^- \[[^\]]*\] \[(.)\]")


def _read(path: Path) -> list[str]:
    return path.read_text().splitlines(keepends=True)


def _index(lines: list[str], needle: str) -> int:
    for i, ln in enumerate(lines):
        if ln.startswith(needle):
            return i
    raise SystemExit(f"marker not found: {needle!r}")


def _queue_blocks(region: list[str]) -> tuple[list[str], list[list[str]]]:
    """Split the Inbox region into a leading preamble + per-#NNN blocks.

    A block runs from a `- **#NNN` header line up to (but not including) the next
    header — so each block carries its own trailing blank-line separator, keeping
    spacing intact when blocks are removed.
    """
    preamble: list[str] = []
    blocks: list[list[str]] = []
    cur: list[str] | None = None
    for ln in region:
        if ENTRY_RE.match(ln):
            if cur is not None:
                blocks.append(cur)
            cur = [ln]
        elif cur is None:
            preamble.append(ln)
        else:
            cur.append(ln)
    if cur is not None:
        blocks.append(cur)
    return preamble, blocks


def _is_terminal_queue(block: list[str]) -> bool:
    for ln in block:
        m = STATUS_RE.search(ln)
        if m:
            return m.group(1) in TERMINAL
    return False


def _norm_block(block: list[str]) -> list[str]:
    """Trim trailing blank lines, then end with exactly one blank separator."""
    out = list(block)
    while out and out[-1].strip() == "":
        out.pop()
    out.append("\n")
    return out


def process_queue(apply: bool) -> list[str]:
    lines = _read(QUEUE)
    inbox_i = _index(lines, INBOX_HDR)
    gov_i = _index(lines, GOVERNED)
    region = lines[inbox_i + 1 : gov_i]
    preamble, blocks = _queue_blocks(region)

    kept, archived = [], []
    for b in blocks:
        (archived if _is_terminal_queue(b) else kept).append(b)

    moved_ids = [ENTRY_RE.match(b[0]).group(1) for b in archived]
    if not apply or not archived:
        return moved_ids

    new_region = list(preamble)
    for b in kept:
        new_region.extend(b)
    new_lines = lines[: inbox_i + 1] + new_region + lines[gov_i:]
    QUEUE.write_text("".join(new_lines))

    _append_archive([ln for b in archived for ln in _norm_block(b)], moved_ids)
    return moved_ids


def _append_archive(blocks_text: list[str], ids: list[str]) -> None:
    today = dt.date.today().isoformat()
    stamp = f"\n### Archived {today}\n\n"
    if not ARCHIVE.exists():
        header = (
            "# Task Archive\n\n"
            "Terminal `#NNN` tasks (done / cancelled / rejected / archived) moved out of the\n"
            "active queue by `scripts/archive-tasks.py` (#089). This is a canonical, never-pruned\n"
            "human-readable record — the governed source of truth remains `docs/process/state/tasks.json`.\n\n"
            "## Entries\n"
        )
        ARCHIVE.write_text(header + stamp + "".join(blocks_text))
    else:
        with ARCHIVE.open("a") as f:
            f.write(stamp + "".join(blocks_text))


def _board_blocks(lines: list[str]) -> list[tuple[int, list[str]]]:
    """Index board entries: each is a `- [..] [.]` line + its indented sub-lines."""
    out = []
    i = 0
    while i < len(lines):
        if BOARD_ENTRY_RE.match(lines[i]):
            block = [lines[i]]
            j = i + 1
            while j < len(lines) and lines[j].startswith((" ", "\t")) and lines[j].strip():
                block.append(lines[j])
                j += 1
            out.append((i, block))
            i = j
        else:
            i += 1
    return out


def process_board(apply: bool) -> list[str]:
    lines = _read(BOARD)
    resolved_i = _index(lines, RESOLVED_HDR)
    selfreview_i = _index(lines, SELFREVIEW)

    moved: list[list[str]] = []
    drop: set[int] = set()
    for start, block in _board_blocks(lines):
        if start >= resolved_i:  # already in Resolved / Self-Review — leave it
            continue
        if BOARD_ENTRY_RE.match(block[0]).group(1) == "x":
            moved.append(block)
            drop.update(range(start, start + len(block)))

    labels = [b[0].strip() for b in moved]
    if not apply or not moved:
        return labels

    # Insert moved entries at the end of the Resolved section (before the blank
    # line that precedes the SELF-REVIEW marker), then drop them from their
    # original positions. Build the insert before deleting so indices stay valid.
    insert_at = selfreview_i
    while insert_at - 1 > resolved_i and lines[insert_at - 1].strip() == "":
        insert_at -= 1
    moved_text = [ln for b in moved for ln in b]

    out = lines[:insert_at] + moved_text + lines[insert_at:]
    # Recompute drop offsets are unaffected (all drops are before resolved_i < insert_at),
    # so deleting by original index on the *prefix* is safe.
    out = [ln for k, ln in enumerate(out) if k >= insert_at or (k not in drop)]
    BOARD.write_text("".join(_collapse_blanks(out)))
    return labels


def _collapse_blanks(lines: list[str]) -> list[str]:
    """Removing a board block leaves its trailing blank behind; collapse any run
    of 2+ blank lines down to a single blank so sections don't gap out."""
    out: list[str] = []
    blank = False
    for ln in lines:
        is_blank = ln.strip() == ""
        if is_blank and blank:
            continue
        out.append(ln)
        blank = is_blank
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    args = ap.parse_args()

    q_ids = process_queue(args.apply)
    b_labels = process_board(args.apply)

    verb = "Archived" if args.apply else "Would archive"
    print(f"{verb} {len(q_ids)} queue task(s): {', '.join('#' + i for i in q_ids) or '(none)'}")
    print(f"{verb} {len(b_labels)} board entry/entries to ## Resolved:")
    for lab in b_labels:
        print(f"  {lab}")
    if not args.apply:
        print("\n(dry run — re-run with --apply to write)")


if __name__ == "__main__":
    main()
