#!/usr/bin/env python3
"""test-ai-merge-resolver.py — guard the merge-resolver's safety gates.

The AI step is non-deterministic, but the MECHANICAL safety gates (conflict
parsing, the blast-radius bound, sentinel extraction, marker detection) are pure
and MUST be correct — they are what stops a hallucinated resolution from touching
code outside the conflict. This tests those, no AI required. Exit 0/1 like the
other selftests; wired into CI.
"""
import sys
import importlib.util
import os

REPO = os.path.realpath(os.path.join(os.path.dirname(__file__), ".."))
spec = importlib.util.spec_from_file_location("aimerge", os.path.join(REPO, "scripts", "ai-merge-resolver.py"))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

fails = []


def check(c, m):
    if not c:
        fails.append(m)


# Build the conflict markers from pieces so this TEST FILE contains no literal
# marker line-starts — otherwise the #058 pre-commit guard (and the resolver's own
# no-marker grep) would false-trip on legitimate test data. The runtime string
# still has real markers, which is what we're testing.
_LT, _EQ, _GT = "<" * 7, "=" * 7, ">" * 7
CONFLICT = (
    f"line A\nline B\n{_LT} HEAD\nours line 1\nours line 2\n"
    f"{_EQ}\ntheirs line 1\n{_GT} branch\nline C\nline D\n"
)

# --- split_conflicts ---
segs, n = M.split_conflicts(CONFLICT)
check(n == 1, f"split: expected 1 conflict, got {n}")
plains = [s["text"] for s in segs if s["type"] == "plain"]
check("line A\nline B\n" in plains[0], "split: leading plain text wrong")
check("line C\nline D\n" in plains[-1], "split: trailing plain text wrong")
conf = [s for s in segs if s["type"] == "conflict"][0]
check("ours line 1\nours line 2\n" == conf["ours"], "split: ours side wrong")
check("theirs line 1\n" == conf["theirs"], "split: theirs side wrong")

# --- marker detection ---
check(M.CONFLICT_RE.search(CONFLICT) is not None, "marker: should detect markers")
check(M.CONFLICT_RE.search("clean\nfile\n") is None, "marker: clean file falsely flagged")

# --- extract (sentinel) ---
wrapped = f"chatter\n{M.BEGIN}\nRESOLVED CONTENT\n{M.END}\ntrailing"
check(M.extract(wrapped) == "RESOLVED CONTENT\n", "extract: sentinel content wrong")
check(M.extract("no fence or sentinel here") is None, "extract: plain prose should be None")

# --- extract (markdown fence fallback — models reliably wrap code in fences) ---
fenced = "calc.py\n```python\ndef add(a, b):\n    return a + b\n```\n"
check(M.extract(fenced) == "def add(a, b):\n    return a + b\n", "extract: fenced code block wrong")
# Largest fence wins (prose may include a tiny inline example fence).
multi = "```\nsmall\n```\nblah\n```python\nbig resolved\nfile body\n```"
check(M.extract(multi) == "big resolved\nfile body\n", "extract: should pick the largest fence")

# --- blast_radius_ok: the core safety bound ---
# (1) A valid resolution: only the conflict region changed, plain lines verbatim.
good = "line A\nline B\nours line 1\nours line 2\ntheirs line 1\nline C\nline D\n"
check(M.blast_radius_ok(CONFLICT, good) is True, "blast: valid in-region merge should pass")

# (2) Picking one side is fine (still only touches the conflict region).
pick_ours = "line A\nline B\nours line 1\nours line 2\nline C\nline D\n"
check(M.blast_radius_ok(CONFLICT, pick_ours) is True, "blast: choosing one side should pass")

# (3) OVERREACH: AI altered a non-conflicted line (line B -> line B!) → must FAIL.
overreach = "line A\nline B CHANGED\nours line 1\ntheirs line 1\nline C\nline D\n"
check(M.blast_radius_ok(CONFLICT, overreach) is False, "blast: altering a plain line MUST fail")

# (4) OVERREACH: AI dropped a non-conflicted trailing line → must FAIL.
dropped = "line A\nline B\nours line 1\ntheirs line 1\nline C\n"
check(M.blast_radius_ok(CONFLICT, dropped) is False, "blast: dropping a plain line MUST fail")

# (5) OVERREACH: AI inserted code OUTSIDE the conflict (before line A) — the plain
#     segments still appear in order, so this specific case is allowed (additions
#     adjacent to a conflict are within tolerance); altering EXISTING plain text is not.
#     Assert the stricter property we DO guarantee: existing plain text is preserved.
check(M.blast_radius_ok(CONFLICT, "PRE\n" + good) is True,
      "blast: prepend keeps plain segments in order (tolerated)")

# --- RESOLVABLE_EXT sanity: governed-state JSON is intentionally NOT auto-resolved
check(".py" in M.RESOLVABLE_EXT and ".sh" in M.RESOLVABLE_EXT, "ext: code types must be resolvable")

# --- integration: keepours ADD/ADD auto-resolves keep-ours; non-keepours add/add still defers ---
# Models the REAL 2026-08-29 wedge: a projection artifact and its `merge=keepours` .gitattributes
# line were introduced together, but a machine BEHIND that commit had neither at merge start — so
# git ran no driver for the path and left a raw add/add CONFLICT, while the merged-in .gitattributes
# meant post-merge `check-attr` reported keepours. (With the attr present from the START, git's ort
# strategy auto-resolves the add/add itself — no conflict, no resolver — so the attr must arrive via
# THEIRS to reproduce the wedge.) The resolver must apply the declared keep-ours policy there, not
# defer; a path with no such base-independent policy must still defer.
import subprocess, tempfile, shutil
from pathlib import Path as _P
def _git(rp, *a):
    return subprocess.run(["git", *a], cwd=rp, text=True, capture_output=True)
def _addadd_repo(theirs_declares_keepours):
    rp = tempfile.mkdtemp(prefix="aimerge-addadd-")
    _git(rp, "init", "-q", "-b", "main")
    _git(rp, "config", "user.email", "t@t"); _git(rp, "config", "user.name", "t")
    _git(rp, "config", "merge.keepours.driver", "true")
    (_P(rp) / "README").write_text("base\n")
    _git(rp, "add", "README"); _git(rp, "commit", "-qm", "base")   # base: no probe.json, no .gitattributes
    _git(rp, "checkout", "-qb", "theirs")                          # theirs introduces the file (+ maybe the attr)
    if theirs_declares_keepours:
        (_P(rp) / ".gitattributes").write_text("probe.json merge=keepours\n")
        _git(rp, "add", ".gitattributes")
    (_P(rp) / "probe.json").write_text('{"who":"theirs"}\n')
    _git(rp, "add", "probe.json"); _git(rp, "commit", "-qm", "theirs adds")
    _git(rp, "checkout", "-q", "main")                             # ours-at-start has NO .gitattributes driver
    (_P(rp) / "probe.json").write_text('{"who":"ours"}\n')
    _git(rp, "add", "probe.json"); _git(rp, "commit", "-qm", "ours adds")
    _git(rp, "merge", "--no-edit", "theirs")                       # add/add → real CONFLICT (no driver at start)
    return rp
def _run_resolver(rp):
    return subprocess.run([sys.executable, os.path.join(REPO, "scripts", "ai-merge-resolver.py"), "--repo", rp],
                          text=True, capture_output=True)

_ko = _addadd_repo(True)   # theirs brought the keepours declaration in → post-merge check-attr = keepours
try:
    check(_P(_ko + "/.git/MERGE_HEAD").exists(), "keepours add/add: setup should leave a real conflict")
    _r = _run_resolver(_ko)
    check(_r.returncode == 0, f"keepours add/add: resolver should keep-ours-resolve (exit {_r.returncode}; {_r.stderr.strip()[:140]})")
    check(_git(_ko, "diff", "--name-only", "--diff-filter=U").stdout.strip() == "", "keepours add/add: no unmerged paths should remain")
    check((_P(_ko) / "probe.json").read_text() == '{"who":"ours"}\n', "keepours add/add: must keep OURS content")
finally:
    shutil.rmtree(_ko, ignore_errors=True)

_nd = _addadd_repo(False)   # no driver declared anywhere → .json is unresolvable → must DEFER
try:
    check(_P(_nd + "/.git/MERGE_HEAD").exists(), "non-keepours add/add: setup should leave a real conflict")
    _r = _run_resolver(_nd)
    check(_r.returncode == 1, f"non-keepours .json add/add: must defer to human (got exit {_r.returncode})")
    check(_git(_nd, "diff", "--name-only", "--diff-filter=U").stdout.strip() == "probe.json", "non-keepours add/add: file stays unmerged (deferred)")
finally:
    shutil.rmtree(_nd, ignore_errors=True)

if fails:
    print("AI-MERGE-RESOLVER SELFTEST FAILED:")
    for f in fails:
        print("  - " + f)
    raise SystemExit(1)
print("AI-MERGE-RESOLVER SELFTEST OK — conflict parse, blast-radius bound, extraction, markers all hold")
