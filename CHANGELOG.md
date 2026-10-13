# Changelog

All notable changes to Metis Framework. Format loosely follows Keep a Changelog;
versions are semver. Pre-1.0: the public contract (config schema, skill/protocol
names, script CLIs) may still shift between minor versions.

## [Unreleased]

_Nothing yet._

## [0.2.0]: 2026-10-13

This release is mostly about how the framework leaves the private repo it grows in. v0.1.0 was exported by hand. From here, an export copies only files on an explicit list, scrubs machine and owner details, and has to pass a leak scan and this repo's own CI before a release branch is ever pushed. Anything not on the list stays private by default, which is the right failure mode for a project that started as one person's operating system.

- Gated export: allowlist-only copy, private scrub rules, a leak scan over every added line, and this repo's CI run against the export before release.
- Lease fix: free-work.py now treats any non-terminal lease status as held. Before, only "checked-out" counted, so a task held under another status could be claimed twice.
- State tooling: update-tier1-state.py is split into lib/tier1_state_* modules with a shared lib/lease_state.
- Emitted formats (sign-off, board lines, documents) use colons instead of em dashes and carry no emoji.
- README: new banner, mark, and brand story.

## [0.1.0]: 2026-07-08

Launch release: the repo went public (source-available, FSL-1.1-Apache-2.0).
### Added
- `scripts/ai-merge-resolver.py` + `docs/process/sync-merge-boundary.md`: Tier-3
  AI author-intent resolver for genuine CODE merge conflicts in the auto-sync
  ladder. Resolves honoring both sides' intent, then proves it through four gates
  (no-markers + blast-radius bound + independent intent-review + compile/tests)
  before anything is staged; any failure defers to the deterministic fail-soft
  abort, so it can only improve on it. `scripts/test-ai-merge-resolver.py` guards
  the pure safety gates and is wired into `core-ci.yml`.
- `scripts/test-governance-core.py`: dependency-free test suite for the two
  safety-critical cores: the forward-only task state DAG + done-gate
  (`update-tier1-state.py`) and Kleppmann fencing tokens + lease activeness
  (`agent-work.py`). ~40 assertions, hermetic (no git/gh/live state), wired into
  `core-ci.yml` next to `test-self-heal.py`. Mutation-checked non-vacuous.
- `docs/QUICKSTART.md`: fresh-consumer setup walkthrough (subtree vendor →
  `METIS_HOME` → fill `config/infrastructure.json` field-by-field → smoke-test →
  session lifecycle → sync/troubleshooting). Folds in the config fill-in guide;
  linked from README. All documented commands verified runnable.

### Changed
- LICENSE: replaced the proprietary placeholder with **FSL-1.1-Apache-2.0**
  (Functional Source License: source-available, blocks Competing Use, converts
  to Apache-2.0 two years after each version ships). Productization licensing
  decision; see `docs/PRODUCTIZATION.md`.

## [0.1.0]: 2026-06-11
### Added
- Initial extraction of the portable Métis framework from `metis-os`:
  decision/output doctrine, 16 skills, hooks + guards, ~65 governance/sync
  scripts (forward-only task DAG, leases + fencing, merge drivers, self-heal),
  config/settings patterns, templates, portable project frameworks
  (dev-review, metis-command, agent-workbench, forge3d-lib), design system.
- `config/infrastructure.json`: the single org-config seam (machines, agents,
  model, domains, network), read via `scripts/lib/infra_config.py`.
- Partner content isolated from the framework core (later removed from the public line).
- `build/manifest.py` (reproducible seed) and `build/publish.py` (Model B
  publish pipeline: refresh derived files from metis-os, preserve overlay, scrub).
- Product seams: `VERSION`, `LICENSE` (proprietary placeholder), `core-ci.yml`
  with a parameterization-leak guard, `docs/PRODUCTIZATION.md` roadmap,
  branch CODEOWNERS (`@anthonyabusa`).
