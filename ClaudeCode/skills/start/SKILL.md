---
name: Start Session
slug: start
version: 1.0.0
description: "Begin a new session — collect git/system/task state, detect cold pickup, and present a ranked workstream briefing."
argument-hint: "[focus hint (optional)]"
---

## Step 0 — Fast path (default): the assembled brief (#2467)

Run the deterministic assembler FIRST — it collects every data stream below and composes the
briefing per `briefing-format.md`, so the session reads one compact artifact instead of ingesting
~10 raw command dumps and composing on Opus (PLAN-orchestration-pma P1):
```bash
cd ~/metis-os && python3 scripts/start-brief.py
```
If it prints a `SESSION BRIEF` block, **present that as the briefing** — skip the manual assembly
in Steps 1–7 (they are the FALLBACK for when the script errors). Then still do the interactive-only
follow-ups the script can't: **Step 5b** ready-check on any WIP lease it flagged, **Step 5d** Notion
`fold-it` actions that need an edit-vs-canonical diff, and the Step-7 close (ask Ant which option —
the workstream map's ★ is the recommended pick). If `$ARGUMENTS` was given, apply it as a filter/hint.
The script self-gates on an **arbiter-vs-spec check** (`validate()`): if the assembled brief fails
structural conformance to `briefing-format.md` it exits non-zero and prints nothing, so a malformed
brief is never presented. If the script fails, exits non-zero, or prints no brief, fall through to
the manual steps below. (`start-brief.py --check` runs the gate; `--selftest` is the regression;
`--arbiter` adds an opt-in single-step semantic verdict from the arbiter lane.)

---

The steps below are the FALLBACK path (run in order, collecting data before presenting) — and the
reference spec for what `start-brief.py` assembles.

## Step 1 — Git continuity check
```bash
cd ~/metis-os

# Uncommitted work from a prior session
git status --short

# Intentional commits since the last close (filter out auto-sync snapshots)
last_sha=$(grep -h 'closed-at:' workspace/memory/*.md 2>/dev/null | tail -1 | awk '{print $2}')
if [ -n "$last_sha" ]; then
  git log "${last_sha}..HEAD" --invert-grep --grep='\[auto-sync\]' --oneline
else
  git log --invert-grep --grep='\[auto-sync\]' --oneline -10
fi
```
Any dirty files from `git status --short` mean a prior session ended without `/checkpoint` or `/end` — surface this prominently.

## Step 2 — Cold session detection
From the git log and working-context.md date:
- **Cold** = working-context date is NOT today AND last intentional commit is >24h old → flag prominently; threads may be stale.
- Otherwise → normal continuation.

## Step 3 — System health
```bash
cd ~/metis-os && openclaw status 2>&1

# LaunchAgent pulse
launchctl list | grep -E 'ant\.|<<MACHINE_2_USER>>\.' 2>/dev/null
```
Interpret three-column `(PID, Status, Label)` output:
- PID present + status 0 → running normally
- PID absent + status 0 → scheduled agent at rest between runs (RAPTOR, git-sync, morning-brief) — **normal**
- PID absent + status non-zero → last run **failed** → flag it
- Label missing entirely → not loaded → flag it

Flag `dashboard` and `ttyd` explicitly if PID is absent (they should be persistent).

**At-<<MACHINE_1_ID>> reminders (#769):** if this session is on **<<MACHINE_1_ID>> (<<MACHINE_1_ID>>)**, surface any pending
sudo/physical-access actions — they can't be done remotely, so this is the moment:
```bash
[ -s ~/metis-os/workspace/state/at-<<MACHINE_1_ID>>-reminders.md ] && cat ~/metis-os/workspace/state/at-<<MACHINE_1_ID>>-reminders.md
```
On <<MACHINE_2_ID>>, skip it. Call out anything listed in the briefing (Step 7) so it doesn't slip another cycle.

## Step 3b — Budget pre-flight (#781)
Surface the remaining Claude budget at session start so routing is a conscious choice, not a mid-session surprise:
```bash
python3 scripts/metis-status.py --dispatches 2>&1 | sed -n '1,20p'
```
Read the aggregated **5h / 7d** windows. If the 5h window is running low (heuristic: ≲20% left), bias routine generation to <<MACHINE_1_ID>> lanes (`smith`/`scout`) or `metis` (which auto-falls-back Claude→Codex→local MLX by remaining budget) and reserve Claude for judgment/agentic work; call it out in the briefing (Step 7). Plenty left → proceed normally. Money is never printed (`--cost` stays off). Unknown budget = treat as usable, never demote on a probe blip.

## Step 3c — Desktop-control stale-sweep (<<MACHINE_1_ID>> only, #654)
Crash-safety net for desktop control: a session that drove <<MACHINE_1_ID>>'s GUI and crashed before `/end`
leaves its desktop baseline on disk. Sweep a *stale* one (older than 30 min, so a concurrent live
session's baseline is never touched):
```bash
python3 scripts/computer_use/desktop_hygiene.py restore --if-stale 1800   # <<MACHINE_1_ID>> only
```
`no_snapshot`/`fresh_skip` → nothing to do. On <<MACHINE_2_ID>>/Air (no desktop control), skip. If it closes
anything, note it in the briefing (Step 7). Standard: `docs/process/desktop-control-hygiene.md`.

## Step 4 — Working context
Read `~/metis-os/workspace/memory/working-context.md` explicitly:
- **Active focus** — what last session was driving
- **Open threads** — in-flight items, dispatched agents, residuals
- **Blockers** — anything unresolved
- **Next action** — the single highest-value forward step from last close

## Step 5 — Project board + task queue

**Lane scope first (#325):** if `$METIS_LANE` is set (session launched via `lane <name>`,
see `docs/process/claude-session-persistence.md`), this session belongs to that campaign lane.
Open the briefing with the lane name, scope the board to the lane's projects, and prefer
lane-scoped claiming for the rest of the session — `claim-next` already applies the
`$METIS_LANE` filter automatically. `hub` (or unset) = unscoped, use the global board.
Working outside the lane is a deliberate pivot — surface it as such, never silent.

```bash
cd ~/metis-os && python3 scripts/free-work.py
```
Default output is the ranked **PROJECT BOARD** (#181) — which projects need hands, with free/blocked/claimed counts and the presence roster per row. Drill into the top candidates:
```bash
python3 scripts/free-work.py --project <slug>
```
Read the buckets: **CLAIMED / BLOCKED / FREE / DRIFT / WIP**.
- `CLAIMED` → a live lease; someone is actively on that *task*; do not start it (sharing the *project* is fine — that's the model)
- `WIP` → live leases on THIS machine → surface prominently; finish/release before claiming more
- `DRIFT` → projection/canonical mismatch → reconcile before recommending FREE items
- `FREE` → eligible work for this machine, priority-ranked
- Presence roster → sibling sessions in a project; brief by project, not by isolated task

**Gated insights (don't let them rot):** surefire, low-risk insights auto-graduate to `queued`
and get acted on; the rest sit in the inbox gate. Surface the gated count so Ant sees them:
```bash
python3 scripts/insights-inbox.py --summary
```
If >0, mention it in the briefing (e.g. "3 insights gated in inbox — review with
`insights-inbox.py` to `--queue`/`--drop`"). Don't force triage — just make it visible.

## Step 5a — Workstream map
```bash
cd ~/metis-os && python3 scripts/session-workstreams.py
```
Paste output verbatim as the briefing's **Workstream map** section. It already marks the recommended pick (★), held leases `[HELD!]`, and Ant-gated items `[ANT]`. If the script fails, fall back to a flat ranked list.

## Step 5b — Ready-check held leases
If `free-work.py` reported **WIP** items, run `task-ready.sh` on each:
```bash
bash ~/metis-os/scripts/task-ready.sh "<label>"
```
- Exit 2 (MAYBE DONE) → surface prominently; ask Ant to confirm before re-working
- Exit 1 (BLOCKED) → surface; recommend releasing or switching to the blocking task
- Exit 0 (READY) → continue normally

## Step 5c — Canonical-state invariant check
```bash
cd ~/metis-os && python3 scripts/agent-work.py reconcile
```
- **Any FAIL line** → structural break; surface prominently and reconcile BEFORE recommending any FREE item
- **WARN lines only** → routine projection lag; note the count in `Drift:` line
- Script unavailable → note "reconcile unavailable"; fall back to free-work's DRIFT bucket

## Step 5d — Notion Control Center sweep (Lane 2, #218)
```bash
cd ~/metis-os && python3 scripts/notion-session-sweep.py
```
Surfaces judgment cards Ant directed from his phone that need an agent this session:
- **`judgment`** reason → card marked `Action=▶ Run on <<MACHINE_1_ID>>` with no Run Key (not a script — needs your call/action). The poller defers these here.
- **`fold-it`** reason → `Status=Edited: fold it` → diff Ant's edits vs the repo canonical, fold voice deltas, set `Status=Done` ([[project_notion_command_center]]).

Include any surfaced cards in the briefing as a **Control Center** section and treat them as high-priority pickups. Soft-fail: if the sweep errors (Notion down, token/share issue → `restricted_resource`/`object_not_found`), note "Control Center unreachable" and continue — never block session start. Reading per-card comments is the #219 feedback loop (gated on the comment-capability toggle).

## Step 5e — Autonomy graduation tiers (#3444, doctrine §2e)
```bash
cd ~/metis-os && python3 scripts/autonomy-graduation-reader.py --json
```
Per-work-class trust tiers (spec'd code · infra/maintenance · voice drafting · research): tier 0 = propose (decision-card before acting), 1 = act + review-card, 2 = act + log (silent). **Surface only classes at `tier ≥ 1`** as a one-line **Autonomy** note in the briefing — they've *earned* less-gated routine handling this session, so let it change how you operate in that class. If every class is tier 0 (the default until trust accumulates), stay silent — no ignorable FYI. Hard floors (money/external/irreversible/secrets) still force a decision-card regardless of tier. Soft-fail: reader errors → skip.

## Step 5f — Pending reasoning proposals (#3556, self-improve)
```bash
cd ~/metis-os && python3 scripts/reasoning-proposal-review.py --list
```
The weekly `ant.reasoning-synthesize` job distills the growing mindset/ratings/decision corpus into doctrine-improvement proposals; this is the review seam so they don't pile up unseen. **If any are pending**, surface a one-line **Reasoning proposals** note (count + newest date) in the briefing so Ant can review/accept via `reasoning-proposal-review.py --proposal <f> --action accept|edit|reject`. None pending → stay silent (state-layer, not an FYI). Soft-fail: script errors → skip.

## Step 6 — Dispatched/pending agent work
Scan `## Open threads` for items marked `[Scout/Smith dispatched]` or `awaiting`. Note any with results ready to review and apply.

## Step 7 — Present the session briefing
See `briefing-format.md` in this skill directory for the exact output template.

If `$ARGUMENTS` was provided, use it as a filter/hint: prioritise options that match, note if it conflicts with a WIP/CLAIMED item.

After the briefing: ask Ant which option to take. **Do not claim anything yet** — claiming happens when Ant picks a task.

## Failure modes
- `openclaw status` times out → note "openclaw unreachable" in System line; continue
- `launchctl` unavailable → skip silently
- `free-work.py` fails → note "task state unavailable"; fall back to working-context + manual OPEN_TASKS.md read
- No `closed-at:` SHA in daily logs → use last 10 intentional commits; note "no close boundary found"
- working-context.md missing → skip steps 2/4; note it
