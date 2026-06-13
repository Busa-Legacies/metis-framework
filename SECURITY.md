# Security Policy

## Reporting a vulnerability

Report security issues privately, never in a public issue or pull request. Use
GitHub's private vulnerability reporting on this repository (the **Security** tab,
then **Report a vulnerability**). Include enough to reproduce: the affected files or
scripts, the conditions that trigger it, and the impact you observed.

Expect an initial acknowledgment within a few days. This is a small project, so
fixes are best-effort rather than bound to a fixed SLA; once an issue is confirmed,
a coordinated disclosure timeline is agreed with the reporter before any public
detail lands.

## Scope

In scope is the framework code in this repository: the governance scripts, hooks,
merge drivers, and session machinery. A credible report shows how that code can be
made to leak data, corrupt governed task state, run unintended commands, or bypass a
guard.

Out of scope is anything in a consuming organization's own overlay repo (its
identity, integrations, and credentials live there, not here) and configuration
mistakes a deploying org makes in its own
[`config/infrastructure.json`](config/infrastructure.json).

## Design properties that bear on security

- The core ships with **no secrets**. Every credential and real identifier is
  parameterized out into the config seam and supplied by the consuming org at
  runtime; CI fails the build if a personal value, IP, hostname, or credential is
  committed to core.
- `main` is protected: changes land only through reviewed pull requests with passing
  CI and linear history, which keeps an auditable trail on every change to the
  shared spine.
