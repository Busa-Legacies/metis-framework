"""State-machine operations layer extracted from update-tier1-state.py (#6460 Slice 4).

The domain layer: all task/project/milestone CRUD, the governed state transitions, task-id
allocation, lease restamping, projection rendering, and the commit-under-the-sync-lock.
Byte-faithful move via scripts/extract-symbols.py (the few __file__-relative paths were first
rewritten to the location-independent ROOT so the code resolves siblings from scripts/lib/).
update-tier1-state.py is now a thin CLI over these, re-importing them so every caller is
unchanged. Imports the lower layers (constants, validation, io); datetime/fcntl/subprocess/
yaml/infra_config/task_id_alloc are local imports inside the functions that use them.
"""
from __future__ import annotations

import copy  # noqa: F401  (used by moved functions)
import json  # noqa: F401  (used by moved functions)
import os
import re  # noqa: F401  (used by moved functions)
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tier1_state_constants import (  # noqa: E402,F401
    ALLOWED_STATE_TRANSITIONS,
    BOARD_FIELDS,
    RICH_REQUIRED_STATES,
    CREATE_TASK_REQUIRED_FIELDS,
    DISMISSABLE_STATES,
    TASK_MUTABLE_FIELDS,
    VALID_AGENTS,
    VALID_DONEWHEN_TYPES,
    VALID_ORIGINS,
    VALID_TASK_STATES,
)
from tier1_state_validation import (  # noqa: E402,F401
    DUP_TERMINAL_STATES,
    _current_session,
    _enforce_append_only,
    _reset_reject_streak_on_reactivate,
    _state_overlap_warn,
    _validate_iso_date,
    find_near_duplicate,
    parse_patch,
    validate_focus_patch,
    validate_state_transition,
    validate_task_patch,
    validate_task_shape,
    validate_title,
)
from tier1_state_io import (  # noqa: E402,F401
    AREAS_PATH,
    FOCUS_PATH,
    PROJECTS_PATH,
    ROOT,
    TASKS_PATH,
    TAXONOMY_PATH,
    _acquire_sync_lock,
    _git,
    _git_locked,
    _release_sync_lock,
    dump_json,
    load_json,
    tasks_lock,
)


def _valid_machines() -> set:
    """Valid machine ids. In a consuming org (the published metis-framework) the
    infra_config seam reads them from config/infrastructure.json, so ANY topology
    validates. In the canonical metis-os repo there is no such config -> fall back to
    the real roster. (#434: the seam must not reject a stranger's configured machine.)"""
    try:
        sys.path.insert(0, str(ROOT / "scripts" / "lib"))
        import infra_config  # overlay-provided in metis-framework; absent in metis-os
        # valid_machine_tokens() = canonical ids + declared aliases/users + 'either',
        # so a not-yet-migrated pin (machine='<<MACHINE_2_ID>>') stays valid through the
        # <<MACHINE_2_ID>>-><<MACHINE_2_ID>> rename window (Phase 1) instead of failing validation.
        toks = infra_config.valid_machine_tokens()
        if toks:
            return toks
    except Exception:
        pass
    return {"<<MACHINE_1_ID>>", "<<MACHINE_2_ID>>", "<<MACHINE_2_ID>>", "either"}


VALID_MACHINES = _valid_machines()


def _load_valid_domains():
    """Canonical domains from the SoT (docs/process/taxonomy.yaml); fail-open to the
    known set so a yaml hiccup never blocks a task write."""
    try:
        import yaml
        spec = yaml.safe_load(
            (ROOT / "docs/process/taxonomy.yaml").read_text())
        vals = set((spec.get("domains") or {}).keys())
        return vals or {"systems", "career", "finance", "health", "home", "craft", "presence", "joy"}
    except Exception:
        return {"systems", "career", "finance", "health", "home", "craft", "presence", "joy"}


VALID_DOMAINS = _load_valid_domains()


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
    backwards (the bug in the first smith attempt). Best-effort under an flock: a
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
                # #516: `f"#{num}" in title` is an unanchored substring match — task #46's
                # transition would also match lease title "#465 — ...", re-stamping the
                # WRONG lease's liveness. Require "#NUM" not immediately followed by another
                # digit, so #46 can't match inside #465.
                title_re = _re.compile(rf"#{num}(?!\d)")
                mine = [r for r in data.get("checkouts", [])
                        if (str(r.get("issue")) == num or title_re.search(r.get("title") or ""))
                        and r.get("status") not in _LEASE_TERMINAL]
                if mine:
                    holder = max(mine, key=lambda r: int(r.get("fenceToken", 0) or 0))
                    holder["lastRenewedAt"] = stamp
                    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
    except Exception:
        return  # heartbeat is best-effort; the task state write is authoritative


# Governed paths this CLI touches — a subset of the daemon's STATE_PATHSPECS: the
# canonical JSON plus the markdown projections render-tier1-state.py regenerates.
_COMMIT_PATHSPECS = [
    "docs/process/state/tasks.json",
    "docs/process/state/task-counter.json",
    "docs/process/state/live-focus.json",
    "docs/process/state/projects.json",
    "docs/process/taxonomy.yaml",
    "docs/process/task-queue.md",
    "docs/process/live-status.md",
    "docs/process/projects.md",
    "docs/process/task-naming-convention.md",
    "workspace/state/OPEN_TASKS.md",
]


def render_projections():
    """Regenerate the markdown projections from canonical tasks.json so the working tree is
    NEVER left drifted after a state mutation. The recurring main-health red ("projections
    stale vs tasks.json", render-tier1 diff --exit-code) came from mutators writing tasks.json
    without re-rendering: correct-state/dismiss never rendered, and commit_governed_state did
    it only AFTER acquiring the sync lock — so a busy lock (commit deferred to the daemon)
    skipped the render too, and the daemon then committed tasks.json alone. This runs the
    render WITHOUT the lock (it's a deterministic rewrite of derived files), so tasks.json and
    its projections always move together. Best-effort: a render failure WARNs but never blocks
    the mutation (tasks.json is the source of truth). Skipped under pytest (tests point
    TASKS_PATH at a tmp file; rendering would clobber the real projections)."""
    import subprocess
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    if not (ROOT / ".git").exists():
        return
    render = ROOT / "scripts" / "render-tier1-state.py"
    if not render.exists():
        return
    r = subprocess.run([sys.executable, str(render), "write"], cwd=str(ROOT),
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"WARN: projection render failed: {(r.stderr or '').strip()[:300]}",
              file=sys.stderr)


def commit_governed_state(label):
    """Render projections, then commit the governed-state pathspecs under the daemon's
    sync lock so the mutation is durable the instant it is written. Commit-only (no
    push): a local commit on `main` is already clobber-proof — the daemon pushes it on
    its next tick and the `taskstate` merge driver reconciles any divergence. Never
    raises; returns True iff a commit was actually made."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return False  # never commit the real repo from inside a test run (tests monkeypatch TASKS_PATH to a tmp file; the commit would otherwise sweep unrelated staged changes into a mislabeled task() commit)
    if not (ROOT / ".git").exists():
        return False  # not a real checkout (e.g. a sandbox) — nothing to commit
    render_projections()  # ALWAYS render first — independent of the commit lock, so a busy
    #                       lock (commit deferred to the daemon) still leaves projections in sync
    if not _acquire_sync_lock():
        print("NOTE: sync lock busy — commit deferred to auto-sync daemon (change IS written)",
              file=sys.stderr)
        return False
    try:
        present = [p for p in _COMMIT_PATHSPECS if (ROOT / p).exists()]
        if not present:
            return False
        add = _git_locked("add", "--", *present)
        if add.returncode != 0:
            print(f"WARN: git add failed: {add.stderr.strip()[:300]}; daemon will pick up",
                  file=sys.stderr)
            return False
        if _git("diff", "--cached", "--quiet", "--", *present).returncode == 0:
            return False  # nothing staged (identical content) — clean no-op
        commit = _git_locked("commit", "-m", label, "--", *present)
        if commit.returncode != 0:
            print(f"WARN: git commit failed: {commit.stderr.strip()[:300]}; daemon will pick up",
                  file=sys.stderr)
            return False
        print(f"committed governed state: {label}")
        return True
    finally:
        _release_sync_lock()


def surface_project_context(project_slug, tasks, new_task, stream=sys.stderr):
    """Print the target project's existing milestones + open tasks before a create,
    and WARN when the new task links no milestone though the project has open ones (#972).

    Why: on 2026-07-23 a catch-all epic (#917) was minted that duplicated an
    already-decomposed workstream (#696, #886) because NOTHING surfaced the project's
    existing structure at create time, and the concurrency tasks scattered as
    no-milestone. This makes create-task show the structure the minter is about to add
    to — the same collision problem the project exists to solve, applied to creation.

    Advisory only: milestone-linkage is a WARN, never a hard requirement. Cross-cutting
    tasks and --backfill imports legitimately carry no milestone, so a hard gate would
    break real flows; the warning is enough to catch the accidental no-milestone case.
    Prints to stderr so stdout stays clean for --check JSON / scripted callers."""
    if not project_slug:
        return
    try:
        projects = load_json(PROJECTS_PATH).get("projects", [])
    except Exception:
        return
    proj = next((p for p in projects if p.get("slug") == project_slug), None)
    if not proj:
        return
    milestones = proj.get("milestones") or []
    open_ms = [m for m in milestones if m.get("status") not in ("done",)]
    print(f"\n[create-task] project {project_slug!r} ({proj.get('name', '')}):", file=stream)
    if milestones:
        print("  milestones:", file=stream)
        for m in milestones:
            mark = "done" if m.get("status") == "done" else m.get("status", "")
            print(f"    {m.get('id')}: {m.get('title', '')}  [{mark}]", file=stream)
    else:
        print("  (no milestones defined)", file=stream)
    open_tasks = [
        t for t in tasks
        if isinstance(t, dict)
        and t.get("project") == project_slug
        and t.get("state") not in DUP_TERMINAL_STATES
        and t.get("taskId") != new_task.get("taskId")
    ]
    if open_tasks:
        print(f"  open tasks in project ({len(open_tasks)}):", file=stream)
        for t in sorted(open_tasks, key=lambda x: x.get("taskId") or ""):
            ms = t.get("milestone") or "-"
            print(f"    {t.get('taskId')} [{ms}] {t.get('state')}: {(t.get('title') or '')[:70]}", file=stream)
    # WARN: the project has open milestones but this task links none.
    if open_ms and not (new_task.get("milestone") or "").strip():
        ids = ", ".join(m.get("id") for m in open_ms if m.get("id"))
        print(
            f"  WARN: new task links no milestone, but {project_slug!r} has open "
            f"milestones ({ids}). Link one with \"milestone\": \"M#\" unless this is "
            f"genuinely cross-cutting.",
            file=stream,
        )
    print("", file=stream)


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
    when a value is given. Mirrors the require_rich/--backfill split above.

    #517: collects EVERY violation and raises once — the old first-fail raise made
    callers discover requirements one error at a time (a #909-era create took four
    round-trips: create-required, unknown-field, board-presence, then origin)."""
    errors = []
    if require_present:
        missing = [f for f in BOARD_FIELDS if not task.get(f)]
        if missing:
            errors.append(f"missing required board fields: {', '.join(missing)}")

    area = task.get("area")
    if area is not None:
        valid_areas = load_valid_areas()
        if valid_areas and area not in valid_areas:
            errors.append(
                f"invalid area {area!r} (not in task-areas.json: {', '.join(sorted(valid_areas))})"
            )

    project = task.get("project")
    valid_projects = load_valid_project_slugs()
    if valid_projects:
        if project is None or project == "":
            errors.append(
                f"missing required project field (valid slugs: {', '.join(sorted(valid_projects))})"
            )
        elif project not in valid_projects:
            errors.append(
                f"invalid project slug {project!r} (not in projects.json: {', '.join(sorted(valid_projects))})"
            )

    agent = task.get("agent")
    if agent is not None and agent not in VALID_AGENTS:
        errors.append(f"invalid agent {agent!r} (valid: {', '.join(sorted(VALID_AGENTS))})")
    machine = task.get("machine")
    if machine is not None and machine not in VALID_MACHINES:
        errors.append(f"invalid machine {machine!r} (valid: {', '.join(sorted(VALID_MACHINES))})")

    origin = task.get("origin")
    if require_present and origin is None:
        errors.append(f"missing required field: origin (valid: {', '.join(sorted(VALID_ORIGINS))})")
    if origin is not None and origin not in VALID_ORIGINS:
        errors.append(f"invalid origin {origin!r} (valid: {', '.join(sorted(VALID_ORIGINS))})")

    domain = task.get("domain")
    if domain is not None and domain not in VALID_DOMAINS:
        errors.append(f"invalid domain {domain!r} (valid: {', '.join(sorted(VALID_DOMAINS))})")

    if errors:
        raise ValueError(f"{task_id}: " + "; ".join(errors))


def _donewhen_coverage_nudge(task_id: str, task: dict) -> None:
    """Non-blocking completion-time coverage nudge (#5100 fix-loop). When a task reaches done
    with NO verifiable doneWhen (no runnable check, no acceptance criteria), future
    re-verification cannot mechanically confirm it — the structural root of 'marked done but not
    actually done' (measured: only 18/851 done tasks carried any check). Log the coverage outcome
    so the done-with-a-check rate is measurable over time, and — only for the no-criterion case —
    print a one-line advisory. NEVER raises and NEVER blocks: an acceptance criterion is a
    legitimate choice for manual/behavioral work, so this prompts, it does not gate. Retroactive
    closes skip validate_done_gate entirely, so this fires only on real forward completions."""
    dw = task.get("doneWhen") or {}
    dtype = dw.get("type")
    if dtype in ("check", "both") and str(dw.get("check") or "").strip():
        outcome = "check"
    elif dtype == "acceptance" and (dw.get("criteria") or []):
        outcome = "acceptance"
    else:
        outcome = "none"
    log = os.path.expanduser("~/.openclaw/logs/donewhen-coverage.jsonl")
    try:
        os.makedirs(os.path.dirname(log), exist_ok=True)
        with open(log, "a") as f:
            f.write(json.dumps({"ts": now_iso(), "task": task_id, "coverage": outcome}) + "\n")
    except OSError:
        pass
    if outcome == "none":
        sys.stderr.write(
            f"⚠ doneWhen-coverage: {task_id} is being marked done with no verifiable doneWhen "
            f"(no runnable check, no acceptance criteria) — future re-verification cannot "
            f"confirm it. Add a runnable doneWhen.check where the work is mechanically testable, or "
            f"an explicit acceptance criterion for manual/behavioral work. (advisory, not blocking)\n")


# Ghost-control gate (#8105 follow-up, Ant 2026-10-08: "false or ghost buttons must not pass").
# The mobile New Session task (#7208) closed on a screenshot showing the button rendered; the
# button never actually started a session. A task that ships an interactive UI control must
# prove the control WORKS: something was clicked/tapped/submitted and its effect observed.
# Render evidence (a screenshot, a testid count, "button visible") is necessary, never sufficient.
_UI_CONTROL_RE = re.compile(
    r"\b(button|buttons|control|toggle|tap|click|picker|chooser|dropdown|switch|form|submit|"
    r"cta|menu item|new session|composer|send action)\b", re.IGNORECASE)
_UI_SURFACE_RE = re.compile(
    r"\b(ui|view|page|screen|mobile|pwa|sidebar|header|modal|tab|room|dashboard|cockpit|"
    r"metisterm|metis command|frontend|app)\b", re.IGNORECASE)
_BEHAVIOR_EVIDENCE_RE = re.compile(
    r"\b(click(ed|s)?|tap(ped|s)?|press(ed)?|submit(ted)?|toggled|e2e|end-to-end|"
    r"user flow|round-?trip|interaction test|behavio(u)?ral test)\b", re.IGNORECASE)
_RENDER_ONLY_WAIVER_RE = re.compile(r"\[render-only:\s*[^\]]{12,}\]", re.IGNORECASE)


def ghost_control_violation(task: dict) -> str | None:
    """Pure: return a refusal reason when a UI-control task's verification is render-only."""
    scope = " ".join(str(task.get(k) or "") for k in ("title", "summary", "expectedArtifact"))
    if not (_UI_CONTROL_RE.search(scope) and _UI_SURFACE_RE.search(scope)):
        return None
    vm = str(task.get("verificationMethod") or "")
    if _BEHAVIOR_EVIDENCE_RE.search(vm) or _RENDER_ONLY_WAIVER_RE.search(vm):
        return None
    return ("ships an interactive UI control but verificationMethod shows no behavioral proof "
            "(nothing clicked/tapped/submitted with its effect observed). A rendered button is not "
            "a working button. Exercise the control end-to-end on the live path (e.g. Playwright "
            "click -> assert the effect: request 2xx, state changed, session spawned) and record "
            "that in verificationMethod. Deliberately visual-only work may add "
            "'[render-only: <why no behavior applies>]'.")


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
    ghost = ghost_control_violation(task)
    if ghost:
        raise ValueError(f"{task_id}: done refused (ghost-control gate): {ghost}")
    _donewhen_coverage_nudge(task_id, task)


def create_task(args):
    new_task = parse_patch(args.patch)

    # #5255 (post-mortem D1): before an AUTO-MINT reads any local state, assert this
    # clone's task state isn't behind origin/main (self-healing ff first; refusal names
    # the behind-count and the --allow-stale-mint override). Runs BEFORE load_json so a
    # successful fast-forward is what we then load. Explicit-id creates and --check are
    # exempt — see _mint_freshness_guard for the full rationale.
    if not str(new_task.get("taskId", "")).strip() and not args.check:
        _mint_freshness_guard(getattr(args, "allow_stale_mint", False))

    doc = load_json(TASKS_PATH)
    tasks = doc.get("tasks", [])

    # #517: run EVERY validation gate and report all failures in one message —
    # the old first-fail flow made a caller discover create requirements across
    # four sequential error round-trips (create-required -> unknown-field ->
    # board-presence -> origin, seen live minting the 2026-07-08 incident task).
    errors = []

    missing = sorted(CREATE_TASK_REQUIRED_FIELDS - set(new_task.keys()))
    if missing:
        errors.append(f"missing required fields: {', '.join(missing)}")

    # #6773 forward-gate (warn-first): a task born without a completion contract
    # can never be auto-closed by the nightly needs-verification-drain (Segment A
    # runs doneWhen.check) — that gap is the root of the 2026-09 verification leak
    # (146 shipped-but-unclosed tasks). Nudge every new task toward a doneWhen;
    # non-fatal for now (a hard require would wedge existing callers — hardening +
    # caller audit tracked under #6773) so creation is never blocked.
    _dw = new_task.get("doneWhen")
    if not _dw:
        print(
            "WARN [#6773 forward-gate]: no doneWhen completion contract — defaulting to "
            "{type: acceptance} (human/arbiter-judged, never falsely auto-closed). For "
            "mechanical close by the nightly drain, set type:check + a runnable check.",
            file=sys.stderr,
        )
        # Hardened require without wedging (#6773): rather than reject the ~15 automated
        # callers that omit doneWhen (inbound-watch, frontier-scan, insights, self-heal,
        # notion-intake, ...), default a valid contract so EVERY task is born governable.
        # acceptance routes to the drain's human-verify path (same as the old no-doneWhen
        # behaviour) — no drain/projection behaviour change, just an explicit contract.
        # acceptance requires a non-empty criteria list, so derive one from what the task
        # already says it will deliver (expectedArtifact, else summary).
        _crit = str(new_task.get("expectedArtifact") or new_task.get("summary") or
                    "Delivered per task summary; owner/arbiter confirms").strip()[:300]
        new_task["doneWhen"] = {"type": "acceptance", "criteria": [_crit]}
    elif isinstance(_dw, dict) and _dw.get("type") in ("check", "both") and not str(_dw.get("check") or "").strip():
        print(
            "WARN [#6773 forward-gate]: doneWhen.type is check/both but doneWhen.check "
            "is empty — the drain has nothing to run. Provide a runnable check (exit 0 = done).",
            file=sys.stderr,
        )

    try:
        validate_title("create-task", new_task)
    except ValueError as exc:
        errors.append(str(exc))

    # Canonical taskId form is "#NNN" (see docs/process/task-naming-convention.md).
    # #972: the caller no longer has to pick an id. Omit taskId (or pass "") and
    # create-task auto-mints the next free "#NNN" above the current max — the same
    # monotonic minter milestones/projects already use (_mint_next_id) — which ends
    # the guess-and-collide loop (#828, #918 were guessed already-taken and rejected
    # mid-batch). When a caller DOES supply an id we still coerce a bare number to
    # "#NNN" (alloc-id prints the bare form) and reject anything that isn't "#"+digits,
    # so a forwarded id can't store prefix-less and miss every "#NNN" exact-match lookup.
    raw_id = str(new_task.get("taskId", "")).strip()
    if not raw_id and not args.check:
        raw_id = _alloc_next_task_id(tasks)
    elif not raw_id:
        # --check must not consume the counter (it's a dry run) — preview the id instead.
        raw_id = f"#{_next_task_id() or 1}"
    elif raw_id.isdigit():
        raw_id = "#" + raw_id
    if not re.fullmatch(r"#\d+", raw_id):
        errors.append(
            f"taskId must be '#NNN' (got {new_task.get('taskId')!r}); "
            f"omit it to auto-mint, or prefix the alloc-id number with '#'"
        )
        raw_id = None
    if raw_id:
        new_task["taskId"] = raw_id
        if any(t.get("taskId") == raw_id for t in tasks):
            errors.append(f"task already exists: {raw_id}")
    task_id = raw_id or "create-task"

    unknown = sorted(set(new_task.keys()) - (TASK_MUTABLE_FIELDS | {"taskId"}))
    if unknown:
        errors.append(f"unknown task fields: {', '.join(unknown)}")

    task = copy.deepcopy(new_task)
    task.setdefault("mainFiles", [])
    task.setdefault("nextDecisionPoint", None)
    task["updatedAt"] = now_iso()
    task["updatedBy"] = args.actor
    task["revision"] = 1
    # #285: createdAt is set once, at birth. A --backfill import (or an explicit
    # patch carrying createdAt) preserves the historical value; a fresh create
    # stamps it equal to updatedAt. It is never bumped again (see update_task).
    task["createdAt"] = task.get("createdAt") or task["updatedAt"]

    backfill = getattr(args, "backfill", False)
    for gate in (
        lambda: validate_task_shape(task_id, task, require_rich=not backfill),
        lambda: validate_board_fields(task_id, task, require_present=not backfill),
        lambda: (None if backfill else validate_done_gate(task_id, None, task)),
    ):
        try:
            gate()
        except ValueError as exc:
            errors.append(str(exc))

    # Substrate guard against a runaway auto-minter flooding the board (#986): if an
    # OPEN task already has the same normalized title (digits folded, so "Reconcile 42
    # drift" == "Reconcile 43 drift"), refuse — unless the caller passes
    # --allow-duplicate. The refusal carries a machine-parseable DUPLICATE_OF=<id> so a
    # scripted minter (needs_you.py) can fold the create into that existing ask instead
    # of piling on a near-identical card. --backfill imports skip this (historical dups
    # are real history, and they already commit once at the end).
    if not backfill and not getattr(args, "allow_duplicate", False):
        dup = find_near_duplicate(tasks, new_task.get("title"), exclude_id=raw_id)
        if dup:
            errors.append(
                f"refusing near-duplicate of {dup['taskId']} "
                f"({(dup.get('title') or '')[:60]!r}, state={dup.get('state')}) — same "
                f"normalized title. Update that task instead, or pass --allow-duplicate "
                f"if this is genuinely distinct. [DUPLICATE_OF={dup['taskId']}]"
            )

    if errors:
        raise ValueError(
            "create-task: "
            + "\n  - ".join([""] + errors)
            + "\n  (full field reference: update-tier1-state.py schema)"
        )

    # #972: with validation passed, surface the target project's existing milestones
    # + open tasks (and warn on a no-milestone task) so the minter sees the structure
    # it is adding to — catching duplicate epics / scattered no-milestone tasks at the
    # moment of creation. Advisory (stderr), never blocks; runs for --check too.
    surface_project_context(task.get("project"), tasks, task)

    if args.check:
        print(json.dumps(task, indent=2))
        return

    # #3260: persist with lost-update recovery + a hard on-disk verify. create_task loads the
    # whole tasks.json (above), appends, and writes it back — a read-modify-write. A concurrent
    # create_task in another session that interleaves between our load and our write silently
    # CLOBBERS this task (its write, made from an older snapshot, omits ours). That is exactly
    # how two tasks vanished 2026-08-17: the counter advanced + "Created" printed, but the task
    # was never on disk. Re-read FRESH, append, write, then VERIFY the id is on disk; retry if a
    # racing writer clobbered us, and only claim "Created" once it is genuinely persisted.
    def _persisted() -> bool:
        try:
            d = load_json(TASKS_PATH)
            return any(str(t.get("taskId")) == task_id for t in d.get("tasks", []))
        except Exception:
            return False

    persisted = False
    for _attempt in range(4):
        fresh = load_json(TASKS_PATH)
        ftasks = fresh.setdefault("tasks", [])
        if not any(str(t.get("taskId")) == task_id for t in ftasks):
            ftasks.append(task)
            fresh["updatedAt"] = task["updatedAt"]
            dump_json(TASKS_PATH, fresh)
        if _persisted():
            persisted = True
            break
    if not persisted:
        raise ValueError(
            f"create-task: {task_id} failed to persist after 4 attempts (lost-update race on "
            f"tasks.json) — NOT created. Retry."
        )
    print(f"Created task {task_id} -> revision {task['revision']}")
    _catchup_task_counter(task_id)

    # #447: commit the new task immediately so a daemon sync can't clobber it in the
    # uncommitted window (the root cause of vanished tasks). Default-on for a normal
    # create; skipped for --backfill (bulk migration imports commit once at the end)
    # and when --no-commit is passed (caller batches its own commit).
    # #3260: re-verify AFTER the render+commit too — if that step (or a racing writer) dropped
    # it, re-persist once and surface loudly rather than exiting on a false "Created".
    if not backfill and not getattr(args, "no_commit", False):
        title = (task.get("title") or task.get("summary") or "").strip()
        commit_governed_state(f"task({task_id}): create" + (f" — {title[:60]}" if title else ""))
        if not _persisted():
            fresh = load_json(TASKS_PATH)
            fresh.setdefault("tasks", []).append(task)
            fresh["updatedAt"] = task["updatedAt"]
            dump_json(TASKS_PATH, fresh)
            print(f"WARN: {task_id} vanished after commit — re-persisted; verify on origin",
                  file=sys.stderr)


def _slugify(name):
    s = re.sub(r"[^a-z0-9]+", "-", str(name or "").strip().lower()).strip("-")
    return s or "project"


def _mint_next_id(existing_ids, prefix, pad=0):
    """Next monotonic `<prefix><n>` id (e.g. P20, M4) above the max existing one."""
    nums = []
    for i in existing_ids:
        m = re.fullmatch(re.escape(prefix) + r"(\d+)", str(i or ""))
        if m:
            nums.append(int(m.group(1)))
    n = (max(nums) + 1) if nums else 1
    return f"{prefix}{n:0{pad}d}" if pad else f"{prefix}{n}"


def _set_taxonomy_project_domain(slug, domain):
    """Surgically add `  <slug>: <domain>` under the `project_domain:` block in
    taxonomy.yaml, preserving every comment/line (yaml.safe_dump would strip the
    file's heavy commentary). Idempotent — rewrites the line if the slug already
    maps. The backend re-reads taxonomy.yaml per request, so no restart is needed."""
    lines = TAXONOMY_PATH.read_text().splitlines(keepends=True)
    start = next((i for i, ln in enumerate(lines) if re.match(r"^project_domain:\s*$", ln)), None)
    if start is None:
        raise ValueError("taxonomy.yaml: no project_domain: block to extend")
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if re.match(r"^[A-Za-z0-9_]+:", lines[j]):  # next top-level key ends the block
            end = j
            break
    entry_re = re.compile(r"^\s+" + re.escape(slug) + r":\s*\S")
    for j in range(start + 1, end):
        if entry_re.match(lines[j]):
            lines[j] = f"  {slug}: {domain}\n"
            TAXONOMY_PATH.write_text("".join(lines))
            return
    insert_at = end
    while insert_at - 1 > start and lines[insert_at - 1].strip() == "":
        insert_at -= 1  # keep the mapping inside the block, above trailing blanks
    lines.insert(insert_at, f"  {slug}: {domain}\n")
    TAXONOMY_PATH.write_text("".join(lines))


def create_project(args):
    patch = parse_patch(args.patch)
    name = str(patch.get("name") or "").strip()
    if not name:
        raise ValueError("create-project: 'name' is required")
    priority = str(patch.get("priority") or "P2").strip()
    if priority not in {"P1", "P2", "P3"}:
        raise ValueError(f"create-project: invalid priority {priority!r} (P1/P2/P3)")
    domain = str(patch.get("domain") or "").strip()
    if domain not in VALID_DOMAINS:
        raise ValueError(f"create-project: invalid domain {domain!r} (valid: {', '.join(sorted(VALID_DOMAINS))})")
    goal = str(patch.get("goal") or "").strip() or None
    if goal and (valid_goals := _valid_goals()) and goal not in valid_goals:
        raise ValueError(f"create-project: invalid goal {goal!r} (valid: {', '.join(sorted(valid_goals))})")

    doc = load_json(PROJECTS_PATH)
    projects = doc.get("projects", [])
    project_id = _mint_next_id([p.get("projectId") for p in projects], "P", pad=2)
    base_slug = _slugify(patch.get("slug") or name)
    existing_slugs = {p.get("slug") for p in projects}
    slug, n = base_slug, 2
    while slug in existing_slugs:
        slug, n = f"{base_slug}-{n}", n + 1

    # #852: one timestamp for the whole creation event — the project and every
    # seeded milestone it arrives with are born together.
    created = now_iso()

    # Optional seeded milestones (draft-then-apply auto build-out): a list of
    # {title, doneWhen} minted into M1..Mn so a new project can arrive with a
    # skeleton ladder in one atomic write. Empty-titled entries are dropped.
    seeded = []
    for i, m in enumerate(patch.get("milestones") or [], start=1):
        mt = str((m or {}).get("title") or "").strip()
        if not mt:
            continue
        seeded.append({
            "id": f"M{len(seeded) + 1}",
            "title": mt,
            "doneWhen": str((m or {}).get("doneWhen") or "").strip() or None,
            "status": "todo",
            "weight": 1,
            "fill": 0.0,
            "taskIds": [],
            "createdAt": created,  # #852
            "startedAt": None,     # #852: stamped when status first becomes "active"
            "completedAt": None,
            "dueAt": None,         # #DUE: optional target date; human-set via update-milestone
        })

    record = {
        "projectId": project_id,
        "slug": slug,
        "name": name,
        "goal": goal,
        "status": "active",
        "priority": priority,
        "doneWhen": str(patch.get("doneWhen") or "").strip() or None,
        "scope": str(patch.get("scope") or "").strip() or None,
        "updatedAt": created,
        "createdAt": created,  # #852: a project starts "active" at birth, so createdAt IS its start
        "completedAt": None,   # #852: stamped by update-project on the transition into status=done
        "dueAt": None,         # #DUE: optional coarse target date; human-set via update-project
        "milestones": seeded,
    }
    if args.check:
        print(json.dumps({"project": record, "taxonomy_project_domain": {slug: domain}}, indent=2))
        return

    projects.append(record)
    doc["updatedAt"] = record["updatedAt"]
    dump_json(PROJECTS_PATH, doc)
    _set_taxonomy_project_domain(slug, domain)
    print(f"Created project {project_id} ({slug}) in domain {domain}"
          + (f" with {len(seeded)} seeded milestone(s)" if seeded else ""))
    if not getattr(args, "no_commit", False):
        commit_governed_state(f"project({slug}): create — {name[:60]}")


def create_milestone(args):
    patch = parse_patch(args.patch)
    slug = str(patch.get("projectSlug") or patch.get("project") or "").strip()
    title = str(patch.get("title") or "").strip()
    if not slug or not title:
        raise ValueError("create-milestone: 'projectSlug' and 'title' are required")

    doc = load_json(PROJECTS_PATH)
    projects = doc.get("projects", [])
    proj = next((p for p in projects if p.get("slug") == slug), None)
    if proj is None:
        raise ValueError(f"create-milestone: no project with slug {slug!r}")
    milestones = proj.setdefault("milestones", [])
    mid = _mint_next_id([m.get("id") for m in milestones], "M")

    created = now_iso()  # #852
    record = {
        "id": mid,
        "title": title,
        "doneWhen": str(patch.get("doneWhen") or "").strip() or None,
        "status": "active",
        "weight": int(patch.get("weight") or 1),
        "fill": 0.0,
        "taskIds": [],
        "createdAt": created,   # #852
        "startedAt": created,   # #852: standalone milestones are born "active" — start == birth
        "completedAt": None,
        "dueAt": None,          # #DUE: optional target date; human-set via update-milestone
    }
    if args.check:
        print(json.dumps({"project": slug, "milestone": record}, indent=2))
        return

    milestones.append(record)
    proj["updatedAt"] = now_iso()
    doc["updatedAt"] = proj["updatedAt"]
    dump_json(PROJECTS_PATH, doc)
    print(f"Created milestone {mid} in project {slug}")
    if not getattr(args, "no_commit", False):
        commit_governed_state(f"milestone({slug}/{mid}): create — {title[:60]}")


def _remove_taxonomy_project_domain(slug):
    """Remove the `  <slug>: <domain>` line from taxonomy.yaml's project_domain
    block, preserving every other line/comment. Idempotent (no-op if absent)."""
    lines = TAXONOMY_PATH.read_text().splitlines(keepends=True)
    start = next((i for i, ln in enumerate(lines) if re.match(r"^project_domain:\s*$", ln)), None)
    if start is None:
        return
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if re.match(r"^[A-Za-z0-9_]+:", lines[j]):
            end = j
            break
    entry_re = re.compile(r"^\s+" + re.escape(slug) + r":\s*\S")
    for j in range(start + 1, end):
        if entry_re.match(lines[j]):
            del lines[j]
            TAXONOMY_PATH.write_text("".join(lines))
            return


# projects.json status is a free string; these are the values the UI edit/archive
# paths may set (existing data uses active/paused/blocked/todo/done — we add archived).
VALID_PROJECT_STATUS = {"active", "paused", "blocked", "archived", "done"}


VALID_MILESTONE_STATUS = {"todo", "active", "blocked", "done", "archived"}


# Core fields + the rich project-page fields (#project-overview): summary (pitch),
# areas (pillars grouping milestones), resources/docs/artifacts (link lists),
# dependencies (feedsInto/blockedBy), kpis, checklists. All optional; a project
# with none of them renders exactly as before.
_PROJECT_EDITABLE = {
    "name", "priority", "doneWhen", "scope", "goal", "status", "evergreen", "pulse",
    "summary", "areas", "resources", "docs", "dependencies", "artifacts", "kpis", "checklists",
    "dueAt",  # #DUE: optional HARD target date for the whole project (coarse — a committed ship-by).
}


_PULSE_CADENCES = {"weekly", "monthly", "quarterly"}


_MILESTONE_EDITABLE = {"title", "doneWhen", "weight", "status", "fill", "dueAt"}


def _check_obj_list(field, val, required, allowed):
    """Validate `val` is a list of objects, each carrying `required` keys and no
    key outside `allowed`. Used by the rich project-page list fields."""
    if not isinstance(val, list):
        raise ValueError(f"update-project: '{field}' must be a list of objects")
    for i, it in enumerate(val):
        if not isinstance(it, dict):
            raise ValueError(f"update-project: '{field}[{i}]' must be an object")
        missing = set(required) - set(it)
        if missing:
            raise ValueError(f"update-project: '{field}[{i}]' missing {', '.join(sorted(missing))}")
        extra = set(it) - set(allowed)
        if extra:
            raise ValueError(f"update-project: '{field}[{i}]' unknown key(s): {', '.join(sorted(extra))}")


def _valid_goals():
    """The campaign/goal ids (G1..G6) defined in taxonomy.yaml, or empty if it can't
    be read (in which case goal validation is skipped rather than blocking a create)."""
    try:
        import yaml
        tx = yaml.safe_load(TAXONOMY_PATH.read_text()) or {}
        return set((tx.get("campaigns") or {}).keys())
    except Exception:
        return set()


def _find_project(doc, slug):
    proj = next((p for p in doc.get("projects", []) if p.get("slug") == slug), None)
    if proj is None:
        raise ValueError(f"no project with slug {slug!r}")
    return proj


def update_project(args):
    """Patch editable fields on a project record (name/priority/doneWhen/scope/goal/
    status, plus domain via the taxonomy link). tasks_lock serializes writes — projects
    carry no per-record revision, so the lock is the concurrency guard (like create)."""
    patch = parse_patch(args.patch)
    slug = str(getattr(args, "slug", "") or "").strip()
    if not slug:
        raise ValueError("update-project: --slug is required")
    doc = load_json(PROJECTS_PATH)
    proj = _find_project(doc, slug)

    unknown = set(patch) - _PROJECT_EDITABLE - {"domain"}
    if unknown:
        raise ValueError(f"update-project: non-editable field(s): {', '.join(sorted(unknown))}")
    if "name" in patch and not str(patch["name"]).strip():
        raise ValueError("update-project: 'name' cannot be blank")
    if "priority" in patch and str(patch["priority"]) not in {"P1", "P2", "P3"}:
        raise ValueError(f"update-project: invalid priority {patch['priority']!r} (P1/P2/P3)")
    if "status" in patch and str(patch["status"]) not in VALID_PROJECT_STATUS:
        raise ValueError(
            f"update-project: invalid status {patch['status']!r} (valid: {', '.join(sorted(VALID_PROJECT_STATUS))})"
        )
    if "evergreen" in patch and not isinstance(patch["evergreen"], bool):
        raise ValueError(f"update-project: 'evergreen' must be true/false, got {patch['evergreen']!r}")
    if "pulse" in patch:
        # #712: evergreen catchments carry a cadence health-pulse instead of
        # percent-completion — {cadence: weekly|monthly|quarterly, lastPulseAt: ISO date|null}.
        pl = patch["pulse"]
        if not isinstance(pl, dict) or set(pl) - {"cadence", "lastPulseAt"}:
            raise ValueError("update-project: 'pulse' must be {cadence, lastPulseAt?}")
        if pl.get("cadence") not in _PULSE_CADENCES:
            raise ValueError(
                f"update-project: pulse.cadence must be one of {', '.join(sorted(_PULSE_CADENCES))}, "
                f"got {pl.get('cadence')!r}")
        if pl.get("lastPulseAt") is not None:
            from datetime import datetime
            try:
                datetime.fromisoformat(str(pl["lastPulseAt"]).replace("Z", "+00:00"))
            except ValueError:
                raise ValueError(
                    f"update-project: pulse.lastPulseAt must be an ISO date or null, got {pl['lastPulseAt']!r}")
    # Rich project-page fields (all optional).
    if "summary" in patch and patch["summary"] is not None and not isinstance(patch["summary"], str):
        raise ValueError("update-project: 'summary' must be a string")
    if "areas" in patch:
        _check_obj_list("areas", patch["areas"], {"key", "title"}, {"key", "title", "milestoneIds"})
    if "resources" in patch:
        _check_obj_list("resources", patch["resources"], {"title", "url"}, {"title", "url", "kind"})
    if "docs" in patch:
        _check_obj_list("docs", patch["docs"], {"title", "url"}, {"title", "url", "kind"})
    if "artifacts" in patch:
        _check_obj_list("artifacts", patch["artifacts"], {"title", "url"}, {"title", "url", "kind", "at"})
    if "kpis" in patch:
        _check_obj_list("kpis", patch["kpis"], {"label", "value"}, {"label", "value", "target", "unit"})
    if "checklists" in patch:
        if not isinstance(patch["checklists"], list):
            raise ValueError("update-project: 'checklists' must be a list")
        for i, cl in enumerate(patch["checklists"]):
            if not isinstance(cl, dict) or "title" not in cl or not isinstance(cl.get("items"), list):
                raise ValueError(f"update-project: 'checklists[{i}]' must be {{title, items:[]}}")
            for j, item in enumerate(cl["items"]):
                if not isinstance(item, dict) or "text" not in item:
                    raise ValueError(f"update-project: 'checklists[{i}].items[{j}]' needs 'text'")
    if "dependencies" in patch and patch["dependencies"] is not None:
        dep = patch["dependencies"]
        if not isinstance(dep, dict) or set(dep) - {"feedsInto", "blockedBy", "enables"}:
            raise ValueError("update-project: 'dependencies' must be {feedsInto?, blockedBy?, enables?}")
        for kk in ("feedsInto", "blockedBy", "enables"):
            if kk in dep and not (isinstance(dep[kk], list) and all(isinstance(x, str) for x in dep[kk])):
                raise ValueError(f"update-project: dependencies.{kk} must be a list of project slugs")

    if "dueAt" in patch:
        _validate_iso_date(f"update-project {slug}: dueAt", patch["dueAt"])

    new_domain = None
    if "domain" in patch:
        new_domain = str(patch["domain"]).strip()
        if new_domain not in VALID_DOMAINS:
            raise ValueError(f"update-project: invalid domain {new_domain!r} (valid: {', '.join(sorted(VALID_DOMAINS))})")

    old_status = proj.get("status")
    updated = copy.deepcopy(proj)
    for k in _PROJECT_EDITABLE:
        if k in patch:
            v = patch[k]
            if k == "name":
                v = str(v).strip()
            elif k in {"doneWhen", "scope", "goal"}:
                v = str(v).strip() or None
            updated[k] = v
    updated["updatedAt"] = now_iso()
    # #852: a project starts "active" at birth (createdAt covers start); completedAt
    # is the one system-stamped end, mirroring task/milestone completedAt.
    new_status = updated.get("status")
    if new_status == "done" and old_status != "done" and not updated.get("completedAt"):
        updated["completedAt"] = updated["updatedAt"]
    elif new_status in ("active", "blocked") and old_status == "done":
        updated["completedAt"] = None  # genuinely reopened, not archived — the stamp is no longer true

    if args.check:
        print(json.dumps({"project": updated, "domain": new_domain}, indent=2))
        return

    proj.clear()
    proj.update(updated)
    doc["updatedAt"] = updated["updatedAt"]
    dump_json(PROJECTS_PATH, doc)
    if new_domain:
        _set_taxonomy_project_domain(slug, new_domain)
    print(f"Updated project {slug}")
    if not getattr(args, "no_commit", False):
        commit_governed_state(f"project({slug}): update")


def archive_project(args):
    """Soft-remove: status -> archived. Reversible (update-project status=active),
    keeps the record + any linked tasks/milestones intact. The safe default over delete."""
    slug = str(getattr(args, "slug", "") or "").strip()
    if not slug:
        raise ValueError("archive-project: --slug is required")
    doc = load_json(PROJECTS_PATH)
    proj = _find_project(doc, slug)
    if args.check:
        print(json.dumps({"archive_project": slug, "status": "archived"}, indent=2))
        return
    proj["status"] = "archived"
    proj["updatedAt"] = now_iso()
    doc["updatedAt"] = proj["updatedAt"]
    dump_json(PROJECTS_PATH, doc)
    print(f"Archived project {slug}")
    if not getattr(args, "no_commit", False):
        commit_governed_state(f"project({slug}): archive")


def delete_project(args):
    """Hard-delete a project record + its taxonomy link — but ONLY when empty (no
    milestones and no tasks reference it), so nothing is orphaned. For a fat-finger
    mistaken create. Anything with content must be archived instead."""
    slug = str(getattr(args, "slug", "") or "").strip()
    if not slug:
        raise ValueError("delete-project: --slug is required")
    doc = load_json(PROJECTS_PATH)
    proj = _find_project(doc, slug)
    milestones = proj.get("milestones") or []
    if milestones:
        raise ValueError(
            f"delete-project: {slug} has {len(milestones)} milestone(s) — archive it, or delete the milestones first"
        )
    tdoc = load_json(TASKS_PATH)
    # 'dropped' tasks are explicitly discarded — they don't pin the project alive.
    refs = [t.get("taskId") for t in tdoc.get("tasks", []) if t.get("project") == slug and t.get("state") != "dropped"]
    if refs:
        raise ValueError(
            f"delete-project: {slug} is referenced by {len(refs)} live task(s) (e.g. {refs[0]}) — archive it instead"
        )
    if args.check:
        print(json.dumps({"delete_project": slug, "empty": True}, indent=2))
        return
    doc["projects"] = [p for p in doc.get("projects", []) if p.get("slug") != slug]
    doc["updatedAt"] = now_iso()
    dump_json(PROJECTS_PATH, doc)
    _remove_taxonomy_project_domain(slug)
    print(f"Deleted project {slug}")
    if not getattr(args, "no_commit", False):
        commit_governed_state(f"project({slug}): delete (empty)")


def _find_milestone(doc, slug, mid):
    proj = _find_project(doc, slug)
    ms = next((m for m in proj.get("milestones", []) if m.get("id") == mid), None)
    if ms is None:
        raise ValueError(f"no milestone {mid} in project {slug!r}")
    return proj, ms


def update_milestone(args):
    patch = parse_patch(args.patch)
    slug = str(getattr(args, "slug", "") or "").strip()
    mid = str(getattr(args, "milestone_id", "") or "").strip()
    if not slug or not mid:
        raise ValueError("update-milestone: --slug and --milestone-id are required")
    doc = load_json(PROJECTS_PATH)
    proj, ms = _find_milestone(doc, slug, mid)

    unknown = set(patch) - _MILESTONE_EDITABLE
    if unknown:
        raise ValueError(f"update-milestone: non-editable field(s): {', '.join(sorted(unknown))}")
    if "title" in patch and not str(patch["title"]).strip():
        raise ValueError("update-milestone: 'title' cannot be blank")
    if "status" in patch and str(patch["status"]) not in VALID_MILESTONE_STATUS:
        raise ValueError(
            f"update-milestone: invalid status {patch['status']!r} (valid: {', '.join(sorted(VALID_MILESTONE_STATUS))})"
        )
    if "fill" in patch:
        # #712: fill is the audited health/partial-credit signal (contract §7) — the
        # pulse pass writes it here instead of hand-editing projects.json.
        try:
            fill = float(patch["fill"])
        except (TypeError, ValueError):
            raise ValueError(f"update-milestone: 'fill' must be a number 0..1, got {patch['fill']!r}")
        if not 0.0 <= fill <= 1.0:
            raise ValueError(f"update-milestone: 'fill' must be within 0..1, got {fill}")
        if ms.get("status") == "done":
            raise ValueError("update-milestone: 'fill' only applies to non-done milestones (contract §5)")
    if "dueAt" in patch:
        _validate_iso_date(f"update-milestone {slug}/{mid}: dueAt", patch["dueAt"])

    old_status = ms.get("status")
    updated = copy.deepcopy(ms)
    for k in _MILESTONE_EDITABLE:
        if k in patch:
            v = patch[k]
            if k == "title":
                v = str(v).strip()
            elif k == "doneWhen":
                v = str(v).strip() or None
            elif k == "weight":
                v = int(v)
            elif k == "fill":
                v = float(v)
            updated[k] = v

    # #852: system-stamped start/end, not user-editable via patch — a status
    # change is what moves them, mirroring task startedAt/completedAt (#285/#852).
    new_status = updated.get("status")
    stamp = now_iso()
    if new_status == "active" and old_status != "active" and not updated.get("startedAt"):
        updated["startedAt"] = stamp
    if new_status == "done" and old_status != "done" and not updated.get("completedAt"):
        updated["completedAt"] = stamp
    elif new_status in ("todo", "active", "blocked") and old_status == "done":
        updated["completedAt"] = None  # genuinely reopened, not archived — the stamp is no longer true

    if args.check:
        print(json.dumps({"project": slug, "milestone": updated}, indent=2))
        return

    ms.clear()
    ms.update(updated)
    proj["updatedAt"] = now_iso()
    doc["updatedAt"] = proj["updatedAt"]
    dump_json(PROJECTS_PATH, doc)
    print(f"Updated milestone {slug}/{mid}")
    if not getattr(args, "no_commit", False):
        commit_governed_state(f"milestone({slug}/{mid}): update")


def archive_milestone(args):
    slug = str(getattr(args, "slug", "") or "").strip()
    mid = str(getattr(args, "milestone_id", "") or "").strip()
    if not slug or not mid:
        raise ValueError("archive-milestone: --slug and --milestone-id are required")
    doc = load_json(PROJECTS_PATH)
    proj, ms = _find_milestone(doc, slug, mid)
    if args.check:
        print(json.dumps({"archive_milestone": f"{slug}/{mid}", "status": "archived"}, indent=2))
        return
    ms["status"] = "archived"
    proj["updatedAt"] = now_iso()
    doc["updatedAt"] = proj["updatedAt"]
    dump_json(PROJECTS_PATH, doc)
    print(f"Archived milestone {slug}/{mid}")
    if not getattr(args, "no_commit", False):
        commit_governed_state(f"milestone({slug}/{mid}): archive")


def delete_milestone(args):
    """Hard-delete a milestone — ONLY when it holds no tasks (taskIds empty and no
    task's milestone points at it), so no task is orphaned. Else archive it."""
    slug = str(getattr(args, "slug", "") or "").strip()
    mid = str(getattr(args, "milestone_id", "") or "").strip()
    if not slug or not mid:
        raise ValueError("delete-milestone: --slug and --milestone-id are required")
    doc = load_json(PROJECTS_PATH)
    proj, ms = _find_milestone(doc, slug, mid)
    tdoc = load_json(TASKS_PATH)
    dropped = {t.get("taskId") for t in tdoc.get("tasks", []) if t.get("state") == "dropped"}
    task_ids = [tid for tid in (ms.get("taskIds") or []) if tid not in dropped]  # dropped tasks don't pin the milestone
    refs = [t.get("taskId") for t in tdoc.get("tasks", []) if t.get("milestone") == mid and t.get("project") == slug and t.get("state") != "dropped"]
    if task_ids or refs:
        n = len(set(task_ids) | set(refs))
        raise ValueError(f"delete-milestone: {slug}/{mid} holds {n} live task(s) — archive it, or move the tasks first")
    if args.check:
        print(json.dumps({"delete_milestone": f"{slug}/{mid}", "empty": True}, indent=2))
        return
    proj["milestones"] = [m for m in proj.get("milestones", []) if m.get("id") != mid]
    proj["updatedAt"] = now_iso()
    doc["updatedAt"] = proj["updatedAt"]
    dump_json(PROJECTS_PATH, doc)
    print(f"Deleted milestone {slug}/{mid}")
    if not getattr(args, "no_commit", False):
        commit_governed_state(f"milestone({slug}/{mid}): delete (empty)")


def reassign_task(args):
    """Move a task between milestones within its project, or unassign it. Milestone
    membership for the Plan drill is authoritative in each milestone's taskIds[]
    (the projection ignores task.milestone), so this edits taskIds; it also keeps
    the secondary task.milestone field in sync. --unassign removes it from all."""
    task_id = args.task_id.strip()
    slug = args.project.strip()
    target = None if args.unassign else str(args.to_milestone or "").strip()
    if not args.unassign and not target:
        raise ValueError("reassign-task: pass --to-milestone <M#> or --unassign")

    doc = load_json(PROJECTS_PATH)
    proj = _find_project(doc, slug)
    milestones = proj.get("milestones") or []
    if target and not any(m.get("id") == target for m in milestones):
        raise ValueError(f"reassign-task: no milestone {target} in project {slug!r}")

    if args.check:
        print(json.dumps({"reassign": task_id, "project": slug, "to": target or "unassigned"}, indent=2))
        return

    for m in milestones:
        tids = m.get("taskIds") or []
        if task_id in tids:
            m["taskIds"] = [x for x in tids if x != task_id]
    if target:
        tgt = next(m for m in milestones if m.get("id") == target)
        tgt.setdefault("taskIds", [])
        if task_id not in tgt["taskIds"]:
            tgt["taskIds"].append(task_id)
    proj["updatedAt"] = now_iso()
    doc["updatedAt"] = proj["updatedAt"]
    dump_json(PROJECTS_PATH, doc)

    # Keep the secondary task.milestone field consistent (few readers use it).
    tdoc = load_json(TASKS_PATH)
    for t in tdoc.get("tasks", []):
        if t.get("taskId") == task_id:
            if target:
                t["milestone"] = target
            else:
                t.pop("milestone", None)
            t["updatedAt"] = now_iso()
            tdoc["updatedAt"] = t["updatedAt"]
            dump_json(TASKS_PATH, tdoc)
            break

    print(f"Reassigned {task_id} -> {target or 'unassigned'} in {slug}")
    if not getattr(args, "no_commit", False):
        commit_governed_state(f"task({task_id}): milestone -> {target or 'unassigned'} ({slug})")


def cascade_unblock_dependents(tasks, resolved_tid, actor):
    """When ``resolved_tid`` ENTERS done, clear references to it in other tasks'
    ``blockerOrNone`` so dependents that were only waiting on it become unblocked.

    Folds the Notion Command Center writeback's ``cascade_unblock`` INTO the shared mutator
    (#notion-independence Phase 2): both callers of update-tier1-state.py — the Notion card
    writeback AND the dashboard's governed decide/transition routes (the native Metis Command
    inbox) — now unblock dependents identically, so approving a task in the app matches
    approving it in Notion. Operates on the in-memory ``tasks`` list (same list the caller
    dump_json's), bumping each cleared dependent's revision so the JSONL merge driver reconciles
    it. A dependent that would become invalid with the blocker removed is left untouched (logged)
    rather than written broken. Returns the list of cleared task ids.
    """
    def _norm_ref(s):
        return "#" + str(s).strip().lstrip("#")
    target = _norm_ref(resolved_tid)              # e.g. "#10"
    cleared = []
    for t in tasks:
        tid = t.get("taskId")
        if tid == resolved_tid or t.get("state") == "done":
            continue
        blk = (t.get("blockerOrNone") or "").strip()
        if not blk or blk.lower() == "none":
            continue
        # blockerOrNone is structural: "none" or a comma/semicolon list of task-id refs. Match
        # EXACT ref tokens (so resolving #10 never strips #100), and leave a prose blocker that
        # isn't a clean id list untouched (conservative — never mangle text we can't parse).
        parts = [p.strip() for p in re.split(r"[,;]", blk) if p.strip()]
        norm_parts = [_norm_ref(p) for p in parts]
        if target not in norm_parts:
            continue
        kept = [p for p, npart in zip(parts, norm_parts) if npart != target]
        new_blk = ", ".join(kept) if kept else "none"
        if new_blk == blk:
            continue
        candidate = copy.deepcopy(t)
        candidate["blockerOrNone"] = new_blk
        # Only rewrite if the dependent stays valid without the blocker — never persist a
        # broken task as a side effect of unblocking (parity with the Notion path, which
        # validates via task-update).
        try:
            validate_task_shape(tid, candidate)
            validate_board_fields(tid, candidate, require_present=False)
        except ValueError as e:
            print(f"  cascade: SKIP {tid} (clearing {resolved_tid} would invalidate it: {e})",
                  file=sys.stderr)
            continue
        t["blockerOrNone"] = new_blk
        t["updatedAt"] = now_iso()
        t["updatedBy"] = actor
        t["updatedBySession"] = _current_session()
        t["revision"] = t.get("revision", 0) + 1
        cleared.append(tid)
        print(f"  cascade: unblock {tid} (was blocked on {resolved_tid})", file=sys.stderr)
    return cleared


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

    _state_overlap_warn(task, args.actor)

    patch = parse_patch(args.patch)
    validate_task_patch(args.task_id, patch)
    _enforce_append_only(args.task_id, task, patch)

    new_task = copy.deepcopy(task)
    new_task.update(patch)
    validate_state_transition(args.task_id, task.get("state"), new_task.get("state"))
    new_task["updatedAt"] = now_iso()
    new_task["updatedBy"] = args.actor
    new_task["updatedBySession"] = _current_session()
    new_task["revision"] = task.get("revision", 0) + 1
    # #285: createdAt is immutable once born — preserve the original even if a
    # patch tried to carry one. completedAt stamps the FIRST entry into done so
    # cycle-time (completedAt - createdAt) is computable.
    if task.get("createdAt"):
        new_task["createdAt"] = task["createdAt"]
    # #852: startedAt stamps the FIRST entry into in_progress (a task can leave and
    # re-enter in_progress via waiting/blocked/failed — only the first counts as when
    # work actually began), so cycle-time can split queued-wait from active-work.
    if new_task.get("state") == "in_progress" and task.get("state") != "in_progress" and not new_task.get("startedAt"):
        new_task["startedAt"] = new_task["updatedAt"]
    if new_task.get("state") == "done" and task.get("state") != "done" and not new_task.get("completedAt"):
        new_task["completedAt"] = new_task["updatedAt"]
    _reset_reject_streak_on_reactivate(new_task, task.get("state"), patch)
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
    # When this update lands the task in done, unblock its dependents in the SAME write
    # (parity with the Notion Command Center cascade — see cascade_unblock_dependents).
    if new_task.get("state") == "done" and task.get("state") != "done":
        cascade_unblock_dependents(tasks, args.task_id, args.actor)
    doc["updatedAt"] = new_task["updatedAt"]
    dump_json(TASKS_PATH, doc)
    restamp_lease_on_transition(args.task_id, task.get("state"), new_task.get("state"))
    print(f"Updated task {args.task_id} -> revision {new_task['revision']}")

    # #447: opt-in atomic commit for important manual updates. Off by default so the
    # queue-runner's high-frequency state transitions don't generate a commit storm —
    # updates patch an EXISTING task (merge driver reconciles fields by revision), a far
    # less catastrophic loss than a vanished create. Pass --commit to make it durable now.
    if getattr(args, "commit", False):
        commit_governed_state(f"task({args.task_id}): update -> r{new_task['revision']}")


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

    _state_overlap_warn(task, args.actor)

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
    new_task["updatedBySession"] = _current_session()
    new_task["revision"] = task.get("revision", 0) + 1
    # #285: keep completedAt honest across a correction — stamp it when a
    # correction lands a task in done (e.g. retroactive close), and clear a stale
    # one if a correction pulls a task back out of done.
    if task.get("createdAt"):
        new_task["createdAt"] = task["createdAt"]
    # #852: keep startedAt honest across a correction too, mirroring completedAt.
    if args.to_state == "in_progress" and not new_task.get("startedAt"):
        new_task["startedAt"] = correction["at"]
    if args.to_state == "done":
        new_task.setdefault("completedAt", correction["at"])
        new_task.setdefault("startedAt", correction["at"])
    elif old_state == "done":
        new_task.pop("completedAt", None)
    # #2237: un-parking a give-up task via correct-state (blocked -> queued/in_progress) is
    # the human "re-enable it" action — clear the reject streak so the breaker re-admits it.
    _reset_reject_streak_on_reactivate(new_task, old_state)
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
    # A correction that lands the task in done unblocks its dependents too (parity with the
    # Notion Command Center cascade — see cascade_unblock_dependents).
    if args.to_state == "done" and old_state != "done":
        cascade_unblock_dependents(tasks, args.task_id, args.actor)
    doc["updatedAt"] = new_task["updatedAt"]
    dump_json(TASKS_PATH, doc)
    restamp_lease_on_transition(args.task_id, old_state, args.to_state)
    render_projections()  # keep projections in lock-step so a correction never leaves drift red
    print(f"Corrected task {args.task_id}: {old_state} -> {args.to_state} (revision {new_task['revision']})")


def dismiss_task(args):
    """Drop an untriaged suggestion (#417) — terminal 'dropped', honest by design.

    Auto-filed insight/inbox suggestions (insights-to-board.py) that triage judges
    not-worth-doing had no cull path: 'done' is hard-gated to needs_verification +
    rich artifacts, so the only way to clear them was to FABRICATE a completion that
    never happened. 'dropped' is a distinct terminal state meaning triaged-and-
    discarded — no work occurred, so no rich fields are required. Only valid from a
    pre-work state (inbox/queued); real work in flight must use blocked/failed or an
    audited correct-state, never a silent drop. Requires --reason; audited in
    stateCorrections[] like correct-state so the discard is explicit, not a backdoor.
    """
    reason = (args.reason or "").strip()
    if not reason:
        raise ValueError("dismiss requires a non-empty --reason")

    doc = load_json(TASKS_PATH)
    tasks = doc.get("tasks", [])
    task = next((t for t in tasks if t.get("taskId") == args.task_id), None)
    if task is None:
        raise ValueError(f"task not found: {args.task_id}")
    if task.get("revision") != args.expected_revision:
        raise ValueError(
            f"{args.task_id}: revision mismatch (expected {args.expected_revision}, found {task.get('revision')})"
        )
    _state_overlap_warn(task, args.actor)

    old_state = task.get("state")
    if old_state not in DISMISSABLE_STATES:
        raise ValueError(
            f"{args.task_id}: dismiss only allowed from {sorted(DISMISSABLE_STATES)} "
            f"(state is {old_state!r}); real work in flight uses blocked/failed/correct-state"
        )

    correction = {
        "from": old_state,
        "to": "dropped",
        "reason": reason,
        "actor": args.actor,
        "at": now_iso(),
        "dismissed": True,
    }
    new_task = copy.deepcopy(task)
    new_task["state"] = "dropped"
    new_task["blockerOrNone"] = "none"
    new_task["nextAction"] = "none"
    new_task.setdefault("stateCorrections", []).append(correction)
    new_task["updatedAt"] = correction["at"]
    new_task["updatedBy"] = args.actor
    new_task["updatedBySession"] = _current_session()
    new_task["revision"] = task.get("revision", 0) + 1
    if task.get("createdAt"):
        new_task["createdAt"] = task["createdAt"]
    new_task.setdefault("droppedAt", correction["at"])
    # Shape still applies (taskId/title/etc.); the done-gate does NOT — dropped is
    # not done, and RICH_REQUIRED_STATES excludes it, so no fabricated artifacts.
    validate_task_shape(args.task_id, new_task)

    if args.check:
        print(json.dumps(new_task, indent=2, ensure_ascii=False))
        return

    for idx, candidate in enumerate(tasks):
        if candidate.get("taskId") == args.task_id:
            tasks[idx] = new_task
            break
    doc["updatedAt"] = new_task["updatedAt"]
    dump_json(TASKS_PATH, doc)
    restamp_lease_on_transition(args.task_id, old_state, "dropped")
    render_projections()  # keep projections in lock-step so a dismiss never leaves drift red
    print(f"Dismissed task {args.task_id}: {old_state} -> dropped (revision {new_task['revision']})")


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


def _catchup_task_counter(task_id):
    """Keep task-counter.json monotonic vs the ids actually created (#647/I6).
    create-task accepts any unused '#NNN', so a caller that mints an id by eye
    (instead of agent-work.py alloc-id) lands a task ABOVE lastAssigned and the
    counter 'regresses' — the recurring I6 drift. After a successful create,
    catch the counter up under the same flock alloc-id uses. Best-effort: the
    governed write already landed; a counter hiccup must never fail the create."""
    try:
        import fcntl
        m = re.search(r"\d+", str(task_id) or "")
        if not m:
            return
        num = int(m.group(0))
        # Derive from TASKS_PATH, not ROOT: tests monkeypatch TASKS_PATH into a tmp
        # sandbox, and resolving the counter against ROOT wrote the CANONICAL
        # counter from those sandboxes — test_planref's fixture id #901 bumped the
        # real sequence 648->901 on 2026-07-08, burning ids 668-901 (#912, the
        # #283 split-brain class). Following the store keeps sandbox writes
        # sandboxed; in prod both files live in docs/process/state/ as before.
        counter_path = TASKS_PATH.parent / "task-counter.json"
        lock_path = counter_path.with_suffix(".json.lock")
        with lock_path.open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            doc = json.loads(counter_path.read_text())
            if num > int(doc.get("lastAssigned", 0)):
                doc["lastAssigned"] = num
                doc["updatedAt"] = now_iso()
                counter_path.write_text(json.dumps(doc, indent=2) + "\n")
    except Exception:
        pass


def _next_task_id():
    """Next id WITHOUT consuming it (preview only). The atomic allocator that
    actually bumps the counter is `agent-work.py alloc-id`."""
    try:
        counter = json.loads((ROOT / "docs/process/state/task-counter.json").read_text())
        return int(counter.get("lastAssigned", 0)) + 1
    except (OSError, ValueError):
        return None


def _strided_task_id(floor):
    """Next id after `floor` in THIS machine's residue lane (#1246 cross-clone collision
    prevention). Falls back to floor+1 (legacy) if the stride helper or topology is
    unavailable — a strict no-op, so minting never breaks on an import/config hiccup."""
    try:
        sys.path.insert(0, str(ROOT / "scripts" / "lib"))
        from task_id_alloc import machine_stride, strided_next
        residue, modulus = machine_stride()
        return strided_next(floor, residue, modulus)
    except Exception:
        return floor + 1


def _alloc_next_task_id(tasks):
    """Atomically allocate the next free '#NNN' when create-task is called with no id
    (#972 — the caller no longer guesses). Consumes task-counter.json under the SAME
    flock agent-work.py alloc-id and _catchup_task_counter use, so a concurrent alloc-id
    and an auto-mint can never hand out the same number. Also jumps past any task id
    already ABOVE the counter (an eye-minted create that outran lastAssigned — the I6
    drift class) so the returned id is free in BOTH the counter and tasks.json. Counter
    path derives from TASKS_PATH (not ROOT) so tests' tmp sandboxes stay sandboxed, per
    _catchup_task_counter. Falls back to a pure tasks-scan mint if the counter is
    unavailable (fresh sandbox / missing file)."""
    max_task = 0
    for t in tasks:
        if not isinstance(t, dict):
            continue
        m = re.fullmatch(r"#(\d+)", str(t.get("taskId") or ""))
        if m:
            max_task = max(max_task, int(m.group(1)))
    try:
        import fcntl
        counter_path = TASKS_PATH.parent / "task-counter.json"
        lock_path = counter_path.with_suffix(".json.lock")
        with lock_path.open("w") as lock:  # per-clone lock OUTER
            fcntl.flock(lock, fcntl.LOCK_EX)
            doc = json.loads(counter_path.read_text())
            clone_floor = max(int(doc.get("lastAssigned", 0)), max_task)
            # host-global floor INNER (#1247): serialize against sibling worktrees on this host
            # so two clones sharing a residue lane can't hand out the same id between syncs. Strict
            # no-op (== _strided_task_id(clone_floor)) when the host counter is unavailable.
            def _mint(eff):
                n = _strided_task_id(eff)
                return n, n  # (result, new_high_water)
            try:
                sys.path.insert(0, str(ROOT / "scripts" / "lib"))
                from task_id_alloc import with_host_floor
                nxt = with_host_floor(clone_floor, _mint)
            except Exception:
                nxt = _strided_task_id(clone_floor)
            doc["lastAssigned"] = nxt
            doc["updatedAt"] = now_iso()
            counter_path.write_text(json.dumps(doc, indent=2) + "\n")
        return f"#{nxt}"
    except Exception:
        return f"#{max_task + 1}"


def _mint_freshness_guard(allow_stale: bool = False):
    """#5255 (2026-08-15 post-mortem, incident D1): refuse to auto-mint a task id from
    a clone whose TASK STATE is behind origin/main.

    The incident: a session auto-minted on a clone 91 commits behind origin (wedged
    ff-sync), so the next-free id was computed against stale tasks.json/
    task-counter.json and the taskstate merge driver later renumbered four
    freshly-minted ids (#2748->#2764 etc). Nothing made minting refuse on a behind
    clone — this guard does, BEFORE the counter is consumed.

    Behavior (fast + offline-safe by design):
      1. Freshen best-effort by REUSING pull-source-on-demand.sh (#2097 C3 — ff-only,
         dirty-safe, fail-soft, kill-switched): a cleanly-behind tree self-heals here,
         so the guard never nags on the healthy path even though origin advances every
         few minutes under fleet auto-sync. Plain `git fetch origin main` if the script
         is missing. Freshen failure (offline/timeout) degrades to a LOUD stderr
         warning, never a crash — we still measure against the last-known origin/main
         (the incident clone knew it was 91 behind with no network at all).
      2. Measure: commits in HEAD..origin/main touching tasks.json/task-counter.json.
         Scoped to those two files on purpose: lag on unrelated code cannot stale the
         mint counter, and a total-behind refusal would fire near-constantly between
         sync ticks, breeding --allow-stale-mint reflexes that kill the guard.
      3. Still behind after the heal attempt (wedged/dirty/diverged tree — exactly the
         incident condition) -> refuse with the behind-count, unless --allow-stale-mint
         downgrades the refusal to a loud warning.

    Exemptions (documented judgment calls):
      * explicit-taskId creates are exempt — they never read the stale counter, the
        local "task already exists" check still runs, and the taskstate merge driver
        covers the cross-clone id-collision on merge; the incident class was
        counter-based auto-mint. --check is exempt too (dry run, consumes nothing).
      * not a git repo / no origin/main ref (hermetic test sandboxes, fresh clones)
        -> silent skip.
      * METIS_SKIP_MINT_FRESHNESS=1 skips the whole guard (emergency hatch);
        OPENCLAW_PULL_ON_DEMAND=0 skips just the freshen leg (mirrors the pull
        script's own kill switch without spawning it).
    """
    import subprocess
    if os.environ.get("METIS_SKIP_MINT_FRESHNESS") == "1":
        return
    # Derive the repo from TASKS_PATH (not ROOT): tests sandbox TASKS_PATH into tmp
    # dirs (no repo -> guard self-disarms), per the _catchup_task_counter precedent.
    state_dir = str(TASKS_PATH.parent)

    def _g(*a, timeout=10):
        return subprocess.run(["git", *a], cwd=state_dir,
                              capture_output=True, text=True, timeout=timeout)

    try:
        p = _g("rev-parse", "--is-inside-work-tree")
        if p.returncode != 0 or p.stdout.strip() != "true":
            return
    except Exception:
        return

    freshen_err = None
    try:
        if os.environ.get("OPENCLAW_PULL_ON_DEMAND") == "0":
            freshen_err = "pull-on-demand disabled (OPENCLAW_PULL_ON_DEMAND=0)"
        else:
            script = ROOT / "scripts" / "pull-source-on-demand.sh"
            if script.exists():
                subprocess.run(["bash", str(script), state_dir],
                               capture_output=True, text=True, timeout=45)
            else:
                p = _g("fetch", "--quiet", "origin", "main", timeout=15)
                if p.returncode != 0:
                    freshen_err = (p.stderr or "").strip() or f"git fetch exited {p.returncode}"
    except Exception as exc:  # timeout/offline — degrade, never hard-block minting
        freshen_err = str(exc)
    if freshen_err:
        print(f"WARN: mint-freshness: could not freshen against origin ({freshen_err}) "
              f"— checking against last-known origin/main", file=sys.stderr)

    try:
        p = _g("rev-list", "--count", "HEAD..origin/main", "--",
               "tasks.json", "task-counter.json")
        if p.returncode != 0:
            return  # no origin/main to compare against (sandbox / offline fresh clone)
        state_behind = int(p.stdout.strip() or 0)
        p2 = _g("rev-list", "--count", "HEAD..origin/main")
        total_behind = int(p2.stdout.strip() or 0) if p2.returncode == 0 else state_behind
    except Exception:
        return
    if state_behind <= 0:
        return
    msg = (
        f"this clone is BEHIND origin/main by {state_behind} task-state commit(s) "
        f"({total_behind} behind total) and could not be fast-forwarded — auto-minting "
        f"here computes the next-free id against stale tasks.json/task-counter.json "
        f"(the 2026-08-15 D1 renumber-against-stale-counter class). Bring the tree "
        f"current (scripts/pull-source-on-demand.sh, or unwedge the dirty/diverged "
        f"tree), pass an explicit alloc-id taskId, or override with --allow-stale-mint."
    )
    if allow_stale:
        print(f"WARN: mint-freshness OVERRIDDEN (--allow-stale-mint): {msg}",
              file=sys.stderr)
        return
    raise ValueError(f"create-task: refusing auto-mint — {msg}")


def _valid_values_map():
    """The valid-enum map, read LIVE from the canonical sources. One source of truth
    shared by `schema`, `enums`, and `requirements` so a new/renamed enum can never
    drift between them (#1695 R3)."""
    return {
        "priority": ["P1", "P2", "P3"],
        "state": sorted(VALID_TASK_STATES),
        "origin": sorted(VALID_ORIGINS),
        "agent": sorted(VALID_AGENTS),
        "machine": sorted(VALID_MACHINES),
        "domain": sorted(VALID_DOMAINS),
        "area": sorted(load_valid_areas()),
        "project": sorted(load_valid_project_slugs()),
        "owner": sorted(VALID_AGENTS),  # owner shares the agent vocabulary
        "doneWhen.type": sorted(VALID_DONEWHEN_TYPES),
    }


def _states_entering(target):
    """Legal predecessor states — every state whose transition set contains target."""
    return sorted(s for s, outs in ALLOWED_STATE_TRANSITIONS.items() if target in outs)


# ── Lease-lifecycle bridge (#922, re-landed #8025) ─────────────────────────────
# The lease lifecycle (active-checkouts.json) and the governed task-state machine (tasks.json)
# are parallel state machines; without this, `finish --merge` closes the lease and merges the
# code but the task keeps reading `queued` and a sibling can re-build it. The original #922
# bridge was dropped by a conflict resolution in the 2026-08-06 origin/main merges; re-landed
# 2026-10-08. A lease event drives tasks.json forward atomically over the shortest legal path.
LIFECYCLE_TARGET = {"claimed": "in_progress", "finished": "needs_verification"}
_LIFECYCLE_NOOP_STATES = {"done", "dropped", "archived"}


def _shortest_state_path(start, target):
    """BFS over ALLOWED_STATE_TRANSITIONS: hops from start to target (excl. start, incl.
    target). [] when start == target or there is no legal route."""
    if start == target:
        return []
    from collections import deque
    q, seen = deque([(start, [])]), {start}
    while q:
        cur, path = q.popleft()
        for nxt in sorted(ALLOWED_STATE_TRANSITIONS.get(cur, ())):
            if nxt in seen:
                continue
            npath = path + [nxt]
            if nxt == target:
                return npath
            seen.add(nxt)
            q.append((nxt, npath))
    return []


def _fill_lifecycle_rich(task, event):
    """Fill only MISSING rich fields so the auto-advance validates; never clobber a value the
    session set (finish does refresh currentStep/nextAction, which describe the new state)."""
    if not task.get("blockerOrNone"):
        task["blockerOrNone"] = "none"
    if not task.get("verificationMethod"):
        task["verificationMethod"] = "manual review against the task's how/summary"
    if not task.get("expectedArtifact"):
        task["expectedArtifact"] = (task.get("summary") or task.get("title") or "per task summary")[:200]
    if event == "claimed":
        task.setdefault("currentStep", "claimed via checkout; work starting")
        task.setdefault("nextAction", "execute per the task's how")
    else:
        task["currentStep"] = "execution finished via agent-work finish; awaiting verification"
        task["nextAction"] = "verify the finished work, then close to done"


def lifecycle_advance(task_id, event, actor="lease-lifecycle", commit=True):
    """Drive tasks.json forward from a lease event: 'claimed' -> in_progress, 'finished' ->
    needs_verification. One revision bump, one commit. Returns (from, to) on a move, None when
    the task is missing, terminal, already at target, or has no legal route. Takes its own
    tasks_lock; callers swallow errors so a bridge hiccup never breaks the lease op.
    Kill switch: METIS_LIFECYCLE_BRIDGE=0."""
    if os.environ.get("METIS_LIFECYCLE_BRIDGE", "1") == "0":
        return None
    target = LIFECYCLE_TARGET[event]
    with tasks_lock():
        doc = load_json(TASKS_PATH)
        tasks = doc.get("tasks", [])
        task = next((t for t in tasks if t.get("taskId") == task_id), None)
        if task is None:
            return None
        cur = task.get("state")
        if cur in _LIFECYCLE_NOOP_STATES or cur == target:
            return None
        path = _shortest_state_path(cur, target)
        if not path:
            return None
        new_task = copy.deepcopy(task)
        prev = cur
        for st in path:
            validate_state_transition(task_id, prev, st)
            new_task["state"] = st
            if st in RICH_REQUIRED_STATES:
                _fill_lifecycle_rich(new_task, event)
            prev = st
        new_task["updatedAt"] = now_iso()
        new_task["updatedBy"] = actor
        new_task["revision"] = task.get("revision", 0) + 1
        if "in_progress" in path and not new_task.get("startedAt"):
            new_task["startedAt"] = new_task["updatedAt"]
        validate_task_shape(task_id, new_task)
        for idx, c in enumerate(tasks):
            if c.get("taskId") == task_id:
                tasks[idx] = new_task
                break
        doc["updatedAt"] = new_task["updatedAt"]
        dump_json(TASKS_PATH, doc)
        restamp_lease_on_transition(task_id, cur, target)
    if commit:
        commit_governed_state(f"task({task_id}): lease-{event} -> {target} (r{new_task['revision']})")
    return (cur, target)
