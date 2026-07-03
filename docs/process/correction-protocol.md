# Correction Protocol

When a correction surfaces — Ant flags a wrong behavior, a verify skill finds a gap, or a retrospective uncovers a pattern — route the fix UP to the governing artifact, not sideways into memory.

## The loop

1. **Identify the root cause.** Ask: which procedural artifact *should have required the right behavior*?
   - A skill step → edit that skill (`ClaudeCode/skills/*/SKILL.md`)
   - A CLAUDE.md section → delta-edit that section
   - A process doc → delta-edit `docs/process/*.md`
   - A hook → edit `ClaudeCode/hooks/`

2. **Delta-edit the artifact** (ACE principle: structured incremental update, never a compressing rewrite). Preserve the *why* — context collapse happens when edits strip rationale to save space.

3. **Convert the memory entry to a breadcrumb.** The memory file becomes ≤3 lines pointing at the fix:
   ```
   Corrected in: <artifact path> (commit <short-SHA>)
   Context: <one-line why this correction happened>
   ```
   The artifact carries the fix; the breadcrumb is a map, not a copy.

4. **Log the correction** in the checkpoint/end commit message body so the git roll-up surfaces it.

## Graduation policy

| Layer | Promote when |
|---|---|
| Episodic (git log / daily log) | One-off event, debugging artifact, incident record |
| Semantic memory (`ClaudeCode/memory/`) | Durable + cross-session + non-obvious + not in code/docs |
| Procedural playbook (skills / CLAUDE.md) | The lesson should *change behavior*, not just inform it |

A lesson that belongs in a skill must reach the skill — a memory entry that only influences recall is insufficient for behavioral change.

## What NOT to do

- Never write a memory file as the *primary* fix for a behavioral correction. Memory is recall; skills drive behavior.
- Never do a monolithic rewrite of a skill or CLAUDE.md section to incorporate a correction — always a targeted delta. Rewrites cause "context collapse" and "brevity bias" (ACE, arXiv 2510.04618).
- Never leave a correction as a chat note or ephemeral observation — it will not survive context compaction.
