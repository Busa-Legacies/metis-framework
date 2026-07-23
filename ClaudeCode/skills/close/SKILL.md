---
name: Close Session (legacy)
slug: close
version: 1.0.0
description: "Alias for the session close protocol. Prefer /end; it is the current, complete protocol. Session name: $ARGUMENTS"
---

Run the full `/end` protocol. This command is a legacy alias; `/end` is the authoritative, up-to-date version.

Steps:
1. Commit any uncommitted work with a descriptive message.
2. Push to GitHub.
3. Update `working-context.md` via ops (`working-context-update.py`): max 35 lines, forward-looking only.
4. Roll up completed work from git history. Filter auto-sync snapshots: `git log <range> --invert-grep --grep='\[auto-sync\]' --oneline`. Run `python3 scripts/self-review.py --latest` (when that script is present) for session friction signals. Route Scribe lane to compose the daily log.
5. Task dedup gate: run `python3 scripts/free-work.py` and check `task-queue.md` + `OPEN_TASKS.md` before logging any followup. Add genuinely-new entries with Priority/Agent/Machine/Status.
6. Save durable, non-obvious decisions or Ant preferences to `ClaudeCode/memory/`.
7. Run `bash scripts/close-integrity-check.sh`; fix any FAILs before declaring done.
8. Rename the session: `/rename <short-descriptive-name>`.

**Use `/end` instead**; it has the complete 13-step protocol including the concurrency lock, cross-agent handoff, and the session sign-off standard.
