#!/usr/bin/env python3
"""reconcile.py — the single authoritative invariant catalog over canonical state.

Canonical sources: tasks.json (governed tasks) + active-checkouts.json (leases).
Every projection (free-work DRIFT, OPEN_TASKS board, working-context) should
validate against — or derive from — this one module, instead of each
re-implementing its own partial reconciliation. That fragmentation is why drift
kept recurring as point bugs (#131; umbrella over #130/#124/#123/#100).

`verify` (read-only) runs invariants I1-I8. `--fix` (Phase 4) plans and, with
`--apply`, executes idempotent repairs for the fixable invariants I1/I2 (stale &
duplicate leases) and I5 (crash-orphaned in_progress tasks — #283
session-crash-recovery) — dry-run by default. Lease mutations go only through
agent-work.py's locked unclaim path; task-state mutations go only through
update-tier1-state.py correct-state (audited, optimistic revision check).
The check_* and plan_* functions are PURE — they take
already-loaded data and return
violation dicts — so tests never touch the filesystem. evaluate() does the IO,
then calls them. This mirrors how free-work's aggregate() is callable under a
held LOCK_EX (no IO in the evaluator).
"""
import sys
import os
import re
import json
import argparse
import datetime as dt
import subprocess
import importlib.util
from pathlib import Path
from collections import Counter, defaultdict

# Import the sibling free-work module (hyphen in filename → load by path).
_FW_PATH = Path(__file__).resolve().parent / "free-work.py"
_spec = importlib.util.spec_from_file_location("free_work", _FW_PATH)
free_work = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(free_work)

REPO_ROOT = free_work.REPO_ROOT
NAMING_CONVENTION = REPO_ROOT / "docs/process/task-naming-convention.md"
TASK_QUEUE = REPO_ROOT / "docs/process/task-queue.md"
TASK_ARCHIVE = REPO_ROOT / "docs/process/task-archive.md"
TASKS_ARCHIVE_JSON = REPO_ROOT / "docs/process/state/tasks-archive.json"

# Only `done` is terminal. needs_verification / in_progress / queued / blocked
# are all live states a lease may legitimately point at.
TERMINAL_STATES = {"done"}
WC_LINE_BUDGET = 35

_ID_RE = re.compile(r"#(\d{2,})")


# ---- helpers ---------------------------------------------------------------
def viol(inv_id: str, severity: str, detail: str, fixable: bool) -> dict:
    return {"id": inv_id, "severity": severity, "detail": detail, "fixable": fixable}


def lease_label(lease: dict) -> str:
    return lease.get("title") or lease.get("branch") or ""


def extract_task_id(text: str):
    """Return the first '#NNN' id embedded in text, or None."""
    m = _ID_RE.search(text or "")
    return f"#{m.group(1)}" if m else None


def resolve_lease_task(lease: dict, tasks_by_id: dict, tasks: list):
    """Map a lease to its governed task. Prefer the explicit #NNN id; fall back to
    a case-insensitive substring title match (len>6) only when no id resolves.
    The fuzzy match is a known drift source — it is the fallback, never the first
    choice."""
    label = lease_label(lease)
    tid = extract_task_id(label)
    if tid and tid in tasks_by_id:
        return tasks_by_id[tid]
    label_l = label.lower()
    for t in tasks:
        tt = (t.get("title") or "").lower()
        if len(tt) > 6 and (tt in label_l or label_l in tt):
            return t
    return None


# ---- invariant catalog (pure) ---------------------------------------------
def check_I1(leases: list, tasks: list) -> list:
    """Every live lease must map to a NON-terminal task."""
    tasks_by_id = {t.get("taskId"): t for t in tasks}
    out = []
    for lease in leases:
        t = resolve_lease_task(lease, tasks_by_id, tasks)
        if t is None:
            continue  # unresolvable → I3's concern, not I1
        state = (t.get("state") or "").lower()
        if state in TERMINAL_STATES:
            out.append(
                viol(
                    "I1",
                    "fail",
                    f"live lease '{lease_label(lease)}' -> task {t.get('taskId')} is {state}",
                    True,
                )
            )
    return out


def check_I2(leases: list, tasks: list) -> list:
    """At most one live lease per resolved task."""
    tasks_by_id = {t.get("taskId"): t for t in tasks}
    groups = defaultdict(list)
    for lease in leases:
        t = resolve_lease_task(lease, tasks_by_id, tasks)
        if t is None:
            continue
        groups[t.get("taskId")].append(lease)
    out = []
    for tid, ls in groups.items():
        if len(ls) > 1:
            labels = [lease_label(x) for x in ls]
            out.append(
                viol("I2", "fail", f"{len(ls)} live leases resolve to task {tid}: {labels}", True)
            )
    return out


def check_I3(leases: list, tasks: list) -> list:
    """Every live lease title must resolve to some governed task."""
    tasks_by_id = {t.get("taskId"): t for t in tasks}
    out = []
    for lease in leases:
        if resolve_lease_task(lease, tasks_by_id, tasks) is None:
            out.append(
                viol(
                    "I3",
                    "warn",
                    f"live lease '{lease_label(lease)}' resolves to no governed task",
                    False,
                )
            )
    return out


def check_I4(opens: list, tasks: list, leases: list, owner_is_mine=None) -> list:
    """Every OPEN board item must map to a non-terminal governed task. A live
    lease covering the item means it's claimed, not drift.

    `owner_is_mine(owner)` lets a per-machine caller (free-work) suppress the
    in_progress case for tasks it owns — an in_progress task I own is not drift,
    it's my active work. Default (None → never-mine) is the machine-agnostic
    catalog view: every in_progress board item is reported. Caller is responsible
    for any machine-scoped pre-filtering of `opens`.

    Wording matches free-work's historical drift strings verbatim so that routing
    free-work's DRIFT bucket through this function produces byte-identical output
    (#131 — nothing parses these strings; they are human hints)."""
    if owner_is_mine is None:
        owner_is_mine = lambda _o: False  # noqa: E731
    canonical = {(t.get("title") or "").lower(): t for t in tasks}
    lease_titles = {lease_label(c).lower() for c in leases if lease_label(c)}
    out = []
    for it in opens:
        if not it.get("open"):
            continue
        label_l = it["label"].lower()
        if any(len(lt) > 6 and (lt in label_l or label_l in lt) for lt in lease_titles):
            continue  # claimed by a live lease
        matched = None
        for ct_title, ct in canonical.items():
            if len(ct_title) > 6 and (ct_title in label_l or label_l in ct_title):
                matched = ct
                break
        if matched is None:
            out.append(
                viol(
                    "I4",
                    "warn",
                    f"OPEN_TASKS '{it['label']}' is open but has no governed task in tasks.json — migrate it",
                    False,
                )
            )
            continue
        st = (matched.get("state") or "").lower()
        owner = matched.get("owner")
        if st in TERMINAL_STATES:
            out.append(
                viol(
                    "I4",
                    "warn",
                    f"OPEN_TASKS '{it['label']}' is open but tasks.json {matched.get('taskId')} is DONE",
                    False,
                )
            )
        elif st == "in_progress" and not owner_is_mine(owner):
            out.append(
                viol(
                    "I4",
                    "warn",
                    f"OPEN_TASKS '{it['label']}' is open but tasks.json {matched.get('taskId')} is in_progress (owner {owner})",
                    False,
                )
            )
    return out


def check_I5(leases: list, tasks: list) -> list:
    """Every in_progress task should have a live lease."""
    tasks_by_id = {t.get("taskId"): t for t in tasks}
    leased_ids = set()
    for lease in leases:
        t = resolve_lease_task(lease, tasks_by_id, tasks)
        if t is not None:
            leased_ids.add(t.get("taskId"))
    out = []
    for t in tasks:
        if (t.get("state") or "").lower() == "in_progress" and t.get("taskId") not in leased_ids:
            out.append(
                viol("I5", "warn", f"task {t.get('taskId')} is in_progress but has no live lease", True)
            )
    return out


def check_I6(last_assigned, doc_ids: list, governed_ids: list) -> list:
    """Counter must not have regressed below the highest known id; no duplicate
    governed taskIds. doc_ids = ints scanned from queue/archive/tasks.json;
    governed_ids = taskIds from tasks.json (dupe detection)."""
    out = []
    if doc_ids:
        mx = max(doc_ids)
        if last_assigned is not None and mx > last_assigned:
            out.append(
                viol("I6", "fail", f"counter regressed: max id #{mx} > last-assigned #{last_assigned}", False)
            )
    dupes = sorted(i for i, c in Counter(governed_ids).items() if c > 1 and i)
    if dupes:
        out.append(viol("I6", "fail", f"duplicate governed taskIds: {dupes}", False))
    return out


def check_I7(thread_ids: list, tasks: list) -> list:
    """Every working-context Open-threads #NNN must point at a non-terminal task."""
    tasks_by_id = {t.get("taskId"): t for t in tasks}
    out = []
    for tid in thread_ids:
        t = tasks_by_id.get(tid)
        if t is not None and (t.get("state") or "").lower() in TERMINAL_STATES:
            out.append(
                viol("I7", "warn", f"working-context Open thread {tid} points at a {t.get('state')} task", False)
            )
    return out


def check_I8(line_count: int) -> list:
    if line_count > WC_LINE_BUDGET:
        return [viol("I8", "warn", f"working-context.md is {line_count} lines (>{WC_LINE_BUDGET})", False)]
    return []


def _load_valid_project_slugs() -> set[str]:
    """Load the set of valid project slugs from projects.json."""
    import json as _json
    path = Path(__file__).resolve().parent.parent / "docs/process/state/projects.json"
    if not path.exists():
        return set()
    try:
        with open(path) as f:
            return {p["slug"] for p in _json.load(f).get("projects", [])}
    except Exception:
        return set()


def check_I9(tasks: list) -> list:
    """Every task with a project field must resolve to a live slug in projects.json.
    While the project field is optional, a set but invalid slug is always a warn.
    Tasks without any project field are warned when the registry is non-empty."""
    valid = _load_valid_project_slugs()
    if not valid:
        return []  # projects.json absent or empty — skip silently
    out = []
    for t in tasks:
        proj = t.get("project")
        tid = t.get("taskId", "?")
        state = (t.get("state") or "").lower()
        if state in TERMINAL_STATES:
            continue  # done/cancelled tasks — don't warn
        if proj is None or proj == "":
            out.append(viol("I9", "fail", f"task {tid} has no project field (write gate now enforces this)", False))
        elif proj not in valid:
            out.append(viol("I9", "fail", f"task {tid} project '{proj}' not in projects.json", False))
    return out


def check_I10(presence: list) -> list:
    """Presence records must be well-formed (required fields present, expiresAt parseable)."""
    REQUIRED = {"session", "agent", "machine", "project", "since", "lastSeen", "expiresAt"}
    out = []
    for i, p in enumerate(presence):
        missing = REQUIRED - set(p.keys())
        if missing:
            out.append(viol("I10", "warn", f"presence[{i}] missing fields: {missing}", False))
            continue
        try:
            import datetime as _dt
            ts = p["expiresAt"]
            if ts.endswith("Z"):
                ts = ts[:-1] + "+00:00"
            exp = _dt.datetime.fromisoformat(ts).astimezone(_dt.timezone.utc)
            if exp <= _dt.datetime.now(_dt.timezone.utc):
                out.append(viol("I10", "warn", f"presence record for {p.get('session','?')} is expired (reap should remove it)", False))
        except Exception as e:
            out.append(viol("I10", "warn", f"presence[{i}] invalid expiresAt: {e}", False))
    return out


def _load_projects_full() -> list:
    import json as _json
    path = Path(__file__).resolve().parent.parent / "docs/process/state/projects.json"
    try:
        return _json.load(open(path)).get("projects", [])
    except Exception:
        return []


def _load_goal_ids() -> set:
    import re as _re
    path = Path(__file__).resolve().parent.parent / "docs/process/goals.md"
    if not path.exists():
        return set()
    return {m.group(1) for line in path.read_text().splitlines()
            if (m := _re.match(r"#+\s*(G\d+)\b", line))}


def _archived_task_ids() -> set:
    """Ids of tasks moved to tasks-archive.json (archive-done-tasks.py) — for reference resolution."""
    if not TASKS_ARCHIVE_JSON.exists():
        return set()
    try:
        return {t.get("taskId") for t in json.load(open(TASKS_ARCHIVE_JSON)).get("tasks", [])}
    except (ValueError, OSError):
        return set()


def check_I11(tasks: list) -> list:
    """Project-progress integrity (#221): project goals resolve in goals.md, milestone
    taskIds resolve to live tasks, and active non-evergreen projects are seeded."""
    projects = _load_projects_full()
    if not projects:
        return []
    out = []
    goal_ids = _load_goal_ids()
    # Milestones legitimately reference completed tasks, which may be archived out of tasks.json
    # (archive-done-tasks.py). Resolve milestone ids against active + archived so a clean archive
    # doesn't produce false "unknown task" warnings.
    task_ids = {t.get("taskId") for t in tasks} | _archived_task_ids()
    for p in projects:
        slug = p.get("slug", "?")
        g = p.get("goal")
        if goal_ids and g and g not in goal_ids:
            out.append(viol("I11", "fail", f"project '{slug}' goal '{g}' not defined in goals.md", False))
        if p.get("evergreen"):
            continue
        ms = p.get("milestones") or []
        if p.get("status") == "active" and not ms:
            out.append(viol("I11", "warn", f"active project '{slug}' has no milestones (#221 seed missing)", False))
        for m in ms:
            for tid in (m.get("taskIds") or []):
                if tid not in task_ids:
                    out.append(viol("I11", "warn", f"project '{slug}' milestone {m.get('id')} references unknown task {tid}", False))
            # A done milestone is legitimately either fully filled (all linked tasks
            # done -> fill 1.0) or empty (no linked tasks -> fill 0). Only a PARTIAL
            # fill is a real integrity violation: the milestone is declared done while
            # tasks under it are still unfinished (e.g. M3 at fill 0.5 with a blocked task).
            fill = m.get("fill") or 0
            if m.get("status") == "done" and 0 < fill < 1:
                out.append(viol("I11", "warn", f"project '{slug}' milestone {m.get('id')} is done but only {int(round(fill * 100))}% filled (unfinished tasks under a done milestone)", False))
    return out


# ---- fix planning (pure) ---------------------------------------------------
# `--fix` repairs ONLY the fixable=True invariants — I1 (a live lease on a
# terminal task) and I2 (duplicate live leases on one task). Both repairs are
# lease releases. The other six are fixable=False: they need a human judgment
# call (renumbering a duplicate #ID, migrating a board item, trimming
# working-context) that an automated pass must never make on its own.
#
# SAFETY RULE: fix planning resolves a lease to its task by the EXPLICIT #NNN id
# only — never the fuzzy title-substring fallback resolve_lease_task() uses.
# verify can rely on the fuzzy match because it only prints a human hint; fix
# MUTATES state, and a fuzzy title collision could release a genuinely-active
# lease. So a lease with no #NNN (or whose #NNN names no governed task) is left
# untouched and stays visible as a verify warning for a human to resolve.
def resolve_lease_task_strict(lease: dict, tasks_by_id: dict):
    tid = extract_task_id(lease_label(lease))
    return tasks_by_id.get(tid) if tid else None


def _release_action(inv_id: str, lease: dict, reason: str):
    cid = lease.get("claimId")
    if not cid:
        return None  # no claim id → nothing agent-work.py unclaim can target
    return {
        "inv": inv_id,
        "action": "release-lease",
        "claimId": cid,
        "label": lease_label(lease),
        "reason": reason,
    }


def plan_I1_fixes(leases: list, tasks: list) -> list:
    """Release every live lease whose id-resolved task is terminal (done)."""
    tasks_by_id = {t.get("taskId"): t for t in tasks}
    out = []
    for lease in leases:
        t = resolve_lease_task_strict(lease, tasks_by_id)
        if t is None:
            continue
        if (t.get("state") or "").lower() in TERMINAL_STATES:
            a = _release_action(
                "I1", lease, f"task {t.get('taskId')} is {t.get('state')} (terminal) — stale lease"
            )
            if a:
                out.append(a)
    return out


def plan_I2_fixes(leases: list, tasks: list) -> list:
    """For each task with >1 live id-resolved lease, keep the authoritative one
    (highest fenceCounter, tie-broken by latest leaseExpiresAt) and release the
    rest — matching the fenceCounter-wins rule the sync merge driver already uses
    (T-SYNC-10), so --fix and a git merge converge on the same survivor."""
    tasks_by_id = {t.get("taskId"): t for t in tasks}
    groups = defaultdict(list)
    for lease in leases:
        t = resolve_lease_task_strict(lease, tasks_by_id)
        if t is not None:
            groups[t.get("taskId")].append(lease)
    out = []
    for tid, ls in groups.items():
        if len(ls) <= 1:
            continue
        winner = max(ls, key=lambda x: (int(x.get("fenceCounter", 0) or 0), str(x.get("leaseExpiresAt", ""))))
        for lease in ls:
            if lease is winner:
                continue
            a = _release_action(
                "I2", lease,
                f"duplicate lease on {tid}; keeping fence={winner.get('fenceCounter')} '{lease_label(winner)}'",
            )
            if a:
                out.append(a)
    return out


# ---- I5 crash recovery (#283) ----------------------------------------------
# Policy (v1): REQUEUE, never resume. A crashed session cannot be resumed from
# the outside; requeueing returns the task to the pool where the original
# session (if it is in fact alive) or any other worker re-claims it cleanly.
# Restore-lease was rejected: without per-task liveness proof, re-minting a
# lease for a dead session just re-orphans the task for another TTL.
I5_GRACE_MINUTES = 30          # newest lease must be expired/ended this long
I5_CRASH_RETRY_CAP = 3         # recoveries per task before parking as blocked
STRIKES_PATH = Path(os.environ.get("OPENCLAW_HOME", str(Path.home() / ".openclaw"))) / "reconcile-strikes.json"


def _parse_ts(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def load_strikes() -> dict:
    try:
        return json.loads(STRIKES_PATH.read_text())
    except (OSError, ValueError):
        return {}


def save_strikes(strikes: dict) -> None:
    STRIKES_PATH.parent.mkdir(parents=True, exist_ok=True)
    STRIKES_PATH.write_text(json.dumps(strikes, indent=2, sort_keys=True))


def plan_I5_fixes(checkouts: list, leases: list, tasks: list, now, strikes: dict):
    """Crash-recovery planner: an in_progress task with NO live lease is an
    orphan — its session crashed, its lease expired, or an auto-sync re-root
    wiped the lease record.

    Guards against racing live work:
      - grace: the newest lease record for the task must have ended/expired
        more than I5_GRACE_MINUTES ago (a session mid-renew is not a crash).
      - two-strike: with NO lease record at all (re-root wipe), act only when
        the same orphan was already recorded by a previous applying run, so a
        single transient snapshot never requeues anything. The strike file is
        machine-local (never synced) — a re-root cannot fabricate strikes.
      - retry cap: after I5_CRASH_RETRY_CAP recoveries a task is parked
        (blocked) instead of requeued — work that keeps killing its workers
        needs a human, not another retry.

    Pure: returns (actions, strikes') and mutates nothing; the applying caller
    persists strikes'. Mutations themselves run in apply_fixes through
    update-tier1-state.py correct-state (audited, optimistic revision check)."""
    tasks_by_id = {t.get("taskId"): t for t in tasks}
    leased_ids = set()
    for lease in leases:
        t = resolve_lease_task(lease, tasks_by_id, tasks)
        if t is not None:
            leased_ids.add(t.get("taskId"))

    records_by_task = defaultdict(list)
    for rec in checkouts:
        t = resolve_lease_task(rec, tasks_by_id, tasks)
        if t is not None:
            records_by_task[t.get("taskId")].append(rec)

    strikes = json.loads(json.dumps(strikes))  # never mutate caller's dict
    actions = []
    for t in tasks:
        tid = t.get("taskId")
        if (t.get("state") or "").lower() != "in_progress" or tid in leased_ids:
            continue  # not an orphan; the end-of-loop filter prunes its strikes

        entry = strikes.setdefault(tid, {})
        records = records_by_task.get(tid, [])
        if records:
            newest = max(records, key=lambda r: (int(r.get("fenceToken", 0) or 0),
                                                 str(r.get("leaseExpiresAt", ""))))
            evidence_ts = _parse_ts(newest.get("endedAt")) or _parse_ts(newest.get("leaseExpiresAt"))
            if evidence_ts is None or (now - evidence_ts) < dt.timedelta(minutes=I5_GRACE_MINUTES):
                continue  # inside grace (or unreadable evidence — stay safe)
            evidence = f"newest lease (fence={newest.get('fenceToken')}) ended {evidence_ts.isoformat()}"
        else:
            if not entry.get("seenAt"):
                entry["seenAt"] = now.isoformat()
                continue  # first sighting with no record — strike, act next run
            evidence = f"no lease record at all (re-root wipe?); first seen {entry['seenAt']}"

        recoveries = int(entry.get("recoveries", 0))
        if recoveries >= I5_CRASH_RETRY_CAP:
            action, to_state = "park-task", "blocked"
            reason = (f"crash-recovery cap hit ({recoveries}/{I5_CRASH_RETRY_CAP}): "
                      f"in_progress with no live lease; {evidence}; parking for human review")
        else:
            action, to_state = "requeue-task", "queued"
            reason = (f"crash-recovery {recoveries + 1}/{I5_CRASH_RETRY_CAP}: "
                      f"in_progress with no live lease; {evidence}; requeueing")
            entry["recoveries"] = recoveries + 1
        entry.pop("seenAt", None)
        actions.append({
            "inv": "I5",
            "action": action,
            "taskId": tid,
            "toState": to_state,
            "revision": t.get("revision"),
            "label": t.get("title") or "",
            "reason": reason,
        })

    # Drop strike entries for tasks that are no longer orphaned in_progress.
    live_orphans = {a["taskId"] for a in actions} | {
        t.get("taskId") for t in tasks
        if (t.get("state") or "").lower() == "in_progress" and t.get("taskId") not in leased_ids
    }
    strikes = {k: v for k, v in strikes.items() if k in live_orphans}
    return actions, strikes


def plan_fixes(leases: list, tasks: list, checkouts: list | None = None,
               now=None, strikes: dict | None = None):
    """All repair actions for the fixable invariants, in a stable order.
    Idempotent by construction: a released lease is no longer 'checked-out' so
    filter_live_leases drops it next run; a requeued task is no longer
    in_progress so I5 skips it — re-running --fix on a repaired tree yields [].
    Returns (actions, strikes'); I5 planning only runs when checkouts/now are
    provided (legacy two-arg callers get I1/I2 only)."""
    actions = plan_I1_fixes(leases, tasks) + plan_I2_fixes(leases, tasks)
    strikes_out = dict(strikes or {})
    if checkouts is not None and now is not None:
        i5_actions, strikes_out = plan_I5_fixes(checkouts, leases, tasks, now, strikes or {})
        actions += i5_actions
    return actions, strikes_out


# ---- IO loaders (used only by evaluate) ------------------------------------
def _read_last_assigned():
    try:
        text = NAMING_CONVENTION.read_text()
    except OSError:
        return None
    m = re.search(r"Last assigned:\s*#(\d+)", text)
    return int(m.group(1)) if m else None


def _scan_ids(path: Path) -> list:
    try:
        text = path.read_text()
    except OSError:
        return []
    return [int(n) for n in re.findall(r"#(\d{2,})", text)]


def _working_context_thread_ids() -> list:
    try:
        lines = free_work.WORKING_CONTEXT.read_text().splitlines()
    except OSError:
        return []
    ids = []
    seen = set()
    in_threads = False
    for ln in lines:
        s = ln.strip()
        if s.startswith("## "):
            in_threads = s.lower().startswith("## open threads")
            continue
        if in_threads and (s.startswith('- ') or s.startswith('* ')):
            # Extract only the LEADING bracket's #NNN — the thread's own ID.
            # Ignoring secondary #NNN refs in description bodies prevents I7
            # false-positives on threads like "[#131] ...umbrella over #130 done...".
            m = re.match(r'[-*]\s+(?:\*+\s*)?\[#(\d{2,})', s)
            if m:
                tid = f"#{m.group(1)}"
                if tid not in seen:
                    seen.add(tid)
                    ids.append(tid)
    return ids


def _working_context_line_count() -> int:
    try:
        return len(free_work.WORKING_CONTEXT.read_text().splitlines())
    except OSError:
        return 0


# ---- fix application (IO) --------------------------------------------------
_AGENT_WORK = Path(__file__).resolve().parent / "agent-work.py"
_UPDATE_TIER1 = Path(__file__).resolve().parent / "update-tier1-state.py"
_RENDER_TIER1 = Path(__file__).resolve().parent / "render-tier1-state.py"


def _live_leases_and_tasks():
    checkouts = (free_work.load_json(free_work.CHECKOUTS) or {}).get("checkouts", [])
    return checkouts, free_work.filter_live_leases(checkouts), free_work.load_tasks()


def apply_fixes(actions: list) -> list:
    """Execute each planned release through the canonical `agent-work.py unclaim`
    path, so leases mutate under the same LOCK_EX + fenceCounter discipline as
    every other lease write. reconcile never hand-edits active-checkouts.json —
    that file is owned by agent-work.py and the sync merge driver. Returns the
    actions annotated with applied/error."""
    # Pin child mutators to the SAME tree the planner read. update-tier1-state
    # resolves its root as REPO_ROOT env > METIS_HOME env > file location, so an
    # inherited METIS_HOME would otherwise split-brain a non-canonical checkout
    # (read sandbox/worktree state, write the canonical repo).
    env = {**os.environ, "REPO_ROOT": str(REPO_ROOT)}
    results = []
    state_changed = False
    for a in actions:
        if a.get("action") == "release-lease":
            proc = subprocess.run(
                [sys.executable, str(_AGENT_WORK), "unclaim", a["claimId"],
                 "--note", f"reconcile --fix {a['inv']}: {a['reason']}"],
                capture_output=True, text=True, env=env,
            )
        elif a.get("action") in ("requeue-task", "park-task"):
            # Audited backward transition; --expected-revision makes this a
            # compare-and-swap: if any session touched the task between plan
            # and apply, the correction fails and the next run re-evaluates.
            proc = subprocess.run(
                [sys.executable, str(_UPDATE_TIER1), "correct-state",
                 "--task-id", a["taskId"],
                 "--expected-revision", str(a.get("revision", "")),
                 "--actor", "reconcile-crash-recovery",
                 "--to-state", a["toState"],
                 "--reason", a["reason"]],
                capture_output=True, text=True, env=env,
            )
        else:
            results.append({**a, "applied": False, "error": "unknown action"})
            continue
        ok = proc.returncode == 0
        state_changed = state_changed or (ok and a["action"] != "release-lease")
        results.append({
            **a,
            "applied": ok,
            "error": None if ok else (proc.stderr.strip() or proc.stdout.strip() or f"{a['action']} failed"),
        })
    if state_changed:
        # Re-project the board so OPEN_TASKS reflects the corrected state
        # (otherwise the requeue itself would manufacture an I4 drift warn).
        subprocess.run([sys.executable, str(_RENDER_TIER1), "write"],
                       capture_output=True, text=True, env=env)
    return results


# ---- evaluator -------------------------------------------------------------
def evaluate() -> dict:
    """Load every source, run I1-I10, return {violations, ok}. ok == no fails."""
    raw_checkouts = free_work.load_json(free_work.CHECKOUTS) or {}
    checkouts = raw_checkouts.get("checkouts", [])
    presence = raw_checkouts.get("presence", [])
    leases = free_work.filter_live_leases(checkouts)
    tasks = free_work.load_tasks()
    opens = free_work.parse_open_tasks()

    last_assigned = _read_last_assigned()
    doc_ids = _scan_ids(TASK_QUEUE) + _scan_ids(TASK_ARCHIVE) + [
        int(extract_task_id(t.get("taskId") or "")[1:])
        for t in tasks
        if extract_task_id(t.get("taskId") or "")
    ]
    governed_ids = [t.get("taskId") for t in tasks]
    thread_ids = _working_context_thread_ids()
    wc_lines = _working_context_line_count()

    violations = []
    violations += check_I1(leases, tasks)
    violations += check_I2(leases, tasks)
    violations += check_I3(leases, tasks)
    violations += check_I4(opens, tasks, leases)
    violations += check_I5(leases, tasks)
    violations += check_I6(last_assigned, doc_ids, governed_ids)
    violations += check_I7(thread_ids, tasks)
    violations += check_I8(wc_lines)
    violations += check_I9(tasks)
    violations += check_I10(presence)
    violations += check_I11(tasks)

    ok = not any(v["severity"] == "fail" for v in violations)
    return {"violations": violations, "ok": ok}


# ---- CLI -------------------------------------------------------------------
def _print_plan(actions: list) -> None:
    for a in actions:
        if a["action"] == "release-lease":
            print(f"FIX {a['inv']} — release lease {a['claimId']} '{a['label']}' ({a['reason']})")
        else:
            print(f"FIX {a['inv']} — {a['action']} {a['taskId']} '{a['label']}' ({a['reason']})")


def _run_fix(args) -> int:
    """Plan repairs for the fixable invariants; execute only under --apply.
    Dry-run (no --apply) mutates nothing — including the strike file — and
    always exits 0: it is a report, safe to run unattended; strikes are only
    recorded by an applying run so the two-strike clock matches real sweeps."""
    checkouts, leases, tasks = _live_leases_and_tasks()
    strikes = load_strikes()
    actions, strikes_out = plan_fixes(
        leases, tasks, checkouts=checkouts,
        now=dt.datetime.now(dt.timezone.utc), strikes=strikes,
    )

    if not args.apply:
        if args.json:
            print(json.dumps({"actions": actions, "applied": False}, indent=2))
        else:
            _print_plan(actions)
            print(f"{len(actions)} fix(es) planned (dry-run; pass --apply to execute)")
        return 0

    results = apply_fixes(actions)
    save_strikes(strikes_out)
    failed = [r for r in results if not r["applied"]]
    if args.json:
        print(json.dumps({"actions": results, "applied": True}, indent=2))
    else:
        for r in results:
            tag = "OK  " if r["applied"] else "FAIL"
            what = (f"released {r['claimId']}" if r["action"] == "release-lease"
                    else f"{r['action']} {r['taskId']}")
            line = f"{tag} {r['inv']} {what} '{r['label']}'"
            if not r["applied"]:
                line += f" — {r['error']}"
            print(line)
        print(f"{len(results) - len(failed)} applied, {len(failed)} failed")
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Reconcile canonical state against the invariant catalog (I1-I8).")
    ap.add_argument("mode", nargs="?", default="verify", choices=["verify"], help="verify (read-only)")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    ap.add_argument(
        "--fix", action="store_true",
        help="plan idempotent repairs for the fixable invariants (I1/I2 stale & duplicate leases, I5 crash-orphaned tasks); read-only unless --apply",
    )
    ap.add_argument(
        "--apply", action="store_true",
        help="with --fix, execute the planned lease releases (mutates state via agent-work.py unclaim)",
    )
    args = ap.parse_args()

    if args.apply and not args.fix:
        ap.error("--apply requires --fix")

    if args.fix:
        return _run_fix(args)

    result = evaluate()
    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    fails = [v for v in result["violations"] if v["severity"] == "fail"]
    warns = [v for v in result["violations"] if v["severity"] == "warn"]
    for v in result["violations"]:
        tag = "FAIL" if v["severity"] == "fail" else "WARN"
        print(f"{tag} {v['id']} — {v['detail']}")
    print(f"{len(fails)} fail, {len(warns)} warn")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
