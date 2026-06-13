#!/usr/bin/env python3
"""Self-test for the priorities engine (pure functions, synthetic data)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import priorities as p  # noqa: E402

PASS = FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1; print(f"  ok  {name}")
    else:
        FAIL += 1; print(f"  XX  {name}")


GOALS = [
    {"id": "G1", "system": 1, "title": "Ecosystem", "weight": 5, "projects": ["ops"], "areas": ["OpenClaw Infrastructure", "Automation"]},
    {"id": "G2", "system": 1, "title": "Dashboard", "weight": 4, "projects": ["dashboard-core"], "areas": ["Dashboard"]},
    {"id": "G3", "system": 2, "title": "Example", "weight": 4, "projects": ["partner-brief"], "areas": ["Example Market"]},
]


def task(tid, area=None, pri="P2", state="queued", blocker="none", goalIds=None, project=None):
    t = {"taskId": tid, "title": tid, "area": area, "priority": pri,
         "state": state, "blockerOrNone": blocker}
    if goalIds:
        t["goalIds"] = goalIds
    if project:
        t["project"] = project
    return t


print("== mapping ==")
check("area maps to goal", p.map_task_goals(task("#1", "Dashboard"), GOALS) == ["G2"])
check("explicit goalIds override area", p.map_task_goals(task("#2", "Dashboard", goalIds=["G1"]), GOALS) == ["G1"])
check("invalid explicit goalId dropped", p.map_task_goals(task("#3", goalIds=["G9"]), GOALS) == [])
check("unmapped area → orphan", p.map_task_goals(task("#4", "Uncategorized"), GOALS) == [])
check("multi-area goal matches", p.map_task_goals(task("#5", "Automation"), GOALS) == ["G1"])
check("project maps before area", p.map_task_goals(task("#6", "Uncategorized", project="dashboard-core"), GOALS) == ["G2"])

print("== scoring (goal_weight × urgency × readiness) ==")
check("P1 dashboard queued = 4×3×1 = 12", p.score_task(task("#a", "Dashboard", "P1"), GOALS)["score"] == 12.0)
check("P2 G1 in_progress = 5×2×1.3 = 13", p.score_task(task("#b", "Automation", "P2", "in_progress"), GOALS)["score"] == 13.0)
check("P3 G1 queued = 5×1×1 = 5", p.score_task(task("#c", "Automation", "P3"), GOALS)["score"] == 5.0)
check("blocked halves readiness (P1 G2 blocked = 4×3×0.5 = 6)",
      p.score_task(task("#d", "Dashboard", "P1", blocker="waiting on Ant"), GOALS)["score"] == 6.0)
check("state=blocked also 0.5", p.score_task(task("#e", "Dashboard", "P1", state="blocked"), GOALS)["readiness"] == 0.5)
check("needs_verification readiness 1.2",
      p.score_task(task("#f", "Dashboard", "P2", state="needs_verification"), GOALS)["readiness"] == 1.2)
check("orphan flagged + weight 0", p.score_task(task("#g", "Uncategorized"), GOALS)["orphan"] is True
      and p.score_task(task("#g", "Uncategorized"), GOALS)["goal_weight"] == 0.0)
check("blocked P1 (6) outranks queued P3 (5)",
      p.score_task(task("#d", "Dashboard", "P1", blocker="x"), GOALS)["score"]
      > p.score_task(task("#c", "Automation", "P3"), GOALS)["score"])

print("== ranking + filtering ==")
tasks = [
    task("#done", "Dashboard", "P1", state="done"),       # terminal — excluded
    task("#wip", "Automation", "P2", state="in_progress"),  # 13
    task("#nav", "Example Market", "P1"),                   # 12, system 2
    task("#orph", "Uncategorized", "P1"),                  # orphan
    task("#low", "Dashboard", "P3"),                       # 4
]
r = p.rank(tasks, GOALS)
check("terminal (done) excluded from ranking", all(s["taskId"] != "#done" for s in r["ranked"]))
check("ranked desc by score", [s["taskId"] for s in r["ranked"]] == ["#wip", "#nav", "#low"])
check("split by system", set(r["by_system"]) == {1, 2})
check("system 2 holds example", [s["taskId"] for s in r["by_system"][2]] == ["#nav"])
check("orphan separated out", [s["taskId"] for s in r["orphans"]] == ["#orph"])

print("== goal coverage ==")
cov = {g["id"]: g for g in p.goal_coverage(tasks, GOALS)}
check("G1 active counts wip", cov["G1"]["active"] == 1 and cov["G1"]["in_progress"] == 1)
check("G2 counts done separately", cov["G2"]["done"] == 1 and cov["G2"]["active"] == 1)
check("G3 active from example", cov["G3"]["active"] == 1)

print("== real data sanity ==")
try:
    g, t = p.load_goals(), p.load_tasks()
    rr = p.rank(t, g)
    check("loads real goals.json + tasks.json", len(g) == 6 and len(t) > 0)
    check("real ranking non-empty + scored", rr["ranked"] and rr["ranked"][0]["score"] > 0)
except Exception as e:
    check(f"real data load ({e})", False)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
