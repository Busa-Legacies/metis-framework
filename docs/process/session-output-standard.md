# Session Final-Output Standard

**Effective:** 2026-06-05 · **Revised:** 2026-06-07 (v2 — every stop, no trivial-turn skip, hook-enforced)
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
2. **Work banked** — a task/chunk is complete (done, checkpointed, or session close).
3. **Blocked** — progress is impossible and the blocker is named.

"Trivial/conversational" is NOT a stop category — if the turn was trivial, either keep
working (momentum doctrine) or it was Ant asking a question, which is case 1: he's about
to act on the answer and needs the same context. **Therefore every stop carries the
sign-off block.** There is no skip rule. A conversational stop uses the minimal form
(header + whichever fields apply — at minimum `Next:` or `Asks:`).

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
  or failures. Show your reasoning only for judgment-call or destructive-edge actions.

### When it fires

**Every stop.** Including, specifically:

- The confirm step of `/checkpoint`.
- The final step of `/end` (after the close ceremony).
- Any task-completion, blocked, or input-needed turn (no slash-command needed).
- Conversational stops — minimal form (see R6).

### Enforcement

Prose-only compliance failed (2% over the standard's first 48h — the rule lived in
`/end` Step 13 and a memory index line, with nothing present at the moment a mid-session
message was composed). It is now mechanically enforced:

- **Stop hook:** `ClaudeCode/hooks/hook-signoff-gate.sh` (zero-LLM) checks the final
  assistant message for the header pattern + ≥1 field line. Missing → blocks the stop
  once with a reason instructing the session to append the block. Loop-safe via
  `stop_hook_active`; skips when a `/restart` is pending.
- **Always-loaded context:** compact rule in global `ClaudeCode/CLAUDE.md` so the
  standard is in working context at composition time, not only at close ceremonies.

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
