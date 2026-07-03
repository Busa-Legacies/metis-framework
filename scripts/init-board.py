#!/usr/bin/env python3
"""init-board.py — scaffold an empty governed task board for a fresh metis-core install.

A new consumer's `docs/process/state/` ships with no `tasks.json` / `task-areas.json` /
`projects.json`, so `claim-next` has nothing to read and the lifecycle dead-ends on first
run. This seeds them from `config/infrastructure.json` (domains -> board areas) so a stranger
can create and claim their first task immediately. (#434)

Idempotent: refuses to overwrite a `tasks.json` that already holds tasks.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
# REPO_ROOT (per-invocation/worktree/vendored subtree) -> METIS_HOME (canonical) ->
# file location, matching update/render-tier1-state.py so cold-start seeds the host
# repo's board, not the framework dir, under a REPO_ROOT-pinned layout (#434/#451).
HOME = Path(os.environ.get("REPO_ROOT") or os.environ.get("METIS_HOME") or HERE.parent)
STATE = HOME / "docs" / "process" / "state"

sys.path.insert(0, str(HERE / "lib"))
try:
    import infra_config
    DOMAINS = infra_config.domains()
except Exception:
    DOMAINS = ["uncategorized"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2) + "\n")


def main() -> int:
    tasks_p = STATE / "tasks.json"
    if tasks_p.exists():
        try:
            if json.loads(tasks_p.read_text()).get("tasks"):
                print(f"board already initialized at {STATE} — nothing to do")
                return 0
        except ValueError:
            pass  # corrupt/empty -> re-seed

    # Board areas from the org's declared domains, plus an always-present catch-all.
    seen, areas = set(), []
    for dom in list(DOMAINS) + ["uncategorized"]:
        name = str(dom).replace("-", " ").replace("_", " ").title()
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        areas.append({"name": name, "priority": "P2", "status": "active",
                      "description": f"{name} work."})

    _write(STATE / "task-areas.json",
           {"version": 1, "comment": "Board areas seeded by init-board from config domains.",
            "areas": areas})
    _write(STATE / "projects.json",
           {"version": 1, "updatedAt": _now(), "projects": [
               {"projectId": "P01", "slug": "general", "name": "General", "goal": "G1",
                "status": "active", "priority": "P2",
                "doneWhen": "Replace with your first real project."}]})
    _write(tasks_p, {"version": 1, "updatedAt": _now(), "tasks": [], "archivedIds": []})
    _write(STATE / "tasks-archive.json", {"version": 1, "tasks": []})
    _write(STATE / "live-focus.json",
           {"version": 1, "focusSummary": "", "mode": "active", "waitingOnAnt": False,
            "blockerSummary": None, "nextSteps": [], "derivedFromTaskIds": [],
            "updatedAt": _now()})

    # The machine-local workspace: 'state/' holds the rendered board projection
    # (render-tier1-state.py writes OPEN_TASKS.md here) and 'memory/' holds the
    # cross-session working-context scratchpad. Seed both so the first render and
    # session-start read succeed instead of dead-ending on a missing dir.
    ws = HOME / "workspace"
    (ws / "state").mkdir(parents=True, exist_ok=True)
    (ws / "memory").mkdir(parents=True, exist_ok=True)
    wc = ws / "memory" / "working-context.md"
    if not wc.exists():
        wc.write_text("# Working context\n\n## Next action\n\n## Open threads\n")
    print(f"seeded board at {STATE}: {len(areas)} area(s), starter project 'general', empty task list")
    print(f"seeded workspace at {ws}: state/ (board projection) + memory/working-context.md")

    render = HERE / "render-tier1-state.py"
    if render.exists():
        r = subprocess.run([sys.executable, str(render)], cwd=str(HOME),
                           capture_output=True, text=True)
        print("rendered board projection" if r.returncode == 0
              else f"(render skipped: {r.stderr.strip()[:120]})")
    print("\nNext: create your first task, then claim it —")
    print("  python3 scripts/update-tier1-state.py create-task --actor <you> --patch "
          "'{\"taskId\":\"#1\",\"title\":\"my first task\",\"project\":\"general\","
          "\"area\":\"Uncategorized\",\"agent\":\"claude\",\"machine\":\"<your-machine-id>\","
          "\"origin\":\"ant\",\"owner\":\"<you>\",\"priority\":\"P2\",\"state\":\"queued\"}'")
    print("  python3 scripts/agent-work.py claim-next --agent <you>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
