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

`OPEN_TASKS.md` is a **read-only projection** auto-rendered from `tasks.json`
(`render-tier1-state.py`) — never hand-write a board line. Its rendered shape, for reference:

```
- [P2] [ ] **#NNN slug** — brief context note @agent:smith @machine:<<MACHINE_1_ID>>
```

Type and area tags optional in board view; include `@type:T @area:A` when useful for filtering.

## Fields

| Field | Values | Notes |
|---|---|---|
| `#NNN` | 001–999 | Sequential, never reused. **Stored canonically with the leading `#`** — the `taskId` field in `tasks.json` is `"#361"`, never `"361"`. See counter + canonical-form note below. |
| `slug` | `kebab-case` | Verb-noun describing the work. No domain prefix — that's `area`. |
| `type` | `bug` `feat` `chore` `infra` `research` `doc` | Kind of work |
| `area` | `openclaw` `dashboard` `trading-bot` `example` `infra` `<<MACHINE_2_ID>>` `personal` | Project domain |
| `goal` | `G1` `G2` `G3` `G4` `G5` `G6` | Active campaign this serves. See [goals.md](goals.md); life-domain vocabulary lives in [taxonomy.yaml](taxonomy.yaml). |
| `project` | kebab-case slug | Project this belongs to. See [projects.md](projects.md). |
| `priority` | `P1` `P2` `P3` | P1 = blocking · P2 = important · P3 = nice-to-have |
| `effort` | `XS` `S` `M` `L` `XL` | XS <30min · S <2hr · M half-day · L 1-2d · XL 3+d |
| `agent` | `claude` `smith` `scout` `warden` `echo` `steward` | Who executes |
| `machine` | `<<MACHINE_1_ID>>` `<<MACHINE_2_ID>>` `either` | Where it runs |
| `status` | `open` `in-progress` `blocked` `done` `cancelled` `needs-review` `monitoring` `partially-fixed` | Current state |
| `blocked-by` | `#NNN` | Optional. Dependency link. |
| `gh` | `#N` | Optional. GitHub Issue number when one exists. |

## ID Counter

The counter is **canonical in `docs/process/state/task-counter.json`** (field
`lastAssigned`) — there is no markdown mirror (#352 removed it; the duplicated
line raced two concurrent allocs into a merge conflict). Allocate atomically with
`scripts/agent-work.py alloc-id` (used by `/add-task`); never hand-edit the counter.
`alloc-id --peek` shows the next id without consuming it; `update-tier1-state.py
schema` prints the next available id. IDs are never reused, even for cancelled tasks.
The close gate verifies the counter against canonical state via
`scripts/lib/close_integrity_canonical.py id-counter`.

### Canonical `taskId` form — leading `#` is mandatory

The stored `taskId` is always `"#NNN"` **with** the hash (e.g. `"#361"`). Note that
`alloc-id` prints the **bare** number (`361`) — callers must prepend `#` before writing it.
A prefix-less id (`"361"`) is a bug: it collides on number with a real `#NNN` task and
misses every `#NNN` exact-match lookup (e.g. the born-governed commit-reference guard).
`update-tier1-state.py create-task` enforces this: a bare-numeric `taskId` is coerced to
`#NNN` and anything that isn't `#` + digits is rejected. (Historical lapse: a batch created
2026-06-14 stored bare ids `356`–`365`, three of which collided with the `#363`–`#365`
eval-pipeline tasks; normalized + re-IDed 2026-06-15.)

## Scope Notes

**This convention applies to:**
- `docs/process/task-queue.md` — inbox and free-form sections
- `workspace/state/OPEN_TASKS.md` — board view entries

**Exempt:** The `<!-- GOVERNED:START --> ... <!-- GOVERNED:END -->` section of task-queue.md is managed by <<MACHINE_2_ID>> + `docs/process/state/tasks.json` and uses its own ID scheme (`T02`, `T06`, etc.). Do not manually rename governed entries — they will adopt this convention as <<MACHINE_2_ID>> updates tasks.json.

**Done tasks** use the same `#NNN slug` format with `status:done` in the fields line. All tasks (open and done) were migrated 2026-06-01.

## Legacy ID Mapping

Full `T-DOMAIN-NN` → `#NNN slug` mapping (41 entries, migration 2026-06-01): `docs/process/legacy-id-mapping.md`

## Referencing tasks in prose (enforced)

Never refer to a task by a **bare `#NNN`** in prose, commit messages, or sign-offs — the number
is opaque and drops the meaning the slug carries. Use the **descriptive title with the id in
parens**: `the per-file-leases sync task (#234)`, never `flip #234 to live`.

Enforced mechanically by `ClaudeCode/hooks/hook-task-naming-gate.sh` — a zero-LLM Stop hook
(sibling of `hook-signoff-gate.sh`) that scans the closing message and blocks **once** on a bare
`#NNN`, with the fix. Exempts the parenthesised `(#NNN)` form and external VCS refs (`PR #NNN`);
ignores code fences; fails open; loop-safe. Documentation alone failed for a whole session, hence
the gate. Register it in the `Stop` array of your Claude Code settings.
