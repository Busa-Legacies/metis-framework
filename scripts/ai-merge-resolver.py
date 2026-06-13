#!/usr/bin/env python3
"""ai-merge-resolver.py — author-intent resolution of genuine CODE merge conflicts.

Invoked by openclaw-git-sync.sh ONLY at the point where the deterministic layers
(leasestate/taskstate merge drivers + rerere) have already run and a genuine,
novel conflict remains in code/text files. Today that path fail-soft aborts and
pages a human. Ant is not a programmer and cannot review conflicting code; the
agent that authored both sides can. This resolves the conflict honoring both
sides' intent, then proves the result before letting the daemon push it.

SAFETY CONTRACT — this script can only ever IMPROVE on the current fail-soft abort:
  * It stages NOTHING until every gate passes. Any failure / exception returns a
    non-zero exit, and the caller falls back to the existing `git merge --abort`.
    So a bug here degrades to today's behavior, never to a corrupt push.
  * Four gates, all must pass:
      1. NO MARKERS  — resolved file contains no conflict markers.
      2. BLAST RADIUS — the AI may only change text INSIDE conflict regions; every
                        non-conflicted line of the original must survive verbatim,
                        in order. Verified mechanically, not trusted.
      3. INTENT REVIEW — a second, independent AI pass adversarially confirms the
                        resolution preserves BOTH sides' intent (the "author review"
                        a human can't do here). Must return APPROVE.
      4. MECHANICAL  — changed files compile/parse; governance + self-heal tests pass.
  * Only code/text files are eligible. Anything else (binary, or an unresolved
    governed-state JSON that the drivers should have handled) → defer to human.

Exit 0  → a verified resolution is staged; caller completes the merge + pushes + audits.
Exit 2  → nothing to do (no conflict / not mid-merge).
Exit 1  → could not produce a verified resolution; caller MUST abort (today's path).

Usage:  ai-merge-resolver.py [--repo PATH] [--dry-run] [--summary-file PATH]
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

# Files we can resolve AND verify. Governed-state JSON (tasks.json / active-checkouts)
# is intentionally absent: those have dedicated merge drivers — if one reaches here
# unresolved that's a driver gap for a human, not something to AI-guess.
RESOLVABLE_EXT = {
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".sh", ".bash",
    ".md", ".txt", ".yml", ".yaml", ".toml", ".css", ".html", ".env", ".template",
}
CONFLICT_RE = re.compile(r"^(<<<<<<< |=======$|>>>>>>> )", re.M)
BEGIN, END = "<<<RESOLVED_BEGIN>>>", "<<<RESOLVED_END>>>"
AI_TIMEOUT = 240


def run(args, repo, check=False, capture=True):
    return subprocess.run(args, cwd=repo, text=True, capture_output=capture, check=check)


def git(repo, *args, check=False):
    return run(["git", *args], repo, check=check)


def log(msg):
    print(f"[ai-merge] {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Conflict parsing + the blast-radius bound
# ---------------------------------------------------------------------------
def split_conflicts(text: str):
    """Return (segments, n_conflicts). segments is a list of dicts:
    {'type':'plain','text':...} or {'type':'conflict','ours':...,'theirs':...,'raw':...}.
    Used to (a) feed the AI and (b) bound its blast radius afterward."""
    lines = text.splitlines(keepends=True)
    segs, i, n = [], 0, 0
    buf = []
    while i < len(lines):
        if lines[i].startswith("<<<<<<< "):
            if buf:
                segs.append({"type": "plain", "text": "".join(buf)})
                buf = []
            ours, theirs, raw = [], [], [lines[i]]
            i += 1
            while i < len(lines) and not lines[i].startswith("======="):
                ours.append(lines[i]); raw.append(lines[i]); i += 1
            if i < len(lines):
                raw.append(lines[i]); i += 1  # the =======
            while i < len(lines) and not lines[i].startswith(">>>>>>> "):
                theirs.append(lines[i]); raw.append(lines[i]); i += 1
            if i < len(lines):
                raw.append(lines[i]); i += 1  # the >>>>>>>
            segs.append({"type": "conflict", "ours": "".join(ours),
                         "theirs": "".join(theirs), "raw": "".join(raw)})
            n += 1
        else:
            buf.append(lines[i]); i += 1
    if buf:
        segs.append({"type": "plain", "text": "".join(buf)})
    return segs, n


def blast_radius_ok(original: str, resolved: str) -> bool:
    """The AI may ONLY change text inside conflict regions. Verify every PLAIN
    segment of the original survives verbatim and in order in the resolved file.
    If a plain (non-conflicted) line was altered, reject — the AI overreached."""
    segs, _ = split_conflicts(original)
    pos = 0
    for seg in segs:
        if seg["type"] != "plain" or not seg["text"]:
            continue
        idx = resolved.find(seg["text"], pos)
        if idx == -1:
            log(f"blast-radius FAIL: a non-conflicted region was altered/dropped")
            return False
        pos = idx + len(seg["text"])
    return True


# ---------------------------------------------------------------------------
# AI invocation (via dispatch — role × engine, with built-in fallback to qwen)
# ---------------------------------------------------------------------------
def dispatch(repo: Path, agent: str, engine: str | None, message: str) -> str | None:
    """Call dispatch; stdout is the model response (exit 0). Returns text or None."""
    disp = repo / "scripts" / "dispatch"
    if disp.exists():
        cmd = [sys.executable, str(disp), "--agent", agent, "--message", message]
    else:  # fall back to dispatch on PATH (symlinked wrapper) — also enables sandbox tests
        import shutil as _sh
        binp = _sh.which("dispatch")
        if not binp:
            log("dispatch not found (repo script or PATH)"); return None
        cmd = [binp, "--agent", agent, "--message", message]
    if engine:
        cmd += ["--engine", engine]
    # Both calls are read-only from dispatch's view — the model returns text; the
    # resolver does any file-writing itself, under its own gates. Declaring this
    # lets a read-only high-risk review lane (warden) auto-proceed without an
    # interactive --approve-risk prompt the unattended daemon can't answer.
    cmd += ["--mutation", "read-only"]
    try:
        r = subprocess.run(cmd, cwd=repo, text=True, capture_output=True, timeout=AI_TIMEOUT)
    except subprocess.TimeoutExpired:
        log(f"dispatch({agent}) timed out after {AI_TIMEOUT}s")
        return None
    if r.returncode != 0:
        log(f"dispatch({agent}) failed rc={r.returncode}: {r.stderr.strip()[:200]}")
        return None
    return r.stdout


FENCE_RE = re.compile(r"```[^\n]*\n(.*?)```", re.S)


def extract(text: str) -> str | None:
    """Pull the resolved file out of the model response. Prefer our sentinels;
    fall back to the largest markdown code fence (models reliably use fences even
    when told not to). Permissive on purpose — the no-markers + blast-radius +
    compile gates downstream reject any wrong content, so a loose grab is safe."""
    if BEGIN in text and END in text:
        return text.split(BEGIN, 1)[1].split(END, 1)[0].lstrip("\n")
    fences = FENCE_RE.findall(text)
    if fences:
        best = max(fences, key=len)          # the file is the biggest code block
        return best if best.endswith("\n") else best + "\n"
    return None


def resolve_file(repo: Path, rel: str, ours_intent: str, theirs_intent: str) -> str | None:
    path = repo / rel
    original = path.read_text()
    segs, ncon = split_conflicts(original)
    if ncon == 0:
        return None
    prompt = f"""You are resolving a git merge conflict in `{rel}`. You authored both sides.

INTENT of the current branch (OURS):
{ours_intent or '(no message)'}

INTENT of the incoming branch (THEIRS):
{theirs_intent or '(no message)'}

Below is the file with {ncon} conflict region(s) marked by <<<<<<< / ======= / >>>>>>>.
Resolve EVERY region by merging both sides so BOTH intents are preserved — keep all
logic from both unless they truly contradict, in which case prefer the change that
matches the stated intent. Do NOT touch anything outside the conflict regions.

Return ONLY the complete resolved file, with all markers removed, wrapped EXACTLY as:
{BEGIN}
<the full resolved file content>
{END}

FILE:
{original}"""
    for engine in ("sonnet-standard", None, "qwen-shallow"):  # strong → policy → free
        out = dispatch(repo, "smith", engine, prompt)
        if not out:
            continue
        resolved = extract(out)
        if resolved is None:
            log(f"{rel}: no sentinel in {engine or 'policy'} output — retrying next engine")
            continue
        if CONFLICT_RE.search(resolved):
            log(f"{rel}: gate1 FAIL (markers remain) from {engine or 'policy'}")
            continue
        if not blast_radius_ok(original, resolved):
            log(f"{rel}: gate2 FAIL (blast radius) from {engine or 'policy'}")
            continue
        return resolved
    return None


def intent_review(repo: Path, rel: str, original: str, resolved: str,
                  ours_intent: str, theirs_intent: str) -> bool:
    """Independent adversarial pass: does the resolution preserve BOTH intents?"""
    prompt = f"""Adversarially review a merge-conflict resolution in `{rel}`.
OURS intent: {ours_intent or '(none)'}
THEIRS intent: {theirs_intent or '(none)'}

ORIGINAL (with conflict markers):
{original}

PROPOSED RESOLUTION:
{resolved}

Did the resolution preserve BOTH sides' intent, drop no logic, and introduce no bug
or syntax error? Be skeptical. As the VERY LAST line of your reply, output exactly
one machine token: `VERDICT=APPROVE` or `VERDICT=REJECT` (REJECT if unsure)."""
    for engine in ("sonnet-standard", None):
        out = dispatch(repo, "warden", engine, prompt)
        if not out:
            continue
        # Search the whole reply for the explicit token (the warden lane wraps its
        # output in a sign-off block, so the verdict isn't positional). Take the
        # LAST token; absence ⇒ reject (fail-safe).
        tokens = re.findall(r"VERDICT\s*=\s*(APPROVE|REJECT)", out, re.I)
        if tokens and tokens[-1].upper() == "APPROVE":
            log(f"{rel}: intent-review APPROVE")
            return True
        log(f"{rel}: intent-review {(tokens[-1] if tokens else 'no-token')} → reject")
        return False
    return False


# ---------------------------------------------------------------------------
# Mechanical gate
# ---------------------------------------------------------------------------
def mechanical_ok(repo: Path, files: list[str]) -> bool:
    pys = [f for f in files if f.endswith(".py")]
    if pys:
        r = run([sys.executable, "-m", "py_compile", *pys], repo)
        if r.returncode != 0:
            log(f"compile FAIL: {r.stderr.strip()[:200]}"); return False
    for f in files:
        if f.endswith((".js", ".mjs", ".cjs")):
            r = run(["node", "--check", f], repo)
            if r.returncode != 0:
                log(f"node --check FAIL {f}: {r.stderr.strip()[:160]}"); return False
        if f.endswith((".json",)):
            try:
                import json as _j; _j.loads((repo / f).read_text())
            except Exception as e:
                log(f"json parse FAIL {f}: {e}"); return False
    # Governance + self-heal self-tests (cheap, no live state).
    for t in ("test-governance-core.py", "test-self-heal.py"):
        tp = repo / "scripts" / t
        if tp.exists():
            r = run([sys.executable, str(tp)], repo)
            if r.returncode != 0:
                log(f"selftest FAIL {t}: {(r.stdout + r.stderr).strip()[-200:]}"); return False
    return True


def intents(repo: Path):
    base = git(repo, "merge-base", "HEAD", "MERGE_HEAD").stdout.strip()
    ours = git(repo, "log", "--format=- %s", f"{base}..HEAD").stdout.strip()
    theirs = git(repo, "log", "--format=- %s", f"{base}..MERGE_HEAD").stdout.strip()
    return ours, theirs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=os.environ.get("METIS_HOME") or str(Path(__file__).resolve().parents[1]))
    ap.add_argument("--dry-run", action="store_true", help="resolve + verify but do not stage")
    ap.add_argument("--summary-file", help="write a one-paragraph audit summary here on success")
    args = ap.parse_args()
    repo = Path(args.repo).resolve()

    if not (repo / ".git" / "MERGE_HEAD").exists():
        log("not in a merge — nothing to do"); return 2
    unmerged = [f for f in git(repo, "diff", "--name-only", "--diff-filter=U").stdout.split("\n") if f]
    if not unmerged:
        log("no unmerged paths"); return 2

    ineligible = [f for f in unmerged if Path(f).suffix not in RESOLVABLE_EXT]
    if ineligible:
        log(f"ineligible files present → defer to human: {', '.join(ineligible)}")
        return 1

    ours_intent, theirs_intent = intents(repo)
    log(f"resolving {len(unmerged)} conflicted file(s): {', '.join(unmerged)}")

    originals = {f: (repo / f).read_text() for f in unmerged}
    for f in unmerged:
        resolved = resolve_file(repo, f, ours_intent, theirs_intent)
        if resolved is None:
            log(f"{f}: could not produce a clean resolution → abort"); return 1
        if not intent_review(repo, f, originals[f], resolved, ours_intent, theirs_intent):
            log(f"{f}: intent review rejected → abort"); return 1
        (repo / f).write_text(resolved)

    if not mechanical_ok(repo, unmerged):
        log("mechanical gate failed → abort"); return 1

    if args.dry_run:
        log("dry-run: all gates passed, not staging"); return 0

    git(repo, "add", "--", *unmerged)
    summary = (f"auto-resolved {len(unmerged)} code conflict(s): {', '.join(unmerged)} "
               f"[gates: no-markers + blast-radius + intent-review + compile/tests]")
    log(summary)
    if args.summary_file:
        try:
            Path(args.summary_file).write_text(summary + "\n")
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # any failure degrades to the caller's abort path
        log(f"unexpected error → defer to human abort: {e}")
        sys.exit(1)
