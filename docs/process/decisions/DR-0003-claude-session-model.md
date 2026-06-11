# DR-0003: Claude session model — per-window persistence, not a single shared session

- **Status:** Accepted
- **Date:** 2026-06-04
- **Supersedes:** —
- **Superseded-by:** —

## Context

Opening a new terminal and running `claude` attached a *second* tmux client to the
one fixed session `claude-main`, producing a mirror — both windows showed the
same Claude and fought over screen size. Root cause: the original persistence
build (T-FW-03) hardcoded a single session name. That conflated two orthogonal
ideas — *persistence* (survive sleep/terminal-close, reconnect) and *a single
session*. The intent was only ever persistence; the fixed name was a shortcut for
easy reconnect that quietly collapsed every window onto one session.

The intent was never captured anywhere queryable — it lived in a commit body and
a thin how-to doc — so a later convenience commit wiring `claude-main` to the
everyday `claude` alias had no reference point to flag the contradiction. This DR
exists partly to stop that class of drift: design intent now has a durable home.

## Decision

Each terminal gets its **own** persistent tmux session `claude-<N>` (lowest unused
N). Plain `claude` is the zero-prompt default — straight to a fresh session.
Reattaching a prior session is opt-in via `cca` (`claude-tmux.sh --pick`), which
lists existing `claude-*` sessions (defaulting to reattach #1) plus an `n` option
to start new. The in-tmux restart loop (mobile/ttyd, `/restart`) is unchanged.

Mobile/ttyd/SSH access is a **separate** system (session `ccc`) and is untouched
by this — the two must not be conflated again.

## Alternatives considered

- **Smart guard on a single name** (attach `claude-main` only if unattached, else
  spawn new): preserves one canonical name but keeps the fragile single-name model
  and surprising conditional behavior. Rejected for per-window names — simpler and
  unambiguous.
- **Picker on every `claude`**: first iteration. Rejected — it taxed the common
  case (new session) with a prompt. New must be frictionless; reattach is the rare
  path and earns the extra step.

## Changes

- See `git log --grep=DR-0003` for the implementing commits.
- Files: `scripts/claude-tmux.sh`, `dotfiles/shell.zsh`,
  `docs/process/claude-session-persistence.md`

## Consequences

- New windows are independent and never mirror. Reconnect after sleep is `cca`.
- Session names are now dynamic (`claude-1`, `claude-2`, …) — anything keying off
  a fixed `claude-main` name would break; nothing currently does (verified).
- `claude-tmux.sh` targets macOS system bash 3.2 — no `mapfile`, associative
  arrays, or `${var^^}`. Use `while read; arr+=()`. See [[macos-bash32]].
- Do not reintroduce a single fixed session name for the laptop launcher, and do
  not conflate it with the mobile `ccc` system.
