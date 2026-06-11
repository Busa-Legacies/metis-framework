#!/usr/bin/env python3
"""System-wide priorities — the decision matrix that ranks active work against goals.

Connects the two halves that were sitting disconnected:
  - docs/process/goals.json  (G1-G5, weights, area->goal mapping)
  - docs/process/state/tasks.json  (governed task state)

It maps each active task to a goal (explicit `goalIds`, else by `area`), scores it
on a transparent matrix (goal weight × urgency × readiness), and ranks the result
per priority-system. Orphans (no goal) are surfaced for triage. Fully derived from
governed state — no manual upkeep.

    python3 scripts/priorities.py matrix         # the full ranked decision matrix
    python3 scripts/priorities.py next -n 8       # top actionable work, system-wide
    python3 scripts/priorities.py next --system 1 # within one priority system
    python3 scripts/priorities.py goals           # goal coverage / load
    python3 scripts/priorities.py orphans         # active tasks mapping to no goal
"""
import argparse
import json
import sys
from pathlib import Path


def find_repo_root(start=None):
    path = Path(start or Path(__file__).resolve().parent).resolve()
    while path != path.parent:
        if (path / "docs" / "process" / "state").is_dir():
            return path
        path = path.parent
    raise RuntimeError("repo root not found (docs/process/state)")


REPO = find_repo_root()
GOALS_FILE = REPO / "docs" / "process" / "goals.json"
TASKS_FILE = REPO / "docs" / "process" / "state" / "tasks.json"

# A task in one of these states is finished — never ranked.
TERMINAL_STATES = {"done", "rejected", "cancelled", "dropped", "archived"}
# Urgency weight by task priority.
URGENCY = {"P1": 3.0, "P2": 2.0, "P3": 1.0}


# ── pure engine ───────────────────────────────────────────────────────────────
def goals_by_id(goals: list) -> dict:
    return {g["id"]: g for g in goals}


def _area_to_goals(goals: list) -> dict:
    out: dict = {}
    for g in goals:
        for area in g.get("areas", []):
            out.setdefault(area, []).append(g["id"])
    return out


def map_task_goals(task: dict, goals: list) -> list:
    """Goal ids a task serves: explicit task['goalIds'] wins, else map by area."""
    explicit = task.get("goalIds")
    if explicit:
        valid = {g["id"] for g in goals}
        return [g for g in explicit if g in valid]
    return _area_to_goals(goals).get(task.get("area") or "", [])


def _readiness(task: dict) -> float:
    """How actionable a task is right now."""
    state = (task.get("state") or "").lower()
    blocked = (task.get("blockerOrNone") or "none").strip().lower() not in ("", "none")
    if state == "blocked" or blocked:
        return 0.5                      # de-rank (not actionable) but keep above trivia
    if state == "in_progress":
        return 1.3                      # finish what's started
    if state in ("needs_verification", "execution_finished"):
        return 1.2                      # nearly closed — push it over
    return 1.0


def score_task(task: dict, goals: list) -> dict:
    """The matrix row: goal weight × urgency × readiness, with components exposed."""
    gids = map_task_goals(task, goals)
    by_id = goals_by_id(goals)
    goal_weight = max((by_id[g]["weight"] for g in gids), default=0.0)
    urgency = URGENCY.get((task.get("priority") or "").upper(), 1.0)
    readiness = _readiness(task)
    score = round(goal_weight * urgency * readiness, 2)
    system = next((by_id[g]["system"] for g in gids), None)
    return {
        "taskId": task.get("taskId"), "title": task.get("title"),
        "priority": task.get("priority"), "state": task.get("state"),
        "area": task.get("area"), "goals": gids, "system": system,
        "goal_weight": goal_weight, "urgency": urgency, "readiness": readiness,
        "score": score, "orphan": not gids,
    }


def active_tasks(tasks: list) -> list:
    return [t for t in tasks if (t.get("state") or "").lower() not in TERMINAL_STATES]


def rank(tasks: list, goals: list) -> dict:
    """Ranked decision matrix: scored active tasks split by priority-system, plus
    the orphan list (active tasks that map to no goal)."""
    scored = [score_task(t, goals) for t in active_tasks(tasks)]
    ranked = sorted((s for s in scored if not s["orphan"]),
                    key=lambda s: (s["score"], URGENCY.get((s["priority"] or "").upper(), 0)),
                    reverse=True)
    by_system: dict = {}
    for s in ranked:
        by_system.setdefault(s["system"], []).append(s)
    orphans = [s for s in scored if s["orphan"]]
    return {"by_system": by_system, "ranked": ranked, "orphans": orphans}


def goal_coverage(tasks: list, goals: list) -> list:
    """Per-goal active load + done count (rough progress signal)."""
    act = active_tasks(tasks)
    done = [t for t in tasks if (t.get("state") or "").lower() == "done"]
    rows = []
    for g in goals:
        a = [t for t in act if g["id"] in map_task_goals(t, goals)]
        d = [t for t in done if g["id"] in map_task_goals(t, goals)]
        rows.append({
            "id": g["id"], "title": g["title"], "system": g["system"],
            "weight": g["weight"], "marker": g.get("marker", ""),
            "active": len(a),
            "in_progress": sum(1 for t in a if (t.get("state") or "") == "in_progress"),
            "blocked": sum(1 for t in a
                           if (t.get("state") == "blocked"
                               or (t.get("blockerOrNone") or "none") not in ("none", ""))),
            "done": len(d),
        })
    return rows


# ── IO + CLI ──────────────────────────────────────────────────────────────────
def load_goals() -> list:
    return json.loads(GOALS_FILE.read_text())["goals"]


def load_tasks() -> list:
    d = json.loads(TASKS_FILE.read_text())
    return d["tasks"] if isinstance(d, dict) and "tasks" in d else d


def _systems() -> dict:
    return {int(k): v for k, v in json.loads(GOALS_FILE.read_text()).get("systems", {}).items()}


def _row(s: dict) -> str:
    gl = ",".join(s["goals"]) or "—"
    return (f"  {s['score']:>5.1f}  {s['priority'] or '--':<3} {s['state'] or '':<16} "
            f"[{gl:<6}] {s['taskId'] or '':<6} {(s['title'] or '')[:54]}")


def cmd_matrix(args):
    goals, tasks = load_goals(), load_tasks()
    r = rank(tasks, goals)
    systems = _systems()
    print("══ PRIORITY DECISION MATRIX  (score = goal_weight × urgency × readiness) ══")
    for sysid in sorted(r["by_system"]):
        rows = r["by_system"][sysid]
        print(f"\n── System {sysid}: {systems.get(sysid, '?')}  ({len(rows)} active) ──")
        print("  score  pri state            goal   id     title")
        for s in rows[: args.limit]:
            print(_row(s))
    if r["orphans"]:
        print(f"\n── Orphans: {len(r['orphans'])} active task(s) map to NO goal (triage) ──")
        for s in r["orphans"][: args.limit]:
            print(_row(s))


def cmd_next(args):
    goals, tasks = load_goals(), load_tasks()
    r = rank(tasks, goals)
    rows = r["ranked"]
    if args.system:
        rows = [s for s in rows if s["system"] == args.system]
    print(f"══ NEXT {min(args.n, len(rows))} (system-wide ranked) ══")
    print("  score  pri state            goal   id     title")
    for s in rows[: args.n]:
        print(_row(s))


def cmd_goals(args):
    rows = goal_coverage(load_tasks(), load_goals())
    systems = _systems()
    print("══ GOAL COVERAGE ══")
    print("  goal  w  sys  active  wip  blkd  done  title")
    for g in sorted(rows, key=lambda x: (x["system"], -x["weight"])):
        print(f"  {g['id']:<4} {g['weight']}  S{g['system']}   {g['active']:>5}  "
              f"{g['in_progress']:>3}  {g['blocked']:>3}  {g['done']:>4}  {g['title'][:40]}"
              + (f"   ← {g['marker']}" if g["marker"] else ""))


def cmd_orphans(args):
    goals, tasks = load_goals(), load_tasks()
    orphans = rank(tasks, goals)["orphans"]
    print(f"══ ORPHANS — {len(orphans)} active task(s) with no goal (drop, defer, or assign goalIds) ══")
    for s in sorted(orphans, key=lambda s: URGENCY.get((s["priority"] or "").upper(), 0), reverse=True):
        print(f"  {s['priority'] or '--':<3} {s['state'] or '':<16} {s['area'] or 'None':<22} "
              f"{s['taskId'] or '':<6} {(s['title'] or '')[:50]}")


def cmd_blocked(args):
    """Important-but-stuck work — high score yet not actionable (readiness 0.5)."""
    goals, tasks = load_goals(), load_tasks()
    scored = [score_task(t, goals) for t in active_tasks(tasks)]
    blocked = [s for s in scored if s["readiness"] == 0.5]
    print(f"══ BLOCKED — {len(blocked)} active task(s) stuck (unblock to action) ══")
    print("  score  pri state            goal   id     title")
    for s in sorted(blocked, key=lambda s: s["score"], reverse=True):
        print(_row(s))


def main():
    ap = argparse.ArgumentParser(description="System-wide priorities / decision matrix")
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("matrix"); m.add_argument("--limit", type=int, default=12); m.set_defaults(fn=cmd_matrix)
    n = sub.add_parser("next"); n.add_argument("-n", type=int, default=8)
    n.add_argument("--system", type=int); n.set_defaults(fn=cmd_next)
    sub.add_parser("goals").set_defaults(fn=cmd_goals)
    sub.add_parser("orphans").set_defaults(fn=cmd_orphans)
    sub.add_parser("blocked").set_defaults(fn=cmd_blocked)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
