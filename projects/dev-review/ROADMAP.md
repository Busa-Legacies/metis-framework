# Dev Review — v2 Roadmap

v1 (#185) ships: same-origin proxy preview, pick → pin → rail, session
persistence, agent handoff, e2e verification (`scripts/e2e-verify.py`, 8 checks).
Candidates below are ordered by leverage. Mint a governed task +
plan before building (per `/plan` gate).

## v2 scoring (#215, 2026-06-10)

Scored 1–5 on user value · effort (5 = cheapest) · strategic weight for the
open-source/SaaS story (#212/#213). Top 4 minted as governed tasks.

| # | Candidate | Value | Effort | Strategic | Σ | Verdict |
|---|---|---|---|---|---|---|
| 1 | Screenshot crop | 5 | 3 | 4 | 12 | **minted #256** |
| 2 | Orphan re-pick | 4 | 4 | 3 | 11 | **minted #257** |
| 3 | Round-trip verify | 5 | 3 | 5 | 13 | **minted #258** |
| 10 | Trust gate | 2 | 3 | 5 | 10 | **minted #259** (P3 — #212 Phase-3 prerequisite) |
| 4 | Severity/subset send | 3 | 5 | 2 | 10 | next batch — quick win, no strategic pull |
| 5 | Agent presets | 3 | 4 | 3 | 10 | next batch |
| 6 | Session switcher | 3 | 4 | 2 | 9 | next batch |
| 8 | In-repo artifacts | 3 | 3 | 4 | 10 | hold until review files prove durable (its own gate) |
| 9 | Electron packaging | 2 | 3 | 3 | 8 | hold — matters at SaaS distribution time, not before |
| 7 | WS/HMR proxying | 4 | 2 | 2 | 8 | hold — highest effort, manual reload is a livable workaround |
| 11 | Sub-path SPA root nav | 2 | 2 | 1 | 5 | hold — documented v1 limit |

Build order: #258 round-trip-verify → #256 screenshot-crop → #257 orphan-re-pick
(verify loop first: it makes every later feature self-evidencing). #259 fires
whenever #212 Phase 3 planning starts.

## High leverage
1. **Screenshot crop per annotation** — capture the pinned element's region
   (canvas/`getDisplayMedia` or sidecar playwright) and attach to the payload;
   gives the agent visual ground truth when selectors orphan. (Plan's original
   open item.)
2. **Orphan re-anchor flow** — orphaned pins are currently dead ends (e2e
   confirmed send skips them, by design). Add "re-pick" on an orphaned
   annotation to re-attach it to a new element, preserving the comment.
3. **Round-trip verify loop** — after the agent edits, auto-reload the preview
   and re-run each annotation's selector check: resolved/changed/still-broken
   per pin. Closes the review loop in-window (evidence-first done gate, per
   design-guidelines workspace UX).

## Medium
4. **Severity picker in the comment bar** (defaults to `issue` today) +
   send-selected subset instead of all-open.
5. **Agent presets** — kind/lane choice (claude / codex / shell) and a reviewer
   system-prompt preset; today the spawn button is claude-only.
6. **Session switcher UI** — sessions are already per-target files on disk;
   surface them (recent targets, open-pin counts).
7. **WS/HMR proxying** — dev servers' hot reload through the middleware proxy;
   today the workaround is manual preview reload.

## Later / structural
8. **In-repo review artifacts** — move sessions from `~/.openclaw` into the repo
   (shareable, RAG-indexable) once review files prove durable.
9. **Electron packaging pass** — `app:dist` build, icon, signed artifact; only
   dev mode exercised so far.
10. **Trust gate** — PTY sidecar has no auth; fine on the tailnet, required
    before any wider exposure.
11. **Sub-path SPA root navigation** — proxied page's `/` links collide with the
    console shell (documented v1 limit).
