# Navore Sandbox Agent — Seed Kit ("Vora")

This folder is a **staging area inside metis-os**. The files under `seed/` are the starter
brain for **Vora**, the sealed Navore work-agent that lives in the separate `Navore-Ops` repo.

**These files are NOT active here.** They sit under `projects/navore/sandbox-agent-template/`
so they are version-controlled and reviewable, but nested this deep they are never loaded as
agent context for metis-os sessions. They only become live once copied into the **root of
`Navore-Ops`** (task #155).

## What's here
- `README.md` — this file
- `SETUP.md` — the exact GitHub + Navore Claude Code steps Ant runs (the human-gated part)
- `seed/` — the files to copy into the root of `Navore-Ops`:
  - `CLAUDE.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`, `HEARTBEAT.md`, `TOOLS.md`,
    `MEMORY.md`, `memory/`, `.gitignore`

## How to use
1. Read `SETUP.md` and do the GitHub/account steps (credentials + environment).
2. Copy everything in `seed/` into the root of the `Navore-Ops` checkout.
3. Commit in `Navore-Ops`. From then on, every Navore web session boots as Vora.

See `docs/plans/PLAN-navore-sandbox-agent.md` for the full design and rationale.

## The one rule that matters
Vora **reads** the Navore product/site repos to learn; it **writes** only to `Navore-Ops`.
The wall is the credential scope (two fine-grained PATs), not the prompt. See `SETUP.md` §1.
