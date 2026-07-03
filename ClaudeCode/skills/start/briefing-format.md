# Briefing Format — /start output template

Print a single clean briefing block. No preamble, no padding.

```
---
**SESSION BRIEF — <date>**

⚠ **COLD PICKUP** — working-context is from <date>, last close was <N> days ago. Threads may be stale.
*(omit this line if not a cold session)*

**Git state:** <uncommitted files if any, or "clean"> · <N intentional commits since last close>

**System:** <one line — gateway up/down, lanes status> · LaunchAgents: <dashboard/RAPTOR/auto-sync: up or flagged>

**Last session left off:** <one sentence from Active focus + Next action>

**Open threads:** <bulleted list of unresolved items from working-context — trim to what's actionable>

**Active in other sessions:** <CLAIMED + WIP items, or "clear" if none — so we don't collide>

**Workstream map:**
<paste session-workstreams.py output verbatim here — the lane diagram IS the menu>

*Drift: <none, or: "N reconcile warn(s)" for routine lag — name any reconcile FAIL (I1/I2/I6) explicitly: those are structural breaks to reconcile before acting on FREE items>*

*(Fallback only — if session-workstreams.py failed, replace the map with a flat ranked list:)*
1. **<label>** [<priority>] — <one-line why: what this unblocks or delivers>
2. **<label>** [<priority>] — <one-line why>
3. **<label>** [<priority>] — <one-line why>
---
```

## Rules

- One briefing block — no multiple sections or follow-up prose before Ant picks a task
- Workstream map verbatim — do not summarise `session-workstreams.py` output into a flat list unless the script failed
- Structural FAILs from reconcile → name them explicitly above the workstream map, not buried in Drift
- COLD PICKUP warning → first line of the block, bold, so it's impossible to miss
