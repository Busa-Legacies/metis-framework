#!/usr/bin/env python3
import argparse
import copy
import json
import os
import sys
from pathlib import Path

# Portable repo root: REPO_ROOT (per-invocation/worktree) -> METIS_HOME (canonical)
# -> self-locating fallback (<this file>/../..). Self-location is rename- and
# symlink-proof, so it survives removal of the Ant-openclaw-framework compat symlink.
ROOT = Path(os.environ.get("REPO_ROOT") or os.environ.get("METIS_HOME") or Path(__file__).resolve().parents[1])
TASKS_PATH = ROOT / "docs/process/state/tasks.json"
FOCUS_PATH = ROOT / "docs/process/state/live-focus.json"
AREAS_PATH = ROOT / "docs/process/state/task-areas.json"
PROJECTS_PATH = ROOT / "docs/process/state/projects.json"

# Board-projection enums (#100). area is validated against task-areas.json (one
# source of truth, shared with render-tier1-state.py); agent/machine are fixed.
VALID_AGENTS = {"forge", "scout", "shield", "echo", "claude", "codex", "hermes", "curator"}
VALID_MACHINES = {"antfox", "jarry", "either"}
BOARD_FIELDS = ("area", "agent", "machine")

VALID_TASK_STATES = {
    "inbox",
    "queued",
    "accepted",
    "in_progress",
    "execution_finished",
    "needs_verification",
    "waiting",
    "blocked",
    "failed",
    "done",
}

ALLOWED_STATE_TRANSITIONS = {
    "inbox": {"queued", "accepted", "done"},
    "queued": {"accepted", "waiting", "in_progress"},
    "accepted": {"in_progress"},
    "in_progress": {"execution_finished", "waiting", "blocked", "failed"},
    "execution_finished": {"needs_verification"},
    "needs_verification": {"done", "blocked", "failed", "in_progress"},
    "waiting": {"in_progress"},
    "blocked": {"in_progress"},
    "failed": {"accepted", "in_progress"},
    "done": set(),
}

TASK_MUTABLE_FIELDS = {
    "title",
    "priority",
    "state",
    "owner",
    "summary",
    "why",
    "how",
    "currentStep",
    "firstStep",
    "expectedArtifact",
    "verificationMethod",
    "blockerOrNone",
    "nextAction",
    "mainFiles",
    "nextDecisionPoint",
    "stateCorrections",
    "area",
    "agent",
    "machine",
    "project",
    "domain",
    "milestone",
    "origin",
    "originRef",
    "doneWhen",
    "decisionOptions",
    "recommendation",
    "decisionContext",
    "decision",  # resolved outcome: the chosen decisionOptions.key (writeback sets it)
}

# queue-runner-v2 hybrid doneWhen contract (docs/process/queue-runner-v2-design.md).
# Optional today; the v2 runner executes/judges it so curator-approve == done
# honestly. type=check -> runnable command (exit 0 = pass); acceptance -> explicit
# criteria curator judges; both -> run the check AND confirm the criteria.
VALID_DONEWHEN_TYPES = {"check", "acceptance", "both"}

# WHO originated the task: ant=Ant directly asked; agent=agent proposed autonomously;
# collab=agent proposed, Ant approved; system=automated review/check caught it
VALID_ORIGINS = {"ant", "agent", "collab", "system"}


def _load_valid_domains():
    """Canonical domains from the SoT (docs/process/taxonomy.yaml); fail-open to the
    known set so a yaml hiccup never blocks a task write."""
    try:
        import pathlib
        import yaml
        spec = yaml.safe_load(
            (pathlib.Path(__file__).resolve().parents[1] / "docs/process/taxonomy.yaml").read_text())
        vals = set((spec.get("domains") or {}).keys())
        return vals or {"systems", "career", "finance", "health", "home", "craft", "presence", "joy"}
    except Exception:
        return {"systems", "career", "finance", "health", "home", "craft", "presence", "joy"}


VALID_DOMAINS = _load_valid_domains()

FOCUS_MUTABLE_FIELDS = {
    "focusSummary",
    "mode",
    "waitingOnAnt",
    "blockerSummary",
    "nextSteps",
    "derivedFromTaskIds",
}

CREATE_TASK_REQUIRED_FIELDS = {"taskId", "title", "priority", "state", "owner", "summary", "why", "how", "project"}
RICH_REQUIRED_STATES = {
    "accepted",
    "in_progress",
    "execution_finished",
    "needs_verification",
    "waiting",
    "blocked",
    "failed",
}
REQUIRED_RICH_FIELDS = [
    "currentStep",
    "expectedArtifact",
    "verificationMethod",
    "blockerOrNone",
    "nextAction",
]


def now_iso():
    from datetime import datetime

    return datetime.now().astimezone().isoformat(timespec="seconds")


CHECKOUTS_PATH = ROOT / "docs/process/state/active-checkouts.json"
# Lease statuses that are no longer live work — never re-stamp these (mirrors
# agent-work.py TERMINAL so a released/expired/stolen lease is not revived).
_LEASE_TERMINAL = {"done", "released", "blocked", "expired", "stolen", "abandoned"}


def restamp_lease_on_transition(task_id, old_state, new_state, checkouts_path=None):
    """#309 heartbeat-on-transition: when a task's state ACTUALLY changes, re-stamp
    the owning live lease's lastRenewedAt so stale-lease logic (reconcile I5 grace)
    never requeues actively-progressing work. Fires only on a real transition, and
    records liveness via lastRenewedAt ONLY — it never rewrites the lease's state
    backwards (the bug in the first forge attempt). Best-effort under an flock: a
    missing or locked checkouts file must never block the governed task write that
    already landed. Does not extend leaseExpiresAt — the lease's live/stale status
    for I1/I2 is unchanged; only the I5 crash-recovery grace consumes lastRenewedAt."""
    import re as _re
    from datetime import datetime, timezone
    if not old_state or old_state == new_state:
        return
    path = checkouts_path or CHECKOUTS_PATH
    m = _re.search(r"\d+", task_id or "")
    if not m or not path.exists():
        return
    num = m.group(0)
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    lock_path = path.with_suffix(path.suffix + ".lock")
    try:
        import fcntl
        with lock_path.open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                data = json.loads(path.read_text())
                mine = [r for r in data.get("checkouts", [])
                        if (str(r.get("issue")) == num or f"#{num}" in (r.get("title") or ""))
                        and r.get("status") not in _LEASE_TERMINAL]
                if mine:
                    holder = max(mine, key=lambda r: int(r.get("fenceToken", 0) or 0))
                    holder["lastRenewedAt"] = stamp
                    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
    except Exception:
        return  # heartbeat is best-effort; the task state write is authoritative


def load_json(path: Path):
    return json.loads(path.read_text())


def dump_json(path: Path, data):
    # ensure_ascii=False preserves raw UTF-8 (en/em dashes, etc.) so governed
    # writes don't churn unrelated lines into \uXXXX escapes in the diff.
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def parse_patch(patch_text: str):
    try:
        patch = json.loads(patch_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid patch JSON: {exc}")
    if not isinstance(patch, dict):
        raise ValueError("patch must decode to a JSON object")
    return patch


def validate_task_shape(task_id: str, task: dict, require_rich: bool = True):
    state = task.get("state")
    if state not in VALID_TASK_STATES:
        raise ValueError(f"{task_id}: invalid state {state!r}")

    if require_rich and state in RICH_REQUIRED_STATES:
        missing = [field for field in REQUIRED_RICH_FIELDS if not task.get(field)]
        if missing:
            raise ValueError(
                f"{task_id}: missing required rich fields for state {state}: {', '.join(missing)}"
            )

    if state == "done" and task.get("blockerOrNone") not in (None, "", "none"):
        raise ValueError(f"{task_id}: done task should not carry a meaningful blocker")

    if state == "execution_finished" and not task.get("verificationMethod"):
        raise ValueError(f"{task_id}: execution_finished task must preserve verificationMethod")

    validate_done_when(task_id, task)
    validate_decision(task_id, task)


def validate_decision(task_id: str, task: dict):
    """Validate the optional structured decision affordances (#323, decision-inbox).
    Both Notion and Control Center render these instead of scraping nextDecisionPoint prose:
      decisionOptions: [{"key": "a", "label": "...", "detail"?: "..."}]  # the one-tap choices
      recommendation:  "<key or short text> — why"                       # agent's pick
      decisionContext: "why it matters / trade-offs / links"             # context to decide
    """
    opts = task.get("decisionOptions")
    if opts is not None:
        if not isinstance(opts, list) or not opts:
            raise ValueError(f"{task_id}: decisionOptions must be a non-empty list")
        keys = set()
        for o in opts:
            if not isinstance(o, dict):
                raise ValueError(f"{task_id}: each decisionOption must be an object {{key,label}}")
            k, label = o.get("key"), o.get("label")
            if not isinstance(k, str) or not k.strip():
                raise ValueError(f"{task_id}: decisionOption needs a non-empty 'key'")
            if not isinstance(label, str) or not label.strip():
                raise ValueError(f"{task_id}: decisionOption {k!r} needs a non-empty 'label'")
            if "detail" in o and not isinstance(o["detail"], str):
                raise ValueError(f"{task_id}: decisionOption {k!r} 'detail' must be a string")
            if k in keys:
                raise ValueError(f"{task_id}: duplicate decisionOption key {k!r}")
            keys.add(k)
    for f in ("recommendation", "decisionContext"):
        v = task.get(f)
        if v is not None and (not isinstance(v, str) or not v.strip()):
            raise ValueError(f"{task_id}: {f} must be a non-empty string when present")


def validate_done_when(task_id: str, task: dict):
    """Validate the optional structured doneWhen (queue-runner-v2). When present it
    must be USABLE — the v2 runner executes the check or curator judges the
    criteria, so a malformed contract would silently break the apply+verify loop.
      {"type": "check"|"acceptance"|"both",
       "check": "<shell command, exit 0 = pass>",   # required for check/both
       "criteria": ["explicit acceptance bullet", ...]}  # required for acceptance/both
    """
    dw = task.get("doneWhen")
    if dw is None:
        return
    if not isinstance(dw, dict):
        raise ValueError(f"{task_id}: doneWhen must be an object")
    dtype = dw.get("type")
    if dtype not in VALID_DONEWHEN_TYPES:
        raise ValueError(
            f"{task_id}: doneWhen.type must be one of {', '.join(sorted(VALID_DONEWHEN_TYPES))}"
        )
    if dtype in {"check", "both"}:
        check = dw.get("check")
        if not isinstance(check, str) or not check.strip():
            raise ValueError(
                f"{task_id}: doneWhen.type={dtype} requires a non-empty 'check' command string"
            )
    if dtype in {"acceptance", "both"}:
        crit = dw.get("criteria")
        if not isinstance(crit, list) or not crit or not all(
            isinstance(c, str) and c.strip() for c in crit
        ):
            raise ValueError(
                f"{task_id}: doneWhen.type={dtype} requires a non-empty 'criteria' list of strings"
            )


def load_valid_areas():
    """Area names from task-areas.json — single source of truth shared with the
    projector. Returns an empty set if the file is missing/unreadable so the enum
    check degrades to a no-op rather than blocking writes on a config error."""
    try:
        doc = json.loads(AREAS_PATH.read_text())
        return {a["name"] for a in doc.get("areas", [])}
    except (OSError, ValueError):
        return set()


def load_valid_project_slugs():
    """Project slugs from projects.json. Returns empty set on missing/unreadable file."""
    try:
        doc = json.loads(PROJECTS_PATH.read_text())
        return {p["slug"] for p in doc.get("projects", [])}
    except (OSError, ValueError):
        return set()


def validate_board_fields(task_id: str, task: dict, require_present: bool = True):
    """Gate the board-projection fields (#100). Presence is required only for
    born-governed tasks (require_present=True); enum-validity is always enforced
    when a value is given. Mirrors the require_rich/--backfill split above."""
    if require_present:
        missing = [f for f in BOARD_FIELDS if not task.get(f)]
        if missing:
            raise ValueError(f"{task_id}: missing required board fields: {', '.join(missing)}")

    area = task.get("area")
    if area is not None:
        valid_areas = load_valid_areas()
        if valid_areas and area not in valid_areas:
            raise ValueError(
                f"{task_id}: invalid area {area!r} (not in task-areas.json: {', '.join(sorted(valid_areas))})"
            )

    project = task.get("project")
    valid_projects = load_valid_project_slugs()
    if valid_projects:
        if project is None or project == "":
            raise ValueError(
                f"{task_id}: missing required project field (valid slugs: {', '.join(sorted(valid_projects))})"
            )
        if project not in valid_projects:
            raise ValueError(
                f"{task_id}: invalid project slug {project!r} (not in projects.json: {', '.join(sorted(valid_projects))})"
            )

    agent = task.get("agent")
    if agent is not None and agent not in VALID_AGENTS:
        raise ValueError(f"{task_id}: invalid agent {agent!r} (valid: {', '.join(sorted(VALID_AGENTS))})")
    machine = task.get("machine")
    if machine is not None and machine not in VALID_MACHINES:
        raise ValueError(f"{task_id}: invalid machine {machine!r} (valid: {', '.join(sorted(VALID_MACHINES))})")

    origin = task.get("origin")
    if require_present and origin is None:
        raise ValueError(f"{task_id}: missing required field: origin (valid: {', '.join(sorted(VALID_ORIGINS))})")
    if origin is not None and origin not in VALID_ORIGINS:
        raise ValueError(f"{task_id}: invalid origin {origin!r} (valid: {', '.join(sorted(VALID_ORIGINS))})")

    domain = task.get("domain")
    if domain is not None and domain not in VALID_DOMAINS:
        raise ValueError(f"{task_id}: invalid domain {domain!r} (valid: {', '.join(sorted(VALID_DOMAINS))})")


def validate_task_patch(task_id: str, patch: dict):
    unknown = sorted(set(patch.keys()) - TASK_MUTABLE_FIELDS)
    if unknown:
        raise ValueError(f"{task_id}: unknown task patch fields: {', '.join(unknown)}")
    state = patch.get("state")
    if state is not None and state not in VALID_TASK_STATES:
        raise ValueError(f"{task_id}: invalid state {state!r}")


def validate_focus_patch(patch: dict):
    unknown = sorted(set(patch.keys()) - FOCUS_MUTABLE_FIELDS)
    if unknown:
        raise ValueError(f"live-focus: unknown patch fields: {', '.join(unknown)}")


def validate_state_transition(task_id: str, old_state: str, new_state: str):
    if old_state == new_state:
        return
    allowed = ALLOWED_STATE_TRANSITIONS.get(old_state, set())
    if new_state not in allowed:
        raise ValueError(f"{task_id}: invalid state transition {old_state!r} -> {new_state!r}")


def validate_done_gate(task_id: str, old_state: str, task: dict):
    if task.get("state") != "done":
        return
    if old_state == "done":
        # No transition is occurring — the task is already done and the patch
        # touches non-state fields (e.g. a project refile). The gate guards the
        # *move* into done; re-tripping it here made every done task immutable.
        return
    if old_state != "needs_verification":
        raise ValueError(f"{task_id}: done is only allowed from needs_verification")
    if task.get("blockerOrNone") not in (None, "", "none"):
        raise ValueError(f"{task_id}: done requires blockerOrNone to be none")
    next_action = task.get("nextAction")
    if next_action not in (None, "", "none"):
        raise ValueError(f"{task_id}: done requires nextAction to be none or empty")
    if not task.get("expectedArtifact"):
        raise ValueError(f"{task_id}: done requires expectedArtifact")
    if not task.get("verificationMethod"):
        raise ValueError(f"{task_id}: done requires verificationMethod")


def create_task(args):
    doc = load_json(TASKS_PATH)
    tasks = doc.get("tasks", [])
    new_task = parse_patch(args.patch)

    missing = sorted(CREATE_TASK_REQUIRED_FIELDS - set(new_task.keys()))
    if missing:
        raise ValueError(f"create-task: missing required fields: {', '.join(missing)}")

    task_id = new_task.get("taskId")
    if any(t.get("taskId") == task_id for t in tasks):
        raise ValueError(f"create-task: task already exists: {task_id}")

    unknown = sorted(set(new_task.keys()) - (TASK_MUTABLE_FIELDS | {"taskId"}))
    if unknown:
        raise ValueError(f"{task_id}: unknown task fields: {', '.join(unknown)}")

    task = copy.deepcopy(new_task)
    task.setdefault("mainFiles", [])
    task.setdefault("nextDecisionPoint", None)
    task["updatedAt"] = now_iso()
    task["updatedBy"] = args.actor
    task["revision"] = 1

    backfill = getattr(args, "backfill", False)
    validate_task_shape(task_id, task, require_rich=not backfill)
    validate_board_fields(task_id, task, require_present=not backfill)
    if not backfill:
        validate_done_gate(task_id, None, task)

    if args.check:
        print(json.dumps(task, indent=2))
        return

    tasks.append(task)
    doc["updatedAt"] = task["updatedAt"]
    dump_json(TASKS_PATH, doc)
    print(f"Created task {task_id} -> revision {task['revision']}")


def update_task(args):
    doc = load_json(TASKS_PATH)
    tasks = doc.get("tasks", [])
    task = next((t for t in tasks if t.get("taskId") == args.task_id), None)
    if task is None:
        raise ValueError(f"task not found: {args.task_id}")

    if task.get("revision") != args.expected_revision:
        raise ValueError(
            f"{args.task_id}: revision mismatch (expected {args.expected_revision}, found {task.get('revision')})"
        )

    patch = parse_patch(args.patch)
    validate_task_patch(args.task_id, patch)

    new_task = copy.deepcopy(task)
    new_task.update(patch)
    validate_state_transition(args.task_id, task.get("state"), new_task.get("state"))
    new_task["updatedAt"] = now_iso()
    new_task["updatedBy"] = args.actor
    new_task["revision"] = task.get("revision", 0) + 1
    validate_task_shape(args.task_id, new_task)
    validate_board_fields(args.task_id, new_task, require_present=False)
    validate_done_gate(args.task_id, task.get("state"), new_task)

    if args.check:
        print(json.dumps(new_task, indent=2))
        return

    for idx, candidate in enumerate(tasks):
        if candidate.get("taskId") == args.task_id:
            tasks[idx] = new_task
            break
    doc["updatedAt"] = new_task["updatedAt"]
    dump_json(TASKS_PATH, doc)
    restamp_lease_on_transition(args.task_id, task.get("state"), new_task.get("state"))
    print(f"Updated task {args.task_id} -> revision {new_task['revision']}")


def correct_state(args):
    """Audited escape hatch for DATA CORRECTION, not workflow progress.

    The forward-only ALLOWED_STATE_TRANSITIONS graph models a task being
    *worked* — it deliberately has no rewind edges, so a task mis-created at
    the wrong state (e.g. the #098 migration dropping tasks into
    needs_verification/blocked with no matching content) cannot be fixed via
    task-update. This bypasses the transition check ON PURPOSE, but requires a
    --reason and records every correction in stateCorrections[] so the override
    is explicit and auditable rather than a silent backdoor around workflow.
    Shape + done-gate are still enforced (a correction can't fake a completion).

    --retroactive is a narrower escape hatch for closing tasks that were ALREADY
    completed before the governed system existed (e.g. #098 imported board items
    like #066 that were deployed pre-migration). Walking such a task to done
    honestly would mean fabricating an in_progress -> needs_verification workflow
    chain it never had. Mirroring create-task --backfill, --retroactive (only
    valid with --to-state done) skips the done-gate's "must come from
    needs_verification + rich artifacts" requirement, and instead records the
    --reason as the verificationMethod note. blockerOrNone/nextAction are forced
    to none. The correction is still audited in stateCorrections[].
    """
    reason = (args.reason or "").strip()
    if not reason:
        raise ValueError("correct-state requires a non-empty --reason")
    if args.to_state not in VALID_TASK_STATES:
        raise ValueError(f"{args.task_id}: invalid target state {args.to_state!r}")
    retroactive = getattr(args, "retroactive", False)
    if retroactive and args.to_state != "done":
        raise ValueError("correct-state --retroactive is only valid with --to-state done")

    doc = load_json(TASKS_PATH)
    tasks = doc.get("tasks", [])
    task = next((t for t in tasks if t.get("taskId") == args.task_id), None)
    if task is None:
        raise ValueError(f"task not found: {args.task_id}")
    if task.get("revision") != args.expected_revision:
        raise ValueError(
            f"{args.task_id}: revision mismatch (expected {args.expected_revision}, found {task.get('revision')})"
        )

    old_state = task.get("state")
    new_task = copy.deepcopy(task)
    new_task["state"] = args.to_state
    if retroactive:
        # Substitute an honest audit note for the workflow chain we're legitimately
        # skipping — the task is terminal data, not live work in flight.
        new_task["blockerOrNone"] = "none"
        new_task["nextAction"] = "none"
        if not new_task.get("verificationMethod"):
            new_task["verificationMethod"] = f"retroactive: {reason}"
        if not new_task.get("expectedArtifact"):
            new_task["expectedArtifact"] = "(retroactive — completed before governance)"
    correction = {
        "from": old_state,
        "to": args.to_state,
        "reason": reason,
        "actor": args.actor,
        "at": now_iso(),
        "retroactive": retroactive,
    }
    new_task.setdefault("stateCorrections", []).append(correction)
    new_task["updatedAt"] = correction["at"]
    new_task["updatedBy"] = args.actor
    new_task["revision"] = task.get("revision", 0) + 1
    # shape always applies; done-gate too unless this is an audited retroactive close
    validate_task_shape(args.task_id, new_task)
    if not retroactive:
        validate_done_gate(args.task_id, old_state, new_task)

    if args.check:
        print(json.dumps(new_task, indent=2, ensure_ascii=False))
        return

    for idx, candidate in enumerate(tasks):
        if candidate.get("taskId") == args.task_id:
            tasks[idx] = new_task
            break
    doc["updatedAt"] = new_task["updatedAt"]
    dump_json(TASKS_PATH, doc)
    restamp_lease_on_transition(args.task_id, old_state, args.to_state)
    print(f"Corrected task {args.task_id}: {old_state} -> {args.to_state} (revision {new_task['revision']})")


def update_live_focus(args):
    doc = load_json(FOCUS_PATH)
    if doc.get("revision") != args.expected_revision:
        raise ValueError(
            f"live-focus: revision mismatch (expected {args.expected_revision}, found {doc.get('revision')})"
        )

    patch = parse_patch(args.patch)
    validate_focus_patch(patch)

    new_doc = copy.deepcopy(doc)
    new_doc.update(patch)
    new_doc["updatedAt"] = now_iso()
    new_doc["updatedBy"] = args.actor
    new_doc["revision"] = doc.get("revision", 0) + 1

    if args.check:
        print(json.dumps(new_doc, indent=2))
        return

    dump_json(FOCUS_PATH, new_doc)
    print(f"Updated live-focus -> revision {new_doc['revision']}")


def main():
    parser = argparse.ArgumentParser(description="Small revision-aware Tier 1 state update helper.")
    sub = parser.add_subparsers(dest="command", required=True)

    create_p = sub.add_parser("create-task", help="Create one new task object in tasks.json")
    create_p.add_argument("--actor", required=True)
    create_p.add_argument("--patch", required=True, help="JSON object for the new task")
    create_p.add_argument(
        "--check", action="store_true", help="Validate and print the new task without writing"
    )
    create_p.add_argument(
        "--backfill",
        action="store_true",
        help="Historical/migration import — skips done-gate lifecycle check AND rich-field enforcement so pre-schema tasks can be imported as-is",
    )

    task_p = sub.add_parser("task-update", help="Patch one task object in tasks.json")
    task_p.add_argument("--task-id", required=True)
    task_p.add_argument("--expected-revision", type=int, required=True)
    task_p.add_argument("--actor", required=True)
    task_p.add_argument("--patch", required=True, help="JSON object patch string")
    task_p.add_argument(
        "--check", action="store_true", help="Validate and print the updated object without writing"
    )

    correct_p = sub.add_parser(
        "correct-state",
        help="AUDITED data correction — set state bypassing the forward-only transition graph (requires --reason)",
    )
    correct_p.add_argument("--task-id", required=True)
    correct_p.add_argument("--expected-revision", type=int, required=True)
    correct_p.add_argument("--actor", required=True)
    correct_p.add_argument("--to-state", required=True, help="Target state (any valid state)")
    correct_p.add_argument(
        "--reason", required=True, help="Why this is a correction, not workflow progress (audited)"
    )
    correct_p.add_argument(
        "--retroactive",
        action="store_true",
        help="Close a pre-governance/migrated task (only with --to-state done): skips the done-gate workflow-chain requirement, records --reason as the verificationMethod note",
    )
    correct_p.add_argument(
        "--check", action="store_true", help="Validate and print the corrected object without writing"
    )

    focus_p = sub.add_parser(
        "live-focus-update", help="Patch the live-focus object in live-focus.json"
    )
    focus_p.add_argument("--expected-revision", type=int, required=True)
    focus_p.add_argument("--actor", required=True)
    focus_p.add_argument("--patch", required=True, help="JSON object patch string")
    focus_p.add_argument(
        "--check", action="store_true", help="Validate and print the updated object without writing"
    )

    args = parser.parse_args()

    if args.command == "create-task":
        create_task(args)
    elif args.command == "task-update":
        update_task(args)
    elif args.command == "correct-state":
        correct_state(args)
    elif args.command == "live-focus-update":
        update_live_focus(args)
    else:
        raise ValueError(f"unknown command: {args.command}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
