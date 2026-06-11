#!/usr/bin/env python3
"""One-time migration: import hand-maintained #NNN Inbox tasks from
docs/process/task-queue.md into the governed store docs/process/state/tasks.json.

After this runs, tasks.json is the single source of truth for #NNN tasks and the
markdown becomes a pure projection (rendered by render-tier1-state.py).

Idempotent: tasks whose taskId already exists in tasks.json are skipped.
Run with --check to preview the parse; --apply to write tasks.json.

Mapping:
  slug                 -> title
  post-dash one-liner  -> summary  (the "what")
  Why / why            -> why
  Plan/Approach/Fix    -> how
  status:X             -> state    (see STATUS_TO_STATE)
  machine:X            -> owner
  priority:Px          -> priority
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
QUEUE_MD = ROOT / "docs/process/task-queue.md"
ARCHIVE_MD = ROOT / "docs/process/task-archive.md"
TASKS_PATH = ROOT / "docs/process/state/tasks.json"

STATUS_TO_STATE = {
    "open": "queued",
    "queued": "queued",
    "in-progress": "in_progress",
    "in_progress": "in_progress",
    "partially-fixed": "in_progress",
    "blocked": "blocked",
    "monitoring": "waiting",
    "ready-to-apply": "needs_verification",
    "done": "done",
    "complete": "done",
    "rejected": "failed",
    "cancelled": "failed",
    "archived": "done",
}

BLOCK_RE = re.compile(r"^- \*\*#(\d+)\s+`([^`]+)`\*\*\s*—\s*(.*)$")
# fallback for entries without a backticked slug
BLOCK_RE2 = re.compile(r"^- \*\*#(\d+)\b[^*]*\*\*\s*—?\s*(.*)$")


def strip_label(line, labels):
    """If an indented sub-bullet starts with one of labels (bold or plain),
    return its value text; else None."""
    s = line.strip()
    if s.startswith("- "):
        s = s[2:].strip()
    for label in labels:
        for variant in (f"**{label}:**", f"{label}:"):
            if s.lower().startswith(variant.lower()):
                return s[len(variant):].strip()
    return None


def parse_metadata(line):
    """Parse a `key:value | key:value` pipe-delimited sub-bullet."""
    s = line.strip().lstrip("- ").strip()
    meta = {}
    if "|" not in s or ":" not in s:
        return meta
    for part in s.split("|"):
        if ":" in part:
            k, _, v = part.partition(":")
            meta[k.strip().lower()] = v.strip()
    return meta


def extract_inbox(text):
    """Return the lines between '## Inbox' and the first GOVERNED:START / next '## '."""
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.strip() == "## Inbox":
            start = i + 1
            break
    if start is None:
        return []
    end = len(lines)
    for i in range(start, len(lines)):
        if lines[i].startswith("<!-- GOVERNED:START") or lines[i].startswith("## "):
            end = i
            break
    return lines[start:end]


def split_blocks(lines):
    blocks = []
    current = None
    for ln in lines:
        if ln.startswith("- **#"):
            if current:
                blocks.append(current)
            current = [ln]
        elif current is not None:
            # continuation belongs to the current block unless it's a stray note/sep
            current.append(ln)
    if current:
        blocks.append(current)
    return blocks


def parse_block(block):
    head = block[0]
    m = BLOCK_RE.match(head)
    if m:
        num, slug, desc = m.group(1), m.group(2), m.group(3)
    else:
        m = BLOCK_RE2.match(head)
        if not m:
            return None
        num, desc = m.group(1), m.group(2)
        slug = f"task-{num}"

    desc = desc.strip()
    # strikethrough-marked completion (e.g. "~~DONE (date)...~~") with no status
    # line is a terminal task — flag it so the scan-all terminal filter drops it.
    default_state = "done" if desc.startswith("~~") else "queued"

    task = {
        "taskId": f"#{num}",
        "title": slug,
        "summary": desc,
        "why": None,
        "how": None,
        "priority": "P3",
        "state": default_state,
        "owner": "either",
        "blockerOrNone": None,
        "nextAction": None,
    }

    for ln in block[1:]:
        meta = parse_metadata(ln)
        if meta:
            if "priority" in meta:
                task["priority"] = meta["priority"]
            if "machine" in meta:
                task["owner"] = meta["machine"]
            if "status" in meta:
                raw = meta["status"].lower()
                task["state"] = STATUS_TO_STATE.get(raw, "queued")
            continue

        why = strip_label(ln, ["Why"])
        if why and not task["why"]:
            task["why"] = why
            continue
        how = strip_label(ln, ["Plan", "Approach", "Fix", "Done"])
        if how and not task["how"]:
            task["how"] = how
            continue
        summ = strip_label(ln, ["Summary"])
        if summ:
            # explicit Summary overrides the one-liner as the "what"
            task["summary"] = summ
            continue
        blk = strip_label(ln, ["Blocked by", "Blocker or none"])
        if blk and not task["blockerOrNone"]:
            task["blockerOrNone"] = blk
            continue
        nxt = strip_label(ln, ["Next action"])
        if nxt and not task["nextAction"]:
            task["nextAction"] = nxt
            continue

    # required-field fallbacks (backfill of pre-schema tasks)
    if not task["why"]:
        task["why"] = "(migrated — rationale not separately recorded; see summary)"
    if not task["how"]:
        task["how"] = "(migrated — approach not separately recorded; see summary)"
    # clean optional empties
    if not task["blockerOrNone"]:
        task["blockerOrNone"] = "none"
    if not task["nextAction"]:
        task.pop("nextAction")
    return task


TERMINAL_STATES = {"done", "failed"}


def load_archived_ids():
    """Return a set of taskIds (e.g. '#096') that appear in task-archive.md."""
    if not ARCHIVE_MD.exists():
        return set()
    archived = set()
    id_re = re.compile(r"^\s*-\s+\*\*#(\d+)\b")
    for line in ARCHIVE_MD.read_text().splitlines():
        m = id_re.match(line)
        if m:
            archived.add(f"#{m.group(1)}")
    return archived


def extract_all_nnn_blocks(text):
    """Scan the WHOLE file for old-format `- **#NNN `slug`**` blocks (Inbox or
    misfiled in the archive). The rendered governed section uses a no-backtick
    `- **#NNN — title**` format that BLOCK_RE won't match, so already-governed
    tasks are not re-captured."""
    lines = text.splitlines()
    return split_blocks([ln for ln in lines])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["check", "apply"], default="check", nargs="?")
    ap.add_argument("--actor", default="claude (migration #098)")
    ap.add_argument(
        "--scan-all",
        action="store_true",
        help="Scan the whole file (not just Inbox) and import any NON-TERMINAL "
        "old-format #NNN block — catches queued tasks misfiled in the archive.",
    )
    args = ap.parse_args()

    archived_ids = load_archived_ids()

    text = QUEUE_MD.read_text()
    if args.scan_all:
        blocks = extract_all_nnn_blocks(text)
    else:
        blocks = split_blocks(extract_inbox(text))

    parsed = []
    for b in blocks:
        t = parse_block(b)
        if not t:
            continue
        # If the task is in task-archive.md, force state=done regardless of
        # what the queue-md block says — never import an archived task as queued.
        if t["taskId"] in archived_ids:
            t["state"] = "done"
        elif args.scan_all and t["state"] in TERMINAL_STATES:
            continue  # non-archived terminal tasks stay as historical markdown
        parsed.append(t)

    doc = json.loads(TASKS_PATH.read_text())
    existing = {t["taskId"] for t in doc["tasks"]}

    to_add = [t for t in parsed if t["taskId"] not in existing]
    skipped = [t["taskId"] for t in parsed if t["taskId"] in existing]

    print(f"Parsed {len(parsed)} inbox tasks; {len(to_add)} new, {len(skipped)} already governed.")
    if skipped:
        print(f"  skipped (already in tasks.json): {', '.join(skipped)}")
    for t in to_add:
        print(f"  + {t['taskId']} [{t['state']}/{t['priority']}/{t['owner']}] {t['title']}")

    if args.mode == "check":
        print("\n--check: no write. Sample of first new task:")
        if to_add:
            print(json.dumps(to_add[0], indent=2, ensure_ascii=False))
        return

    from datetime import datetime
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    for t in to_add:
        t.setdefault("mainFiles", [])
        t.setdefault("nextDecisionPoint", None)
        t["updatedAt"] = now
        t["updatedBy"] = args.actor
        t["revision"] = 1
        if t["taskId"] in archived_ids and t.get("state") == "done":
            t["verificationMethod"] = "retroactive"
        doc["tasks"].append(t)
    doc["updatedAt"] = now
    TASKS_PATH.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print(f"\nWrote {len(to_add)} tasks to {TASKS_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
