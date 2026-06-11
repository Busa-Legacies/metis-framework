#!/usr/bin/env python3
"""Harness for the governed task archiver + tombstone merge (archive-done-tasks.py + merge-taskstate.py).

Run before deploying either. Exercises the real scripts against throwaway temp files. Exit 0 = all pass.
"""
import json, subprocess, sys, tempfile, pathlib, importlib.util

ROOT = pathlib.Path(__file__).resolve().parent.parent
MERGE = ROOT / "scripts/merge-taskstate.py"

def _load_archiver():
    spec = importlib.util.spec_from_file_location("ada", ROOT / "scripts/archive-done-tasks.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m

def _task(tid, state, **kw):
    t = {"taskId": tid, "state": state, "revision": kw.pop("revision", 1),
         "updatedAt": kw.pop("updatedAt", "2026-06-10T00:00:00+00:00")}
    t.update(kw); return t

results = []
def check(name, cond):
    results.append((name, cond))
    print(("✓ " if cond else "✗ FAIL ") + name)

# ---- 1. archiver: terminal moved, open kept, referenced-terminal kept ----
ada = _load_archiver()
doc = {"version": 1, "tasks": [
    _task("#001", "done"),
    _task("#002", "done"),
    _task("#003", "queued"),
    _task("#004", "done"),                                  # referenced as prereq by open #003 -> keep
    _task("#003", "queued", prerequisites=["#004"]) if False else _task("#005", "in_progress"),
]}
# make #003 depend on #004
for t in doc["tasks"]:
    if t["taskId"] == "#003": t["prerequisites"] = ["#004"]
to_arch, kept_refs, already = ada.plan(doc)
arch_ids = {t["taskId"] for t in to_arch}
check("archiver picks terminal #001/#002", {"#001", "#002"} <= arch_ids)
check("archiver keeps open #003/#005 out", not ({"#003", "#005"} & arch_ids))
check("archiver keeps terminal #004 referenced by open #003", "#004" not in arch_ids and "#004" in kept_refs)

# ---- 2. tombstone merge converges: ours archived #001, theirs still active+done ----
with tempfile.TemporaryDirectory() as td:
    td = pathlib.Path(td)
    base = {"version": 1, "tasks": [_task("#001", "done"), _task("#009", "queued")]}
    ours = {"version": 1, "archivedIds": ["#001"], "tasks": [_task("#009", "queued", revision=2)]}
    theirs = {"version": 1, "tasks": [_task("#001", "done", revision=1), _task("#009", "queued")]}
    (td/"O").write_text(json.dumps(base)); (td/"A").write_text(json.dumps(ours)); (td/"B").write_text(json.dumps(theirs))
    rc = subprocess.run([sys.executable, str(MERGE), str(td/"O"), str(td/"A"), str(td/"B"),
                         "docs/process/state/tasks.json"]).returncode
    merged = json.loads((td/"A").read_text())
    ids = {t["taskId"] for t in merged["tasks"]}
    check("merge driver exits 0", rc == 0)
    check("tombstoned #001 EXCLUDED from active after merge (convergence)", "#001" not in ids)
    check("archivedIds retained through merge", "#001" in merged.get("archivedIds", []))
    check("non-archived #009 survives + keeps higher revision", any(t["taskId"]=="#009" and t["revision"]==2 for t in merged["tasks"]))

# ---- 3. tombstone union: each side archived a different id -> both excluded ----
with tempfile.TemporaryDirectory() as td:
    td = pathlib.Path(td)
    ours = {"version":1,"archivedIds":["#001"],"tasks":[_task("#002","done"),_task("#003","queued")]}
    theirs = {"version":1,"archivedIds":["#002"],"tasks":[_task("#001","done"),_task("#003","queued")]}
    (td/"O").write_text("{}"); (td/"A").write_text(json.dumps(ours)); (td/"B").write_text(json.dumps(theirs))
    subprocess.run([sys.executable, str(MERGE), str(td/"O"), str(td/"A"), str(td/"B"), "tasks.json"])
    merged = json.loads((td/"A").read_text())
    ids = {t["taskId"] for t in merged["tasks"]}
    check("union of tombstones excludes BOTH #001 and #002", not ({"#001","#002"} & ids))
    check("archivedIds is the union", set(merged.get("archivedIds",[])) == {"#001","#002"})

# ---- 4. counter merge still works (no archivedIds key) ----
with tempfile.TemporaryDirectory() as td:
    td = pathlib.Path(td)
    (td/"O").write_text("{}")
    (td/"A").write_text(json.dumps({"lastAssigned": 262, "updatedAt": "2026-06-10T10:00:00"}))
    (td/"B").write_text(json.dumps({"lastAssigned": 261, "updatedAt": "2026-06-10T11:00:00"}))
    subprocess.run([sys.executable, str(MERGE), str(td/"O"), str(td/"A"), str(td/"B"), "task-counter.json"])
    merged = json.loads((td/"A").read_text())
    check("counter merge keeps max(lastAssigned)", merged["lastAssigned"] == 262)

passed = sum(1 for _, c in results if c)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
