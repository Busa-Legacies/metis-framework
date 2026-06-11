---
name: Next Task
slug: next
version: 1.0.0
description: "Atomically claim the next-highest-priority free task for THIS machine — collision-free even when several sessions wrap up at once. Write-side companion to /free-work."
---

## Steps

Pickup is **project-oriented** (#181): join a project (shared workspace, never a lock), then claim tasks within it. If this session already has a live presence record, `claim-next` defaults to that project automatically.

1. **Join a project (if not already in one):**
   ```bash
   python3 scripts/agent-work.py join <slug>
   ```
   Writes an informational presence record (4h TTL, session-keyed). Multiple sessions can and should share a project — presence is a roster, not a lock. Pick the project from `/free-work`'s ranked board.

2. **Preview first (optional):**
   ```bash
   python3 scripts/agent-work.py claim-next --agent claude --dry-run
   ```
   Shows the top 5 it *would* claim (scoped to your joined project, or global if none); mutates nothing.

3. **Claim:**
   ```bash
   python3 scripts/agent-work.py claim-next --agent claude --json
   ```
   Scopes to your presence project by default; `--project <slug>` overrides; bare (no presence, no flag) falls back to the global ranked list. On success: prints the task, a `claim-id`, a fence token, and holds a 4h lease.
   - `already holds N live lease(s)` → finish or `unclaim` the existing task first, or pass `--allow-multi` to deliberately take a second.
   - `no free work in project '<slug>'` → that project is drained; `leave` + re-check the board.
   - `no free work for <machine>` → nothing free; use `/free-work` to inspect CLAIMED/BLOCKED/DRIFT.

4. **Pre-start check:**
   ```bash
   bash scripts/task-ready.sh "<task-label>"
   ```
   - Exit 0 (READY) → proceed.
   - Exit 1 (BLOCKED) → prerequisites unmet; surface the reason and pick the next free task instead.
   - Exit 2 (MAYBE DONE) → verify passed before starting; confirm with Ant. If done, unclaim and run `/checkpoint` to close it.

5. **Confirm with Ant**, then work the task. The lease is what keeps other sessions off it; presence is what lets sibling sessions in the same project see you and split the list.

6. **When done:**
   ```bash
   python3 scripts/agent-work.py unclaim <claim-id>
   ```
   (Or it auto-expires after the lease window and the reaper frees it.) Stay joined if continuing in the project; `leave` when switching projects or ending the session.

## Flags
`--project <slug>` · `--machine antfox|abusa` · `--hours N` · `--allow-multi` · `--dry-run` · `--json`

Machine + ranking come from `free-work.py` (single source of truth — `claim-next` imports its `aggregate()`), so `/next` and `/free-work` always agree on what's free and in what order.
