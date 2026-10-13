#!/usr/bin/env python3
# `from __future__ import annotations` keeps type annotations as lazy strings so PEP-604
# unions (`dict | None`) don't evaluate at def-time — this file must import cleanly under
# macOS's system /usr/bin/python3 (3.9), which launchd-invoked callers (needs_you.py) use.
from __future__ import annotations
import argparse
import json
import os
import sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from tier1_state_constants import (  # noqa: E402,F401  re-export (#6460 Slice 1): preserve uts.<CONST>
    ALLOWED_STATE_TRANSITIONS,
    BOARD_FIELDS,
    CREATE_TASK_REQUIRED_FIELDS,
    DISMISSABLE_STATES,
    FOCUS_MUTABLE_FIELDS,
    REQUIRED_RICH_FIELDS,
    RICH_REQUIRED_STATES,
    TASK_MUTABLE_FIELDS,
    VALID_AGENTS,
    VALID_DONEWHEN_TYPES,
    VALID_NEEDS_YOU_KINDS,
    VALID_NEEDS_YOU_KIND_SOURCES,
    VALID_ORIGINS,
    VALID_TASK_STATES,
    VALID_WAKE_ACTIONS,
    VALID_WAKE_TYPES,
)
from tier1_state_validation import (  # noqa: F401  re-export (extracted)
    APPEND_ONLY_FIELDS,
    DUP_TERMINAL_STATES,
    _EMPTY_VALUES,
    _REACTIVATE_STATES,
    _current_session,
    _dup_norm,
    _enforce_append_only,
    _reset_reject_streak_on_reactivate,
    _state_overlap_warn,
    _validate_iso_date,
    find_near_duplicate,
    parse_patch,
    validate_dates,
    validate_decision,
    validate_done_when,
    validate_focus_patch,
    validate_state_transition,
    validate_task_patch,
    validate_task_shape,
    validate_title,
    validate_wake,
    warn_unstructured_decision,
)
from tier1_state_io import (  # noqa: F401  re-export (extracted)
    AREAS_PATH,
    FOCUS_PATH,
    PROJECTS_PATH,
    ROOT,
    TASKS_PATH,
    TAXONOMY_PATH,
    _LOCK_DIR,
    _SYNC_LOCK,
    _acquire_sync_lock,
    _find_repo_root,
    _git,
    _git_locked,
    _heal_stale_index_lock,
    _holder_alive,
    _holder_is_leaked,
    _release_sync_lock,
    dump_json,
    load_json,
    tasks_lock,
)
from tier1_state_ops import (  # noqa: F401  re-export (extracted)
    CHECKOUTS_PATH,
    VALID_DOMAINS,
    VALID_MACHINES,
    VALID_MILESTONE_STATUS,
    VALID_PROJECT_STATUS,
    _COMMIT_PATHSPECS,
    _LEASE_TERMINAL,
    _MILESTONE_EDITABLE,
    _PROJECT_EDITABLE,
    _PULSE_CADENCES,
    _alloc_next_task_id,
    _catchup_task_counter,
    _check_obj_list,
    _donewhen_coverage_nudge,
    _find_milestone,
    _find_project,
    _load_valid_domains,
    _mint_freshness_guard,
    _mint_next_id,
    _next_task_id,
    _remove_taxonomy_project_domain,
    _set_taxonomy_project_domain,
    _slugify,
    _states_entering,
    _strided_task_id,
    _valid_goals,
    _valid_machines,
    _valid_values_map,
    archive_milestone,
    archive_project,
    commit_governed_state,
    correct_state,
    lifecycle_advance,
    create_milestone,
    create_project,
    create_task,
    delete_milestone,
    delete_project,
    dismiss_task,
    load_valid_areas,
    load_valid_project_slugs,
    now_iso,
    reassign_task,
    render_projections,
    restamp_lease_on_transition,
    surface_project_context,
    update_live_focus,
    update_milestone,
    update_project,
    update_task,
    validate_board_fields,
    validate_done_gate,
)


def cmd_schema(args):
    """Print the task-creation contract — required fields + every valid enum,
    read LIVE from the canonical sources — so an agent never has to grep four
    files to learn the shape. This is the on-demand (Tier 2) layer behind the
    one-screen contract in docs/process/state/README.md."""
    nxt = _next_task_id()
    schema = {
        "canonical": "docs/process/state/tasks.json (projections are rendered — never hand-edit)",
        "nextAvailableId": nxt,
        "create": {
            "requiredFields": sorted(CREATE_TASK_REQUIRED_FIELDS),
            "boardFields": list(BOARD_FIELDS),
            "richFields": {
                "fields": list(REQUIRED_RICH_FIELDS),
                "requiredWhenStateIn": sorted(RICH_REQUIRED_STATES),
            },
            "allMutableFields": sorted(TASK_MUTABLE_FIELDS),
        },
        "validValues": _valid_values_map(),
        "stateTransitions": {k: sorted(v) for k, v in ALLOWED_STATE_TRANSITIONS.items()},
    }

    if getattr(args, "json", False):
        print(json.dumps(schema, indent=2))
        return

    print("TASK SCHEMA — canonical: docs/process/state/tasks.json (projections are rendered)")
    print()
    print("Create a task (or use the /add-task skill, which wraps these):")
    print("  1) python3 scripts/update-tier1-state.py create-task --actor <you> --patch '<json>'")
    print("     # OMIT taskId to auto-mint the next free '#NNN' atomically (#972); it also")
    print("     # prints the project's milestones + open tasks so you link the right one.")
    print("  2) python3 scripts/render-tier1-state.py write       # refresh board + projections")
    print("  verify: python3 scripts/agent-work.py reconcile")
    if nxt is not None:
        print(f"\nNext available id: {nxt}")
    print("\nREQUIRED (create): " + ", ".join(sorted(CREATE_TASK_REQUIRED_FIELDS)))
    print("Rich fields (required once state in {}): {}".format(
        ", ".join(sorted(RICH_REQUIRED_STATES)), ", ".join(REQUIRED_RICH_FIELDS)))
    print("\nVALID VALUES")
    for k, v in schema["validValues"].items():
        print(f"  {k:<14}: {', '.join(v) if v else '(none configured)'}")
    print("\nSTATE TRANSITIONS")
    for k, v in schema["stateTransitions"].items():
        print(f"  {k:<20} -> {', '.join(v) if v else '(terminal)'}")
    print("\nCOMMON CALLS (copy-paste shapes)")
    print("  python3 scripts/update-tier1-state.py create-task --actor claude \\   # taskId auto-mints if omitted")
    print("      --patch '{\"title\":...,\"summary\":...,\"why\":...,\"how\":...,")
    print("               \"priority\":\"P2\",\"state\":\"queued\",\"owner\":...,\"project\":...,")
    print("               \"area\":...,\"agent\":...,\"machine\":...,\"domain\":...,\"origin\":...}'")
    print("  python3 scripts/update-tier1-state.py task-update --actor claude --task-id '#NNN' \\")
    print("      --expected-revision N --patch '{\"state\":...}'   # rich fields required entering active states")
    print("  python3 scripts/agent-work.py claim '#NNN' --agent claude   |   unclaim <claim-id>")
    print("  python3 scripts/render-tier1-state.py write              # refresh projections after batches")
    print("\nFull field definitions: ClaudeCode/skills/add-task/task-fields-reference.md")


def cmd_enums(args):
    """#1695 R3 — surface valid values for a field BEFORE a patch is built, so an
    invalid area/project/machine is discoverable up front instead of only via a
    create/update REJECT. `enums` lists every field; `enums <field>` prints one."""
    vals = _valid_values_map()
    field = getattr(args, "field", None)
    if getattr(args, "json", False):
        print(json.dumps(vals if not field else {field: vals.get(field, [])}, indent=2))
        if field and field not in vals:
            sys.exit(1)
        return
    if field:
        if field not in vals:
            print(f"unknown field {field!r} — valid fields: {', '.join(sorted(vals))}", file=sys.stderr)
            sys.exit(1)
        v = vals[field]
        print(f"{field}: {', '.join(v) if v else '(none configured)'}")
        return
    print("VALID VALUES (live from canonical sources)")
    for k, v in vals.items():
        print(f"  {k:<14}: {', '.join(v) if v else '(none configured)'}")
    print("\nOne field: update-tier1-state.py enums <field>   ·   full contract: … schema")


def cmd_requirements(args):
    """#1695 R2 — print EXACTLY what entering <state> demands (required fields + the
    legal predecessor states) BEFORE a patch is assembled, so a caller never learns the
    required set only by getting rejected. Reuses the same maps the validators enforce,
    so it can't drift from the real requirement."""
    state = args.state
    valid = _valid_values_map()["state"]
    if state not in valid:
        print(f"unknown state {state!r} — valid states: {', '.join(valid)}", file=sys.stderr)
        sys.exit(1)
    board_fields = ["area", "agent", "machine", "origin"]
    create_required = sorted(CREATE_TASK_REQUIRED_FIELDS) + board_fields
    rich = list(REQUIRED_RICH_FIELDS) if state in RICH_REQUIRED_STATES else []
    # `done` has a guard STRICTER than the raw transition graph (validate_done_gate):
    # it is legal ONLY from needs_verification and additionally demands
    # blockerOrNone=none + nextAction=none. Teach that, not the graph's looser edges.
    if state == "done":
        preds = ["needs_verification"]
        note = "'done' is allowed ONLY from needs_verification, and requires blockerOrNone=none + nextAction=none"
    else:
        preds = _states_entering(state)
        note = ("rich fields are required to ENTER this state" if rich
                else "no rich fields required for this state")
    payload = {
        "state": state,
        "createRequiredFields": create_required,
        "richFieldsRequired": rich,
        "reachableFromStates": preds,
        "note": note,
    }
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2))
        return
    print(f"REQUIREMENTS to reach state '{state}'")
    if state == "queued" or not preds:
        print("  create-required fields: " + ", ".join(create_required))
    if rich:
        print("  rich fields required (patch must set these): " + ", ".join(rich))
    if preds:
        print("  reachable only from: " + ", ".join(preds))
    else:
        print("  reachable from: (create-time / terminal — no inbound transition)")
    print("  note: " + payload["note"])
    print("  full contract: update-tier1-state.py schema   ·   enums: … enums <field>")


def main():
    parser = argparse.ArgumentParser(description="Small revision-aware Tier 1 state update helper.")
    sub = parser.add_subparsers(dest="command", required=True)

    create_p = sub.add_parser("create-task", help="Create one new task object in tasks.json")
    create_p.add_argument("--actor", required=True)
    create_p.add_argument("--patch", required=True, help="JSON object for the new task. Omit taskId to auto-mint the next free '#NNN' (#972); it also prints the project's milestones + open tasks so you link the right one. Discover valid field values first: `update-tier1-state.py enums [field]`")
    create_p.add_argument(
        "--check", action="store_true", help="Validate and print the new task without writing"
    )
    create_p.add_argument(
        "--backfill",
        action="store_true",
        help="Historical/migration import — skips done-gate lifecycle check AND rich-field enforcement so pre-schema tasks can be imported as-is",
    )
    create_p.add_argument(
        "--no-commit",
        action="store_true",
        help="Skip the automatic atomic commit (default commits the new task immediately so a daemon sync can't clobber it). Use when batching many creates that commit once at the end.",
    )
    create_p.add_argument(
        "--allow-stale-mint",
        action="store_true",
        help="Bypass the stale-clone mint-freshness guard (#5255) that refuses to auto-mint an id when this clone's tasks.json/task-counter.json is behind origin/main and cannot be fast-forwarded. Use only when minting stale is genuinely intended (e.g. deliberate offline work); the mint may be renumbered at merge.",
    )
    create_p.add_argument(
        "--allow-duplicate",
        action="store_true",
        help="Bypass the near-duplicate guard (#986) that refuses a create whose normalized title (digits folded) matches an OPEN task. Use only when the new task is genuinely distinct from the existing one it collides with.",
    )

    proj_p = sub.add_parser("create-project", help="Create one project record in projects.json + its taxonomy domain link")
    proj_p.add_argument("--actor", required=True)
    proj_p.add_argument("--patch", required=True, help="JSON: {name, domain, priority?, doneWhen?, scope?, goal?, slug?}")
    proj_p.add_argument("--check", action="store_true", help="Validate and print without writing")
    proj_p.add_argument("--no-commit", action="store_true", help="Skip the automatic atomic commit")

    ms_p = sub.add_parser("create-milestone", help="Create one milestone nested in a project record")
    ms_p.add_argument("--actor", required=True)
    ms_p.add_argument("--patch", required=True, help="JSON: {projectSlug, title, doneWhen?, weight?}")
    ms_p.add_argument("--check", action="store_true", help="Validate and print without writing")
    ms_p.add_argument("--no-commit", action="store_true", help="Skip the automatic atomic commit")

    upproj_p = sub.add_parser("update-project", help="Patch editable fields on a project record")
    upproj_p.add_argument("--actor", required=True)
    upproj_p.add_argument("--slug", required=True)
    upproj_p.add_argument("--patch", required=True, help="JSON: any of {name, priority, doneWhen, scope, goal, status, domain}")
    upproj_p.add_argument("--check", action="store_true", help="Validate and print without writing")
    upproj_p.add_argument("--no-commit", action="store_true", help="Skip the automatic atomic commit")

    arproj_p = sub.add_parser("archive-project", help="Soft-remove a project (status -> archived, reversible)")
    arproj_p.add_argument("--actor", required=True)
    arproj_p.add_argument("--slug", required=True)
    arproj_p.add_argument("--check", action="store_true", help="Print without writing")
    arproj_p.add_argument("--no-commit", action="store_true", help="Skip the automatic atomic commit")

    delproj_p = sub.add_parser("delete-project", help="Hard-delete an EMPTY project + its taxonomy link (guarded)")
    delproj_p.add_argument("--actor", required=True)
    delproj_p.add_argument("--slug", required=True)
    delproj_p.add_argument("--check", action="store_true", help="Print without writing")
    delproj_p.add_argument("--no-commit", action="store_true", help="Skip the automatic atomic commit")

    upms_p = sub.add_parser("update-milestone", help="Patch editable fields on a milestone")
    upms_p.add_argument("--actor", required=True)
    upms_p.add_argument("--slug", required=True)
    upms_p.add_argument("--milestone-id", required=True)
    upms_p.add_argument("--patch", required=True, help="JSON: any of {title, doneWhen, weight, status}")
    upms_p.add_argument("--check", action="store_true", help="Validate and print without writing")
    upms_p.add_argument("--no-commit", action="store_true", help="Skip the automatic atomic commit")

    arms_p = sub.add_parser("archive-milestone", help="Soft-remove a milestone (status -> archived, reversible)")
    arms_p.add_argument("--actor", required=True)
    arms_p.add_argument("--slug", required=True)
    arms_p.add_argument("--milestone-id", required=True)
    arms_p.add_argument("--check", action="store_true", help="Print without writing")
    arms_p.add_argument("--no-commit", action="store_true", help="Skip the automatic atomic commit")

    delms_p = sub.add_parser("delete-milestone", help="Hard-delete an EMPTY milestone (guarded)")
    delms_p.add_argument("--actor", required=True)
    delms_p.add_argument("--slug", required=True)
    delms_p.add_argument("--milestone-id", required=True)
    delms_p.add_argument("--check", action="store_true", help="Print without writing")
    delms_p.add_argument("--no-commit", action="store_true", help="Skip the automatic atomic commit")

    reassign_p = sub.add_parser("reassign-task", help="Move a task to a different milestone (or --unassign) within its project")
    reassign_p.add_argument("--actor", required=True)
    reassign_p.add_argument("--task-id", required=True)
    reassign_p.add_argument("--project", required=True, help="Project slug the task belongs to")
    reassign_p.add_argument("--to-milestone", help="Target milestone id (M#)")
    reassign_p.add_argument("--unassign", action="store_true", help="Remove the task from all milestones")
    reassign_p.add_argument("--check", action="store_true", help="Print without writing")
    reassign_p.add_argument("--no-commit", action="store_true", help="Skip the automatic atomic commit")

    task_p = sub.add_parser("task-update", help="Patch one task object in tasks.json")
    task_p.add_argument("--task-id", required=True)
    task_p.add_argument("--expected-revision", type=int, required=True)
    task_p.add_argument("--actor", required=True)
    task_p.add_argument("--patch", required=True, help="JSON object patch string")
    task_p.add_argument(
        "--check", action="store_true", help="Validate and print the updated object without writing"
    )
    task_p.add_argument(
        "--commit",
        action="store_true",
        help="Atomically commit this update under the sync lock (off by default to avoid commit storms from high-frequency transitions; use for important manual updates)",
    )

    life_p = sub.add_parser(
        "lifecycle-advance",
        help="Lease-lifecycle bridge (#922/#8025): claimed -> in_progress, finished -> needs_verification",
    )
    life_p.add_argument("--task-id", required=True)
    life_p.add_argument("--event", required=True, choices=["claimed", "finished"])
    life_p.add_argument("--actor", default="lease-lifecycle")
    life_p.add_argument("--no-commit", action="store_true")

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

    dismiss_p = sub.add_parser(
        "dismiss",
        help="Drop an untriaged inbox/queued suggestion to terminal 'dropped' (no rich fields; requires --reason; #417)",
    )
    dismiss_p.add_argument("--task-id", required=True)
    dismiss_p.add_argument("--expected-revision", type=int, required=True)
    dismiss_p.add_argument("--actor", required=True)
    dismiss_p.add_argument(
        "--reason", required=True, help="Why this suggestion is discarded (audited in stateCorrections[])"
    )
    dismiss_p.add_argument(
        "--check", action="store_true", help="Validate and print the dropped object without writing"
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

    schema_p = sub.add_parser(
        "schema",
        aliases=["cheatsheet"],  # #517: the name people reach for when a gate rejects them
        help="Print the task-creation contract: required fields + valid enums (live)",
    )
    schema_p.add_argument("--json", action="store_true", help="Emit machine-readable JSON")

    enums_p = sub.add_parser(
        "enums",
        help="Print valid values for a field (or all fields) — discover area/project/machine before building a patch (#1695 R3)",
    )
    enums_p.add_argument("field", nargs="?", help="One field (e.g. area, project, machine, state); omit for all")
    enums_p.add_argument("--json", action="store_true", help="Emit machine-readable JSON")

    req_p = sub.add_parser(
        "requirements",
        help="Print exactly what entering a target STATE requires (fields + legal predecessor states) before assembling a patch (#1695 R2)",
    )
    req_p.add_argument("state", help="Target state, e.g. in_progress, needs_verification, done")
    req_p.add_argument("--json", action="store_true", help="Emit machine-readable JSON")

    args = parser.parse_args()

    if args.command == "cheatsheet":
        args.command = "schema"
    if args.command == "schema":
        cmd_schema(args)
    elif args.command == "enums":
        cmd_enums(args)
    elif args.command == "requirements":
        cmd_requirements(args)
    elif args.command == "create-task":
        with tasks_lock():
            create_task(args)
    elif args.command == "create-project":
        with tasks_lock():
            create_project(args)
    elif args.command == "create-milestone":
        with tasks_lock():
            create_milestone(args)
    elif args.command == "update-project":
        with tasks_lock():
            update_project(args)
    elif args.command == "archive-project":
        with tasks_lock():
            archive_project(args)
    elif args.command == "delete-project":
        with tasks_lock():
            delete_project(args)
    elif args.command == "update-milestone":
        with tasks_lock():
            update_milestone(args)
    elif args.command == "archive-milestone":
        with tasks_lock():
            archive_milestone(args)
    elif args.command == "delete-milestone":
        with tasks_lock():
            delete_milestone(args)
    elif args.command == "reassign-task":
        with tasks_lock():
            reassign_task(args)
    elif args.command == "task-update":
        with tasks_lock():
            update_task(args)
    elif args.command == "lifecycle-advance":
        moved = lifecycle_advance(args.task_id, args.event, actor=args.actor,
                                  commit=not args.no_commit)
        print(f"{args.task_id}: {moved[0]} -> {moved[1]}" if moved else f"{args.task_id}: no change")
    elif args.command == "correct-state":
        with tasks_lock():
            correct_state(args)
    elif args.command == "dismiss":
        with tasks_lock():
            dismiss_task(args)
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
