# Metis Framework

> **Metis** (Greek): cunning, adaptive, practical intelligence; counsel internalized into judgment.

The portable core of the Metis operating system: an
org-agnostic framework for running AI agents as a governed, multi-session,
memory-backed workforce. This repo holds **only** the pieces that generalize to any
organization adopting the system (the protocols, skills, hooks, governance
machinery, and templates), with every personal or organization-specific value
parameterized out into [`config/infrastructure.json`](config/infrastructure.json).

It is consumed by downstream repos (e.g. an org's private operating repo) via
**git subtree**, so the same spine stays in sync across every agent that runs it.

![Metis Command cockpit: agent lanes, governed task board, assistant panel (agent-captured demo)](docs/assets/metis-cockpit-demo.gif)

## A production implementation of the long-running-agent harness

Anthropic's *[Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)*
names five primitives for building agents that work across many fresh-context sessions without a
human babysitting each step. Metis was built on the same problem and **independently converged on
four of them** — with an evidence gate that runs as a standing protocol across every agent, not a
per-project hook. It's a battle-tested implementation of the pattern the article describes in theory.

| Harness primitive | In Metis |
|---|---|
| Default-FAIL / evidence-first contract | The done-gate — a task stays `needs_verification` until observed proof is Read (`scripts/update-tier1-state.py`, `docs/process/doctrine-to-operations-bridge.md`) |
| Fresh-context evaluator | `warden` / `arbiter` lanes grade from a virgin context with no write tools, binary PASS/NEEDS_WORK (`CLAUDE.md`) |
| Agent-maintained handoff | `checkpoint` / `end` commit state + refresh forward state across the context boundary (`ClaudeCode/skills/`, `surgical-delivery-protocol.md`) |
| Decomposed, one-feature-at-a-time work | `plan` → `build` over a forward-only task DAG with leases + fencing (`ClaudeCode/skills/`, `scripts/agent-work.py`) |
| Operator control hooks | Budgeted unattended windows (`offline-autopilot-protocol.md`); in-band steer/kill is on the roadmap |

Full mapping, with the honest "four of five" caveat: **[`docs/harness-primitives.md`](docs/harness-primitives.md)**.
Metis is a **personal-system spine you vendor into your own operating repo**, not a turnkey product.

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

## Getting started

New consumer? Follow **[`docs/QUICKSTART.md`](docs/QUICKSTART.md)** to vendor the
core, declare your topology in one config file, smoke-test, and run the session
lifecycle in ~15 minutes. The short version is below.

## Consuming metis-core via git subtree

In your org's operating repo:

```bash
# First time: add the core under a vendored path
git subtree add --prefix metis-core git@github.com:Busa-Legacies/metis-framework.git main --squash

# Pull updates later
git subtree pull --prefix metis-core git@github.com:Busa-Legacies/metis-framework.git main --squash

# Contribute a fix back up to the core
git subtree push --prefix metis-core git@github.com:Busa-Legacies/metis-framework.git <branch>
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
contract; it changes deliberately.
