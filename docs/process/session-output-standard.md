# Session Final-Output Standard

**Effective:** 2026-06-05 · **Revised:** 2026-08-03 (v3 — stop legitimacy gated on the *question* too;
prevention moved upstream of enforcement) · v2 2026-06-07 (every stop, no trivial-turn skip, hook-enforced)
**Applies to:** Claude Code (main sessions) — the final in-chat message of EVERY turn that returns control to Ant.
**Task:** #146

---

## The Problem

Ant reads the chat on mobile, often picking a session back up after a gap. A sign-off
that says "done — pushed" with no framing forces him to scroll back to reconstruct
*which project*, *which task*, and *what he now needs to do or check*. The result is
re-orientation cost on every hand-back, and verification asks (e.g. "test the scroll
fix live") get buried in prose and missed.

There was no standard for this. `/start` defines the opening briefing and `/end` defines
the close ceremony, but neither specifies the **final message** itself or requires it to
carry project + task context.

---

## The Standard

### Stop discipline (v2, Ant 2026-06-07)

A turn may only END (stop and hand control back to Ant) for one of three reasons:

1. **Input needed** — a decision, credential, or eyes-on check only Ant can provide.
2. **All queued work done** — every item in the current request is complete, not just
   the slice in hand. Status `done`.
3. **Blocked** — progress is impossible and the blocker is named.

**"Work banked" is NOT a fourth reason.** Banking (commit / push / checkpoint) is something
you do *continuously while working* to make progress durable — it is not a hand-back trigger.
After you bank a slice mid-task, you **keep going** to the next queued item. The tell of an
illegitimate stop: a `Next:` action you could take right now and no real `Asks:`/`Check:` — i.e.
*"I know the next step and need nothing from Ant."* That is never a valid stop; do the Next action
instead. The tell is **status-agnostic**: it holds whether you labeled the stop `banked`,
`in-progress`, **or `done`**. A `done` that dangles a takeable forward `Next:` with no ask is the
SAME premature stop wearing a terminal label (the loophole Ant hit 2026-07-21). **A true `done`
carries NO forward-looking `Next:`** — if the Next is in-scope, it is not done (do it); if it is
genuine future-scope, log it as a task/suggestion (never dangle a path-forward only in chat) and
drop the line. `blocked` is the sole exemption — its `Next:` is the planned resumption. (`banked`
remains a legit *status* only when the stop is itself Ant-directed — "checkpoint here" / "pause" —
or the session is closing.) This is **hook-enforced**: `hook-signoff-gate.sh` blocks a stop
matching that premature signature (`banked`/`in-progress`/`done` + Next + no ask) and tells you to
continue — mirroring the format gate below.

**Chat vs work split (Ant 2026-08-23, [[feedback_response_formatting]]).** The block earns
its place on real work — a session that made a git commit, took a task checkout
(`agent-checkout`/`claim-next`), or edited `tasks.json`. Those sessions **carry the full
sign-off block** on every stop, no skip rule. A **pure conversational session** (none of
those markers) **ends like a normal message** — no block, no forced AskUserQuestion; the
block is clutter there. `hook-signoff-gate.sh` enforces the split, and its detection **fails
toward requiring the block** (any commit / checkout / tasks.json edit, or any unreadable
transcript → block required), so a real work session never loses its mobile handoff. When a
work session's stop is itself lightweight, use the minimal form (header + whichever fields
apply — at minimum `Next:` or `Asks:`).

### Close every turn with an AskUserQuestion (Ant 2026-07-27, standing across all sessions/accounts/machines)

Every hand-back to Ant **ends with an `AskUserQuestion`** — the sign-off block reports where
things stand, and the AskUserQuestion is the interactive hand-off it lands on: the next-step /
direction choice or the decision that gates further work, framed as 2-4 informed options with a
recommended default first (per `feedback_askuserquestion_for_all_questions` — propose candidate
answers even for open-ended asks; the always-present "Other" captures free text). Ant answers on
mobile; a tappable question is the low-friction hand-off, and it keeps the session moving on his
steer rather than idling.

**Enforced (2026-10-05).** `hook-signoff-gate.sh` blocks a work-session stop whose last tool call since Ant's last message is not `AskUserQuestion` (exempt: `/end`/`/restart` turns, idling on the session's own background job, pure chat). Before that nothing enforced this section, and two restatements (the per-prompt turn contract and the Metis output style) had narrowed it to "non-terminal" stops, so fleet-wide only ~10-25% of `done` stops asked (<<MACHINE_1_ID>> 9.7% of 93, <<MACHINE_2_ID>> 14.3% of 77, Air 25% of 12, 14-day audit). Any restatement of this rule must say EVERY stop, `done` and `blocked` included. Test: `tests/test-signoff-gate-closing-question.sh`. Headless `-p`/SDK runs (transcript `entrypoint: sdk-cli`) are exempt. Tracked weekly as the `closing-question` rule in `scripts/compliance/audit.py`, read from interactive transcripts (not the gate log), so accounts or machines without the gate still count. Isolated accounts get the gate via `scripts/fleet/claude-account-output-hooks.py`, run by `claude-fleet.sh setup|launch`.

**Sole exception: a turn advising a session end.** When the turn recommends ending or closing
(`/end`, `/restart`, or explicitly "we should wrap up here"), it closes with the sign-off block
and **no question** — you don't ask what's next while saying goodbye.

**This rule governs HOW a hand-back is delivered, never WHETHER to hand back (v3, Ant
2026-08-03).** Stop legitimacy is decided first, by the three reasons above. Only once a turn
has *earned* its stop does this rule apply, and then it is binding: the `Asks:` / `Proposed:`
content is *delivered as* the closing AskUserQuestion — naming a `Next:` and stopping is the
anti-pattern; ask it. **Manufacturing a question in order to close a turn inverts the rule and
is itself a violation.** If you find yourself reaching for "…or good to move on?" / "ready to
continue?" to satisfy this section, the correct move is not to ask — it is to keep working.

**How it interacts with the stop-gate (v1-v2 got this wrong).** v2 claimed the two rules
"partition cleanly" because a turn ending in an AskUserQuestion is awaiting a tool result, not
stopping, "so it never reaches `hook-signoff-gate.sh` at all." That is true, and it was the
hole, not the harmony: measured 2026-07-20..08-03, **374 hand-backs reached the Stop gate while
668 ended in an AskUserQuestion — ~64% of all hand-backs bypassed stop-legitimacy enforcement.**
Compounding it, the Stop gate's premature test is "`Next:` with no `Asks:`/`Check:`", so
*attaching an ask makes a stop legal*. Between them, "do a slice → ask 'continue?' → turn ends"
was the cheapest way to satisfy both rules and nothing checked it — which is exactly the drift
Ant corrected on 2026-07-28 and again on 2026-08-03 ("Metis doesn't need to ask permission to
continue with each step").

**Closed by `hook-ask-gate.sh`** (PreToolUse on AskUserQuestion): the legitimacy test now runs
on the question itself. It denies permission-to-continue phrasing ("should I proceed…", "ready
to continue?", "…or good to move on?"), continue/stop option pairs, and ordering *within* an
agreed sequence ("which step first?"). It fails open — always — on STOP floors (money, deploy /
prod, external send, secrets, irreversible), eyes-on `Check:` questions, open direction menus
("how do you want to proceed?" with real alternatives), genuine design forks, and any second
block inside a 240s per-session cooldown, so it can never trap a session in a loop. Back-tested
over 669 real questions it denies 1.8%; regression suite `tests/test_ask_gate.py`.

So the partition is now by *legitimacy*, not by mechanism: a turn that earned its stop ends with
a question (or, for a session-end advisory, with the block and no question); a turn that did not
earn its stop keeps working — and both gates say so.

### The sign-off block

End **every** turn that returns control to Ant with this block as the last thing in
the message:

```
**<Project/area> › <#id slug | ad-hoc label>** — <status>
- Done: <what landed — 1-3 bullets, not a re-paste of the diff>
- Verified: <evidence I already ran — "46 tests green", "grep clean" — reassurance, never a chore>
- Check: <ONLY if Ant must verify something himself — a direct question with an easy answer; omit otherwise>
- Next: <single highest-value next action>
- Asks: <decision/input you need from Ant — omit the line entirely if none>
```

- **Status** is one of: `done` · `banked` (checkpointed, continuing) · `blocked` · `in-progress`.
- **Project/area** = the workstream (e.g. `OpenClaw Infra`, `Trading`, `Dashboard`). **task** = `#id slug` if governed, else a short ad-hoc label.
- **Ad-hoc label is for small/trivial work only (#5680).** A turn that creates a new file or produces more than ~50 lines of substantive output must link a real `#id` (mint one via `/add-task` if none exists yet) — never file that work under a bare ad-hoc label. Ad-hoc labels stay for genuinely small, non-tracked work: a lookup, a one-line fix, a chat reply. Governed output without a governed id is the "ungoverned output" leak.

### Rules

- **R1 — Lead with project + task context.** The header (`area › task`) is mandatory and
  comes first, so the sign-off is self-explanatory without scrollback. This is the core ask.
- **R2 — Terse.** One line per field, bullets not paragraphs. Don't restate what the diff
  already shows. Ant's standing preference is short.
- **R3 — Verification honesty, two distinct lines** *(split 2026-06-06 — a single `Verify:`
  read ambiguously as both "what I verified" and "what you must verify")*:
  - `Verified:` = evidence **I** already ran (`46 tests green`, `grep clean`). It is
    reassurance, never a task for Ant.
  - `Check:` = something only **Ant** can verify (TUI/UI behavior, trackpad, external/live
    state). Include it ONLY then, and phrase it as a **direct question with an easy answer**:
    name the exact action + the expected observation so he can answer y/n or A/B from his
    phone. ✓ `Check: open the dashboard drawer on mobile — does it scroll past item 10? (y/n)`
    ✗ `Verify: agent worktrees left alone — if you know they're dead, they're a quick prune`
    (statement; unclear who acts; no answerable question).
  - Never imply success you didn't observe. (See [agent-observation-verification-standard.md](agent-observation-verification-standard.md).)
- **R4 — Next is an action, not a question.** Give the single highest-value next step; if
  genuinely ambiguous, name the top 2 — never "should I proceed?".
- **R5 — Asks only when real.** Include the `Asks` line only when you need a decision or
  input. Omit it otherwise — no filler.
- **R6 — Every stop, minimal form allowed** *(v2 2026-06-07 — replaced "skip on trivial
  turns", which became the loophole every session hid in: a 2026-06-05→06-07 transcript
  audit measured 2% compliance across 363 stops)*. Every turn that hands control back to
  Ant ends with the block. For a conversational/answer turn, collapse to the minimal form:
  the header plus only the fields that apply (≥1 of `Done/Verified/Check/Next/Asks` —
  usually `Next:` or `Asks:`). The header is never optional: Ant reads on mobile and acts
  on the answer; he needs to know which project/task the stop belongs to.
- **R7 — Multiple tasks → one header line each** (or a compact table if 3+), each with its
  own status, so nothing blurs together.
- **R8 — Asks are for Ant, FYIs are for the state layer** (Ant flagged 2026-06-06 after an
  "Asks — no action needed" contradiction). An Ask is a direct question or an action only
  Ant can take. Watch items, heads-ups, and anything aimed at a *sibling session* go into
  `working-context.md` threads or the daily log instead — inter-session coordination routes
  through the state layer, never through Ant. If he reads an Ask and there's nothing for
  him to do, it was mis-routed.
- **R9 — Routine ops are silent** (Ant flagged 2026-06-06: "you tell me far too often that
  you've merged or cleaned the tree"). Maintenance already governed by a standard — worktree
  cleanup, commit/push mechanics, lease/board hygiene, memory trims — executes without
  narration and without its own Done bullet. Surface only outcomes Ant acts on, deviations,
  or failures. State your rationale only for judgment-call or destructive-edge actions.
- **R10 — A confirm/decide Ask carries its artifact IN-block** (Ant flagged 2026-07-14 after an
  `Asks: confirm the v1 scope above` where the scope wasn't marked in the block). When `Asks:`
  or `Check:` requires Ant to **confirm, approve, or choose**, the exact thing he is deciding on —
  the proposed scope, the options, the copy, the diff summary — must appear **inside the sign-off
  block, clearly labelled on its own line** (e.g. `- Proposed v1 scope: …` or a short marked
  sub-block **immediately above the `Asks:` line**). Never reference it as "above", "see the plan",
  or a bare file path — Ant reads on mobile and acts on the block alone, so an Ask that points
  elsewhere forces scrollback or a file-open and stalls the decision. Pair with decide-and-present:
  state your recommended default so he can one-tap confirm. (Extends
  [session inline-not-doc rule] and [decision-presentation]: the decidable content lives where the
  Ask does.)

- **R11 — Answer what was asked, before the noise (#5685).** When the user's latest message
  carries a direct question, request, or complaint, the response body must substantively address
  it — in prose, ahead of or independent from any `Done:`/task-completion recitation. Task-completion
  status is never a substitute for answering what was asked; if the sign-off's `Done:` bullets and
  the user's actual ask compete for the top of the message, the ask wins. (Distinct from the
  response-required hook (#5044), which only forces *a* response to exist — R11 governs that the
  response leads with the user's concern, not status noise.)

### When it fires

**Every stop.** Including, specifically:

- The confirm step of `/checkpoint`.
- The final step of `/end` (after the close ceremony).
- Any task-completion, blocked, or input-needed turn (no slash-command needed).
- Conversational stops — minimal form (see R6).

### Substance, not just form (#519)

A well-formed block can still be empty of substance. The gate additionally lints two
recurring defects Ant corrected repeatedly. Both are **fail-open** (only the clear-cut
shape fires; anything ambiguous passes) and every decision is logged with
`lint_fp_candidate:true` for the false-positive meter.

- **`Asks:` must be a request TO Ant, not your own next step.** If the Asks line reads
  as *your* continuation, omit it (there's no ask) or move it to `Next:`.
  - ✗ `- Asks: proceeding down the list` · ✗ `- Asks: I'll wire the next card` · ✗ `- Asks: FYI the build is green`
  - ✓ `- Asks: layout A (accounts-first) or B (trend-first)?` · ✓ omit the line entirely
- **No bare option token as the whole `Next:`/`Asks:`.** A bare key (`2b`, `a`, `1a`) is
  unmappable on mobile — this is R10 in miniature. Restate the decidable content on a
  `Proposed <X>:` line and make `Next:`/`Asks:` a full imperative/question.
  - ✗ `- Next: 2b` · ✗ `- Asks: b`
  - ✓ `- Proposed rollout: A = ship now · B = wait for CI` + `- Asks: ship now (A) or wait for CI (B)?`

### Enforcement

Prose-only compliance failed (2% over the standard's first 48h — the rule lived in
`/end` Step 13 and a memory index line, with nothing present at the moment a mid-session
message was composed). It is now mechanically enforced:

- **Stop hook:** `ClaudeCode/hooks/hook-signoff-gate.sh` (zero-LLM) checks the final
  assistant message for the header pattern + ≥1 field line, the stop-legitimacy signature,
  and the two substance lints above. A miss → blocks the stop once with a reason. Loop-safe
  via `stop_hook_active`; skips when a `/restart` is pending or `METIS_HEADLESS=1`.
- **Dropped-request gate (#7965, 2026-10-08):** the same Stop hook blocks once when Ant's
  last message is a request (an imperative ask, a broken-state report, a next-step query, or
  a plain question, classified by `hook-response-required.sh --classify`) and the turn
  produced no visible text AND no tool call, i.e. the "No response requested" zero-out.
  Chat and work sessions alike. Any action this turn, headless/`sdk-cli`, slash or injected
  prompts stay fail-open (the flush race). Prompt side, the same classifier injects an
  EXPLICIT ASK nudge on imperative asks (check / research / compare / update / add / look
  into / review / run ...) so the ask is done or answered before any wrap, redirect, or
  status. Logged as `reason=dropped-request` in `signoff-gate.jsonl` (FP-meter watched).
  Tests: `tests/test-hooks.sh`.
- **Checkout guard:** `ClaudeCode/bin/checkout-guard.sh` **denies** a direct Edit/Write to
  `docs/process/state/*` (the governed board) from a session holding no live lease — the
  strongest anti-collision rule, no longer honor-only (#519). Change board state through
  `scripts/update-tier1-state.py` / `scripts/agent-work.py`, not hand-edits.
- **Ask gate (v3):** `ClaudeCode/hooks/hook-ask-gate.sh` (PreToolUse on `AskUserQuestion`,
  zero-LLM) applies the stop-legitimacy test to the question, closing the ~64% of hand-backs
  the Stop hook structurally cannot see. Fail-open on stop floors / eyes-on checks / open
  direction menus, and rate-limited to one denial per session per 240s so it can never loop.
  Decisions logged to `~/.openclaw/logs/ask-gate.jsonl` for the FP meter; suite
  `tests/test_ask_gate.py`.
- **Always-loaded context:** compact rule in global `ClaudeCode/CLAUDE.md` so the
  standard is in working context at composition time, not only at close ceremonies.
- **Turn-start contract (v3, PREVENTION):** `ClaudeCode/hooks/hook-turn-contract.sh`
  (UserPromptSubmit, last in the chain) injects stop legitimacy + the sign-off template
  adjacent to every prompt. Rationale: over 2026-07-20..08-03 the Stop gate blocked **233 of
  640 stops (36%)**, and **141 of those (60%) were pure format misses** — the spec was in
  always-loaded `CLAUDE.md` the whole time and still missed, because static system-prompt text
  sits far from the moment of use. Each block costs a full extra round trip (whole context
  re-sent) plus a re-emitted message; 13 sessions ate 3+ blocks each, worst 34. Note the
  always-on design: format misses do not correlate with prompt shape, which is why the
  shape-matched `hook-plan-nudge.sh` never caught them. Enforcement stays as the backstop —
  this is the cheaper half, paid ~150 tokens per prompt instead of a wasted turn.

Both #519 gates extend the enforcement-gap audit from #345 (which catalogued every recurring
correction as has-gate / needs-gate / accept-advisory); these were two of its needs-gate items.

---

## Example

```
**OpenClaw Infra › #146 session-final-output-standard** — done
- Done: wrote the standard doc; wired it into /end + /checkpoint; added feedback memory.
- Verified: docs only, no runtime — grep confirms /end + /checkpoint reference the standard.
- Check: read the example block on your phone — is it scannable without scrolling? (y/n)
- Next: #138 repo-root-path-drift, or pick the next free task.
- Asks: want any fields cut/reordered?
```
