"""Path resolution + IO/lock/git base layer extracted from update-tier1-state.py (#6460 Slice 3).

The lowest layer of the tier-1 state mutator: it locates the repo root (location-independently,
via a marker-walk), derives the state-file paths, and performs all atomic reads/writes, the
tasks-file lock, and git-under-the-sync-lock. Byte-faithful move via scripts/extract-symbols.py;
update-tier1-state.py re-imports these names so every caller is unchanged. Depends only on the
stdlib -- fcntl/tempfile/subprocess/time/shutil are imported locally inside the functions that
use them, so they travel with the code.
"""
from __future__ import annotations

import contextlib  # noqa: F401  (used by moved functions)
import json  # noqa: F401  (used by moved functions)
import os
from pathlib import Path


# Portable repo root: REPO_ROOT (per-invocation/worktree) -> METIS_HOME (canonical)
# -> a marker-walk up from this file for the state dir (or .git). Marker-walk is
# LOCATION-INDEPENDENT: it resolves the same repo root no matter how deep the calling
# module sits (scripts/ or scripts/lib/), which is what lets the IO/paths layer be
# extracted into scripts/lib/ without breaking path resolution (#6460 Slice 3). It is
# also rename- and symlink-proof, surviving removal of any compat symlink.
def _find_repo_root() -> Path:
    env = os.environ.get("REPO_ROOT") or os.environ.get("METIS_HOME")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for cand in (here, *here.parents):
        if (cand / "docs/process/state/tasks.json").exists() or (cand / ".git").exists():
            return cand
    return here.parents[1]  # last-resort: the pre-#6460 behavior


ROOT = _find_repo_root()


TASKS_PATH = ROOT / "docs/process/state/tasks.json"


FOCUS_PATH = ROOT / "docs/process/state/live-focus.json"


AREAS_PATH = ROOT / "docs/process/state/task-areas.json"


PROJECTS_PATH = ROOT / "docs/process/state/projects.json"


TAXONOMY_PATH = ROOT / "docs/process/taxonomy.yaml"


def load_json(path: Path):
    return json.loads(path.read_text())


def dump_json(path: Path, data):
    # ensure_ascii=False preserves raw UTF-8 (en/em dashes, etc.) so governed
    # writes don't churn unrelated lines into \uXXXX escapes in the diff.
    #
    # Atomic write (#511): serialize to a temp file in the SAME directory, fsync,
    # then os.replace onto the target. os.replace is an atomic same-filesystem
    # rename, so a reader (or a mid-write kill) sees either the complete old file
    # or the complete new one — never a torn tasks.json. The same-dir tmp
    # guarantees the rename stays on one filesystem.
    import tempfile
    payload = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


@contextlib.contextmanager
def tasks_lock(path: Path = None):
    """Exclusive inter-process lock over a mutator's load->validate->dump window (#511).

    The four mutators (create_task/update_task/correct_state/dismiss_task) each do
    load -> mutate -> dump. Revision-CAS only guards the SAME task, so two processes
    editing DIFFERENT tasks would both load the file, both mutate their own task, and
    the second dump would silently clobber the first. An flock on a '<file>.lock'
    sidecar serializes the whole window across processes (mirrors agent-work.py
    locked_state + restamp_lease_on_transition). Together with the atomic dump_json,
    concurrent mutations of different tasks both survive and no kill leaves a torn
    file. On a platform without fcntl the lock degrades to a no-op rather than
    crashing (single-writer assumption)."""
    path = path or TASKS_PATH
    lock_path = path.with_suffix(path.suffix + ".lock")
    try:
        import fcntl
    except ImportError:
        yield
        return
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


# --- atomic governed-state commit (clobber-prevention) ------------------------
# A governed mutation written to tasks.json but left UNCOMMITTED can be silently
# lost. The auto-sync daemon (scripts/openclaw-git-sync.sh) has several paths that
# discard uncommitted working-tree changes: the bulk-deletion guard's `git reset`
# (when unrelated churn trips the delete limit), a pre-pull stash whose pop conflicts
# (`git reset --hard HEAD`), and stash pruning. The registered `taskstate` merge
# driver only protects COMMITTED blobs. So we commit the mutation the instant it is
# written, under the SAME mkdir lock the daemon uses — a committed change survives
# every daemon path (it's in HEAD / PRE_PULL_HEAD) and the merge driver unions it
# through any divergent pull. Best-effort: the canonical write already succeeded, so
# any git failure only falls back to (racy) daemon pickup and never fails the mutation.
_LOCK_DIR = Path(os.environ.get("OPENCLAW_LOCK_DIR") or (Path(os.environ.get("HOME", str(Path.home()))) / ".openclaw" / "locks"))  # override: isolate the lock for tests (#452)


_SYNC_LOCK = _LOCK_DIR / "git-sync.lock.d"


def _holder_alive(pid_text):
    if not pid_text.isdigit():
        return False
    try:
        os.kill(int(pid_text), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:  # exists, owned by another user — still alive
        return True
    except OSError:
        return False


def _holder_is_leaked(pid_text):
    """True iff the holder pid is a reclaimable leaked orphan — a bare `sleep`
    reparented to PID 1 after a SIGKILLed lock-holder (#452). Mirrors the bash
    holder_is_leaked() in scripts/lib/git-sync-lock.sh. Conservative: returns False
    unless certain, so a legitimate live holder is never stolen. (macOS launchd is
    PID 1, so the bare-`sleep` command match — not PPID alone — is the safe signal.)"""
    import subprocess
    if not pid_text.isdigit():
        return False
    try:
        out = subprocess.run(
            ["ps", "-o", "ppid=,comm=", "-p", pid_text],
            capture_output=True, text=True,
        ).stdout.strip()
    except OSError:
        return False
    if not out:
        return False  # no such process (dead) — handled by the dead-pid path
    parts = out.split(None, 1)
    if len(parts) != 2:
        return False
    ppid, cmd = parts[0], parts[1].strip()
    if ppid != "1":
        return False  # has a live parent → genuine holder
    base = cmd.rsplit("/", 1)[-1]
    return base == "sleep"


def _acquire_sync_lock(timeout=30):
    """Acquire the daemon's mkdir lock (with stale-holder reclaim). Returns True on
    success, False if it couldn't be taken within `timeout`s — the caller then skips
    the commit and relies on daemon pickup, so task creation never hangs on a wedged
    lock. Mirrors scripts/git-lock.sh / openclaw-git-sync.sh acquire semantics."""
    import random
    import time
    import shutil
    _LOCK_DIR.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    # #6475: jittered exponential backoff (0.25s -> 3s cap, +-50% jitter) instead of a
    # fixed 1s poll, so N sessions closing out together don't retry in lockstep against
    # the daemon's mkdir lock (thundering herd = everyone times out together).
    delay = 0.25
    while True:
        try:
            _SYNC_LOCK.mkdir()
            (_SYNC_LOCK / "pid").write_text(str(os.getpid()))
            return True
        except FileExistsError:
            try:
                holder = (_SYNC_LOCK / "pid").read_text().strip()
            except OSError:
                holder = ""
            if _holder_alive(holder) and not _holder_is_leaked(holder):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                time.sleep(min(remaining, delay * random.uniform(0.5, 1.5)))
                delay = min(delay * 2, 3.0)
                continue
            # dead, unknown, OR a leaked orphan holder (#452) — reclaim and retry.
            # Reclaim by ATOMIC RENAME (audit 2026-10-01 finding 27): a check-then-rmtree let two
            # acquirers that both saw the same dead holder delete each other's fresh lock. Only
            # one rename wins; the loser's rename fails and it simply retries mkdir.
            reclaimed = _SYNC_LOCK.with_name(f"{_SYNC_LOCK.name}.reclaim.{os.getpid()}")
            try:
                os.rename(_SYNC_LOCK, reclaimed)
            except OSError:
                continue  # another acquirer won the reclaim; retry mkdir against their lock
            shutil.rmtree(reclaimed, ignore_errors=True)


def _release_sync_lock():
    import shutil
    shutil.rmtree(_SYNC_LOCK, ignore_errors=True)


def _git(*args):
    import subprocess
    return subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True, text=True)


def _heal_stale_index_lock():
    """Remove .git/index.lock IFF no live process owns it (mirrors git-lock.sh). A
    crashed git leaves this behind and blocks every later git op; a live holder is
    left alone (we retry instead). Returns True if a stale lock was cleared."""
    import subprocess
    r = _git("rev-parse", "--git-dir")
    if r.returncode != 0:
        return False
    lock = (ROOT / r.stdout.strip() / "index.lock") if not os.path.isabs(r.stdout.strip()) \
        else Path(r.stdout.strip()) / "index.lock"
    if not lock.exists():
        return False
    owner = subprocess.run(["lsof", str(lock)], capture_output=True, text=True)
    # lsof prints a header + a row per owning process; no rows => no live owner.
    if owner.returncode == 0 and len(owner.stdout.strip().splitlines()) > 1:
        return False  # a live process owns it — don't steal
    try:
        lock.unlink()
        return True
    except OSError:
        return False


def _git_locked(*args, retries=6):
    """Run a mutating git op, resilient to a concurrent process holding .git/index.lock.
    A different session/hook (which doesn't take our sync lock) can hold index.lock; we
    heal it if stale, else wait and retry. Returns the final CompletedProcess."""
    import time
    r = _git(*args)
    attempt = 0
    while r.returncode != 0 and "index.lock" in (r.stderr or "") and attempt < retries:
        if not _heal_stale_index_lock():
            time.sleep(0.5)  # live holder — let it finish, then retry
        attempt += 1
        r = _git(*args)
    return r
