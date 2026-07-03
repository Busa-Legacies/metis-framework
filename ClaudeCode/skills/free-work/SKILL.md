---
name: Free Work
slug: free-work
version: 1.0.0
description: "Show what work is open and unclaimed for THIS machine right now — browse without claiming. Use /next to claim atomically."
---

## Steps

Pickup is **project-oriented** (#181): the default view is a ranked **project board**, not a flat task list. The pickup question is "which project needs hands", then "which task inside it".

1. Run the aggregator:
   ```bash
   cd ~/metis-os && python3 scripts/free-work.py
   ```
   Default output is the **PROJECT BOARD**: active projects ranked by status > priority > free-count > blocked-ratio, each row showing `free / blocked / claimed` counts and the live presence roster (who's working there now).

2. Drill into a project:
   ```bash
   python3 scripts/free-work.py --project <slug>
   ```
   Shows that project's CLAIMED / BLOCKED / FREE tasks. (`--flat` gives the legacy global task list; sources and buckets unchanged: leases + `tasks.json` canonical, OPEN_TASKS.md/issues projections.)

3. If DRIFT is non-empty, call it out — do not recommend a "free" item that drift contradicts until reconciled.

4. Present a **ranked shortlist (top 3)** — projects first (with the why), then the top free task inside the recommended one. A project with sibling presence is a *feature* (collaborate, split its list), not a conflict. Skip CLAIMED tasks (lease = someone is actively on it) and BLOCKED.

5. If WIP shows this session already holds a live lease, surface that first — finish or release it before claiming more.

6. Ask which project/task to pick up, or proceed if Ant already named one.

## Notes
- Machine identity auto-derived from hostname (AntFox-Macbook → <<MACHINE_1_ID>>/<<MACHINE_1_ID>>). Override: `--machine <name>` or `FREE_WORK_MACHINE=<name>`.
- Use `/next` to actually claim — `join <slug>` then `claim-next` (selects + claims inside one lock so concurrent sessions get different tasks, even within the same project).
