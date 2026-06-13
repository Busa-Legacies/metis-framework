# Task Naming Convention

Version: 1.0 (adopted 2026-06-01)

## Format

### task-queue.md entries

**Header + fields line:**
```
- **#NNN `slug`** — one-line description
  - type:T | area:A | goal:GN | project:slug | priority:P | effort:E | agent:X | machine:Y | status:S
```

`goal:` and `project:` are required. See [projects.md](projects.md) for the project list and IDs.

**Body** — **always required, no exceptions** (see [task-writing-protocol.md](task-writing-protocol.md)). Minimum required sections:
```
  - **Why:** [Trigger — incident, observation, or friction point. Include date if a live event.]
  - **Plan:** [Approach direction + what NOT to do / what was already tried.]
  - **Main files:** `path/to/file.py`, `path/to/other.py`
```
Optional additions: `**Next action:**`, `**Blocked by:** #NNN`, `**Done when:**`.

### OPEN_TASKS.md (board view) entries

```
- [P2] [ ] **#NNN slug** — brief context note @agent:forge @machine:antfox
```

Type and area tags optional in board view; include `@type:T @area:A` when useful for filtering.

## Fields

| Field | Values | Notes |
|---|---|---|
| `#NNN` | 001–999 | Sequential, never reused. See counter below. |
| `slug` | `kebab-case` | Verb-noun describing the work. No domain prefix — that's `area`. |
| `type` | `bug` `feat` `chore` `infra` `research` `doc` | Kind of work |
| `area` | `openclaw` `dashboard` `trading-bot` `example` `infra` `jarry` `personal` | Project domain |
| `goal` | `G1` `G2` `G3` `G4` `G5` `G6` | Active campaign this serves. See [goals.md](goals.md); life-domain vocabulary lives in [taxonomy.yaml](taxonomy.yaml). |
| `project` | kebab-case slug | Project this belongs to. See [projects.md](projects.md). |
| `priority` | `P1` `P2` `P3` | P1 = blocking · P2 = important · P3 = nice-to-have |
| `effort` | `XS` `S` `M` `L` `XL` | XS <30min · S <2hr · M half-day · L 1-2d · XL 3+d |
| `agent` | `claude` `forge` `scout` `shield` `echo` `hermes` | Who executes |
| `machine` | `antfox` `jarry` `either` | Where it runs |
| `status` | `open` `in-progress` `blocked` `done` `cancelled` `needs-review` `monitoring` `partially-fixed` | Current state |
| `blocked-by` | `#NNN` | Optional. Dependency link. |
| `gh` | `#N` | Optional. GitHub Issue number when one exists. |

## ID Counter

**Last assigned: #345**
**Next available: #346**

These two lines are a **human-readable mirror** — the canonical, race-safe counter lives in
`docs/process/state/task-counter.json` and is allocated atomically by
`scripts/agent-work.py alloc-id` (used by `/add-task`). Do **not** hand-edit to claim an id;
run `alloc-id` so two concurrent sessions can't stamp the same `#NNN`. IDs are never reused,
even for cancelled tasks. (`alloc-id --peek` shows the next id without consuming it.)

## Scope Notes

**This convention applies to:**
- `docs/process/task-queue.md` — inbox and free-form sections
- `Jay/state/OPEN_TASKS.md` — board view entries

**Exempt:** The `<!-- GOVERNED:START --> ... <!-- GOVERNED:END -->` section of task-queue.md is managed by Jarry + `docs/process/state/tasks.json` and uses its own ID scheme (`T02`, `T06`, etc.). Do not manually rename governed entries — they will adopt this convention as Jarry updates tasks.json.

**Done tasks** use the same `#NNN slug` format with `status:done` in the fields line. All tasks (open and done) were migrated 2026-06-01.

## Legacy ID Mapping

Full `T-DOMAIN-NN` → `#NNN slug` mapping (41 entries, migration 2026-06-01): `docs/process/legacy-id-mapping.md`
