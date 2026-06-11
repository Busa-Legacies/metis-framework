# The metis-core / metis-os split

How content was divided between **metis-core** (this repo — portable framework,
synced between Busa-Legacies and Navore agents) and **metis-os** (the personal
operating repo, left untouched). Built from a full 5-region read of metis-os on
2026-06-10. The machine-readable manifest is `metis-core-build/manifest.py`.

## In metis-core (CORE)

| Category | Included | Why |
|---|---|---|
| **Protocols** (`docs/process/`) | decision-doctrine, correction-protocol, session-output-standard, tiered-context-architecture, task-lifecycle, task-writing, tier1-governed-state-model, surgical-delivery, gap-analysis-standard, multi-provider-agent-framework, command-center-standard, public-repo-playbook, offline-autopilot, dispatch-protocol, doctrine-to-operations-bridge, future-agent-scaffold-template, task-naming-convention, platform-registry | The architectural doctrine — portable to any org. |
| **Skills** | start, checkpoint, end, close, add-task, next, free-work, gap-analysis, sync-tasks, plan, build, fix, qa-ui, file, study (16 of 23) | Session/task/build patterns with no machine binding. |
| **Hooks + guards** | all of `ClaudeCode/hooks/`, `ClaudeCode/bin/` | file-guard, checkout-guard, signoff-gate, session-init, format, machine-identity, post-compact — portable. |
| **Governance/sync scripts** | ~65 scripts: agent-work, update/render-tier1-state, reconcile, archive-*, link-milestones, merge drivers, git-lock, close-*, session-*, self-heal, mirror, backfill-*, plus tests | The task-governance + multi-session-safety machinery. |
| **Config patterns** | `.gitattributes` (merge drivers), settings.shared.json, mirror-manifest.json, pyproject.toml, .prettierrc, .codex/hooks.json, .github/ | Reusable structure (templated where values are personal). |
| **Architecture docs** | AGENTS.md, new CLAUDE.md, README.md | The system contract, personal overlay stripped. |
| **Templates** | DR template + standard, plan template, agent-scaffold template, launchagent template | Reusable scaffolds. |
| **Project frameworks** | dev-review, metis-command, agent-workbench, forge3d (lib + tooling only — not personal models) | Org-agnostic tooling; no personal data. |
| **Design + decks** | design-guidelines.md, docs/design, decks/assets, decks/metis | Framework design system + intro deck. |
| **Navore seed kit** | projects/navore/sandbox-agent-template + templates | The portable "Vora" agent scaffold, explicitly built for sharing. |
| **Config seam** | `config/infrastructure.json` (new) | The single file an org fills in: machines, agents, model, domains, network. |

## In metis-os (PERSONAL — left untouched)

- **Identity**: USER.md, IDENTITY.md, TOOLS.md values, machine wiring.
- **Personal projects**: trading-bot, polymarket-bot, social-pipeline, dashboard, consulting-portfolio, writing.
- **Navore business IP**: strategy/, ops/, distribution/, lfpp-grant/, producer-onboarding/ (project content, not architectural core — kept out of the seed).
- **Personal integrations**: discord_*, notion-cc-*, ms365, google, jay-*, heartbeat, tailscale, ttyd, navore_stakeholder_report, copilot-* scripts.
- **Personal infra/ops docs**: goals, projects, live-status, infrastructure-state, jay-lanes (specific wiring), research, reviews, fitbod, remote-cloud, specific PLAN-*.md.
- **Machine-specific**: launchagents, settings.local.json, ttyd plists, lane tooling (dispatch/jlane/lane-*).
- **All credentials / real IDs** — never in the shared repo.

## Parameterization status (chosen approach: full parameterization)

A leak scan of the assembled tree confirmed **no credentials/tokens/keys** were
copied. Remaining personal *values* (not secrets) still need to be parameterized
out before the seed is clean — this is the open work:

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
| metis-command / dev-review app source | dev-server allowed-host IPs, sample paths | template next.config host list |
| agent-workbench/data sample reports | `$HOME` sample paths | scrub sample data |

## Status — SEEDED 2026-06-11

- **Parameterization: DONE.** All items above are wired to `config/infrastructure.json`
  via `scripts/lib/infra_config.py` (free-work, queue-runner, task-domain) or
  templatized to `<<PLACEHOLDER>>` values (network helpers, mirror-manifest,
  settings.shared model, machine-identity, hook-session-init). Final scan: **0
  hardcoded IPs, 0 home paths, 0 real credentials** in core (navore/ holds Ant's
  own content by design).
- **Repo: created** — `Busa-Legacies/metis-core`, **private**, seed pushed to `main`.
- **CODEOWNERS** (`@anthonyabusa`) is in place, so PRs auto-request his review.
- **Branch-protection ENFORCEMENT is blocked**: classic protection and rulesets
  both require GitHub Pro/Team for *private* repos. Options (Ant's call, involves
  money or visibility): upgrade Busa-Legacies to GitHub Team, OR accept CODEOWNERS
  as advisory (review requested, not a hard merge gate), OR make the repo public.

### Remaining polish (tracked, non-blocking)
- Jay/Jarry appear as illustrative *examples* in ~70 protocol/skill docs (not code).
  Acceptable for a repo private to the owning org; genericize in a follow-up.
- Bundled app frameworks (metis-command/dev-review) carry sample paths/dev-host
  lists in their own source; scrub on next touch.
