#!/usr/bin/env python3
import argparse
import difflib
import json
import os
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path
import yaml

# #DUE: how many days ahead of a dueAt counts as "due soon" (badge escalates to @due).
DUE_SOON_DAYS = 3


def _as_date(val):
    """Parse an ISO date/datetime string to a date; None on empty/malformed (never raises —
    a bad stored value must not crash the projector, the mutator already validates on write)."""
    if not isinstance(val, str) or not val.strip():
        return None
    try:
        return datetime.fromisoformat(val.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _date_badges(task, today=None):
    """#DUE: inline board badges for the human-set date fields. Distinct signals:
      @OVERDUE:<date> — dueAt is past and the task isn't done (hard miss).
      @due:<date>     — dueAt is today..+DUE_SOON_DAYS (approaching deadline).
      @due-set:<date> — a dueAt further out (visible but not yet pressing).
      @followup-due:<date> / @followup:<date> — human check-back due now / scheduled ahead.
    completedAt (system-stamped) and wakeWhen (automated) are surfaced elsewhere, not here."""
    today = today or date.today()
    badge = ""
    is_done = task.get("state") == "done"
    due = _as_date(task.get("dueAt"))
    if due and not is_done:
        if due < today:
            badge += f" @OVERDUE:{task['dueAt']}"
        elif (due - today).days <= DUE_SOON_DAYS:
            badge += f" @due:{task['dueAt']}"
        else:
            badge += f" @due-set:{task['dueAt']}"
    fu = _as_date(task.get("followUpAt"))
    if fu and not is_done:
        badge += f" @followup-due:{task['followUpAt']}" if fu <= today else f" @followup:{task['followUpAt']}"
    return badge

# Portable repo root: REPO_ROOT (per-invocation/worktree) -> METIS_HOME (canonical)
# -> self-locating fallback (<this file>/../..). Self-location is rename- and
# symlink-proof, so it survives removal of the Ant-openclaw-framework compat symlink.
ROOT = Path(os.environ.get("REPO_ROOT") or os.environ.get("METIS_HOME") or Path(__file__).resolve().parents[1])
TASKS_PATH = ROOT / "docs/process/state/tasks.json"
FOCUS_PATH = ROOT / "docs/process/state/live-focus.json"
ARCHIVE_PATH = ROOT / "docs/process/state/tasks-archive.json"
AREAS_PATH = ROOT / "docs/process/state/task-areas.json"
PROJECTS_PATH = ROOT / "docs/process/state/projects.json"
TAXONOMY_PATH = ROOT / "docs/process/taxonomy.yaml"
QUEUE_MD = ROOT / "docs/process/task-queue.md"
LIVE_MD = ROOT / "docs/process/live-status.md"
OPEN_TASKS_MD = ROOT / "workspace/state/OPEN_TASKS.md"
PROJECTS_MD = ROOT / "docs/process/projects.md"

# Project progress layer (#221) — optional; render degrades gracefully if absent.
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from lib import progress as _progress
except Exception:
    _progress = None

GOVERNED_START = "<!-- GOVERNED:START -->"
GOVERNED_END = "<!-- GOVERNED:END -->"

STATE_ORDER = [
    "open",
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
    "archived",  # #887: terminal + completed-and-filed (mirrors update-tier1-state.py). Kept
                 # out of GOVERNED_STATE_ORDER below so it never renders as active board work.
    "dropped",
]

# tasks.json is the single source of truth. The governed anchors render every
# NON-TERMINAL state (inbox -> failed) so no live section of task-queue.md is
# hand-maintained. The TERMINAL states (done, dropped) are excluded here — they
# live in tasks.json (the complete record); done projects to the Done Archive
# (#089), dropped = triaged-and-discarded suggestions that leave the board (#417).
GOVERNED_STATE_ORDER = [s for s in STATE_ORDER if s not in ("done", "archived", "dropped")]

STATE_HEADERS = {
    "open": "Open · needs you",
    "inbox": "Inbox",
    "queued": "Queued",
    "accepted": "Accepted",
    "in_progress": "In Progress",
    "execution_finished": "Execution Finished",
    "needs_verification": "Needs Verification",
    "waiting": "Waiting",
    "blocked": "Blocked",
    "failed": "Failed",
    "done": "Done",
    "archived": "Archived",
}

VALID_STATES = set(STATE_ORDER)
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


def replace_governed_section(original: str, new_content: str) -> str:
    """Replace content between GOVERNED anchors; fall back to full replace if absent."""
    start_idx = original.find(GOVERNED_START)
    end_idx = original.find(GOVERNED_END)
    if start_idx == -1 or end_idx == -1:
        return new_content
    before = original[: start_idx + len(GOVERNED_START)] + "\n"
    after = original[end_idx:]
    return before + new_content + after


def load_json(path: Path):
    return json.loads(path.read_text())


def load_taxonomy():
    if not TAXONOMY_PATH.exists():
        return {}
    return yaml.safe_load(TAXONOMY_PATH.read_text()) or {}


def archived_task_ids():
    """Ids of tasks moved to tasks-archive.json (archive-done-tasks.py). Used only to RESOLVE
    references (e.g. live-focus history) — archived tasks never render as active work."""
    if not ARCHIVE_PATH.exists():
        return set()
    try:
        return {t["taskId"] for t in load_json(ARCHIVE_PATH).get("tasks", [])}
    except (json.JSONDecodeError, KeyError):
        return set()


def read_text_if_exists(path: Path):
    return path.read_text() if path.exists() else ""


def unified_diff(old_text: str, new_text: str, from_name: str, to_name: str) -> str:
    return "".join(
        difflib.unified_diff(
            old_text.splitlines(keepends=True),
            new_text.splitlines(keepends=True),
            fromfile=from_name,
            tofile=to_name,
        )
    )


def validate_tasks_doc(tasks_doc):
    tasks = tasks_doc.get("tasks")
    if not isinstance(tasks, list):
        raise ValueError('tasks.json must contain a top-level "tasks" list')

    seen_ids = set()
    for task in tasks:
        task_id = task.get("taskId")
        if not task_id:
            raise ValueError("every task must have taskId")
        if task_id in seen_ids:
            raise ValueError(f"duplicate taskId: {task_id}")
        seen_ids.add(task_id)

        state = task.get("state")
        if state not in VALID_STATES:
            raise ValueError(f"{task_id}: invalid state {state!r}")

        if state in RICH_REQUIRED_STATES:
            missing = [field for field in REQUIRED_RICH_FIELDS if not task.get(field)]
            if missing:
                # Non-fatal: the hard gate lives at the write path
                # (update-tier1-state.py create/update) for born-governed tasks.
                # Migrated/grandfathered tasks render with a visible warning rather
                # than blocking the whole projection.
                print(
                    f"WARNING: {task_id}: missing rich fields for state {state}: {', '.join(missing)}",
                    file=sys.stderr,
                )

        if state == "done" and task.get("blockerOrNone") not in (None, "", "none"):
            raise ValueError(f"{task_id}: done task should not carry a meaningful blocker")

        if state == "execution_finished" and not task.get("verificationMethod"):
            raise ValueError(f"{task_id}: execution_finished task must preserve verificationMethod")

    return {task["taskId"] for task in tasks}


def validate_focus_doc(focus_doc, task_ids):
    derived = focus_doc.get("derivedFromTaskIds", [])
    if not isinstance(derived, list):
        raise ValueError("live-focus.json derivedFromTaskIds must be a list")
    for task_id in derived:
        if task_id not in task_ids:
            raise ValueError(f"live-focus.json references unknown taskId: {task_id}")


def render_queue(tasks_doc):
    tasks = tasks_doc.get("tasks", [])
    by_state = {state: [] for state in GOVERNED_STATE_ORDER}
    for task in tasks:
        state = task.get("state", "queued")
        if state in by_state:
            by_state[state].append(task)

    out = []
    for state in GOVERNED_STATE_ORDER:
        out.append(f"## {STATE_HEADERS[state]}\n\n")
        state_tasks = by_state.get(state, [])
        if not state_tasks:
            out.append("- none\n\n")
            continue

        for task in state_tasks:
            out.append(f"- **{task['taskId']} — {task['title']}**\n")
            out.append(f"  - Priority: {task.get('priority', 'P?')}\n")
            out.append(f"  - Owner: {task.get('owner', '')}\n")
            # Agent + Machine are the two fields queue-runner.py parses out of this
            # projection to decide dispatch eligibility (is_eligible: agent must be in
            # DISPATCHABLE_AGENTS, machine in DISPATCHABLE_MACHINES). Both live in
            # tasks.json and are validated on create, but were never rendered here, so
            # every governed task parsed as agent=None/machine=None and no governed task
            # could ever be dispatched -- only the legacy hand-written entries below
            # GOVERNED:END carried them. Emit them so the canonical board is dispatchable.
            if task.get("agent"):
                out.append(f"  - Agent: {task['agent']}\n")
            if task.get("machine"):
                out.append(f"  - Machine: {task['machine']}\n")
            out.append(f"  - Project: {task.get('project', 'ops')}\n")
            out.append(f"  - Status: {task.get('state', '')}\n")
            out.append(f"  - Summary (what): {task.get('summary', '')}\n")
            if task.get("why"):
                out.append(f"  - Why: {task['why']}\n")
            if task.get("how"):
                out.append(f"  - How: {task['how']}\n")
            if task.get("firstStep"):
                out.append(f"  - First step: {task['firstStep']}\n")
            if task.get("planRef"):
                out.append(f"  - Plan ref: `{task['planRef']}`\n")

            for label, key in [
                ("Current step", "currentStep"),
                ("Expected artifact", "expectedArtifact"),
                ("Verification method", "verificationMethod"),
                ("Blocker or none", "blockerOrNone"),
                ("Next action", "nextAction"),
            ]:
                value = task.get(key)
                if value:
                    out.append(f"  - {label}: {value}\n")

            ww = task.get("wakeWhen")
            if ww:
                wt = ww.get("type")
                cond = (f"at {ww.get('at')}" if wt == "time"
                        else f"check `{ww.get('cmd', '')}`" if wt == "check" else str(ww))
                act = (task.get("wakeAction") or {}).get("kind") or "dispatch"
                out.append(f"  - Wake when: {wt} — {cond} → auto-{act} (task-wake sweep)\n")

            out.append("  - Main files:\n")
            main_files = task.get("mainFiles", [])
            if main_files:
                for mf in main_files:
                    out.append(f"    - `{mf}`\n")
            else:
                out.append("    - none\n")

            ndp = task.get("nextDecisionPoint")
            if ndp:
                out.append(f"  - Next decision point: {ndp}\n")
            out.append("\n")

    return "".join(out)


def render_live(focus_doc):
    out = []
    out.append(f"Last generated from governed state: `{FOCUS_PATH.relative_to(ROOT)}`\n\n")
    out.append("## Current state\n")
    out.append(f"- **Now working on:** {focus_doc.get('focusSummary', '')}\n")
    out.append(f"- **Mode:** {focus_doc.get('mode', '')}\n")
    out.append(f"- **Waiting on Ant?:** {'yes' if focus_doc.get('waitingOnAnt') else 'no'}\n")
    blocker = focus_doc.get("blockerSummary")
    out.append(f"- **Blocker:** {blocker if blocker else 'none'}\n\n")
    out.append("Authority note:\n")
    out.append("- this file is a Tier 1 markdown projection of governed live-focus state\n")
    out.append(
        "- it should align with `docs/process/state/live-focus.json` and the active task set in `docs/process/state/tasks.json`\n\n"
    )
    out.append("## What happens next\n")
    next_steps = focus_doc.get("nextSteps", [])
    if next_steps:
        for i, step in enumerate(next_steps, start=1):
            out.append(f"{i}. {step}\n")
    else:
        out.append("1. none\n")
    out.append("\n## Active task IDs\n")
    derived = focus_doc.get("derivedFromTaskIds", [])
    if derived:
        for tid in derived:
            out.append(f"- `{tid}`\n")
    else:
        out.append("- none\n")
    out.append("\n")
    return "".join(out)


def _priority_rank(priority):
    # P1 first; unknown priorities sort last but stay deterministic.
    try:
        return int(str(priority).lstrip("Pp"))
    except (ValueError, AttributeError):
        return 99


def render_due_followup_summary(tasks_doc, today=None):
    """#DUE: a board-top digest of time-sensitive work so due/overdue/follow-up items are seen
    at a glance instead of buried per-area. Three buckets, each rendered only when non-empty:
      🔴 Overdue        — dueAt is past and the task isn't done.
      🟠 Due soon       — dueAt within the next DUE_SOON_DAYS.
      🔔 Needs follow-up — followUpAt has arrived (human check-back), with its reason.
    Terminal tasks are excluded (they carry completedAt, not open deadlines)."""
    today = today or date.today()
    overdue, due_soon, followup = [], [], []
    for t in tasks_doc.get("tasks", []):
        if t.get("state") in ("done", "dropped"):
            continue
        due = _as_date(t.get("dueAt"))
        if due:
            if due < today:
                overdue.append((due, t))
            elif (due - today).days <= DUE_SOON_DAYS:
                due_soon.append((due, t))
        fu = _as_date(t.get("followUpAt"))
        if fu and fu <= today:
            followup.append((fu, t))

    if not (overdue or due_soon or followup):
        return ""

    def _line(t, extra=""):
        return f"- **{t['taskId']} {t.get('title', '')}** — {t.get('summary', '')}{extra}\n"

    out = ["## ⏰ Due & Follow-ups\n\n",
           "> Time-sensitive work surfaced from `dueAt` / `followUpAt`. "
           "See task-state-contract §DUE for the field protocol.\n\n"]
    if overdue:
        out.append("**🔴 Overdue**\n")
        for d, t in sorted(overdue, key=lambda x: x[0]):
            out.append(_line(t, f" _(due {t['dueAt']})_"))
        out.append("\n")
    if due_soon:
        out.append("**🟠 Due soon**\n")
        for d, t in sorted(due_soon, key=lambda x: x[0]):
            out.append(_line(t, f" _(due {t['dueAt']})_"))
        out.append("\n")
    if followup:
        out.append("**🔔 Needs follow-up**\n")
        for d, t in sorted(followup, key=lambda x: x[0]):
            why = t.get("followUpReason")
            out.append(_line(t, f" _(follow up {t['followUpAt']}{'; ' + why if why else ''})_"))
        out.append("\n")
    return "".join(out)


def render_open_tasks(tasks_doc, areas_doc):
    """Render the OPEN_TASKS.md board: non-terminal tasks grouped by area.

    The board lists only open work (terminal tasks live in tasks.json + the Done
    Archive). Areas come from task-areas.json in declared order; each task is
    placed by its `area` field. The 'Self-Review' section is NOT rendered here —
    self-review.py owns it inside its own markers, outside the GOVERNED anchors.
    """
    open_states = set(GOVERNED_STATE_ORDER)
    areas = areas_doc.get("areas", [])
    area_names = [a["name"] for a in areas]

    by_area = {name: [] for name in area_names}
    for task in tasks_doc.get("tasks", []):
        if task.get("state") not in open_states:
            continue
        area = task.get("area")
        if area not in by_area:
            area = "Uncategorized"
        if area in by_area:
            by_area[area].append(task)

    out = []
    summary = render_due_followup_summary(tasks_doc)
    if summary:
        out.append(summary)
    for area in areas:
        name = area["name"]
        out.append(f"## {name} | {area.get('priority', 'P?')} | {area.get('status', 'active')}\n\n")
        desc = area.get("description")
        if desc:
            out.append(f"> {desc}\n\n")

        tasks = sorted(
            by_area.get(name, []),
            key=lambda t: (_priority_rank(t.get("priority")), str(t.get("taskId"))),
        )
        for task in tasks:
            tid = task["taskId"]
            prio = task.get("priority", "P?")
            title = task.get("title", "")
            summary = task.get("summary", "")
            tags = f" @agent:{task.get('agent', 'claude')} @machine:{task.get('machine', 'either')}"
            # #887: surface a state signal for EVERY task that isn't fresh-and-untouched, so a
            # reader can tell worked-in-flight (in_progress/execution_finished/needs_verification/
            # accepted) and needs-attention (blocked/failed/waiting) apart from never-started
            # (queued/inbox/open) at a glance. Previously only 'blocked' was tagged, so a
            # partially-done task looked identical to one nobody had picked up.
            _state = task.get("state")
            if _state and _state not in ("queued", "inbox", "open"):
                tags += f" @status:{_state}"
            # Surface a self-trigger badge so a soak's wake condition is visible on the board,
            # not buried in prose — a reader can see WHEN a waiting task will fire itself.
            _ww = task.get("wakeWhen")
            if _ww:
                _wt = _ww.get("type")
                tags += f" @wake:{_ww.get('at')}" if _wt == "time" else " @wake:check"
            # #DUE: hard-deadline (dueAt) + human check-back (followUpAt) badges.
            tags += _date_badges(task)
            line = f"- [{prio}] [ ] **{tid} {title}**"
            if summary:
                line += f" — {summary}"
            line += tags + "\n"
            out.append(line)
        out.append("\n")

    return "".join(out)


def render_projects(projects_doc) -> str:
    """Render projects.md from projects.json."""
    projects = projects_doc.get("projects", [])
    taxonomy = load_taxonomy()
    domains = taxonomy.get("domains") or {}
    project_domain = taxonomy.get("project_domain") or {}
    campaigns = taxonomy.get("campaigns") or {}
    STATUS_RANK = {"active": 0, "paused": 1, "blocked": 2, "done": 3}
    projects_sorted = sorted(projects, key=lambda p: (
        STATUS_RANK.get(p.get("status", "active"), 9),
        p.get("priority", "P3"),
        p.get("projectId", ""),
    ))

    out = [
        "# Projects\n\n",
        "> **Generated projection** — canonical source is `docs/process/state/projects.json`.\n",
        "> Do not edit this file directly; changes will be overwritten by `render-tier1-state.py write`.\n\n",
    ]

    # Domain coverage (#337) — where work clusters, neglect signals. Never completion %.
    if _progress is not None:
        coverage = _progress.domain_coverage(projects, taxonomy)
        if coverage:
            out.append("## Domain coverage\n\n")
            out.append(
                "> Where active work clusters — not completion. "
                "Domains have no end state; ⚠️ flags domains with zero active work.\n\n"
            )
            for d in coverage:
                name = d["domain"]
                label = d["label"] or name
                active = d["active_count"]
                ev = d["evergreen_count"]
                pb = d["paused_blocked_count"]
                cams = ", ".join(d["campaigns"]) if d["campaigns"] else ""
                cam_note = f" · campaigns: {cams}" if cams else ""
                if d["neglected"]:
                    out.append(f"- **{name}** ⚠️ no active work — _{label}_\n")
                else:
                    parts = []
                    if active:
                        parts.append(f"{active} active")
                    if ev:
                        parts.append(f"{ev} evergreen")
                    if pb:
                        parts.append(f"{pb} paused/blocked")
                    count_str = ", ".join(parts) or "—"
                    stale_note = " ⚠️ stale (no recent movement)" if d["stale_signal"] else ""
                    out.append(f"- **{name}** — {count_str}{cam_note}{stale_note}\n")
            out.append("\n")

    # Campaign roll-up (priority-weighted) — #221.
    goals = sorted({p.get("goal") for p in projects if p.get("goal")})
    if _progress is not None and goals:
        out.append("## Campaign roll-up (priority-weighted; excludes evergreen/paused)\n\n")
        for g in goals:
            gp = _progress.goal_rollup(projects, g)
            campaign_name = (campaigns.get(g) or {}).get("name")
            label = f"{g} — {campaign_name}" if campaign_name else g
            if gp is None:
                out.append(f"- **{label}** — (no seeded active projects)\n")
            else:
                out.append(f"- **{label}** — {_progress.bar(gp)} {gp * 100:.0f}%\n")
        out.append("\n")

    active = [p for p in projects_sorted if p.get("status") not in ("done",)]
    done = [p for p in projects_sorted if p.get("status") == "done"]

    if active:
        out.append("## Active / Paused / Blocked Projects\n\n")
        for proj in active:
            pid = proj.get("projectId", "?")
            slug = proj.get("slug", "?")
            name = proj.get("name", slug)
            status = proj.get("status", "active")
            priority = proj.get("priority", "P3")
            # goal=None is legitimate (#645): a project with no active campaign
            # rolls up to its life domain directly instead of borrowing one.
            goal = proj.get("goal") or "none (rolls up to domain)"
            campaign_name = (campaigns.get(goal) or {}).get("name")
            domain = project_domain.get(slug) or (campaigns.get(goal) or {}).get("domain") or "unmapped"
            domain_label = domains.get(domain, "")
            done_when = proj.get("doneWhen", "")
            scope = proj.get("scope", "")
            out.append(f"### {pid} `{slug}` — {name}\n")
            out.append(f"- **Life domain:** {domain}" + (f" — {domain_label}" if domain_label else "") + "\n")
            out.append(f"- **Campaign:** {goal}" + (f" — {campaign_name}" if campaign_name else "") + "\n")
            out.append(f"- **Status:** {status}\n")
            out.append(f"- **Priority:** {priority}\n")
            out.append(f"- **Done when:** {done_when}\n")
            out.append(f"- **Scope:** {scope}\n")
            if _progress is not None:
                prog, shipped, total = _progress.project_progress(proj)
                if proj.get("evergreen"):
                    out.append("- **Progress:** evergreen (no completion target)\n")
                elif prog is not None:
                    out.append(f"- **Progress:** {_progress.bar(prog)} {prog * 100:.0f}% · {shipped}/{total} shipped\n")
                    sym = {"done": "✅", "active": "🟦", "blocked": "⛔", "todo": "⬜"}
                    out.append("- **Milestones:**\n")
                    for m in proj.get("milestones", []):
                        st = m.get("status", "todo")
                        fill = m.get("fill", 0) or 0
                        ft = f" ({int(fill * 100)}%)" if st in ("active", "blocked") and fill else ""
                        out.append(f"  - {sym.get(st, '?')} {m.get('id', '')} {m.get('title', '')}{ft}\n")
            out.append("\n")

    if done:
        out.append("## Done Projects\n\n")
        for proj in done:
            pid = proj.get("projectId", "?")
            slug = proj.get("slug", "?")
            name = proj.get("name", slug)
            out.append(f"### {pid} `{slug}` — {name} ✓\n\n")

    return "".join(out)


def main():
    parser = argparse.ArgumentParser(
        description="Render Tier 1 markdown projections from governed state."
    )
    parser.add_argument(
        "mode",
        nargs="?",
        default="write",
        choices=["check", "diff", "write"],
        help="check validates only; diff shows markdown changes; write updates markdown files",
    )
    parser.add_argument(
        "--exit-code",
        action="store_true",
        help="with `diff`: exit 1 if any projection is stale (git-diff style), for use as a CI/commit gate",
    )
    args = parser.parse_args()

    tasks_doc = load_json(TASKS_PATH)
    focus_doc = load_json(FOCUS_PATH)
    areas_doc = load_json(AREAS_PATH)
    projects_doc = load_json(PROJECTS_PATH) if PROJECTS_PATH.exists() else {"projects": []}

    task_ids = validate_tasks_doc(tasks_doc)
    # live-focus may reference a now-archived task (history) — resolve against active + archived.
    validate_focus_doc(focus_doc, task_ids | archived_task_ids())

    queue_text = render_queue(tasks_doc)
    live_text = render_live(focus_doc)
    open_tasks_text = render_open_tasks(tasks_doc, areas_doc)
    projects_text = render_projects(projects_doc)

    if args.mode == "check":
        print("Tier 1 state validation passed.")
        print("Projected files:")
        print(f"- {QUEUE_MD}")
        print(f"- {LIVE_MD}")
        print(f"- {OPEN_TASKS_MD}")
        print(f"- {PROJECTS_MD}")
        return

    targets = [
        (QUEUE_MD, queue_text),
        (LIVE_MD, live_text),
        (OPEN_TASKS_MD, open_tasks_text),
        (PROJECTS_MD, projects_text),
    ]

    if args.mode == "diff":
        any_diff = False
        for path, new_body in targets:
            old = read_text_if_exists(path)
            new = replace_governed_section(old, new_body)
            d = unified_diff(old, new, str(path), f"{path} (projected)")
            if d:
                any_diff = True
                print(d, end="" if d.endswith("\n") else "\n")
        if not any_diff:
            print("No projection changes.")
        elif args.exit_code:
            print(
                "\nProjections are stale vs canonical tasks.json. "
                "Run `python3 scripts/render-tier1-state.py write` and commit.",
                file=sys.stderr,
            )
            sys.exit(1)
        return

    print("Rendered:")
    for path, new_body in targets:
        old = read_text_if_exists(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(replace_governed_section(old, new_body))
        print(f"- {path}")

    # Refresh the presence-derived project live-status projection (#3925 S3/S5). This is a
    # SEPARATE projection from the four Tier-1 targets above — it is derived from live
    # presence/leases/file-claims (not tasks.json), so it changes every tick and must stay
    # OUT of the drift-gate `targets` set (else `diff --exit-code` / main-health would read
    # normal presence churn as perpetual drift). Runs as an isolated subprocess so a failure
    # here can NEVER break the daemon-critical Tier-1 render above. Its outputs
    # (docs/process/project-live-status.md + docs/process/state/project-live-status.json) are
    # merge=keepours and ride the auto-sync daemon's commits, not the land pathspec.
    proj_ws = ROOT / "scripts" / "project-workspace.py"
    if proj_ws.exists():
        try:
            r = subprocess.run(
                [sys.executable, str(proj_ws), "render-projection"],
                capture_output=True, text=True, timeout=60,
            )
            if r.returncode == 0:
                print("- docs/process/project-live-status.md (project presence projection)")
            else:
                print(
                    f"WARN: project-live-status projection refresh exited {r.returncode}: "
                    f"{(r.stderr or r.stdout).strip()[:200]}",
                    file=sys.stderr,
                )
        except Exception as exc:  # never let the project projection break the Tier-1 render
            print(f"WARN: project-live-status projection refresh skipped: {exc}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
