#!/usr/bin/env python3
"""free-work.py — "what work is open and unclaimed FOR THIS machine right now".

Aggregates four sources into CLAIMED / BLOCKED / FREE / DRIFT / WIP buckets so a
session can pick up high-value work without colliding with another active session,
and without a human being asked each time.

Sources (relative to repo root = parent of this script's dir):
  1. docs/process/state/active-checkouts.json  — leases (CANONICAL)
  2. docs/process/state/tasks.json             — governed task state (CANONICAL, sole FREE source)
  3. <<MACHINE_1_ID>>/state/OPEN_TASKS.md                   — dashboard board (PROJECTION, drift-check only)
  4. `gh issue list` open issues               — GitHub (PROJECTION)

Canonical sources win. As of the #098 task-system unification, tasks.json is the
single source of truth for what's claimable: FREE work is sourced ONLY from it.
OPEN_TASKS.md is no longer a free-work source — it is scanned solely to surface
DRIFT (board items that disagree with, or are missing from, the governed store).

Usage:
  python3 scripts/free-work.py
  python3 scripts/free-work.py --json
  python3 scripts/free-work.py --machine abusa
  FREE_WORK_MACHINE=abusa python3 scripts/free-work.py
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CHECKOUTS = REPO_ROOT / "docs/process/state/active-checkouts.json"
TASKS = REPO_ROOT / "docs/process/state/tasks.json"
OPEN_TASKS = REPO_ROOT / "<<MACHINE_1_ID>>/state/OPEN_TASKS.md"
WORKING_CONTEXT = REPO_ROOT / "<<MACHINE_1_ID>>/memory/working-context.md"

# Project progress layer (#221).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import progress as _progress  # noqa: E402
from lib import infra_config as _infra  # noqa: E402

# Which agent identities "belong to" each machine (for ownership + WIP checks).
# Derived from config/infrastructure.json so the core carries no specific topology.
MACHINE_AGENTS = _infra.machine_agents()
UNOWNED = {"", "either", "unassigned", "none", "anyone"}
PRIORITY_RANK = {"P1": 0, "P2": 1, "P3": 2}


def warn(msg: str) -> None:
    print(f"[free-work] {msg}", file=sys.stderr)


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        warn(f"missing {path.relative_to(REPO_ROOT)} — treating as empty")
    except (json.JSONDecodeError, OSError) as e:
        warn(f"could not read {path.relative_to(REPO_ROOT)}: {e}")
    return None


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(ts: str):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def detect_machine(override: str | None) -> str:
    if override:
        return override.lower()
    env = os.environ.get("FREE_WORK_MACHINE")
    if env:
        return env.lower()
    # Signals, most-specific first. `hostname` alone is ambiguous (both Macs
    # report 'macbookpro'), so prefer scutil LocalHostName + the unix user/home.
    signals = []
    try:
        r = subprocess.run(
            ["scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=5
        )
        if r.returncode == 0:
            signals.append(r.stdout.strip().lower())
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    user = (os.environ.get("USER") or "").lower()
    signals.append(user)
    signals.append(str(Path.home()).lower())
    signals.append(socket.gethostname().lower())
    blob = " ".join(signals)
    if "abusa" in blob or "anthony" in blob:
        return "abusa"
    if "antfox" in blob or user == "ant" or "/users/ant" in blob:
        return "antfox"
    warn(
        f"could not identify machine from {signals!r}; defaulting to 'antfox' (override with --machine)"
    )
    return "antfox"


def prank(p: str) -> int:
    return PRIORITY_RANK.get((p or "P3").upper(), 2)


# ---- source 1: leases ------------------------------------------------------
def filter_live_leases(checkouts: list[dict]) -> list[dict]:
    """Pure: keep only checked-out records whose lease hasn't expired. No IO.

    Importable by agent-work.py's claim-next so it can derive live leases from a
    state dict it is already holding under LOCK_EX, without re-reading the file.
    """
    out = []
    for c in checkouts:
        if str(c.get("status", "")).lower() != "checked-out":
            continue
        exp = parse_iso(c.get("leaseExpiresAt", ""))
        if exp is None or exp <= now_utc():
            continue
        out.append(c)
    return out


def live_leases() -> list[dict]:
    return filter_live_leases((load_json(CHECKOUTS) or {}).get("checkouts", []))


# ---- source 2: tasks.json --------------------------------------------------
def load_tasks() -> list[dict]:
    data = load_json(TASKS) or {}
    return data.get("tasks", [])


# ---- source 3: OPEN_TASKS.md ----------------------------------------------
OPEN_LINE = re.compile(r"^\s*-\s*\[(P[123])\]\s*\[(.)\]\s*\*\*(.+?)\*\*(.*)$")


def parse_open_tasks() -> list[dict]:
    items = []
    try:
        lines = OPEN_TASKS.read_text().splitlines()
    except (FileNotFoundError, OSError):
        warn(f"missing {OPEN_TASKS.name} — treating as empty")
        return items
    for ln in lines:
        m = OPEN_LINE.match(ln)
        if not m:
            continue
        prio, mark, label, rest = m.groups()
        machine = None
        agent = None
        mm = re.search(r"@machine:(\S+)", rest)
        if mm:
            machine = mm.group(1).lower()
        ma = re.search(r"@agent:(\S+)", rest)
        if ma:
            agent = ma.group(1).lower()
        items.append(
            {
                "priority": prio,
                "open": mark == " ",
                "label": label.strip(),
                "machine": machine,
                "agent": agent,
            }
        )
    return items


# ---- source 3b: working-context soft-WIP -----------------------------------
# Markers that an Open-threads line describes work ACTIVELY in flight in another
# session (vs. merely queued / built / done). Kept strict so we never hide a
# genuinely-free task: require an explicit "in flight right now" phrase.
_WIP_MARKER = re.compile(
    r"active session|being (?:edited|built|wired|written|implemented)"
    r"|\bWIP\b|in[- ]progress|editing (?:now|this)",
    re.IGNORECASE,
)
_WIP_ID = re.compile(r"#(\d{3})")
_WIP_LABEL = re.compile(r"\*\*(.+?)\*\*")


def working_context_active() -> dict:
    """Soft-WIP source: tasks working-context.md flags as live in another session.

    free-work's two canonical signals (leases, tasks.json in_progress) miss a session
    that started work WITHOUT formally claiming. working-context.md is the always-current
    forward-state doc (injected every prompt, rewritten each checkpoint/end); its
    "## Open threads" annotations are a reliable-enough soft claim. Returns
    {"ids": set[str], "labels": list[str]} for lines carrying an active-work marker.

    SOFT signal — a crashed session can leave a stale annotation. Callers surface
    matches under CLAIMED (not silently drop) so a human can override if stale.
    """
    ids: set[str] = set()
    labels: list[str] = []
    try:
        lines = WORKING_CONTEXT.read_text().splitlines()
    except OSError:
        return {"ids": ids, "labels": labels}
    in_threads = False
    for ln in lines:
        s = ln.strip()
        if s.startswith("## "):
            in_threads = s.lower().startswith("## open threads")
            continue
        if not in_threads or not s.startswith("-"):
            continue
        if not _WIP_MARKER.search(s):
            continue
        # Pull the id(s) from the leading bold marker (**[#NNN]** / **#NNN slug**)
        # ONLY — never from the whole line, which also mentions related/blocking ids
        # (e.g. "#080 ... (+#081-#086) ... before #017") that are NOT this thread's
        # own task and must stay claimable.
        bolds = _WIP_LABEL.findall(s)
        for b in bolds:
            ids.update(_WIP_ID.findall(b))
            labels.append(b.strip().lower())
    return {"ids": ids, "labels": labels}


# ---- source 4: gh issues ---------------------------------------------------
def load_issues() -> list[dict]:
    try:
        r = subprocess.run(
            [
                "gh",
                "issue",
                "list",
                "--state",
                "open",
                "--json",
                "number,title,labels",
                "--limit",
                "50",
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if r.returncode != 0:
            warn(f"gh issue list failed ({r.returncode}); skipping issues")
            return []
        return json.loads(r.stdout or "[]")
    except FileNotFoundError:
        warn("gh not installed; skipping GitHub issues")
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        warn(f"gh issue list error: {e}; skipping issues")
    return []


def issue_labels(issue: dict) -> set[str]:
    return {l.get("name", "") for l in issue.get("labels", [])}


# ---- auto-reap -------------------------------------------------------------
def auto_reap(path: Path) -> int:
    """Expire checked-out records whose lease has elapsed.

    Uses a non-blocking trylock — if another process holds the lock (e.g. a
    concurrent session running agent-work.py), silently skips the reap and
    continues with a read-only view. Never raises; a reap failure must not
    crash free-work.py.
    """
    try:
        lock_path = path.with_suffix(path.suffix + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                return 0  # another process holds the lock — skip
            now = now_utc()
            data = load_json(path) or {"version": 1, "updatedAt": None, "checkouts": []}
            count = 0
            for r in data.get("checkouts", []):
                if r.get("status") == "checked-out":
                    exp = parse_iso(r.get("leaseExpiresAt", ""))
                    if exp is not None and exp <= now:
                        r["status"] = "expired"
                        r["endedAt"] = now.isoformat().replace("+00:00", "Z")
                        count += 1
            if count:
                data["updatedAt"] = now.isoformat().replace("+00:00", "Z")
                fd, tmp = tempfile.mkstemp(prefix=path.name, dir=str(path.parent))
                with os.fdopen(fd, "w") as f:
                    json.dump(data, f, indent=2, sort_keys=True)
                    f.write("\n")
                os.replace(tmp, path)
            fcntl.flock(lock, fcntl.LOCK_UN)
            return count
    except Exception:
        return 0  # never crash free-work for a reap failure


# ---- aggregation -----------------------------------------------------------
_reconcile_mod = None


def _reconcile():
    """Lazy, cached import of reconcile.py. reconcile imports THIS module at load,
    so importing it at free-work module level would be a cycle; load it on first
    use instead. Loaded by path (hyphen-free sibling) so it works regardless of
    sys.path, matching agent-work.py's _load_free_work() pattern."""
    global _reconcile_mod
    if _reconcile_mod is None:
        import importlib.util as ilu

        path = Path(__file__).resolve().parent / "reconcile.py"
        spec = ilu.spec_from_file_location("reconcile", path)
        mod = ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _reconcile_mod = mod
    return _reconcile_mod


def aggregate(
    leases: list[dict],
    tasks: list[dict],
    opens: list[dict],
    issues: list[dict],
    machine: str,
    wip_context: dict | None = None,
) -> dict:
    """Pure aggregation — no file IO, no locking. Buckets already-loaded sources
    into claimed/blocked/free/drift/wip for `machine`. Safe to call while holding
    LOCK_EX on active-checkouts.json (agent-work.py's claim-next does exactly that
    to select-and-claim atomically).

    `wip_context` (from working_context_active()) is the optional soft-WIP source:
    tasks another session annotated as live but didn't formally lease. Matches move
    FREE -> CLAIMED so neither the human view nor claim-next picks them up. Default
    None preserves the pre-#097 behavior for any caller that doesn't pass it."""
    my_agents = MACHINE_AGENTS.get(machine, {machine})

    wctx = wip_context or {}
    wip_ids = set(wctx.get("ids", []))
    wip_labels = list(wctx.get("labels", []))

    def is_soft_wip(label: str | None, tid: str | None = None) -> bool:
        lab = (label or "").lower()
        cand = set(re.findall(r"#(\d{3})", lab))
        if tid:
            cand.update(re.findall(r"(\d{3})", str(tid)))
        if cand & wip_ids:
            return True
        return any(len(wl) > 6 and (wl in lab or lab in wl) for wl in wip_labels)

    def owner_is_mine(owner: str | None) -> bool:
        o = (owner or "").lower()
        return o in my_agents or o in UNOWNED

    def machine_matches(tag: str | None) -> bool:
        return tag is None or tag in (machine, "either", "any")

    claimed, blocked, free, drift = [], [], [], []

    # Live leases keyed by lowercased title. A task whose title matches a live
    # lease is CLAIMED no matter what tasks.json's state says — the lease is the
    # truth of activity, and state lags it (claim/claim-next do not flip state).
    # Without this, a label-claimed task double-appears (bare lease in CLAIMED +
    # task in FREE: claim-next's claimed_labels guard was the only thing stopping
    # a second session from picking it), and the project board misattributes its
    # claimed count to 'ops' because bare lease records carry no project field.
    # Matched leases get an enriched record (id/project/priority from the task)
    # in the tasks loop; only unmatched leases are appended bare, after it.
    lease_by_title = {
        (c.get("title") or "").lower(): c for c in leases if c.get("title")
    }
    matched_lease_titles: set[str] = set()

    # tasks.json
    task_state_by_id = {t.get("taskId"): t for t in tasks}
    blocked_task_titles = []
    for t in tasks:
        state = (t.get("state") or "").lower()
        blocker = t.get("blockerOrNone")
        is_blocked = blocker not in (None, "none", "None", "")
        rec = {
            "kind": "task",
            "id": t.get("taskId"),
            "priority": t.get("priority", "P3"),
            "label": t.get("title"),
            "owner": t.get("owner"),
            "next": (t.get("nextAction") or "").strip(),
            "project": t.get("project"),
        }
        # Lease match wins over every state-derived bucket: someone is actively
        # on it, so it is neither FREE nor merely blocked/queued.
        lease = lease_by_title.get((t.get("title") or "").lower())
        if lease is not None:
            matched_lease_titles.add((t.get("title") or "").lower())
            claimed.append(
                {
                    **rec,
                    "kind": "lease",
                    "by": lease.get("agent"),
                    "expires": lease.get("leaseExpiresAt"),
                }
            )
            continue
        # Check prerequisites: any prereq not in state=done blocks this task.
        prereqs = t.get("prerequisites", [])
        unmet = [
            f"{pid} ({(task_state_by_id[pid].get('state', '?'))}, {task_state_by_id[pid].get('owner', '?')})"
            for pid in prereqs
            if pid in task_state_by_id and task_state_by_id[pid].get("state", "") != "done"
        ]
        if unmet:
            rec["blocker"] = "blocked-by: " + ", ".join(unmet)
            is_blocked = True
        if state == "in_progress" and not owner_is_mine(t.get("owner")):
            claimed.append({**rec, "kind": "task:in_progress"})
        elif is_blocked:
            rec["blocker"] = rec.get("blocker") or blocker
            blocked.append(rec)
            blocked_task_titles.append((t.get("title") or "").lower())
        elif state == "queued" and owner_is_mine(t.get("owner")):
            if is_soft_wip(t.get("title"), t.get("taskId")):
                claimed.append({**rec, "kind": "soft-wip", "by": "working-context"})
            else:
                free.append(rec)

    # leases -> claimed (bare records for leases with no matching governed task,
    # e.g. ad-hoc labels or GitHub-issue checkouts; matched ones were enriched above)
    for c in leases:
        if (c.get("title") or "").lower() in matched_lease_titles:
            continue
        claimed.append(
            {
                "kind": "lease",
                "priority": "P1",
                "label": c.get("title") or c.get("branch"),
                "by": c.get("agent"),
                "expires": c.get("leaseExpiresAt"),
            }
        )

    # gh issues -> blocked
    for iss in issues:
        if "status:blocked" in issue_labels(iss):
            blocked.append(
                {
                    "kind": "issue",
                    "id": f"#{iss.get('number')}",
                    "priority": "P2",
                    "label": iss.get("title"),
                    "blocker": "status:blocked (GitHub)",
                }
            )

    # OPEN_TASKS.md is a DASHBOARD PROJECTION only — never a FREE-work source (#098).
    # tasks.json (governed) is the single source of truth for claimable work; the
    # tasks loop above already populated FREE. Here we only scan the board to surface
    # DRIFT — and the board↔canonical drift logic now lives in exactly ONE place:
    # reconcile.check_I4 (#131). We pass the machine-matched OPEN items plus this
    # machine's owner test, so the DRIFT bucket stays machine-scoped exactly as
    # before while the rules are owned by the single invariant catalog.
    machine_opens = [it for it in opens if it["open"] and machine_matches(it["machine"])]
    for v in _reconcile().check_I4(machine_opens, tasks, leases, owner_is_mine=owner_is_mine):
        drift.append(v["detail"])

    for bucket in (claimed, blocked, free):
        bucket.sort(key=lambda r: prank(r.get("priority", "P3")))

    # WIP: live leases held by an agent belonging to this machine
    wip = [c for c in leases if str(c.get("agent", "")).lower() in my_agents]

    return {
        "machine": machine,
        "claimed": claimed,
        "blocked": blocked,
        "free": free,
        "drift": drift,
        "wip": wip,
    }


def build(machine: str) -> dict:
    """Load all four sources (with IO + auto-reap) and aggregate them."""
    auto_reap(CHECKOUTS)  # expire stale leases before computing the free list
    return aggregate(
        live_leases(), load_tasks(), parse_open_tasks(), load_issues(), machine,
        working_context_active(),
    )


# ---- rendering -------------------------------------------------------------
def render(b: dict) -> None:
    m = b["machine"]
    print(f"=== CLAIMED (skip) ===")
    if not b["claimed"]:
        print("  (nothing actively claimed)")
    for r in b["claimed"]:
        if r["kind"] == "lease":
            print(f"  [lease] {r['label']} — held by {r['by']} (expires {r['expires']})")
        elif r["kind"] == "soft-wip":
            print(
                f"  [soft-wip] {r.get('priority', '')} {r['label']} — flagged active in working-context (verify if stale)"
            )
        else:
            print(
                f"  [{r.get('id', '?')}] {r['priority']} {r['label']} — in_progress, owner {r.get('owner')}"
            )

    print(f"\n=== BLOCKED (skip) ===")
    if not b["blocked"]:
        print("  (nothing blocked)")
    for r in b["blocked"]:
        print(f"  [{r.get('id', '?')}] {r.get('priority', '')} {r['label']} — {r.get('blocker')}")

    print(f"\n=== FREE FOR {m} ===")
    if not b["free"]:
        print("  (nothing free for this machine — check CLAIMED/BLOCKED/DRIFT)")
    for r in b["free"]:
        tag = f"[{r['id']}] " if r.get("id") else ""
        line = f"  {tag}{r.get('priority', 'P3')} {r['label']}"
        if r.get("next"):
            line += f"\n        next: {r['next'][:140]}"
        print(line)

    print(f"\n=== DRIFT ===")
    if not b["drift"]:
        print("  none")
    for d in b["drift"]:
        print(f"  ⚠ {d}")

    print(f"\n=== WIP ===")
    if b["wip"]:
        print(f"  ⚠ this machine ({m}) already holds {len(b['wip'])} live lease(s):")
        for c in b["wip"]:
            print(f"      {c.get('agent')} — {c.get('title') or c.get('branch')}")
        print("  finish/release before claiming more (WIP=1 recommended).")
    else:
        print(f"  clear — no live leases held by {m}")


# ---- project board ---------------------------------------------------------

def load_projects() -> list[dict]:
    """Load projects.json; return [] if missing."""
    path = REPO_ROOT / "docs/process/state/projects.json"
    if not path.exists():
        return []
    try:
        with open(path) as f:
            return json.load(f).get("projects", [])
    except Exception:
        return []


def load_presence() -> list[dict]:
    """Load live presence records from active-checkouts.json (already reaped)."""
    try:
        data = load_json(CHECKOUTS)
        cutoff = now_utc()
        return [
            p for p in data.get("presence", [])
            if parse_iso(p["expiresAt"]) > cutoff
        ]
    except Exception:
        return []


def build_project_board(agg: dict, projects: list[dict], presence: list[dict]) -> list[dict]:
    """Rank active projects by: status > priority > free-count desc > blocked-ratio asc > slug."""
    STATUS_RANK = {"active": 0, "paused": 1, "blocked": 2, "done": 3}
    PRIO_RANK = {"P1": 0, "P2": 1, "P3": 2}

    # Bucket tasks by project.
    free_by_proj: dict[str, int] = {}
    blocked_by_proj: dict[str, int] = {}
    claimed_by_proj: dict[str, int] = {}
    for item in agg.get("free", []):
        p = item.get("project") or "ops"
        free_by_proj[p] = free_by_proj.get(p, 0) + 1
    for item in agg.get("blocked", []):
        p = item.get("project") or "ops"
        blocked_by_proj[p] = blocked_by_proj.get(p, 0) + 1
    for item in agg.get("claimed", []):
        p = item.get("project") or "ops"
        claimed_by_proj[p] = claimed_by_proj.get(p, 0) + 1

    # Presence roster by project.
    roster_by_proj: dict[str, list[dict]] = {}
    for p in presence:
        proj = p.get("project", "ops")
        roster_by_proj.setdefault(proj, []).append(p)

    rows = []
    for proj in projects:
        slug = proj["slug"]
        status = proj.get("status", "active")
        priority = proj.get("priority", "P3")
        free_n = free_by_proj.get(slug, 0)
        blocked_n = blocked_by_proj.get(slug, 0)
        claimed_n = claimed_by_proj.get(slug, 0)
        total_nondone = free_n + blocked_n + claimed_n
        blocked_ratio = (blocked_n / total_nondone) if total_nondone else 0.0
        roster = roster_by_proj.get(slug, [])
        prog, shipped, total = _progress.project_progress(proj)
        cur = _progress.current_milestone(proj)
        rows.append({
            "slug": slug,
            "name": proj.get("name", slug),
            "status": status,
            "priority": priority,
            "free": free_n,
            "blocked": blocked_n,
            "claimed": claimed_n,
            "blockedRatio": round(blocked_ratio, 2),
            "roster": roster,
            "progress": round(prog, 3) if prog is not None else None,
            "shipped": shipped,
            "milestones": total,
            "attention": round(_progress.attention_score(proj), 3),
            "bucket": _progress.classify(proj),
            "current": ({"id": cur.get("id"), "title": cur.get("title"),
                         "status": cur.get("status"), "blocker": (cur.get("taskIds") or [None])[0]}
                        if cur else None),
            "_sort": (
                STATUS_RANK.get(status, 9),
                PRIO_RANK.get(priority, 9),
                -free_n,
                blocked_ratio,
                slug,
            ),
        })

    rows.sort(key=lambda r: r["_sort"])
    for r in rows:
        del r["_sort"]
    return rows


def render_project_board(rows: list[dict], machine: str, projects: list[dict]) -> None:
    """Outcome-based board (#221): goal roll-up + progress bars, ranked by attention."""
    print(f"=== PROJECT BOARD for {machine} ===\n")

    # Goal roll-up (priority-weighted, excludes evergreen/paused).
    goals = sorted({p.get("goal") for p in projects if p.get("goal")})
    if goals:
        print("GOALS (priority-weighted roll-up)")
        for g in goals:
            gp = _progress.goal_rollup(projects, g)
            if gp is None:
                print(f"  {g}  {'—' * 10}        (no seeded active projects)")
            else:
                print(f"  {g}  {_progress.bar(gp)} {gp * 100:4.0f}%")
        print()

    def fmt(r: dict) -> str:
        pct = f"{r['progress'] * 100:3.0f}%" if r["progress"] is not None else " — "
        ship = f"{r['shipped']}/{r['milestones']} shipped" if r["milestones"] else "no milestones"
        cur = r.get("current") or {}
        curtxt = f"  → {cur.get('id', '')}: {cur.get('title', '')}" if cur else ""
        hint = ""
        if r["free"] or r["blocked"]:
            hint = f"  [{r['free']}f/{r['blocked']}b]"
        stalled = ""
        return f"  {r['priority']} {r['slug']:<20} {_progress.bar(r['progress'])} {pct}  {ship}{curtxt}{hint}{stalled}"

    decision = [r for r in rows if r["bucket"] == "decision"]
    active = sorted([r for r in rows if r["bucket"] in ("attention", "moving")],
                    key=lambda r: -r["attention"])
    paused = [r for r in rows if r["bucket"] == "paused"]
    evergreen = [r for r in rows if r["bucket"] == "evergreen"]
    done = [r for r in rows if r["bucket"] == "done"]

    if decision:
        print("NEEDS YOUR DECISION (blocked — needs an unblock, not work)")
        for r in decision:
            cur = r.get("current") or {}
            blk = cur.get("blocker")
            print(fmt(r) + (f"   blocked on {blk}" if blk else ""))
        print()
    if active:
        print("ACTIVE — ranked by attention (priority × distance-from-done × staleness)")
        for r in active:
            print(fmt(r))
        print()
    if done:
        print("COMPLETE: " + ", ".join(r["slug"] for r in done) + "\n")
    tail = []
    if paused:
        tail.append(f"paused: {', '.join(r['slug'] for r in paused)}")
    if evergreen:
        tail.append(f"evergreen: {', '.join(r['slug'] for r in evergreen)}")
    if tail:
        print("  ·  ".join(tail))
    print("\nUse --project <slug> for tasks · /project-status <slug> for milestones · --flat for classic list")


def render_project_status(slug: str, projects: list[dict]) -> int:
    """Per-project milestone table (#221) — backs the /project-status skill."""
    proj = next((p for p in projects if p["slug"] == slug), None)
    if not proj:
        print(f"No project '{slug}' in projects.json")
        return 1
    prog, shipped, total = _progress.project_progress(proj)
    print(f"=== {proj.get('name', slug)} ({slug}) ===")
    print(f"Goal {proj.get('goal', '?')} · {proj.get('priority', '?')} · status {proj.get('status', '?')}")
    print(f"doneWhen: {proj.get('doneWhen', '—')}")
    if prog is None:
        print("\n(no milestones — evergreen or unseeded)")
        return 0
    print(f"\nprogress {_progress.bar(prog)} {prog * 100:.0f}%  ·  {shipped}/{total} shipped")
    print()
    sym = {"done": "✅", "active": "🟦", "blocked": "⛔", "todo": "⬜"}
    for m in proj.get("milestones", []):
        st = m.get("status", "todo")
        fill = m.get("fill", 0) or 0
        filltxt = f" ({int(fill * 100)}%)" if st in ("active", "blocked") and fill else ""
        tasks = m.get("taskIds") or []
        tasktxt = f"  [{', '.join(tasks)}]" if tasks else ""
        print(f"  {sym.get(st, '?')} {m.get('id', ''):<3} w{m.get('weight', 1)} {m.get('title', '')}{filltxt}{tasktxt}")
        print(f"        doneWhen: {m.get('doneWhen', '')}")
    return 0


def render_project_tasks(agg: dict, slug: str) -> None:
    """Show CLAIMED/BLOCKED/FREE tasks for a single project."""
    print(f"=== PROJECT: {slug} ===\n")

    claimed = [r for r in agg.get("claimed", []) if r.get("project") == slug]
    blocked = [r for r in agg.get("blocked", []) if r.get("project") == slug]
    free = [r for r in agg.get("free", []) if r.get("project") == slug]

    if claimed:
        print(f"CLAIMED ({len(claimed)})")
        for r in claimed:
            print(f"  [{r.get('id', '?')}] {r.get('priority', '')} {r['label']} — {r.get('by', r.get('owner', '?'))}")
    if blocked:
        print(f"\nBLOCKED ({len(blocked)})")
        for r in blocked:
            print(f"  [{r.get('id', '?')}] {r.get('priority', '')} {r['label']} — {r.get('blocker', '')[:80]}")
    if free:
        print(f"\nFREE ({len(free)})")
        for r in free:
            tag = f"[{r['id']}] " if r.get("id") else ""
            line = f"  {tag}{r.get('priority', 'P3')} {r['label']}"
            if r.get("next"):
                line += f"\n        next: {r['next'][:120]}"
            print(line)
    if not (claimed or blocked or free):
        print("  (no tasks in this project)")


def main() -> int:
    ap = argparse.ArgumentParser(description="Show open, unclaimed work for this machine.")
    ap.add_argument("--json", action="store_true", help="emit buckets as JSON")
    ap.add_argument("--machine", help="override detected machine (antfox/abusa)")
    ap.add_argument("--project", metavar="SLUG",
                    help="show tasks for a specific project (CLAIMED/BLOCKED/FREE)")
    ap.add_argument("--project-status", metavar="SLUG",
                    help="show milestone status + progress for a specific project (#221)")
    ap.add_argument("--flat", action="store_true",
                    help="flat task list view (classic behavior, pre-project-board)")
    args = ap.parse_args()

    machine = detect_machine(args.machine)
    b = build(machine)

    if args.json:
        projects = load_projects()
        presence = load_presence()
        board = build_project_board(b, projects, presence)
        out = dict(b)
        out["projects"] = board
        print(json.dumps(out, indent=2, default=str))
        return 0

    if args.project_status:
        return render_project_status(args.project_status, load_projects())

    if args.project:
        render_project_tasks(b, args.project)
        return 0

    if args.flat:
        render(b)
        return 0

    # Default: project board
    projects = load_projects()
    presence = load_presence()
    board = build_project_board(b, projects, presence)
    if board:
        render_project_board(board, machine, projects)
    else:
        # Fall back to flat view if no projects.json
        render(b)
    return 0


if __name__ == "__main__":
    sys.exit(main())
