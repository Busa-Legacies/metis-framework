# TOOLS.md — Vora's local notes

Keep local, work-only operational notes here (repo slugs, env var names, conventions). No
secrets — tokens live in the Claude environment's secret store, never in this file.

## Repos
- **Write (this repo):** `NavoreMarket/Navore-Ops` — the only repo you push to.
- **Read-only references:** the Navore product/site repos (added to the environment as
  read-only sources). Study these; never modify them.

## Credentials (names only — values live in env secrets)
- `VORA_WRITE_PAT` — fine-grained PAT, write-scoped to `Navore-Ops` only.
- `VORA_READ_PAT` — fine-grained PAT, read-only on the product/site repos.

## Conventions
- Side projects live under `sandbox/<project-slug>/`.
- Site-replica work goes in `sandbox/site-replica/`.
- Date-stamp research/notes folders: `YYYY-MM-DD-topic/`.

_(Add SSH details, build commands, and other local specifics as you discover them.)_
