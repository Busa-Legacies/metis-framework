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

--upsert refuses (exit 2) to replace a thread another session owns unless --take-over.

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
# Session-digest dir: one <full-session-uuid>.md per session, mtime bumped each turn.
# Env-overridable so tests can point it at a fixture without touching the real board.
SESSION_DIGESTS = pathlib.Path(
    os.environ.get("METIS_SESSION_DIGESTS")
    or (ROOT / "<<MACHINE_1_ID>>" / "state" / "session-digests")
)
# A thread owner active within this window is treated as a live session (#3441).
FRESH_WINDOW_S = 24 * 3600

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


def _owner_digest_mtime(owner: str) -> float:
    """Newest session-digest mtime for an owner tag, or 0.0 if none.

    Owner tags are truncated to 8 chars (session_id()); digest files are named with
    the full session UUID, so match by prefix. A recent mtime means the owner session
    has taken a turn recently — i.e. it may still be live.
    """
    if not owner:
        return 0.0
    try:
        return max((p.stat().st_mtime for p in SESSION_DIGESTS.glob(f"{owner}*.md")),
                   default=0.0)
    except OSError:
        return 0.0


def _owner_is_fresh(owner, ts, now, window: int = FRESH_WINDOW_S) -> bool:
    """True when the thread's owner shows activity within `window` seconds.

    Two independent signals: the thread's own provenance ts (last time the owner
    wrote it) and the owner's session-digest mtime (last turn the owner took). The
    digest signal is the one that catches the #3441 case — a thread that is the
    OLDEST by ts (so the trimmer targets it first) but whose owner session is still
    running. A fresh owner means auto-dropping the thread would lose live state.
    """
    if not owner:
        return False
    if ts and (now - ts) <= window:
        return True
    mt = _owner_digest_mtime(owner)
    return bool(mt) and (now - mt) <= window


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

    def upsert_thread(self, key: str, body: str, sess: str, ts: int, take_over=False) -> bool:
        """False (nothing written) when the thread belongs to another session.

        A whole-line replace of someone else's thread silently loses whatever they
        wrote since you last read it; pass take_over only when that is intended.
        """
        line = f"- **[{key}]** {body}".rstrip()
        for t in self.threads:
            if t[0] == key:
                if t[2] not in (None, sess) and not take_over:
                    return False
                t[1], t[2], t[3] = line, sess, ts
                return True
        self.threads.append([key, line, sess, ts])
        return True

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
        # Strip-compare: blocker_key()'s [:24] slice can keep a trailing space,
        # which main()'s k.strip() makes impossible to match from the CLI.
        before = len(self.blockers)
        self.blockers = [b for b in self.blockers if b[0].strip() != key.strip()]
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

    def _is_foreign_live(self, owner, ts, sess: str, now: float) -> bool:
        """True when a thread belongs to a DIFFERENT session that is still active.

        Such a thread is never auto-dropped — losing another running session's state
        is exactly the work-loss the never-lose ops-model prevents (#3441). The
        ENDING session's own DONE threads stay trimmable (it is deliberately closing),
        so the guard is scoped to owner != sess.
        """
        return bool(owner) and owner != sess and _owner_is_fresh(owner, ts, now)

    def enforce_budget(self, sess: str) -> bool:
        """Trim to LINE_BUDGET.

        Auto-trims only threads that (a) carry an explicit DONE/RESOLVED/CLOSED
        marker AND (b) are not owned by a different, currently-active session. A
        blocked-but-running thread reads as done to the marker heuristic (a stray
        "phase 1 DONE" in a live thread's body is enough), so before #3441 the
        trimmer could silently evict another session's live state to fit the budget.
        If nothing is safely trimmable, exit 2 and list candidates so the caller
        knows which threads to --remove explicitly.
        """
        if self.line_count() <= LINE_BUDGET:
            return True
        now = time.time()
        while self.line_count() > LINE_BUDGET:
            # Safe victims: DONE-marked AND not a live foreign session's thread.
            done = sorted(
                [t for t in self.threads
                 if _is_done_thread(t[1]) and not self._is_foreign_live(t[2], t[3], sess, now)],
                key=lambda t: t[3] or 0,
            )
            if done:
                victim = done[0]
                self.threads.remove(victim)
                sys.stderr.write(f"[trim] dropped DONE thread [{victim[0]}]\n")
            else:
                # No safe victims — fail loudly; caller must --remove explicitly.
                protected = [t for t in self.threads
                             if _is_done_thread(t[1]) and self._is_foreign_live(t[2], t[3], sess, now)]
                if protected:
                    sys.stderr.write(
                        f"[budget] {len(protected)} DONE thread(s) protected as "
                        f"foreign-live (owner active <24h) — NOT dropped: "
                        f"{', '.join('[' + t[0] + ']' for t in protected)}\n")
                sys.stderr.write(
                    f"[error] {self.line_count()} lines > {LINE_BUDGET} and no "
                    f"safe DONE/RESOLVED threads to auto-trim. --remove one of these:\n"
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
    ap.add_argument("--take-over", action="store_true",
                    help="let --upsert replace a thread another session owns")
    ap.add_argument("--enforce-budget", action="store_true")
    ap.add_argument("--show", action="store_true", help="print result, do not write")
    args = ap.parse_args()

    path = pathlib.Path(args.file)
    text = path.read_text() if path.exists() else ""
    doc = Doc(text)
    sess = session_id()
    now = int(time.time())

    remove_ok = True
    for val in args.upsert:
        k, v = parse_kv(val)
        if not doc.upsert_thread(k, v, sess, now, args.take_over):
            sys.stderr.write(
                f"[error] thread [{k!r}] is owned by another session — not replaced "
                "(update it from that session, or pass --take-over deliberately)\n"
            )
            remove_ok = False
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
        if not doc.remove_blocker(k.strip()):
            sys.stderr.write(
                f"[error] no blocker keyed {k.strip()!r} found — nothing removed\n"
            )
            remove_ok = False
    if args.focus is not None:
        doc.focus = args.focus.strip()
    if args.next is not None:
        doc.next = args.next.strip()

    over = False
    if args.enforce_budget:
        if not doc.enforce_budget(sess):
            over = True

    # Any write is a refresh: stamp today's date so the header never goes stale.
    doc.header = "# Working Context — " + time.strftime("%Y-%m-%d")
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
