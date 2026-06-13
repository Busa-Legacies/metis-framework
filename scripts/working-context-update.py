#!/usr/bin/env python3
"""working-context-update.py — operation-based editor for working-context.md.

Replaces the full-file *rewrite* in /end + /checkpoint with explicit *operations*.
A snapshot loses intent (you can't tell a deliberate cut from a never-seen thread);
an operation log preserves it. Each thread carries an invisible provenance comment
(`<!-- own:SESS ts:EPOCH -->`) used ONLY to make the 35-line budget trim safe — a
writer never trims another session's thread that is fresher than its own oldest.

Run it under the sync lock so the read-modify-write is serialized:
  scripts/git-lock.sh run python3 scripts/working-context-update.py \
    --upsert '#124::union-merge design locked' \
    --remove '#129' \
    --focus 'one-line active focus' \
    --next 'one-line next action' \
    --enforce-budget

Ops (repeatable): --upsert KEY::text · --remove KEY · --upsert-blocker KEY::text
                  --remove-blocker KEY · --focus TEXT · --next TEXT
--enforce-budget trims to 35 lines using provenance (only /end should pass it).
--show prints the result without writing. Exit 2 = over budget and can't trim safely.
"""

import argparse
import os
import re
import sys
import time
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_FILE = ROOT / "<<MACHINE_1_ID>>" / "memory" / "working-context.md"
LINE_BUDGET = 35

PROV_RE = re.compile(r"\s*<!--\s*own:(\S+)\s+ts:(\d+)\s*-->\s*$")
# Matches **[X]** and **[[X]]** — captures X without brackets.
THREAD_KEY_RE = re.compile(r"\*\*\[{1,2}([^\]]+?)\]{1,2}\*\*")
BLOCKER_KEY_RE = re.compile(r"(#\d+)")
# Threads containing these markers are safe to auto-trim.
_DONE_MARKER_RE = re.compile(r"\b(DONE|RESOLVED|CLOSED)\b", re.IGNORECASE)


def session_id() -> str:
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID") or ""
    if sid:
        return sid[:8]
    return f"{os.uname().nodename.split('.')[0][:4]}{os.getpid()}"[:8]


def strip_prov(text: str):
    """Return (clean_text, owner, ts). owner=None, ts=0 if no provenance."""
    m = PROV_RE.search(text)
    if not m:
        return text.rstrip(), None, 0
    return text[: m.start()].rstrip(), m.group(1), int(m.group(2))


def thread_key(line: str):
    m = THREAD_KEY_RE.search(line)
    return m.group(1) if m else None


def blocker_key(line: str):
    m = BLOCKER_KEY_RE.search(line)
    return m.group(1) if m else line.strip().lstrip("- ").strip()[:24]


def normalize_key(k: str) -> str:
    """Strip **[[ ... ]]** or **[ ... ]** wrappers from a user-supplied key.

    Lets callers pass raw markdown like [[metis-command]] or **[#126]** and
    have them resolve to the same key the parser extracts from the file.
    """
    k = k.strip()
    k = re.sub(r"^\*+|\*+$", "", k)  # strip leading/trailing **
    while k.startswith("[") and k.endswith("]"):
        k = k[1:-1]
    return k.strip()


def _is_done_thread(clean_text: str) -> bool:
    """Return True when the thread text contains an explicit done marker."""
    return bool(_DONE_MARKER_RE.search(clean_text))


class Doc:
    """Parsed working-context.md: header + focus + ordered threads/blockers + next."""

    def __init__(self, text: str):
        self.header = "# Working Context — " + time.strftime("%Y-%m-%d")
        self.focus = ""
        self.next = ""
        self.threads = []   # list of [key, clean_text, owner, ts]
        self.blockers = []  # list of [key, clean_text]
        self._parse(text)

    def _parse(self, text: str):
        section = None
        for raw in text.splitlines():
            line = raw.rstrip("\n")
            if line.startswith("# Working Context"):
                self.header = line
                continue
            m = re.match(r"^##\s+(.+?)\s*$", line)
            if m:
                section = m.group(1).lower()
                continue
            if not line.strip():
                continue
            if section == "active focus":
                self.focus = line.strip()
            elif section == "next action":
                self.next = line.strip()
            elif section == "open threads" and line.lstrip().startswith("-"):
                clean, owner, ts = strip_prov(line)
                key = thread_key(clean) or clean.strip()[:24]
                self.threads.append([key, clean, owner, ts])
            elif section == "blockers" and line.lstrip().startswith("-"):
                self.blockers.append([blocker_key(line), line.rstrip()])

    def upsert_thread(self, key: str, body: str, sess: str, ts: int):
        line = f"- **[{key}]** {body}".rstrip()
        for t in self.threads:
            if t[0] == key:
                t[1], t[2], t[3] = line, sess, ts
                return
        self.threads.append([key, line, sess, ts])

    def remove_thread(self, key: str) -> bool:
        before = len(self.threads)
        self.threads = [t for t in self.threads if t[0] != key]
        return len(self.threads) != before

    def upsert_blocker(self, key: str, body: str):
        line = f"- {body}".rstrip()
        for b in self.blockers:
            if b[0] == key:
                b[1] = line
                return
        self.blockers.append([key, line])

    def remove_blocker(self, key: str) -> bool:
        before = len(self.blockers)
        self.blockers = [b for b in self.blockers if b[0] != key]
        return len(self.blockers) != before

    def render(self) -> str:
        out = [self.header, ""]
        out += ["## Active focus", self.focus or "(none)", ""]
        out.append("## Open threads")
        for key, clean, owner, ts in self.threads:
            if owner and ts:
                out.append(f"{clean}   <!-- own:{owner} ts:{ts} -->")
            else:
                out.append(clean)
        out.append("")
        out.append("## Blockers")
        for _key, line in self.blockers:
            out.append(line)
        out.append("")
        out += ["## Next action", self.next or "(none)"]
        return "\n".join(out) + "\n"

    def line_count(self) -> int:
        return self.render().count("\n")

    def enforce_budget(self, sess: str) -> bool:
        """Trim to LINE_BUDGET.

        Only auto-trims threads with explicit DONE/RESOLVED/CLOSED markers —
        active threads are never silently dropped. If the file is still over
        budget after exhausting safe victims, exit 2 and list candidates so
        the caller knows which threads to --remove explicitly.
        """
        if self.line_count() <= LINE_BUDGET:
            return True
        while self.line_count() > LINE_BUDGET:
            # Only auto-trim threads that carry an explicit done marker.
            done = sorted(
                [t for t in self.threads if _is_done_thread(t[1])],
                key=lambda t: t[3] or 0,
            )
            if done:
                victim = done[0]
                self.threads.remove(victim)
                sys.stderr.write(f"[trim] dropped DONE thread [{victim[0]}]\n")
            else:
                # No safe victims — fail loudly; caller must --remove explicitly.
                sys.stderr.write(
                    f"[error] {self.line_count()} lines > {LINE_BUDGET} and no "
                    f"DONE/RESOLVED threads to auto-trim. --remove one of these:\n"
                )
                for t in self.threads:
                    sys.stderr.write(f"  --remove '{t[0]}'\n")
                return False
        return True


def parse_kv(val: str):
    if "::" not in val:
        sys.exit(f"error: expected KEY::text, got {val!r}")
    k, v = val.split("::", 1)
    return k.strip(), v.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(DEFAULT_FILE))
    ap.add_argument("--upsert", action="append", default=[], metavar="KEY::text")
    ap.add_argument("--remove", action="append", default=[], metavar="KEY")
    ap.add_argument("--upsert-blocker", action="append", default=[], metavar="KEY::text")
    ap.add_argument("--remove-blocker", action="append", default=[], metavar="KEY")
    ap.add_argument("--focus")
    ap.add_argument("--next")
    ap.add_argument("--enforce-budget", action="store_true")
    ap.add_argument("--show", action="store_true", help="print result, do not write")
    args = ap.parse_args()

    path = pathlib.Path(args.file)
    text = path.read_text() if path.exists() else ""
    doc = Doc(text)
    sess = session_id()
    now = int(time.time())

    for val in args.upsert:
        k, v = parse_kv(val)
        doc.upsert_thread(k, v, sess, now)
    remove_ok = True
    for k in args.remove:
        norm = normalize_key(k)
        if not doc.remove_thread(norm):
            sys.stderr.write(
                f"[error] no thread keyed [{norm!r}] (raw: {k!r}) found — nothing removed\n"
            )
            remove_ok = False
    for val in args.upsert_blocker:
        k, v = parse_kv(val)
        doc.upsert_blocker(k, v)
    for k in args.remove_blocker:
        doc.remove_blocker(k.strip())
    if args.focus is not None:
        doc.focus = args.focus.strip()
    if args.next is not None:
        doc.next = args.next.strip()

    over = False
    if args.enforce_budget:
        if not doc.enforce_budget(sess):
            over = True

    rendered = doc.render()
    if args.show:
        sys.stdout.write(rendered)
    else:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(rendered)
        os.replace(tmp, path)
        sys.stderr.write(f"[ok] {doc.line_count()} lines · {len(doc.threads)} threads\n")

    sys.exit(2 if (over or not remove_ok) else 0)


if __name__ == "__main__":
    main()
