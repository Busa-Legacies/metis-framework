# Productization roadmap

Metis Core is incubated **private**, Busa-Legacies + Navore only. The intent is
near-term productization. This doc records the path so Phase 2 is a *flip*, not a
rebuild, and tracks the seams that must be clean before any external consumer.

## Canonicality model (the core decision)

| Phase | Canonical author | metis-os role | Trigger to advance |
|---|---|---|---|
| **1 — now** | `metis-os` | authors the framework in-place; publishes to metis-core via `build/publish.py` | — |
| **2 — productize** | `metis-core` | becomes a *reference consumer* (dogfood); refactored to run from the core | first non-Navore / paying consumer appears |

Phase 1 (Model B) keeps risk low — nothing in the live metis-os system changes.
Phase 2 flips canonicality: metis-core gets independent releases/tests/license,
and metis-os is migrated to consume it (the invasive but justified step).

## Distribution

- **Now:** git subtree (developer-grade; fine for a few sophisticated consumers).
  See README "Consuming metis-core via git subtree".
- **Phase 2 candidates:** `use-this-template` repo, an installer, or a versioned
  package. `config/infrastructure.json` is already the customer-config layer.

## The core-vs-navore split (MUST happen before external sale)

`navore/` currently holds Navore's content **including business strategy** —
correct for a repo private to Busa-Legacies + Navore, but it **cannot ship in a
product sold to others**. The seam is already clean: all Navore content is
isolated under `navore/`, nothing in the framework core depends on it. The
Phase-2 cut is therefore trivial:

1. `git rm -r navore/` from the public/product line (or split it to a private
   `navore-content` repo).
2. The framework core (`scripts/`, `ClaudeCode/`, `docs/process/`, etc.) ships
   untouched.

Keep this invariant: **no framework-core file may import or reference `navore/`.**
(CI could assert this in Phase 2.)

## Product-readiness checklist

- [x] Parameterization seam (`config/infrastructure.json` + `infra_config.py`)
- [x] Reproducible build/publish pipeline (`build/`)
- [x] Clean-core CI guard (no leaked IPs/paths — `core-ci.yml`)
- [x] Versioning + changelog (`VERSION`, `CHANGELOG.md`)
- [x] CODEOWNERS review gate (advisory; enforce when org upgrades to GitHub Team)
- [x] Interim LICENSE notice
- [ ] Licensing decision (commercial EULA / source-available / OSI) — replaces LICENSE
- [ ] navore/ cut out of the product line (Phase 2)
- [ ] Quickstart / install docs for a fresh consumer
- [ ] Fill-in walkthrough for `config/infrastructure.json`
- [ ] Test coverage on the governance core (reconcile, agent-work, state DAG)
- [ ] Branch-protection enforcement (needs GitHub Team for private repos)
- [ ] Secrets/IP review by a human before first external grant
