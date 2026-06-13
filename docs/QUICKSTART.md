# Metis Core — QuickStart

Stand up the Metis framework inside your org's operating repo. By the end you'll
have the core vendored, your topology declared in one config file, and the
governed session lifecycle running. Budget ~15 minutes.

> **Mental model.** Metis Core is the *portable spine* — protocols, skills,
> hooks, task-governance machinery. Your repo is the *overlay* — identity,
> projects, real integration IDs. Core is parameterized; the one file you fill in
> is [`config/infrastructure.json`](../config/infrastructure.json). Nothing else
> is hardcoded to a machine, IP, or person.

## Prerequisites

- **git** with the `subtree` command (ships with git ≥ 1.7.11)
- **Python 3.12+** (the governance scripts target 3.12; `python3 --version`)
- **A git repo for your org** that will consume the core (the "operating repo")
- Read access to `git@github.com:Busa-Legacies/metis-core.git`
- *(optional, multi-machine)* **Tailscale** if you run agents across >1 host

## 1 — Vendor the core via git subtree

From the root of your operating repo:

```bash
git subtree add --prefix metis-core \
  git@github.com:Busa-Legacies/metis-core.git main --squash
```

This drops the whole framework under `metis-core/` as ordinary tracked files (no
submodule, no extra clone). Pull updates and contribute fixes back later — see
[§6](#6--staying-in-sync).

## 2 — Point the scripts at the core (`METIS_HOME`)

The scripts **self-locate** from their own path, so the common case needs zero
env. Set `METIS_HOME` only if you'll invoke scripts from symlinks or wrappers
outside the tree:

```bash
echo 'export METIS_HOME="$HOME/<your-operating-repo>/metis-core"' >> ~/.zshenv
# new shell, or: source ~/.zshenv
```

`METIS_HOME` (env) always wins over self-location. `paths.py` / `paths.env` are
the keystone — renaming or moving the directory is a no-op for code.

## 3 — Fill in `config/infrastructure.json`

This is the single seam. It ships full of `<<PLACEHOLDER>>` values; the loader
([`scripts/lib/infra_config.py`](../scripts/lib/infra_config.py)) is **tolerant**
— placeholders fall back to a generic single-machine default, so nothing crashes
while you fill it in incrementally. Field-by-field:

```jsonc
{
  "org": {
    "name":     "Acme",            // your org/brand name
    "repoName": "acme-ops",        // the operating repo's name
    "home":     "${METIS_HOME}"    // leave as-is; resolved at runtime
  },

  "machines": [                    // one entry per host that runs an agent
    {
      "id":          "host-a",     // short stable name you'll refer to it by
      "role":        "primary",    // exactly one machine should be primary
      "user":        "alice",      // the OS username on that host ($USER)
      "tailscaleIp": "100.x.x.x",  // or "" if single-machine / no Tailscale
      "modelHost":   true,         // true on the box that runs local inference
      "agents":      ["smith", "claude"]   // identities that work on this host
    }
    // add a second {...} for a secondary machine; role "secondary",
    // modelHost false. Omit the whole array's extra entries if single-host.
  ],

  "agents": {
    "all":          ["claude"],            // every identity in play
    "dispatchable": [],                    // lanes the dispatcher may auto-route
                                           //   to (empty = manual only)
    "dispatchableMachines": ["host-a", "either"]
  },

  "model": {
    "primary":   "<your high-judgment model>",   // orchestration/decisions
    "execution": "<your cheaper model>"          // mechanical edits/searches
  },

  "domains": {
    "list": ["infrastructure", "product", "uncategorized"]  // your task domains
  },

  "notifications": {
    "statusChannel": "",   // optional chat channel id for status; "" disables
    "alertChannel":  ""    // optional chat channel id for alerts;  "" disables
  }
}
```

**Minimum viable fill-in** (single machine, manual dispatch): set
`org.name`, one `machines[]` entry with your real `id`/`user`, and
`model.primary`/`model.execution`. Everything else can stay default.

*(Multi-machine only)* If you run agents across hosts and use the shell sync
helpers, also set the IPs in [`scripts/lib/network.env`](../scripts/lib/network.env)
(or `export JAY_IP`/`JARRY_IP` to override the defaults).

### Verify the config resolves

```bash
cd "$METIS_HOME"
python3 -c "import sys; sys.path.insert(0,'scripts'); \
from lib import infra_config as c; \
print('machines:', list(c.machine_agents())); \
print('dispatchable machines:', c.dispatchable_machines()); \
print('domains:', c.domains())"
```

You should see your real machine id(s) and domains — not `<<...>>`. If you still
see placeholders, that field isn't filled (the loader is just falling back).

## 4 — Smoke-test the core

```bash
cd "$METIS_HOME"
python3 -m compileall -q scripts config build        # everything imports
python3 scripts/test-self-heal.py                    # self-heal harness passes
```

Both are exactly what CI runs ([`core-ci.yml`](../.github/workflows/core-ci.yml)),
so green here means green upstream.

## 5 — Run the session lifecycle

The day-to-day loop, governed and collision-free across parallel sessions:

- **Start** — orient + claim work atomically:
  `python3 scripts/agent-work.py claim-next --agent <you>`
- **Work** — a lease + fencing token is held on your task; siblings can't grab it.
- **Checkpoint** — bank a finished unit mid-session (commit with intent, keep going).
- **End** — full close: commit + push, refresh forward state, route lessons, sign off.

The board (`task-queue.md`, `OPEN_TASKS.md`) is a **projection** of the canonical
`tasks.json` — render it, never hand-edit. State moves through a forward-only DAG
(`scripts/update-tier1-state.py`); data fixes use the audited `correct-state`
escape hatch. See [`CLAUDE.md`](../CLAUDE.md) for the doctrine the agents follow
and [`docs/process/`](process/) for the full protocols.

## 6 — Staying in sync

```bash
# Pull core updates into your operating repo
git subtree pull --prefix metis-core \
  git@github.com:Busa-Legacies/metis-core.git main --squash

# Contribute a core fix back upstream (opens against a branch; main is protected)
git subtree push --prefix metis-core \
  git@github.com:Busa-Legacies/metis-core.git <your-branch>
```

Keep your overlay (identity, projects, real IDs, credentials) **out** of
`metis-core/` — it belongs in your operating repo. The boundary is spelled out in
[`SPLIT.md`](../SPLIT.md). `main` on the core is protected: changes land via PR
with code-owner review.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Scripts can't find the repo root | `export METIS_HOME=.../metis-core`; confirm with `python3 -c "import sys;sys.path.insert(0,'scripts');from lib.paths import METIS_HOME;print(METIS_HOME)"` |
| Config helpers return generic defaults | A field is still a `<<placeholder>>` — fill it; the loader falls back silently by design |
| `compileall` fails on 3.11 | Use Python 3.12+ |
| `git subtree` not found | Older git — upgrade, or use `git submodule` as a fallback (not recommended) |
| Multi-machine sync uses wrong IPs | Set them in `scripts/lib/network.env` or export `JAY_IP`/`JARRY_IP` |
