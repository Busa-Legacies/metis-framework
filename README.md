# Metis Core

> **Metis** (Greek): cunning, adaptive, practical intelligence — counsel internalized into judgment.

The shared architectural core of the Metis operating system: the portable,
org-agnostic framework for running AI agents as a governed, multi-session,
memory-backed workforce. This repo holds **only** the pieces that work for any
organization adopting the system — the protocols, skills, hooks, governance
machinery, and templates — with every personal/organization-specific value
parameterized out into [`config/infrastructure.json`](config/infrastructure.json).

It is consumed by downstream repos (e.g. an org's private operating repo) via
**git subtree**, so the same spine stays in sync across every agent that runs it.

## What's in here

| Area | Path | What it is |
|---|---|---|
| **Decision & output doctrine** | `docs/process/decision-doctrine.md`, `session-output-standard.md` | When to act vs. ask; the sign-off contract every stop honors. |
| **Task governance** | `scripts/agent-work.py`, `update-tier1-state.py`, `reconcile.py`, `render-tier1-state.py` | Forward-only governed task DAG, leases + fencing tokens, invariant catalog, board projection. |
| **Session lifecycle** | `ClaudeCode/skills/{start,checkpoint,end,close}` | Start → claim → work → checkpoint → close, collision-free across parallel sessions. |
| **Build & quality** | `ClaudeCode/skills/{plan,build,fix,qa-ui,file}` | Research-first build gate, root-cause fix workflow, design QA, repo filing. |
| **Hooks & guards** | `ClaudeCode/hooks/`, `ClaudeCode/bin/` | Session-init context injection, sign-off gate, optimistic-concurrency file guard, checkout guard. |
| **Sync architecture** | `.gitattributes`, `scripts/merge-*`, `scripts/git-lock.sh`, `scripts/openclaw-git-sync.sh` | Custom merge drivers + locking that make multi-machine auto-sync safe. |
| **Self-heal** | `scripts/self-heal.py`, `add-healthcheck.py` | Mechanical heal + pluggable compliance meters. |
| **Tiered context** | `docs/process/tiered-context-architecture.md` | JIT-loaded context packs (kernel + path-scoped rules + on-demand router). |
| **Templates** | `docs/process/decisions/TEMPLATE.md`, `ClaudeCode/skills/plan/`, `docs/process/future-agent-scaffold-template.md` | Decision Records, plans, agent scaffolds. |
| **Config seam** | `config/infrastructure.json` | The one file a consuming org fills in: machines, agents, model, domains, network. |

## Consuming metis-core via git subtree

In your org's operating repo:

```bash
# First time — add the core under a vendored path
git subtree add --prefix metis-core git@github.com:Busa-Legacies/metis-core.git main --squash

# Pull updates later
git subtree pull --prefix metis-core git@github.com:Busa-Legacies/metis-core.git main --squash

# Contribute a fix back up to the core
git subtree push --prefix metis-core git@github.com:Busa-Legacies/metis-core.git <branch>
```

Then fill in `metis-core/config/infrastructure.json` with your org's machines,
agents, model choice, and network topology. The parameterized scripts read from
it; nothing else is hardcoded to a specific machine, IP, or identity.

## What's deliberately NOT here

Personal/organization-specific layers stay in the consuming repo, never in core:
identity files (USER/IDENTITY/TOOLS values), personal projects, business strategy,
integration wiring (Discord/Notion/cloud-auth with real IDs), machine-specific
LaunchAgents, and any credentials. The boundary is documented in
[`SPLIT.md`](SPLIT.md).

## Governance

`main` is protected: changes require a pull request with review from the code
owner ([`.github/CODEOWNERS`](.github/CODEOWNERS)). The core is the shared
contract — it changes deliberately.
