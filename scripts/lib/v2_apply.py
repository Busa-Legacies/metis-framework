"""v2_apply.py — queue-runner-v2 apply + self-verify harness.

The core of the honest step-away loop (docs/process/queue-runner-v2-design.md):
take a lane's structured output, apply it in an ISOLATED git worktree off
origin/main, run the task's doneWhen check there, and — only on a green check —
let the caller land it to main. Nothing touches the live tree until it's proven.

Safety properties this module guarantees:
  - Lane output is applied in a throwaway worktree, never the live checkout.
  - The doneWhen CHECK comes from the human-authored task, NOT the lane — smith
    produces the code, it cannot choose its own grade.
  - Paths are sandboxed to the worktree (no abs paths, no `..` traversal).
  - A red or unrun check never produces a landable commit.

Pure-ish + injectable so it runs against a throwaway git repo in tests with no
network and no live state. Wiring into the queue-runner dispatch flow is a
separate step; this module is the verified primitive underneath it.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

# Lane output contract: full-file blocks. Full-file (not diff) so application is
# deterministic — no line-number/context matching that LLM diffs routinely botch.
#   === FILE: relative/path.ext ===
#   <complete file content>
#   === END FILE ===
_FILE_BLOCK = re.compile(
    r"^=== FILE: (?P<path>.+?) ===\n(?P<body>.*?)\n=== END FILE ===\s*$",
    re.MULTILINE | re.DOTALL,
)

# Fallback contract (#340): the strict === FILE === markers are what we ASK for,
# but a local model (qwen) routinely emits the natural "path line, then a fenced
# code block" convention instead — exactly the #341 case where the content was
# perfect but the framing differed. Accept it when no strict block is present: a
# standalone relative-path line (ending in a file extension) immediately followed
# by a ```lang fenced block whose contents are the full file body. The isolated
# worktree + doneWhen check still gate every landing, so a mis-parse cannot land.
_FENCED_FILE_BLOCK = re.compile(
    r"^(?P<path>[A-Za-z0-9._/\-]+\.[A-Za-z0-9]+)[ \t]*\n"
    r"```[A-Za-z0-9+\-]*[ \t]*\n(?P<body>.*?)\n```[ \t]*$",
    re.MULTILINE | re.DOTALL,
)


class ApplyResult:
    """Captures every stage of apply_and_verify so the caller and tests can
    assert on it. Plain class (not a dataclass) so the module loads identically
    however it's imported — importlib-without-sys.modules-registration trips
    dataclass field introspection on Python 3.14."""

    def __init__(self):
        self.parsed = []          # [(path, content)]
        self.applied = False
        self.files = []           # paths written
        self.check_ran = False
        self.check_passed = False
        self.check_output = ""
        self.worktree = ""        # path to the isolated worktree (until cleaned up)
        self.commit_sha = ""      # worktree commit, landable on green
        self.no_change = False    # lane output matched base byte-for-byte (#692)
        self.error = ""

    def __repr__(self):
        return (
            f"ApplyResult(applied={self.applied}, files={self.files}, "
            f"check_ran={self.check_ran}, check_passed={self.check_passed}, "
            f"commit_sha={self.commit_sha[:8]!r}, no_change={self.no_change}, "
            f"error={self.error!r})"
        )


def parse_artifact(text: str):
    """Extract (path, content) pairs from a lane's structured output. Tolerates
    surrounding prose — only the FILE blocks are taken. Non-greedy so multiple
    blocks parse independently."""
    out = []
    for m in _FILE_BLOCK.finditer(text or ""):
        out.append((m.group("path").strip(), m.group("body")))
    if out:
        return out
    # No strict block — fall back to the natural path+fenced-code-block format.
    for m in _FENCED_FILE_BLOCK.finditer(text or ""):
        out.append((m.group("path").strip(), m.group("body")))
    return out


def _safe_relpath(path: str) -> bool:
    """A change path must stay inside the worktree: relative, no `..` segment,
    not absolute, not a git-internal path."""
    if not path or path.startswith("/") or path.startswith("~"):
        return False
    parts = Path(path).parts
    if ".." in parts or parts[:1] == (".git",):
        return False
    return True


def _git(args, cwd=None, check=True, timeout=120):
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        check=check,
        timeout=timeout,
    )


def create_worktree(repo: Path, base_ref: str, dest: Path) -> Path:
    """Add a detached worktree at base_ref. Detached so we never move a branch."""
    dest = Path(dest)
    if dest.exists():
        remove_worktree(repo, dest)
    _git(["worktree", "add", "--detach", str(dest), base_ref], cwd=repo)
    return dest


def remove_worktree(repo: Path, dest: Path):
    """Remove a worktree (force — it has uncommitted/applied changes) and prune."""
    try:
        _git(["worktree", "remove", "--force", str(dest)], cwd=repo, check=False)
    finally:
        if Path(dest).exists():
            shutil.rmtree(dest, ignore_errors=True)
        _git(["worktree", "prune"], cwd=repo, check=False)


def apply_changes(worktree: Path, changes):
    """Write each full-file change into the worktree. Returns the list of paths
    written. Raises ValueError on an unsafe path (caller treats as apply failure)."""
    written = []
    for path, content in changes:
        if not _safe_relpath(path):
            raise ValueError(f"unsafe change path rejected: {path!r}")
        target = Path(worktree) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        written.append(path)
    return written


def run_check(worktree: Path, check_cmd: str, timeout: int = 300):
    """Run the human-authored doneWhen check inside the worktree. exit 0 = pass.
    Returns (passed, combined_output). Never raises — a crashed/timed-out check
    is a fail, not an exception."""
    try:
        r = subprocess.run(
            check_cmd,
            shell=True,
            cwd=str(worktree),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return r.returncode == 0, (r.stdout + r.stderr)
    except subprocess.TimeoutExpired:
        return False, f"doneWhen check timed out after {timeout}s"
    except Exception as e:  # pragma: no cover - defensive
        return False, f"doneWhen check errored: {e}"


def commit_worktree(worktree: Path, message: str) -> str:
    """Stage everything in the worktree and commit. Returns the commit SHA. This
    commit is landable but NOT yet on main — landing is a separate, gated step."""
    _git(["add", "-A"], cwd=worktree)
    _git(["commit", "-m", message], cwd=worktree)
    return _git(["rev-parse", "HEAD"], cwd=worktree).stdout.strip()


def apply_and_verify(repo, base_ref, taskid, artifact_text, done_when, worktree_root):
    """Orchestrate parse → worktree → apply → run check → commit-in-worktree.

    Does NOT land to main — the caller runs arbiter on the evidence first, then
    lands on approve (commit_sha) or discards (remove_worktree). Returns an
    ApplyResult capturing every stage so the caller and tests can assert on it.
    """
    repo = Path(repo)
    res = ApplyResult()
    res.parsed = parse_artifact(artifact_text)
    if not res.parsed:
        res.error = "no applyable FILE blocks in lane output"
        return res

    slug = re.sub(r"[^a-z0-9]+", "-", str(taskid).lower()).strip("-") or "task"
    dest = Path(worktree_root) / f"v2-{slug}"
    try:
        create_worktree(repo, base_ref, dest)
        res.worktree = str(dest)
        res.files = apply_changes(dest, res.parsed)
        res.applied = True
    except (ValueError, subprocess.CalledProcessError) as e:
        res.error = f"apply failed: {e}"
        if res.worktree:
            remove_worktree(repo, dest)
            res.worktree = ""
        return res

    dtype = (done_when or {}).get("type")
    check_cmd = (done_when or {}).get("check")
    if dtype in {"check", "both"} and check_cmd:
        res.check_ran = True
        res.check_passed, res.check_output = run_check(dest, check_cmd)
        # A red check is terminal for auto-landing: do not produce a commit the
        # caller could mistakenly land. Leave the worktree for inspection/cleanup.
        if not res.check_passed:
            return res
    # acceptance-only (no runnable check): arbiter judges; commit so it's landable.

    # #692: gate the commit on an ACTUAL diff. A lane that reproduced the base
    # byte-for-byte used to fall into `git commit` failing with a misleading
    # "commit failed" — surface it as a typed no-op instead, and never mint an
    # empty "applied lane output" commit. A green check on a no-op means the
    # current tree already satisfies doneWhen (worth saying explicitly).
    if not _git(["status", "--porcelain"], cwd=dest).stdout.strip():
        res.no_change = True
        if res.check_ran and res.check_passed:
            res.error = "no-op: lane output matches base and doneWhen check is already green on the current tree"
        else:
            res.error = "no-op: lane output matches base byte-for-byte — nothing to commit"
        return res

    try:
        res.commit_sha = commit_worktree(dest, f"{taskid}: queue-runner-v2 applied lane output")
    except subprocess.CalledProcessError as e:
        res.error = f"commit failed: {e.stderr.strip() if e.stderr else e}"
    return res


def land_to_main(repo, commit_sha, message, git_lock=None, push=True):
    """Land a verified worktree commit onto main. Merges the worktree commit into
    the live main checkout (no-ff so the task lands as one identifiable merge),
    under git-lock if provided. Returns the merge commit SHA.

    NOTE: caller must have already confirmed check_passed AND arbiter approve.
    This function does not re-check — it is the trusted landing primitive.
    """
    repo = Path(repo)

    def _do():
        _git(["merge", "--no-ff", "-m", message, commit_sha], cwd=repo)
        if push:
            _git(["push", "origin", "main"], cwd=repo, check=False)
        return _git(["rev-parse", "HEAD"], cwd=repo).stdout.strip()

    if git_lock:
        # git_lock is a callable that runs a function under the repo sync lock.
        return git_lock(_do)
    return _do()
