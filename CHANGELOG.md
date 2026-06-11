# Changelog

All notable changes to Metis Core. Format loosely follows Keep a Changelog;
versions are semver. Pre-1.0: the public contract (config schema, skill/protocol
names, script CLIs) may still shift between minor versions.

## [Unreleased]
### Changed
- LICENSE: replaced the proprietary placeholder with **FSL-1.1-Apache-2.0**
  (Functional Source License — source-available, blocks Competing Use, converts
  to Apache-2.0 two years after each version ships). Productization licensing
  decision; see `docs/PRODUCTIZATION.md`.

## [0.1.0] — 2026-06-11
### Added
- Initial extraction of the portable Métis framework from `metis-os`:
  decision/output doctrine, 16 skills, hooks + guards, ~65 governance/sync
  scripts (forward-only task DAG, leases + fencing, merge drivers, self-heal),
  config/settings patterns, templates, portable project frameworks
  (dev-review, metis-command, agent-workbench, forge3d-lib), design system.
- `config/infrastructure.json` — the single org-config seam (machines, agents,
  model, domains, network), read via `scripts/lib/infra_config.py`.
- Navore content isolated under `navore/` (separate from the framework core).
- `build/manifest.py` (reproducible seed) and `build/publish.py` (Model B
  publish pipeline: refresh derived files from metis-os, preserve overlay, scrub).
- Product seams: `VERSION`, `LICENSE` (proprietary placeholder), `core-ci.yml`
  with a parameterization-leak guard, `docs/PRODUCTIZATION.md` roadmap,
  branch CODEOWNERS (`@anthonyabusa`).
