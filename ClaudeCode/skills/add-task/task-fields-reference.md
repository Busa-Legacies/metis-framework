# Task Fields Reference — /add-task

## Gather prompt (Step 3)

Present as a single prompt — not one question at a time:

```
To add this task I need a few details:

1. **Slug** (verb-noun, 3-5 words, kebab-case, e.g. "fix-free-work-lease-guard") → governed `title`
1b. **Project** — which project (slug from `projects.json`; `ops` if genuinely cross-cutting) → governed `project` (required at the write gate)
2. **What** — one-line description of the change/outcome → governed `summary`
3. **Why** — what surfaced this? (incident, friction point, observation — 1-3 sentences; include date if a live event)
4. **How** — approach direction + what NOT to do / what was already tried
5. **Priority**: P1 / P2 / P3
6. **Owner machine**: <<MACHINE_1_ID>> / <<MACHINE_2_ID>> / either → governed `owner`
7. **Agent lane** (board only): smith / scout / warden / echo / claude
8. **Main files** — key files this touches (optional if unknown) → governed `mainFiles`
9. **First step** (optional) — the single concrete starting action from THIS session; one line, distinct from how. Record now while intent is fresh; skip if genuinely unknown.
10. **Origin** (required) — WHO originated this task:
    - `ant` — Ant directly requested it
    - `agent` — agent proposed it autonomously (auto-logged suggestion, follow-up)
    - `collab` — agent proposed, Ant approved the direction
    - `system` — caught mechanically by a review/check/automated scan
    Also supply **originRef** (optional free-text backlink — strategy doc path, "chat YYYY-MM-DD", incident ref, etc.)
```

## JSON patch template (Step 4)

```json
{
  "taskId": "#NNN",
  "title": "slug",
  "priority": "P2",
  "state": "queued",
  "owner": "either",
  "project": "valid-slug-from-projects.json",
  "area": "OpenClaw Infrastructure",
  "agent": "claude",
  "machine": "either",
  "summary": "one-line what",
  "why": "trigger — incident, observation, friction point; date if live event",
  "how": "approach direction + constraints + what to avoid",
  "origin": "ant",
  "originRef": "chat 2026-06-07 — context of the request",
  "firstStep": "optional — concrete starting action captured from THIS authoring session",
  "mainFiles": ["path/to/file.py"]
}
```

Full create command:
```bash
python3 scripts/update-tier1-state.py create-task --actor claude --patch '{
  "taskId": "#NNN",
  "title": "slug",
  "priority": "P2",
  "state": "queued",
  "owner": "either",
  "summary": "...",
  "why": "...",
  "how": "...",
  "mainFiles": ["path/to/file.py"]
}'
```

## Field constraints

| Field | Required | Notes |
|---|---|---|
| `taskId` | yes | `#NNN` from `alloc-id` — never hand-pick |
| `title` | yes | kebab-case slug, verb-noun, no domain prefix |
| `priority` | yes | P1 (blocking) · P2 (important) · P3 (nice-to-have) |
| `state` | yes | `queued` for new tasks; `inbox` only for un-triaged captures |
| `owner` | yes | <<MACHINE_1_ID>> / <<MACHINE_2_ID>> / either |
| `project` | yes | slug from `docs/process/state/projects.json` — write gate rejects unknown/missing (#181); `ops` is the catch-all |
| `area` / `agent` / `machine` | yes | board-projection fields (#100) — helper rejects if absent |
| `summary` | yes | one-line what — required by schema, helper rejects if absent |
| `why` | yes | required by schema, helper rejects if absent |
| `how` | yes | required by schema, helper rejects if absent |
| `origin` | **yes** | WHO originated it: `ant` / `agent` / `collab` / `system` — write gate rejects missing/invalid |
| `originRef` | no | free-text backlink to specific trigger (strategy doc path, "chat YYYY-MM-DD", incident ref) |
| `firstStep` | no | capture while intent is fresh; omit if genuinely unknown |
| `mainFiles` | no | array of paths; omit if unknown |
| `planRef` | no | the planning/spec doc this task derives from (`docs/plans/PLAN-*.md` slug or a research/spec doc path) — makes the PLAN↔task link queryable instead of freeform prose; rendered in the queue projection |
| `wakeWhen` | no | for a `waiting` (soak/test/wait) task — the structured condition it self-triggers on, so it stops stalling for a human. `{"type":"time","at":"2026-07-28"}` (soak until a date) or `{"type":"check","cmd":"<shell, exit 0 = ready>"}` (data soak / CI / external). The task-wake sweep (folded into the queue-runner cycle) evaluates it every ~30 min. Only valid on `state:waiting`. |
| `wakeAction` | no | what the sweep does when `wakeWhen` is met. `{"kind":"dispatch","agent":"smith","message":"..."}` (DEFAULT if omitted = dispatch `nextAction` to the task's lane, guarded) · `{"kind":"requeue"}` (flip to queued + notify) · `{"kind":"needs_you"}` (page Ant). Money/trading follow-ups are never auto-dispatched — forced to requeue+notify. |
| `dueAt` | no | **hard deadline** — ISO date this task must be *done* by (`"2026-08-20"`). SPARSE: only when a real committed/external deadline exists — not a default on every task. Human-set; the projector flags it `@OVERDUE` (past & not done) or `@due` (≤3d) and lists it in the board-top **Due & Follow-ups** digest. NOT the completed date (that's system-stamped `completedAt`) and NOT an auto-trigger (that's `wakeWhen`). See task-state-contract §DUE. |
| `followUpAt` | no | **soft human check-back** — ISO date to resurface this to a *human* (no auto-run). For blocked / waiting-on-Ant / parked work with no hard deadline. Human-set; surfaces as `@followup-due` + the **Needs follow-up** digest bucket. Use `wakeWhen` instead when a *machine* can resume it on a condition. |
| `followUpReason` | no | one-line WHY for `followUpAt` (e.g. `"ping Ant re: Tiller sheets"`). Rendered next to the follow-up flag. |

### Soak / wait tasks that self-trigger (`waiting` + `wakeWhen`)

Instead of parking a soak as prose ("hold until 2026-07-24, then run the gate") in `blockerOrNone`
and hoping a session revisits it, set `state:"waiting"` + a structured `wakeWhen`. Example — soak a
week of shadow data, then auto-run the follow-up on a lane:

```bash
python3 scripts/update-tier1-state.py create-task --actor claude --patch '{
  "taskId":"#NNN","title":"soak-shadow-then-run-gate","state":"waiting","owner":"either",
  "priority":"P2","project":"queue-runner","area":"OpenClaw Infrastructure","agent":"smith",
  "machine":"<<MACHINE_1_ID>>","origin":"agent","summary":"...","why":"...","how":"...",
  "currentStep":"waiting on soak","expectedArtifact":"gate result","verificationMethod":"eval green",
  "blockerOrNone":"soak until 2026-07-28","nextAction":"run the Phase-5 gate eval",
  "wakeWhen":{"type":"time","at":"2026-07-28"},
  "wakeAction":{"kind":"dispatch","agent":"smith"}
}'
```

Preview what would wake now: `python3 scripts/task_wake.py` (dry-run). Executor: `scripts/task_wake.py`.

## Board line format (reference only — auto-rendered)

`workspace/state/OPEN_TASKS.md` is a **read-only projection** of `tasks.json`
(`render-tier1-state.py` owns it — never hand-edit). Create tasks via the governed mutator
(`update-tier1-state.py create-task`) and the board line renders itself. Its rendered shape:

```
- [P2] [ ] **#NNN slug** — brief context note @agent:smith @machine:<<MACHINE_1_ID>>
```

## Goals and projects reference

Goals:
- G1 — OpenClaw infrastructure reliability
- G2 — Dashboard + personal integrations
- G3 — Example Market operations
- G4 — Financial systems (trading + finances)
- G5 — Public presence (portfolio + social)

Projects (`project` is a required governed field on every task — the mutator rejects a task without one):
- P01 `queue-runner` (G1) · P02 `agent-coordination` (G1) · P03 `lane-reliability` (G1) · P04 `sync-integrity` (G1)
- P05 `dashboard-core` (G2) · P06 `partner-brief` (G3) · P07 `finances-panel` (G4) · P08 `trading-bot` (G4)
- P09 `portfolio-site` (G5) · P10 `portfolio-social` (G5)
