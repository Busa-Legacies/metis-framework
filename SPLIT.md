# The metis-core / metis-os split

How content was divided between **metis-core** (this repo: portable framework,
synced between Busa-Legacies and Navore agents) and **metis-os** (the personal
operating repo, left untouched). Built from a full 5-region read of metis-os on
2026-06-10. The machine-readable manifest is `build/manifest.py`.

## In metis-core (CORE)

| Category | Included | Why |
|---|---|---|
| **Protocols** (`docs/process/`) | decision-doctrine, correction-protocol, session-output-standard, tiered-context-architecture, task-lifecycle, task-writing, tier1-governed-state-model, surgical-delivery, gap-analysis-standard, multi-provider-agent-framework, command-center-standard, public-repo-playbook, offline-autopilot, dispatch-protocol, doctrine-to-operations-bridge, future-agent-scaffold-template, task-naming-convention, platform-registry | The architectural doctrine; portable to any org. |
| **Skills** | start, checkpoint, end, close, add-task, next, free-work, gap-analysis, sync-tasks, plan, build, fix, qa-ui, file, study (16 of 23) | Session/task/build patterns with no machine binding. |
| **Hooks + guards** | all of `ClaudeCode/hooks/`, `ClaudeCode/bin/` | file-guard, checkout-guard, signoff-gate, session-init, format, machine-identity, post-compact; portable. |
| **Governance/sync scripts** | ~65 scripts: agent-work, update/render-tier1-state, reconcile, archive-*, link-milestones, merge drivers, git-lock, close-*, session-*, self-heal, mirror, backfill-*, plus tests | The task-governance + multi-session-safety machinery. |
| **Config patterns** | `.gitattributes` (merge drivers), settings.shared.json, mirror-manifest.json, pyproject.toml, .prettierrc, .codex/hooks.json, .github/ | Reusable structure (templated where values are personal). |
| **Architecture docs** | AGENTS.md, new CLAUDE.md, README.md | The system contract, personal overlay stripped. |
| **Templates** | DR template + standard, plan template, agent-scaffold template, launchagent template | Reusable scaffolds. |
| **Project frameworks** | dev-review, agent-workbench, forge3d (lib + tooling only, not personal models) | Org-agnostic tooling; no personal data. |
| **Design + decks** | design-guidelines.md, docs/design, decks/assets, decks/metis | Framework design system + intro deck. |
| **Config seam** | `config/infrastructure.json` (new) | The single file an org fills in: machines, agents, model, domains, network. |

## In metis-os (PERSONAL, left untouched)

- **Identity**: USER.md, IDENTITY.md, TOOLS.md values, machine wiring.
- **Personal projects**: trading-bot, polymarket-bot, social-pipeline, dashboard, consulting-portfolio, writing.
- **Navore business IP**: strategy/, ops/, distribution/, lfpp-grant/, producer-onboarding/ (project content, not architectural core, kept out of the seed).
- **Personal integrations**: discord_*, notion-cc-*, ms365, google, jay-*, heartbeat, tailscale, ttyd, navore_stakeholder_report, copilot-* scripts.
- **Personal infra/ops docs**: goals, projects, live-status, infrastructure-state, hearth-lanes (specific wiring), research, reviews, fitbod, remote-cloud, specific PLAN-*.md.
- **Machine-specific**: launchagents, settings.local.json, ttyd plists, lane tooling (dispatch/jlane/lane-*).
- **All credentials / real IDs**: never in the shared repo.

## Parameterization status (chosen approach: full parameterization)

A leak scan of the assembled tree confirmed **no credentials/tokens/keys** were
copied. Remaining personal *values* (not secrets) still need to be parameterized
out before the seed is clean; this is the open work:

| File(s) | Contaminant | Action |
|---|---|---|
| `scripts/free-work.py` | `MACHINE_AGENTS` dict (antfox/jarry) | read `config/infrastructure.json` machines/agents |
| `scripts/queue-runner.py` | `DISPATCHABLE_AGENTS` / `DISPATCHABLE_MACHINES` | read config |
| `scripts/task-domain.py` | domain list incl navore/trading/consulting | read config `domains` |
| `scripts/self-heal.sh`, `lib/maintenance.sh`, `system-audit.sh` | hardcoded Discord channel-ID fallback defaults | drop default, require env/config |
| `scripts/lib/network.env`, `network.py` | Tailscale IPs | read config `machines[].tailscaleIp` |
| `ClaudeCode/mirror-manifest.json` | machine names, user paths, IPs | placeholder template |
| `ClaudeCode/settings.shared.json` | `model` value, machine-local refs | `<<PRIMARY_MODEL>>` placeholder |
| `ClaudeCode/hooks/hook-session-init.sh` | Tailscale IP, machine names | config-driven |
| `ClaudeCode/bin/claude-machine-identity.sh` | machine roster (antfox/jarry/abusa) | read config `machines` |
| skill SKILL.md examples (next/file/free-work/end) | antfox/jarry in example text | generhalize to `<machine>` |
| dev-review app source | dev-server allowed-host IPs, sample paths | template next.config host list |
| agent-workbench/data sample reports | `$HOME` sample paths | scrub sample data |

## Status · SEEDED 2026-06-11

- **Parameterization: in progress (#434).** **0 real credentials, 0 hardcoded IPs,
  0 home paths** in core — those are scrubbed at publish + enforced by the CI guard.
  The config seam is now load-bearing: `free-work.py` (machine detection + agent map),
  `update-tier1-state.py` (`VALID_MACHINES`), `queue-runner.py`, `task-domain.py`, and the
  network/mirror/settings helpers read `config/infrastructure.json` via
  `scripts/lib/infra_config.py` (or `<<PLACEHOLDER>>` values).
- **Board/workspace path resolution: DONE (#434 path-resolution sweep).** The persona-named
  board+working-context dir (`Hearth/state`, `Hearth/memory` in metis-os) previously scrubbed
  to an *unresolved* `<<MACHINE_1_ID>>/state` literal that `render-tier1-state.py` would create
  as a directory literally named `<<MACHINE_1_ID>>` — breaking a fresh consumer's cold-start
  loop. It now resolves to a neutral, portable `workspace/` (87 refs across 37 files);
  `publish.py` has a path-aware scrub (`Hearth/<child>` → `workspace/`, prose `Hearth` still
  → `<<MACHINE_1_ID>>`); `init-board.py` seeds `workspace/state` + `workspace/memory`;
  `render` `mkdir`s its parent. **Verified end-to-end** on a stranger config (`host-a`):
  init-board → create-task → claim-next → render all succeed and the board lands in
  `workspace/state/OPEN_TASKS.md`.
- **Remaining (#434):** bare lowercase persona names (`antfox`/`jarry`/`abusa`) still appear
  as illustrative text in ~23 files (71 refs). Derived files are scrubbed to `<<MACHINE_N_ID>>`
  on the next `build/publish.py` run, but OVERLAY files (`free-work.py`, `hook-session-init.sh`,
  `mirror-manifest.json`, `queue-runner.py`) need hand-editing since publish never scrubs them.
  The CI `Parameterization guard` for bare `antfox|jarry|abusa` is **deferred** until that
  cleanup lands (it would fail red on the current residuals).
- **Repo created**: `Busa-Legacies/metis-framework`, **private**, seed pushed to `main`.
- **CODEOWNERS** (`@anthonyabusa`) is in place, so PRs auto-request his review.
- **Branch-protection enforcement** turns on at the public flip. Repo rulesets are
  free for *public* repos on a free org but return 403 while private, so enforcement
  cannot be set while the repo is private. [`build/setup-branch-protection.sh`](build/setup-branch-protection.sh)
  creates the branch and tag rulesets (PR + code-owner review + CI check + no
  force-push + linear history); run it once after flipping the repo public. Until
  then CODEOWNERS keeps review advisory.

### Remaining polish (tracked, non-blocking)
- <<MACHINE_1_ID>>/<<MACHINE_2_ID>> appear as illustrative *examples* in ~70 protocol/skill docs (not code).
  Acceptable for a repo private to the owning org; genericize in a follow-up.
- Bundled app frameworks (dev-review) carry sample paths/dev-host
  lists in their own source; scrub on next touch.
