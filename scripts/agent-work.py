#!/usr/bin/env python3
"""Agent checkout coordinator for Metis OS.

GitHub Issues are the cross-machine source of truth when gh is authenticated;
docs/process/state/active-checkouts.json is the local/offline lease cache.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any

# Portable repo root: REPO_ROOT (per-invocation/worktree, e.g. a vendored subtree)
# -> METIS_HOME (canonical) -> file location. Without this, a subtree copy (navore-ops/
# metis-core) writes leases + the task counter back under the framework dir instead of
# the host repo (#451; same doctrine as render-tier1-state.py + free-claims.py).
ROOT = Path(os.environ.get("REPO_ROOT") or os.environ.get("METIS_HOME") or Path(__file__).resolve().parents[1])
DEFAULT_STATE = ROOT / "docs/process/state/active-checkouts.json"
DEFAULT_WORKTREES = ROOT.parent / f"{ROOT.name}-worktrees"  # self-adjusts to repo dir name
DEFAULT_LEASE_HOURS = 4
TERMINAL = {"done", "released", "blocked", "expired", "stolen"}
AUTOSYNC_PLIST = Path.home() / "Library/LaunchAgents/ant.openclaw-git-sync.plist"
TASK_COUNTER = ROOT / "docs/process/state/task-counter.json"
NAMING_DOC = ROOT / "docs/process/task-naming-convention.md"


def utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def parse_time(value: str) -> dt.datetime:
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return dt.datetime.fromisoformat(value).astimezone(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def slugify(text: str, max_len: int = 48) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", text.strip().lower()).strip("-")
    return (slug or "task")[:max_len].strip("-") or "task"


def run(cmd: list[str], cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess[str]:
    p = subprocess.run(cmd, cwd=str(cwd), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode != 0:
        raise SystemExit(f"command failed: {' '.join(cmd)}\n{p.stderr.strip() or p.stdout.strip()}")
    return p


def git(*args: str, cwd: Path = ROOT, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["git", *args], cwd=cwd, check=check)


def gh_available() -> bool:
    if not shutil.which("gh"):
        return False
    return run(["gh", "auth", "status"], check=False).returncode == 0


def repo_slug() -> str | None:
    p = git("config", "--get", "remote.origin.url", check=False)
    url = p.stdout.strip()
    if not url:
        return None
    m = re.search(r"github.com[:/](.+?)(?:\.git)?$", url)
    return m.group(1) if m else None


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "updatedAt": None, "checkouts": []}
    with path.open() as f:
        raw = f.read().strip()
    if not raw:
        return {"version": 1, "updatedAt": None, "checkouts": []}
    data = json.loads(raw)
    data.setdefault("version", 1)
    data.setdefault("checkouts", [])
    # fenceCounter: a monotonic, never-decreasing token source. Each lease grant
    # (checkout / steal) mints the next value; writers present it and the resource
    # rejects any token below the current max (Kleppmann fencing token). Backfill
    # from existing records so the counter never regresses on an old state file.
    existing_max = max((int(r.get("fenceToken", 0)) for r in data["checkouts"]), default=0)
    data["fenceCounter"] = max(int(data.get("fenceCounter", 0)), existing_max)
    return data


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data["updatedAt"] = iso(utcnow())
    fd, tmp = tempfile.mkstemp(prefix=path.name, dir=str(path.parent))
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
    os.replace(tmp, path)


@contextmanager
def locked_state(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = load_json(path)
        yield data
        save_json(path, data)
        fcntl.flock(lock, fcntl.LOCK_UN)


def stderr(msg: str) -> None:
    print(msg, file=sys.stderr)


def next_fence(data: dict[str, Any]) -> int:
    """Mint the next monotonic fence token and persist the bumped counter."""
    data["fenceCounter"] = int(data.get("fenceCounter", 0)) + 1
    return data["fenceCounter"]


def max_token_for(data: dict[str, Any], issue: int) -> int:
    return max((int(r.get("fenceToken", 0)) for r in find_records(data, issue)), default=0)


def active(record: dict[str, Any], now: dt.datetime) -> bool:
    status = record.get("status")
    if status in TERMINAL:
        return False
    try:
        return parse_time(record["leaseExpiresAt"]) > now
    except Exception:
        return False


def find_records(data: dict[str, Any], issue: int) -> list[dict[str, Any]]:
    def issue_of(r: dict[str, Any]) -> int:
        try:
            return int(r.get("issue"))
        except (TypeError, ValueError):
            return -1

    return [r for r in data["checkouts"] if issue_of(r) == issue]


# #331: mutual exclusion is keyed on the canonical taskId, not the literal claim
# string. Claiming '#229' and 'intraday-deep-history-trades-backfill' used to mint
# two live leases on the same task (reconcile FAIL I2, 2026-06-12) because the
# uniqueness check compared raw titles. Same id pattern as reconcile.py.
_TASK_ID_RE = re.compile(r"(?:#|\bissue[- ])0*(\d{2,})", re.IGNORECASE)


def _tasks_list() -> list[dict[str, Any]]:
    """Best-effort read of the governed task store, for claim-id resolution."""
    try:
        raw = json.loads((ROOT / "docs/process/state/tasks.json").read_text())
        return raw.get("tasks", [])
    except Exception:
        return []


def resolve_task_id(
    label: str | None, tasks: list[dict[str, Any]] | None = None
) -> str | None:
    """Resolve a claim label to its canonical taskId (e.g. '#331').

    Id-form labels ('#229 ...', 'issue-229') resolve directly (canonicalized to
    the store's spelling when the task exists, zero-padded otherwise). Bare
    labels resolve by exact title match against tasks.json. Returns None for
    ad-hoc labels with no id and no governed match — those keep the legacy
    exact-label dedup.
    """
    if not label:
        return None
    if tasks is None:
        tasks = _tasks_list()
    m = _TASK_ID_RE.search(label)
    if m:
        n = int(m.group(1))
        for t in tasks:
            tm = re.fullmatch(r"#0*(\d+)", t.get("taskId") or "")
            if tm and int(tm.group(1)) == n:
                return t["taskId"]
        return f"#{n:03d}"
    norm = label.strip().lower()
    for t in tasks:
        if (t.get("title") or "").strip().lower() == norm:
            return t.get("taskId")
    return None


def lease_task_id(
    rec: dict[str, Any], tasks: list[dict[str, Any]] | None = None
) -> str | None:
    """Canonical taskId a lease record holds.

    Prefers the stored taskId field (written by claim/claim-next/checkout since
    #331); falls back to the issue number, then to resolving the title — so
    pre-#331 records participate in the uniqueness check too.
    """
    if rec.get("taskId"):
        return resolve_task_id(str(rec["taskId"]), tasks)
    if rec.get("issue") is not None:
        return resolve_task_id(f"#{rec['issue']}", tasks)
    return resolve_task_id(rec.get("title") or "", tasks)


def current_branch() -> str:
    return git("branch", "--show-current").stdout.strip()


def dirty(cwd: Path = ROOT) -> bool:
    return bool(git("status", "--porcelain", cwd=cwd).stdout.strip())


def ensure_git_repo() -> None:
    if git("rev-parse", "--is-inside-work-tree", check=False).stdout.strip() != "true":
        raise SystemExit("not inside a git worktree")


def gh_issue_title(issue: int) -> str | None:
    if not gh_available():
        return None
    p = run(["gh", "issue", "view", str(issue), "--json", "title", "--jq", ".title"], check=False)
    return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None


def gh_comment(issue: int, body: str) -> None:
    if not gh_available():
        return
    run(["gh", "issue", "comment", str(issue), "--body", body], check=False)


def gh_labels(issue: int, add: list[str] = [], remove: list[str] = []) -> None:
    if not gh_available():
        return
    for label in remove:
        run(["gh", "issue", "edit", str(issue), "--remove-label", label], check=False)
    if add:
        run(["gh", "issue", "edit", str(issue), "--add-label", ",".join(add)], check=False)


def create_branch_or_worktree(
    branch: str, worktree: Path | None, allow_dirty: bool, no_git: bool = False
) -> Path:
    if no_git:
        return worktree or ROOT
    if worktree:
        if worktree.exists() and any(worktree.iterdir()):
            raise SystemExit(f"worktree path exists and is not empty: {worktree}")
        worktree.parent.mkdir(parents=True, exist_ok=True)
        git("worktree", "add", "-b", branch, str(worktree), "HEAD")
        return worktree
    if dirty() and not allow_dirty:
        raise SystemExit(
            "refusing in-place checkout on dirty tree; use --worktree or --allow-dirty"
        )
    git("checkout", "-b", branch)
    return ROOT


def cmd_checkout(args: argparse.Namespace) -> None:
    ensure_git_repo()
    now = utcnow()
    title = args.title or gh_issue_title(args.issue) or f"issue-{args.issue}"
    branch = args.branch or f"agent-{slugify(args.agent, 18)}-{args.issue}-{slugify(title)}"
    worktree = None
    if args.no_git:
        pass  # no-git skips all worktree/branch creation regardless of auto_worktree
    elif args.worktree:
        worktree = Path(args.worktree).expanduser().resolve()
    elif args.auto_worktree:
        worktree = (
            DEFAULT_WORKTREES / f"{args.issue}-{slugify(args.agent, 14)}-{slugify(title, 30)}"
        ).resolve()
    expires = now + dt.timedelta(hours=args.hours)

    with locked_state(args.state) as data:
        actives = [r for r in find_records(data, args.issue) if active(r, now)]
        # #331: a label-based claim resolving to this task is the same lease —
        # include it so checkout can't mint a second live lease on the task.
        tasks = _tasks_list()
        issue_tid = resolve_task_id(f"#{args.issue}", tasks)
        seen_ids = {id(r) for r in actives}
        if issue_tid is not None:
            actives += [
                r
                for r in data["checkouts"]
                if id(r) not in seen_ids
                and active(r, now)
                and lease_task_id(r, tasks) == issue_tid
            ]
        if actives and not args.steal:
            r = actives[-1]
            held = r.get("branch") or r.get("title") or r.get("claimId")
            raise SystemExit(
                f"issue #{args.issue} already checked out by {r.get('agent')} until {r.get('leaseExpiresAt')} on {held}"
            )
        if actives and args.steal:
            for r in actives:
                r["status"] = "stolen"
                r["endedAt"] = iso(now)
                r["stolenBy"] = args.agent

        checkout_path = create_branch_or_worktree(branch, worktree, args.allow_dirty, args.no_git)
        token = next_fence(
            data
        )  # a steal mints a strictly-higher token than the lease it supersedes
        rec = {
            "issue": args.issue,
            "taskId": issue_tid,
            "title": title,
            "agent": args.agent,
            "session": args.session,
            "status": "checked-out",
            "branch": branch,
            "worktree": str(checkout_path),
            "repo": repo_slug(),
            "fenceToken": token,
            "leaseStartedAt": iso(now),
            "leaseExpiresAt": iso(expires),
            "lastRenewedAt": iso(now),
            "baseSha": git(
                "rev-parse", "HEAD", cwd=(ROOT if args.no_git else checkout_path)
            ).stdout.strip(),
        }
        data["checkouts"].append(rec)

    gh_labels(
        args.issue,
        add=["status:checked-out", f"agent:{args.agent}"],
        remove=["status:ready", "status:blocked"],
    )
    gh_comment(
        args.issue,
        f"Checked out by `{args.agent}`.\n\nBranch: `{branch}`\nWorktree: `{checkout_path}`\nFence token: `{token}`\nLease expires: `{iso(expires)}`",
    )
    print(
        f"checked out #{args.issue} -> {branch}\npath: {checkout_path}\nfence token: {token}\nlease: {iso(expires)}"
    )
    print(
        f"  (pass --fence-token {token} on renew/block/release/finish to prove you still hold this lease)"
    )


def cmd_status(args: argparse.Namespace) -> None:
    now = utcnow()
    data = load_json(args.state)
    rows = data.get("checkouts", [])
    if args.issue:
        rows = [r for r in rows if int(r.get("issue", -1)) == args.issue]
    if args.active_only:
        rows = [r for r in rows if active(r, now)]
    elif not getattr(args, "all", False):
        # Default: hide terminal records (released/done/expired/blocked/stolen)
        # so released-but-not-yet-expired leases don't appear as if still held.
        # Pass --all to see the full history.
        rows = [r for r in rows if r.get("status") not in TERMINAL]
    if args.json:
        print(json.dumps({"now": iso(now), "checkouts": rows}, indent=2, sort_keys=True))
        return
    if not rows:
        print("no checkouts")
        return
    for r in rows:
        state = "active" if active(r, now) else "inactive"
        tok = r.get("fenceToken")
        tok_s = f" token={tok}" if tok is not None else ""
        # Resolve the lease's identity: issue-based claims carry `issue`,
        # label-based `claim "<label>"` carry the task in `title` with issue=None.
        # Reading only `issue` rendered the latter as "#None" (the #130 drift).
        ident = f"#{r['issue']}" if r.get("issue") is not None else (r.get("title") or "?")
        claim_s = f" claim={r['claimId']}" if r.get("claimId") else ""
        branch = r.get("branch") or "-"
        print(
            f"{ident} [{state}/{r.get('status')}]{tok_s}{claim_s} {r.get('agent')} {branch} expires={r.get('leaseExpiresAt')} path={r.get('worktree')}"
        )


def mutate_issue(args: argparse.Namespace, status: str) -> None:
    now = utcnow()
    changed = False
    with locked_state(args.state) as data:
        all_recs = find_records(data, args.issue)
        max_token = max((int(x.get("fenceToken", 0)) for x in all_recs), default=0)
        ft = getattr(args, "fence_token", None)

        if ft is not None:
            # Strict fencing: the resource (this state file, read under lock) is the
            # authority. A token below the current max means a newer lease superseded
            # this one — reject the write regardless of what the caller believes.
            ft = int(ft)
            if ft < max_token:
                raise SystemExit(
                    f"FENCED OUT: issue #{args.issue} fence token {ft} is stale "
                    f"(current is {max_token}). Your lease was superseded — refusing to write."
                )
            target = [x for x in all_recs if int(x.get("fenceToken", -1)) == ft]
            if not target:
                raise SystemExit(f"no checkout for issue #{args.issue} with fence token {ft}")
            r = target[-1]
            if r.get("status") in TERMINAL:
                raise SystemExit(
                    f"FENCED OUT: your lease (token {ft}) on issue #{args.issue} is "
                    f"already '{r.get('status')}' — refusing to write."
                )
        else:
            # Legacy path. Still fence on branch: if the caller names its branch and
            # that exact lease has gone terminal (reaped/stolen), do NOT silently
            # retarget the current holder's record — that is the stale-writer bug.
            records = [x for x in all_recs if x.get("status") not in TERMINAL]
            if args.branch:
                terminal_match = [
                    x
                    for x in all_recs
                    if x.get("branch") == args.branch and x.get("status") in TERMINAL
                ]
                records = [x for x in records if x.get("branch") == args.branch]
                if not records and terminal_match:
                    raise SystemExit(
                        f"FENCED OUT: your lease on '{args.branch}' (issue #{args.issue}) is "
                        f"'{terminal_match[-1].get('status')}'; a newer holder may exist "
                        f"(current fence token {max_token}). Refusing to write."
                    )
            if not records:
                raise SystemExit(f"no open checkout for issue #{args.issue}")
            r = records[-1]
            if int(r.get("fenceToken", 0)) and int(r.get("fenceToken", 0)) < max_token:
                stderr(
                    f"[agent-work] WARNING: mutating #{args.issue} record (token "
                    f"{r.get('fenceToken')}) but a higher token {max_token} exists. "
                    f"Pass --fence-token to write safely."
                )
        if status == "checked-out":
            r["leaseExpiresAt"] = iso(now + dt.timedelta(hours=args.hours))
            r["lastRenewedAt"] = iso(now)
        else:
            r["status"] = status
            r["endedAt"] = iso(now)
            if args.note:
                r["note"] = args.note
        changed = True
    if not changed:
        return
    if status == "checked-out":
        gh_comment(
            args.issue, f"Lease renewed until `{iso(now + dt.timedelta(hours=args.hours))}`."
        )
        print(f"renewed #{args.issue} until {iso(now + dt.timedelta(hours=args.hours))}")
    elif status == "blocked":
        gh_labels(args.issue, add=["status:blocked"], remove=["status:checked-out", "status:ready"])
        gh_comment(args.issue, f"Blocked: {args.note or 'no note'}")
        print(f"blocked #{args.issue}: {args.note or ''}")
    elif status == "released":
        gh_labels(args.issue, add=["status:ready"], remove=["status:checked-out"])
        gh_comment(args.issue, f"Released by agent. {args.note or ''}".strip())
        print(f"released #{args.issue}")
    elif status == "done":
        gh_labels(
            args.issue,
            add=["status:in-review"],
            remove=["status:checked-out", "status:ready", "status:blocked"],
        )
        print(f"marked done locally for #{args.issue}; push/open PR separately if needed")


def cmd_fence(args: argparse.Namespace) -> None:
    """Read-only fence check. A waking session calls this BEFORE writing to learn
    whether its token is still current (exit 0) or has been fenced out (exit 1)."""
    data = load_json(args.state)
    counter = int(data.get("fenceCounter", 0))
    if args.issue is None:
        print(f"fenceCounter={counter}")
        return
    mx = max_token_for(data, args.issue)
    if args.token is not None:
        if int(args.token) < mx:
            print(f"FENCED OUT: token {args.token} < current {mx} for issue #{args.issue}")
            raise SystemExit(1)
        print(f"OK: token {args.token} is current (max {mx}) for issue #{args.issue}")
        return
    print(f"issue #{args.issue}: max fence token = {mx} (counter {counter})")


def _load_projects() -> dict:
    """Load projects.json; return empty registry on missing file."""
    path = ROOT / "docs/process/state/projects.json"
    if not path.exists():
        return {"projects": []}
    with open(path) as f:
        return json.load(f)


def _valid_project_slugs() -> set[str]:
    return {p["slug"] for p in _load_projects().get("projects", [])}


def _live_presence(data: dict[str, Any], now: dt.datetime) -> list[dict[str, Any]]:
    """Return presence records that have not yet expired."""
    return [
        p for p in data.get("presence", [])
        if parse_time(p["expiresAt"]) > now
    ]


def cmd_join(args: argparse.Namespace) -> None:
    """Join a project workspace (informational presence; never blocks any claim)."""
    fw = _load_free_work()
    machine = fw.detect_machine(None)

    valid = _valid_project_slugs()
    if valid and args.project not in valid:
        raise SystemExit(
            f"unknown project slug '{args.project}'\n"
            f"valid slugs: {', '.join(sorted(valid))}"
        )

    now = utcnow()
    expires = now + dt.timedelta(hours=args.hours)

    with locked_state(args.state) as data:
        if "presence" not in data:
            data["presence"] = []

        # Update existing record for this session, or create new one.
        for p in data["presence"]:
            if p.get("session") == args.session:
                p["project"] = args.project
                p["lastSeen"] = iso(now)
                p["expiresAt"] = iso(expires)
                p["agent"] = args.agent
                p["machine"] = machine
                roster = [
                    q for q in data["presence"]
                    if q.get("project") == args.project and parse_time(q["expiresAt"]) > now
                ]
                break
        else:
            data["presence"].append({
                "session": args.session,
                "agent": args.agent,
                "machine": machine,
                "project": args.project,
                "since": iso(now),
                "lastSeen": iso(now),
                "expiresAt": iso(expires),
            })
            roster = [
                p for p in data["presence"]
                if p.get("project") == args.project and parse_time(p["expiresAt"]) > now
            ]

    print(f"joined project '{args.project}' (presence TTL {args.hours}h)")
    if roster:
        print(f"current roster ({len(roster)}):")
        for p in roster:
            print(f"  {p.get('agent','?')} on {p.get('machine','?')} since {p.get('since','?')[:16]}")


def cmd_leave(args: argparse.Namespace) -> None:
    """Leave the current project workspace (remove presence record)."""
    now = utcnow()
    removed = []

    with locked_state(args.state) as data:
        if "presence" not in data:
            print("no presence records found")
            return
        before = data["presence"]
        data["presence"] = [
            p for p in before
            if not (p.get("session") == args.session and (
                args.project is None or p.get("project") == args.project
            ))
        ]
        removed = [p for p in before if p not in data["presence"]]

    if removed:
        for p in removed:
            print(f"left project '{p.get('project','?')}'")
    else:
        print("no matching presence record found for this session")


def cmd_reap(args: argparse.Namespace) -> None:
    now = utcnow()
    expired_count = 0
    pruned_count = 0
    presence_reaped = 0
    cutoff = now - dt.timedelta(days=args.older_than) if args.prune_terminal else None
    with locked_state(args.state) as data:
        for r in data["checkouts"]:
            if r.get("status") == "checked-out" and not active(r, now):
                r["status"] = "expired"
                r["endedAt"] = iso(now)
                expired_count += 1
        if cutoff is not None:
            before = len(data["checkouts"])
            data["checkouts"] = [
                r
                for r in data["checkouts"]
                if not (
                    r.get("status") in TERMINAL
                    and parse_time(r.get("endedAt") or r.get("leaseStartedAt") or iso(now)) < cutoff
                )
            ]
            pruned_count = before - len(data["checkouts"])
        # Reap expired presence records.
        if "presence" in data:
            before_p = len(data["presence"])
            data["presence"] = [
                p for p in data["presence"]
                if parse_time(p["expiresAt"]) > now
            ]
            presence_reaped = before_p - len(data["presence"])
    parts = [f"expired {expired_count} stale checkout(s)"]
    if presence_reaped:
        parts.append(f"reaped {presence_reaped} expired presence record(s)")
    if cutoff is not None:
        parts.append(f"pruned {pruned_count} terminal record(s) older than {args.older_than}d")
    print(", ".join(parts))


def cmd_claim(args: argparse.Namespace) -> None:
    """Lightweight local-only lease for tasks without a GitHub issue number.

    Creates a record in active-checkouts.json with a short claim-id so
    free-work.py can cross-reference it and remove the task from the FREE list.
    Use 'unclaim <claim-id>' to release when done.
    """
    now = utcnow()
    expires = now + dt.timedelta(hours=args.hours)
    label_l = args.label.lower()
    # #331: resolve to the canonical taskId BEFORE taking the lock and key the
    # uniqueness check on it — '#229' and the task's bare title are the same claim.
    tasks = _tasks_list()
    task_id = resolve_task_id(args.label, tasks)

    with locked_state(args.state) as data:
        for r in data["checkouts"]:
            if not active(r, now):
                continue
            same_label = (
                r.get("issue") is None and (r.get("title") or "").lower() == label_l
            )
            same_task = task_id is not None and lease_task_id(r, tasks) == task_id
            if same_label or same_task:
                held = r.get("title") or f"#{r.get('issue')}"
                what = f"'{args.label}'" if same_label else f"task {task_id} ('{held}')"
                raise SystemExit(
                    f"{what} already claimed by {r.get('agent')} "
                    f"until {r.get('leaseExpiresAt')}\n"
                    f"claim-id: {r.get('claimId', '?')}"
                )
        claim_id = str(uuid.uuid4())[:8]
        token = next_fence(data)
        rec = {
            "issue": None,
            "claimId": claim_id,
            "taskId": task_id,
            "title": args.label,
            "agent": args.agent,
            "session": args.session,
            "status": "checked-out",
            "branch": None,
            "worktree": str(ROOT),
            "repo": repo_slug(),
            "fenceToken": token,
            "leaseStartedAt": iso(now),
            "leaseExpiresAt": iso(expires),
            "lastRenewedAt": iso(now),
            "baseSha": git("rev-parse", "HEAD", check=False).stdout.strip(),
        }
        data["checkouts"].append(rec)

    print(
        f"claimed '{args.label}'\n"
        f"claim-id: {claim_id}\n"
        f"fence token: {token}\n"
        f"lease: {iso(expires)}\n"
        f"  (release with: python3 scripts/agent-work.py unclaim {claim_id})"
    )


def _auto_checkpoint_on_close(title: str) -> None:
    """Fire auto-checkpoint-on-close.sh for a just-unclaimed task if it is done.

    Reads task state from tasks.json; skips silently if the task is not in a
    terminal done/needs_verification state (e.g. a temporary release).
    """
    tasks_path = ROOT / "docs/process/state/tasks.json"
    try:
        tasks_data = json.loads(tasks_path.read_text())
    except Exception:
        return
    task = next(
        (t for t in tasks_data.get("tasks", []) if t.get("title") == title), None
    )
    if not task:
        return
    if task.get("state") not in ("done", "needs_verification"):
        return
    task_id = task.get("taskId", "")
    summary = task.get("summary", "")
    script = ROOT / "scripts/auto-checkpoint-on-close.sh"
    if not script.exists():
        return
    subprocess.run(
        ["/bin/bash", str(script), task_id, title, summary],
        cwd=ROOT,
        check=False,
    )


def cmd_unclaim(args: argparse.Namespace) -> None:
    """Release a label-based claim by its claim-id."""
    now = utcnow()
    title = ""
    with locked_state(args.state) as data:
        matches = [
            r
            for r in data["checkouts"]
            if r.get("claimId") == args.claim_id and r.get("status") not in TERMINAL
        ]
        if not matches:
            raise SystemExit(f"no active claim with id '{args.claim_id}'")
        r = matches[-1]
        r["status"] = "released"
        r["endedAt"] = iso(now)
        if args.note:
            r["note"] = args.note
        label = r.get("title", args.claim_id)
        title = label
    print(f"released claim '{label}' ({args.claim_id})")
    if not getattr(args, "no_checkpoint", False):
        _auto_checkpoint_on_close(title)


def default_session() -> str:
    """Best stable per-session id available, for the per-session WIP guard.

    Provider-neutral: any driver (Claude Code, Codex, OpenClaw lanes, a future tool)
    gets its own one-task-at-a-time budget so parallel sessions don't block each other.
    Resolution order, highest precedence first:
      AGENT_SESSION_ID    — neutral override any wrapper/driver can export
      CLAUDE_CODE_SESSION_ID — Claude Code (unique per terminal)
      CODEX_SESSION_ID    — Codex CLI
      OPENCLAW_SESSION    — OpenClaw lanes
      "manual"            — unknown; disables the per-session guard (the lock still
                            protects correctness, but two such sessions can each hold a task)
    Kept in sync with sessionIdResolution in docs/process/platform-registry.json."""
    return (
        os.environ.get("AGENT_SESSION_ID")
        or os.environ.get("CLAUDE_CODE_SESSION_ID")
        or os.environ.get("CODEX_SESSION_ID")
        or os.environ.get("OPENCLAW_SESSION")
        or "manual"
    )


def _load_free_work():
    """Lazy import of free-work.py. The filename is hyphenated so it cannot be a
    normal `import`; load it by path. Done inside the command (not at module top)
    so every other agent-work invocation stays cheap."""
    import importlib.util

    fw_path = Path(__file__).resolve().parent / "free-work.py"
    spec = importlib.util.spec_from_file_location("free_work", fw_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _lane_registry() -> dict[str, list[str]]:
    """Parse `lane.sh --registry` — the SINGLE SOURCE for the terminal goal-lane ->
    projects boundary (#325). Returns {} if the script is missing/unrunnable so lane
    filtering degrades to the global list instead of blocking a claim."""
    reg: dict[str, list[str]] = {}
    try:
        out = subprocess.run(
            ["/bin/bash", str(ROOT / "scripts" / "lane.sh"), "--registry"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        for line in out.splitlines():
            name, _, projs = line.partition("\t")
            if name.strip():
                reg[name.strip()] = projs.split()
    except Exception:
        pass
    return reg


def _resolve_lane_filter(args: argparse.Namespace, explicit_project: str | None) -> tuple[set[str] | None, str | None]:
    """Lane -> project-set filter for claim-next (#325). Precedence: an explicit
    --project wins outright; then --lane; then the METIS_LANE env a goal-lane
    terminal exports. hub (empty project list) means no filter. Returns
    (project_set | None, lane_name | None)."""
    if explicit_project:
        return None, None
    explicit_lane = getattr(args, "lane", None)
    lane = explicit_lane or os.environ.get("METIS_LANE")
    if not lane:
        return None, None
    projs = _lane_registry().get(lane)
    if projs is None:
        # Unknown lane: hard error only when the user typed it; a stale/foreign
        # METIS_LANE env should not block claiming.
        if explicit_lane:
            raise SystemExit(f"unknown lane '{lane}' — see: scripts/lane.sh --registry")
        return None, None
    if not projs:  # hub
        return None, lane
    return set(projs), lane


def cmd_claim_next(args: argparse.Namespace) -> None:
    """Atomically pick the highest-priority FREE task for this machine and claim it.

    The whole select-and-claim runs inside one LOCK_EX on active-checkouts.json, so
    two concurrent `claim-next` calls can never grab the same task: the loser reads
    the winner's fresh claim under the lock and skips to the next free item. This is
    the collision-free replacement for "free-work (read) -> suggest -> claim (write)",
    which had a time-of-check/time-of-use gap when several sessions ran it at once.

    --project <slug>  restricts candidates to tasks in that project. If omitted and the
    session has a live presence record, its project is used as the default. Bare
    claim-next (no project, no presence) falls back to the global ranked free list.
    """
    fw = _load_free_work()
    machine = fw.detect_machine(getattr(args, "machine", None))

    # Resolve project filter: explicit flag > lane (--lane/METIS_LANE) > live
    # presence > None (global).
    project_filter = getattr(args, "project", None)
    lane_set, lane_name = _resolve_lane_filter(args, project_filter)

    # Dry-run: read-only. Deliberately NOT under locked_state — that contextmanager
    # rewrites updatedAt on exit, and a preview must not mutate the state file.
    if args.dry_run:
        # For dry-run, check presence from the live state without locking.
        if not project_filter and not lane_name:
            try:
                raw = load_json(args.state)
                now_p = utcnow()
                live_p = _live_presence(raw, now_p)
                mine_p = [p for p in live_p if p.get("session") == args.session]
                if mine_p:
                    project_filter = mine_p[-1]["project"]
            except Exception:
                pass
        free = fw.build(machine).get("free", [])
        if project_filter:
            free = [it for it in free if it.get("project") == project_filter]
            if not free:
                print(f"no free work in project '{project_filter}' for {machine}")
                return
            print(f"claim-next would pick (top {min(5, len(free))} in '{project_filter}' for {machine}):")
        elif lane_set:
            free = [it for it in free if it.get("project") in lane_set]
            if not free:
                print(f"no free work in lane '{lane_name}' for {machine}")
                return
            print(f"claim-next would pick (top {min(5, len(free))} in lane '{lane_name}' for {machine}):")
        else:
            if not free:
                print(f"no free work for {machine}")
                return
            print(f"claim-next would pick (top {min(5, len(free))} for {machine}):")
        for it in free[:5]:
            tag = f"[{it['id']}] " if it.get("id") else ""
            print(f"  {tag}{it.get('priority', 'P3')} {it['label']}")
        return

    now = utcnow()
    expires = now + dt.timedelta(hours=args.hours)

    picked = claim_id = token = None
    with locked_state(args.state) as data:
        live = fw.filter_live_leases(data["checkouts"])

        # Resolve project filter under the lock (presence may have changed since dry-run).
        # Lane filter outranks presence: a goal-lane terminal stays in its lane.
        pf = project_filter
        if not pf and not lane_set and args.session and args.session != "manual":
            live_p = _live_presence(data, now)
            mine_p = [p for p in live_p if p.get("session") == args.session]
            if mine_p:
                pf = mine_p[-1]["project"]

        # WIP guard: one task per *session*, not per agent. Multiple Claude Code
        # terminals all claim as `claude`, so an agent-keyed guard would wrongly block
        # the 2nd terminal from picking up work — exactly the multi-session flow this
        # command exists to enable. Key on the session id instead (distinct per
        # terminal via CLAUDE_CODE_SESSION_ID). Skip when the session is unknown
        # ("manual"): we then can't tell sessions apart, and the atomic select+claim
        # under this lock still guarantees two concurrent calls get different tasks.
        if not args.allow_multi and args.session and args.session != "manual":
            mine = [c for c in live if c.get("session") == args.session]
            if mine:
                titles = ", ".join(c.get("title") or c.get("branch") or "?" for c in mine)
                raise SystemExit(
                    f"this session already holds {len(mine)} live lease(s): {titles}\n"
                    f"finish/unclaim first, or pass --allow-multi to claim another."
                )

        # Rank in-memory against the leases we hold under the lock. tasks.json and
        # OPEN_TASKS.md are separate read-only files, so reading them here is safe;
        # gh issues are skipped ([]) since they never appear in the FREE bucket.
        # working_context_active() adds the soft-WIP filter (#097) so claim-next won't
        # auto-claim a task another session annotated as live without a formal lease.
        tasks_list = fw.load_tasks()
        agg = fw.aggregate(
            live, tasks_list, fw.parse_open_tasks(), [], machine,
            fw.working_context_active(),
        )
        claimed_labels = {
            (r.get("title") or "").lower() for r in data["checkouts"] if active(r, now)
        }
        # #331: also dedup on resolved taskId so a candidate isn't claimable while a
        # differently-spelled lease (id-string vs bare title vs issue) holds the task.
        claimed_ids = {
            lease_task_id(r, tasks_list)
            for r in data["checkouts"]
            if active(r, now)
        } - {None}

        # Apply project filter if set (--project or presence-derived), else lane filter.
        candidates = agg["free"]
        if pf:
            candidates = [c for c in candidates if c.get("project") == pf]
        elif lane_set:
            candidates = [c for c in candidates if c.get("project") in lane_set]

        # Pick the highest-priority free task that passes the ready check.
        # task-ready.sh: exit 0=ready, 1=blocked/not-ready, 2=maybe-done.
        # We skip exit-1 tasks (blocked prereqs / service down) and warn on exit-2
        # (maybe already done). --skip-ready-check bypasses for scripted callers.
        _skip_ready = getattr(args, "skip_ready_check", False)
        picked = None
        for candidate in candidates:
            if (candidate.get("label") or "").lower() in claimed_labels:
                continue
            cand_tid = resolve_task_id(
                candidate.get("id") or candidate.get("label") or "", tasks_list
            )
            if cand_tid is not None and cand_tid in claimed_ids:
                continue
            if not _skip_ready:
                try:
                    r = subprocess.run(
                        ["bash", str(ROOT / "scripts" / "task-ready.sh"), candidate["label"]],
                        capture_output=True, timeout=20,
                    )
                    if r.returncode == 1:
                        # Blocked or prereq unmet — try next candidate
                        msg = r.stdout.decode().strip().split("\n")[-1]
                        print(f"  skip '{candidate['label']}': {msg}", file=sys.stderr)
                        continue
                    if r.returncode == 2:
                        # Maybe already done — claim it but surface the warning
                        print(f"  warn: '{candidate['label']}' may already be done — confirm before re-working", file=sys.stderr)
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    pass  # ready check unavailable — proceed anyway
            picked = candidate
            break

        if picked is None:
            if pf:
                print(f"no free work in project '{pf}' for {machine}")
            elif lane_set:
                print(f"no free work in lane '{lane_name}' for {machine}")
            else:
                print(f"no free work for {machine}")
            return

        claim_id = str(uuid.uuid4())[:8]
        token = next_fence(data)
        data["checkouts"].append(
            {
                "issue": None,
                "claimId": claim_id,
                "taskId": resolve_task_id(
                    picked.get("id") or picked.get("label") or "", tasks_list
                ),
                "title": picked["label"],
                "agent": args.agent,
                "session": args.session,
                "status": "checked-out",
                "branch": None,
                "worktree": str(ROOT),
                "repo": repo_slug(),
                "fenceToken": token,
                "leaseStartedAt": iso(now),
                "leaseExpiresAt": iso(expires),
                "lastRenewedAt": iso(now),
                "baseSha": git("rev-parse", "HEAD", check=False).stdout.strip(),
            }
        )

        # Refresh lastSeen on any live presence for this session (heartbeat on claim).
        for p in data.get("presence", []):
            if p.get("session") == args.session and parse_time(p["expiresAt"]) > now:
                p["lastSeen"] = iso(now)

    if args.json:
        print(
            json.dumps(
                {
                    "claimId": claim_id,
                    "title": picked["label"],
                    "priority": picked.get("priority"),
                    "fenceToken": token,
                    "agent": args.agent,
                    "leaseExpiresAt": iso(expires),
                },
                indent=2,
            )
        )
    else:
        print(
            f"claim-next -> '{picked['label']}' ({picked.get('priority', 'P3')})\n"
            f"claim-id: {claim_id}\n"
            f"fence token: {token}\n"
            f"lease: {iso(expires)}\n"
            f"  (release with: python3 scripts/agent-work.py unclaim {claim_id})"
        )


def cmd_extend_lease(args: argparse.Namespace) -> None:
    """Extend active claim(s) without shrinking the expiry."""
    now = utcnow()
    new_expiry = now + dt.timedelta(hours=args.hours)

    def _matches(r: dict[str, Any]) -> bool:
        if r.get("status") in TERMINAL:
            return False
        if args.claim_id and r.get("claimId") == args.claim_id:
            return True
        return bool(args.all and r.get("agent") == args.agent)

    # Churn guard (#262): the lease heartbeat calls this every ~3 min, but each extension is
    # +30 min — so re-writing every tick only re-stamps timestamps (save_json always sets a fresh
    # updatedAt) and produces an [auto-sync] commit for nothing (active-checkouts.json was 90% of
    # daily auto-sync commits). With --if-within, do a READ-ONLY pre-check and skip the write
    # entirely unless some matching lease is actually within MINUTES of expiry. Cross-machine safe:
    # the threshold (e.g. 15m) sits well under the +30m extension and above the ~3m heartbeat
    # interval, so a held lease never drains low enough for another machine to read it as expired.
    if args.if_within is not None:
        threshold = now + dt.timedelta(minutes=args.if_within)
        snapshot = load_json(args.state)
        near = [r for r in snapshot.get("checkouts", [])
                if _matches(r) and parse_time(r["leaseExpiresAt"]) <= threshold]
        if not near:
            print(f"all matching leases fresh (none within {args.if_within:g}m of expiry) — no write")
            return

    extended = []
    with locked_state(args.state) as data:
        for r in data["checkouts"]:
            if not _matches(r):
                continue
            current = parse_time(r["leaseExpiresAt"])
            r["leaseExpiresAt"] = iso(max(current, new_expiry))
            r["lastRenewedAt"] = iso(now)
            extended.append((r.get("claimId") or f"#{r.get('issue')}", r["leaseExpiresAt"]))

    if not extended:
        print("no active claims found to extend")
        return
    for cid, exp in extended:
        print(f"extended claim {cid} -> {exp}")



def doctor_line(level: str, name: str, detail: str) -> None:
    print(f"{level.upper():4} {name} — {detail}")


def cmd_doctor(args: argparse.Namespace) -> None:
    """Check local prerequisites without claiming a task."""
    failures = 0
    warnings = 0

    def ok(name: str, detail: str) -> None:
        doctor_line("ok", name, detail)

    def warn(name: str, detail: str) -> None:
        nonlocal warnings
        warnings += 1
        doctor_line("warn", name, detail)

    def fail(name: str, detail: str) -> None:
        nonlocal failures
        failures += 1
        doctor_line("fail", name, detail)

    print("agent-work doctor")
    print(f"repo: {ROOT}")
    print(f"state: {args.state}")

    if shutil.which("git"):
        ok("git", run(["git", "--version"], check=False).stdout.strip())
    else:
        fail("git", "not found in PATH")
        raise SystemExit(1)

    if git("rev-parse", "--is-inside-work-tree", check=False).stdout.strip() == "true":
        ok("git repo", "inside worktree")
    else:
        fail("git repo", "not inside a git worktree")
        raise SystemExit(1)

    branch = current_branch() or "detached"
    ok("branch", branch)
    head = git("rev-parse", "--short", "HEAD", check=False)
    if head.returncode == 0:
        ok("HEAD", head.stdout.strip())
    else:
        fail("HEAD", head.stderr.strip() or head.stdout.strip())

    if dirty():
        warn("working tree", "dirty; prefer --auto-worktree for new tasks")
    else:
        ok("working tree", "clean")

    origin = git("config", "--get", "remote.origin.url", check=False).stdout.strip()
    if origin:
        ok("origin", origin)
    else:
        warn("origin", "remote.origin.url not configured")

    probe_ref = f"refs/agent-doctor/{os.getpid()}"
    p = git("update-ref", probe_ref, "HEAD", check=False)
    if p.returncode == 0:
        git("update-ref", "-d", probe_ref, check=False)
        ok("git ref write", f"created/deleted {probe_ref}")
    else:
        fail("git ref write", p.stderr.strip() or p.stdout.strip() or "update-ref failed")

    state = args.state.expanduser().resolve()
    try:
        data = load_json(state)
        if isinstance(data.get("checkouts"), list):
            ok("state parse", f"{len(data.get('checkouts', []))} checkout record(s)")
        else:
            fail("state parse", "checkouts is not a list")
    except Exception as e:
        fail("state parse", str(e))

    try:
        state.parent.mkdir(parents=True, exist_ok=True)
        lock_path = state.with_suffix(state.suffix + ".lock")
        with lock_path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            fcntl.flock(lock, fcntl.LOCK_UN)
        ok("state lock", str(lock_path))
    except Exception as e:
        fail("state lock", str(e))

    try:
        fd, tmp = tempfile.mkstemp(prefix=".doctor-", dir=str(state.parent))
        os.close(fd)
        os.unlink(tmp)
        ok("state dir write", str(state.parent))
    except Exception as e:
        fail("state dir write", str(e))

    worktree_root = (
        Path(args.worktree_root).expanduser().resolve()
        if args.worktree_root
        else DEFAULT_WORKTREES.resolve()
    )
    try:
        worktree_root.mkdir(parents=True, exist_ok=True)
        test_dir = Path(tempfile.mkdtemp(prefix=".doctor-", dir=str(worktree_root)))
        test_dir.rmdir()
        ok("worktree root write", str(worktree_root))
    except Exception as e:
        fail("worktree root write", str(e))

    if args.worktree_test:
        wt = worktree_root / f".doctor-worktree-{os.getpid()}"
        br = f"agent-doctor-{os.getpid()}"
        try:
            if wt.exists():
                raise RuntimeError(f"test path already exists: {wt}")
            p = git("worktree", "add", "-b", br, str(wt), "HEAD", check=False)
            if p.returncode != 0:
                raise RuntimeError(
                    p.stderr.strip() or p.stdout.strip() or "git worktree add failed"
                )
            current = git("branch", "--show-current", cwd=wt, check=False).stdout.strip()
            if current != br:
                raise RuntimeError(f"expected branch {br}, got {current}")
            ok("real worktree", f"created {wt} on {br}")
        except Exception as e:
            fail("real worktree", str(e))
        finally:
            git("worktree", "remove", str(wt), "--force", check=False)
            git("branch", "-D", br, check=False)

    if shutil.which("gh"):
        p = run(["gh", "auth", "status"], check=False)
        if p.returncode == 0:
            first = (
                (p.stdout or p.stderr).strip().splitlines()[0]
                if (p.stdout or p.stderr).strip()
                else "authenticated"
            )
            ok("gh auth", first)
        else:
            warn("gh auth", "not authenticated; GitHub labels/comments/PRs will be skipped")
    else:
        warn("gh", "not found; local leases still work")

    if not args.skip_network and origin:
        p = git("ls-remote", "--heads", "origin", "main", check=False)
        if p.returncode == 0:
            ok("origin reach", "origin/main reachable")
        else:
            warn("origin reach", p.stderr.strip() or p.stdout.strip() or "ls-remote failed")

    if failures:
        print(f"doctor failed: {failures} failure(s), {warnings} warning(s)")
        raise SystemExit(1)
    print(f"doctor passed: {warnings} warning(s)")


def pause_autosync() -> bool:
    if not AUTOSYNC_PLIST.exists():
        return False
    subprocess.run(["launchctl", "unload", str(AUTOSYNC_PLIST)], check=False)
    return True


def resume_autosync(was_paused: bool) -> None:
    if was_paused:
        subprocess.run(["launchctl", "load", str(AUTOSYNC_PLIST)], check=False)


def cmd_finish(args: argparse.Namespace) -> None:
    if getattr(args, "merge", False) and getattr(args, "revert", False):
        raise SystemExit("--merge and --revert are mutually exclusive")

    # Resolve branch before mutating state — current_branch() reads CWD which may be the main
    # repo (branch=main), not the worktree where the work happened.
    if args.branch:
        resolved_branch = args.branch
    else:
        data = load_json(args.state)
        records = [r for r in find_records(data, args.issue) if r.get("status") not in TERMINAL]
        resolved_branch = records[-1]["branch"] if records else current_branch()

    if getattr(args, "revert", False):
        paused = pause_autosync()
        try:
            git("checkout", "main")
            tags = git("tag", "--sort=-creatordate").stdout.strip().splitlines()
            target = next(
                (t for t in tags if t.startswith("claude-config-") or t.startswith("milestone-")),
                None,
            )
            if not target:
                recent = ", ".join(tags[:5]) or "(none)"
                raise SystemExit(
                    f"no claude-config-* or milestone-* tag found; recent tags: {recent}"
                )
            git("reset", "--hard", target)
            git("push", "--force-with-lease", "origin", "main")
            print(f"reverted main to {target} and force-pushed")
        finally:
            resume_autosync(paused)
        return

    if getattr(args, "merge", False):
        paused = pause_autosync()
        try:
            git("fetch", "origin")
            if current_branch() != "main":
                git("checkout", "main")
            merge = git("merge", "--ff-only", resolved_branch, check=False)
            if merge.returncode != 0:
                merge = git("merge", "--no-ff", resolved_branch, check=False)
                if merge.returncode != 0:
                    raise SystemExit(
                        f"merge failed:\n{merge.stderr.strip() or merge.stdout.strip()}"
                    )
                print(f"merged {resolved_branch} -> main (no fast-forward)")
            else:
                print(f"fast-forwarded main to {resolved_branch}")
            git("push", "origin", "main")
            print("pushed main -> origin")
            mutate_issue(args, "done")
        finally:
            resume_autosync(paused)
        return

    mutate_issue(args, "done")
    if args.push:
        git("push", "-u", "origin", resolved_branch)
        print(f"pushed {resolved_branch} -> origin")
    if args.pr:
        if not gh_available():
            raise SystemExit("gh is not authenticated; cannot create PR")
        title = args.title or f"Agent task #{args.issue}"
        body = args.body or f"Closes #{args.issue}\n\nCreated by agent-work."
        result = run(
            [
                "gh",
                "pr",
                "create",
                "--draft",
                "--base",
                args.base,
                "--head",
                resolved_branch,
                "--title",
                title,
                "--body",
                body,
            ]
        )
        pr_url = result.stdout.strip()
        if pr_url:
            print(f"PR: {pr_url}")


@contextmanager
def locked_file(path: Path):
    """Exclusive flock around an arbitrary file (not the checkout-state schema)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _counter_from_json() -> int:
    if not TASK_COUNTER.exists():
        return 0
    try:
        return int(json.loads(TASK_COUNTER.read_text() or "{}").get("lastAssigned", 0))
    except Exception:
        return 0


def _counter_from_doc() -> int:
    if not NAMING_DOC.exists():
        return 0
    m = re.search(r"Last assigned:\s*#(\d+)", NAMING_DOC.read_text())
    return int(m.group(1)) if m else 0


def _current_counter() -> int:
    # Canonical source is the JSON, but never regress below the human-readable
    # markdown counter — a hand-edit (or an older state file) must not hand out a
    # previously-used id. Same anti-regression rule as the fence counter.
    return max(_counter_from_json(), _counter_from_doc())


def _persist_counter(value: int) -> None:
    TASK_COUNTER.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="task-counter", dir=str(TASK_COUNTER.parent))
    with os.fdopen(fd, "w") as f:
        json.dump({"lastAssigned": value, "updatedAt": iso(utcnow())}, f, indent=2)
        f.write("\n")
    os.replace(tmp, TASK_COUNTER)
    # Mirror the new value into the naming doc so the human-readable counter stays
    # in sync (display only; the JSON above is canonical).
    if NAMING_DOC.exists():
        text = NAMING_DOC.read_text()
        new_text = re.sub(r"(Last assigned: #)\d+", rf"\g<1>{value:03d}", text)
        new_text = re.sub(r"(Next available: #)\d+", rf"\g<1>{value + 1:03d}", new_text)
        if new_text != text:
            NAMING_DOC.write_text(new_text)


def cmd_alloc_id(args: argparse.Namespace) -> None:
    """Atomically allocate the next #NNN task id under an exclusive lock."""
    with locked_file(TASK_COUNTER):
        current = _current_counter()
        if args.peek:
            print(f"{current + 1:03d}")
            return
        count = max(1, args.count)
        _persist_counter(current + count)
        for i in range(1, count + 1):
            print(f"{current + i:03d}")


def cmd_reconcile(args: argparse.Namespace) -> None:
    """Read-only invariant catalog (I1-I8) over canonical state. Thin CLI front
    door onto scripts/reconcile.py's evaluate() so callers (close-integrity,
    /start, ad-hoc) have ONE entry point instead of importing the hyphen-named
    module by path themselves. Exit 1 iff a fail-severity invariant is violated;
    warns never fail the gate."""
    import importlib.util

    rec_path = Path(__file__).resolve().parent / "reconcile.py"
    spec = importlib.util.spec_from_file_location("reconcile", rec_path)
    reconcile = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reconcile)

    result = reconcile.evaluate()
    if args.json:
        print(json.dumps(result, indent=2))
        raise SystemExit(0 if result["ok"] else 1)

    fails = [v for v in result["violations"] if v["severity"] == "fail"]
    warns = [v for v in result["violations"] if v["severity"] == "warn"]
    for v in result["violations"]:
        tag = "FAIL" if v["severity"] == "fail" else "WARN"
        print(f"{tag} {v['id']} — {v['detail']}")
    print(f"{len(fails)} fail, {len(warns)} warn")
    raise SystemExit(1 if fails else 0)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Coordinate agent checkouts with local leases and optional GitHub Issues."
    )
    p.add_argument("--state", type=Path, default=DEFAULT_STATE)
    sub = p.add_subparsers(dest="cmd", required=True)

    co = sub.add_parser("checkout")
    co.add_argument("issue", type=int)
    co.add_argument("--agent", required=True)
    co.add_argument("--session", default=default_session())
    co.add_argument("--title")
    co.add_argument("--branch")
    co.add_argument("--hours", type=float, default=DEFAULT_LEASE_HOURS)
    co.add_argument("--worktree")
    co.add_argument(
        "--auto-worktree",
        action="store_true",
        default=True,
        help="create isolated worktree (default on; prevents auto-sync collision)",
    )
    co.add_argument(
        "--in-place",
        dest="auto_worktree",
        action="store_false",
        help="opt out of auto-worktree; work directly in main tree (use with caution)",
    )
    co.add_argument("--allow-dirty", action="store_true")
    co.add_argument("--steal", action="store_true", help="take over an active lease explicitly")
    co.add_argument(
        "--no-git",
        action="store_true",
        help="record lease only; do not create branch/worktree (tests/recovery only)",
    )
    co.set_defaults(func=cmd_checkout)

    st = sub.add_parser("status")
    st.add_argument("--issue", type=int)
    st.add_argument("--active-only", action="store_true")
    st.add_argument("--all", action="store_true", help="show terminal records too (released/done/expired)")
    st.add_argument("--json", action="store_true")
    st.set_defaults(func=cmd_status)

    rn = sub.add_parser("renew")
    rn.add_argument("issue", type=int)
    rn.add_argument("--hours", type=float, default=DEFAULT_LEASE_HOURS)
    rn.add_argument("--branch")
    rn.add_argument(
        "--fence-token",
        type=int,
        help="prove you still hold the lease; rejected if a newer lease exists",
    )
    rn.add_argument("--note")
    rn.set_defaults(func=lambda a: mutate_issue(a, "checked-out"))

    bl = sub.add_parser("block")
    bl.add_argument("issue", type=int)
    bl.add_argument("note", nargs="?")
    bl.add_argument("--branch")
    bl.add_argument(
        "--fence-token",
        type=int,
        help="prove you still hold the lease; rejected if a newer lease exists",
    )
    bl.set_defaults(func=lambda a: mutate_issue(a, "blocked"))

    rel = sub.add_parser("release")
    rel.add_argument("issue", type=int)
    rel.add_argument("--note")
    rel.add_argument("--branch")
    rel.add_argument(
        "--fence-token",
        type=int,
        help="prove you still hold the lease; rejected if a newer lease exists",
    )
    rel.set_defaults(func=lambda a: mutate_issue(a, "released"))

    rp = sub.add_parser("reap")
    rp.add_argument(
        "--prune-terminal",
        action="store_true",
        help="also remove terminal records (expired/released/done/stolen) older than --older-than days",
    )
    rp.add_argument(
        "--older-than",
        type=int,
        default=7,
        metavar="DAYS",
        help="age threshold for --prune-terminal (default: 7 days)",
    )
    rp.set_defaults(func=cmd_reap)

    cl = sub.add_parser(
        "claim", help="lightweight local lease for tasks without a GitHub issue number"
    )
    cl.add_argument(
        "label", help="task label / title (matched against OPEN_TASKS free list by free-work.py)"
    )
    cl.add_argument("--agent", required=True)
    cl.add_argument("--session", default=default_session())
    cl.add_argument("--hours", type=float, default=DEFAULT_LEASE_HOURS)
    cl.set_defaults(func=cmd_claim)

    uc = sub.add_parser("unclaim", help="release a label-based claim by its claim-id")
    uc.add_argument("claim_id", metavar="CLAIM_ID")
    uc.add_argument("--note")
    uc.add_argument(
        "--no-checkpoint",
        action="store_true",
        default=False,
        help="skip the auto-checkpoint commit after release",
    )
    uc.set_defaults(func=cmd_unclaim)

    cn = sub.add_parser(
        "claim-next",
        help="atomically claim the top free task for this machine (collision-free pickup)",
    )
    cn.add_argument("--agent", required=True)
    cn.add_argument("--session", default=default_session())
    cn.add_argument("--hours", type=float, default=DEFAULT_LEASE_HOURS)
    cn.add_argument("--machine", help="override detected machine (<<MACHINE_1_ID>>/<<MACHINE_2_USER>>)")
    cn.add_argument("--project", metavar="SLUG",
                    help="restrict candidates to this project (default: presence-derived or global)")
    cn.add_argument("--lane", metavar="LANE",
                    help="restrict to a terminal goal-lane's projects (g1-workforce..g6-life; "
                         "default: $METIS_LANE when set by lane.sh; hub = no filter)")
    cn.add_argument(
        "--dry-run", action="store_true", help="show top candidates, claim nothing"
    )
    cn.add_argument("--json", action="store_true", help="emit the claim record as JSON")
    cn.add_argument("--skip-ready-check", action="store_true", dest="skip_ready_check",
                    help="skip task-ready.sh gate (for scripted/automated callers)")
    cn.add_argument(
        "--allow-multi",
        action="store_true",
        help="claim even if this machine already holds a live lease",
    )
    cn.set_defaults(func=cmd_claim_next)

    jn = sub.add_parser(
        "join",
        help="join a project workspace (informational presence; never blocks any claim)",
    )
    jn.add_argument("project", metavar="SLUG", help="project slug to join (see projects.json)")
    jn.add_argument("--agent", required=True)
    jn.add_argument("--session", default=default_session())
    jn.add_argument("--hours", type=float, default=DEFAULT_LEASE_HOURS,
                    help="presence TTL in hours (default: 4h; refreshed on each claim)")
    jn.set_defaults(func=cmd_join)

    lv = sub.add_parser(
        "leave",
        help="leave the current project workspace (remove presence record)",
    )
    lv.add_argument("project", nargs="?", metavar="SLUG",
                    help="project to leave (default: all projects for this session)")
    lv.add_argument("--session", default=default_session())
    lv.set_defaults(func=cmd_leave)

    ai = sub.add_parser(
        "alloc-id", help="atomically allocate the next #NNN task id (race-free)"
    )
    ai.add_argument("--peek", action="store_true", help="print the next id without allocating it")
    ai.add_argument("--count", type=int, default=1, help="reserve a contiguous block of N ids")
    ai.set_defaults(func=cmd_alloc_id)

    fc = sub.add_parser("fence", help="inspect/verify fence tokens (read-only)")
    fc.add_argument("--issue", type=int)
    fc.add_argument(
        "--token", type=int, help="check this token against the current max; exit 1 if stale"
    )
    fc.set_defaults(func=cmd_fence)

    rc = sub.add_parser(
        "reconcile", help="run the invariant catalog (I1-I8) over canonical state (read-only)"
    )
    rc.add_argument("--json", action="store_true", help="emit JSON {violations, ok}")
    rc.set_defaults(func=cmd_reconcile)

    dc = sub.add_parser("doctor")
    dc.add_argument("--worktree-root")
    dc.add_argument(
        "--worktree-test",
        action="store_true",
        help="create and remove a real temporary git worktree/branch",
    )
    dc.add_argument("--skip-network", action="store_true", help="skip origin reachability check")
    dc.set_defaults(func=cmd_doctor)

    fn = sub.add_parser("finish")
    fn.add_argument("issue", type=int)
    fn.add_argument("--branch")
    fn.add_argument(
        "--fence-token",
        type=int,
        help="prove you still hold the lease; rejected if a newer lease exists",
    )
    fn.add_argument("--note")
    fn.add_argument("--push", action="store_true")
    fn.add_argument("--pr", action="store_true")
    fn.add_argument("--base", default="main")
    fn.add_argument("--title")
    fn.add_argument("--body")
    fn.add_argument(
        "--merge",
        action="store_true",
        help="pause autosync, FF-or-merge branch onto main, push main, release lease",
    )
    fn.add_argument(
        "--revert",
        action="store_true",
        help="pause autosync, reset main to last claude-config-*/milestone-* tag, force-push",
    )
    fn.set_defaults(func=cmd_finish)

    el = sub.add_parser("extend-lease", help="extend active claim(s) without shrinking expiry")
    el.add_argument("claim_id", nargs="?", metavar="CLAIM_ID", help="specific claim to extend")
    el.add_argument("--all", action="store_true", help="extend all active claims for --agent")
    el.add_argument("--agent", default="claude", help="agent name for --all mode (default: claude)")
    el.add_argument("--hours", type=float, default=0.5, help="extend by this many hours (default: 0.5)")
    el.add_argument("--if-within", type=float, default=None, metavar="MINUTES",
                    help="only extend (and write) if a matching lease expires within MINUTES; "
                         "otherwise no-op without touching state (#262 heartbeat churn guard)")
    el.set_defaults(func=cmd_extend_lease)

    return p


def main() -> None:
    argv = sys.argv[1:]
    state_override = None
    if "--state" in argv:
        i = argv.index("--state")
        try:
            state_override = Path(argv[i + 1])
        except IndexError:
            raise SystemExit("--state requires a path")
        del argv[i : i + 2]
    args = build_parser().parse_args(argv)
    if state_override is not None:
        args.state = state_override
    args.func(args)


if __name__ == "__main__":
    main()
