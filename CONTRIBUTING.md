# Contributing to Metis Framework

Metis Framework is the portable core of a larger operating system: the protocols,
skills, hooks, and governance machinery that any organization can adopt. Most
consumers vendor it into their own operating repo via `git subtree` and never edit
it directly; a contribution here is a change to the shared spine itself, so it
ships to every org running the framework.

## The one hard rule: keep core org-agnostic

Nothing personal or organization-specific belongs in this repo. Machine names, IPs,
home paths, hostnames, real integration IDs, and credentials are all parameterized
out into [`config/infrastructure.json`](config/infrastructure.json) and resolved at
runtime. A change that hardcodes any of those fails CI's parameterization guard and
cannot merge. When you need a value that varies per org, read it from the config
seam rather than baking it in.

## Proposing a change

`main` is protected; every change lands through a pull request.

1. Branch from `main`.
2. Make the change. Keep it parameterized (see above) and matched to the idiom of
   the surrounding code.
3. Run locally what CI runs:
   ```bash
   python3 -m compileall -q scripts config build
   python3 scripts/test-self-heal.py
   python3 scripts/test-governance-core.py
   ```
4. Open a PR. CI ([`core-ci.yml`](.github/workflows/core-ci.yml)) must pass and a
   code owner ([`.github/CODEOWNERS`](.github/CODEOWNERS)) must approve before merge.
   History stays linear; force-pushes to `main` are blocked.

If you maintain a consuming repo, contribute a fix back upstream with:

```bash
git subtree push --prefix metis-core \
  git@github.com:Busa-Legacies/metis-framework.git <your-branch>
```

then open a PR from that branch.

## What makes a change land cleanly

- It reads like the code around it: same naming, comment density, and idiom.
- It fixes a root cause, not a symptom; the project distrusts band-aids.
- It carries its reasoning. A commit message or PR body that explains *why* is worth
  more than one that restates *what*.
- It keeps signals honest. If a test fails or a step was skipped, say so rather than
  working around it; a blocked-but-true state beats a green-but-false one.

Whether something belongs in core or in an overlay repo is answered in
[`SPLIT.md`](SPLIT.md).
