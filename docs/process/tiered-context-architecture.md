# Tiered Context Architecture

How every agent (Claude Code, Codex, OpenClaw lanes) gets the right protocol context **just-in-time**
instead of paying for all of it on every session. The goal is two things at once: **lower always-on
token cost** AND **guaranteed protocol adherence** — the second is non-negotiable, so adherence is
enforced by mechanism (kernel + hooks), not by hoping always-loaded prose is read.

Status: **proposal (2026-06-09)** — supersedes the "round 1 trim" in `token-optimization.md` with a
systemic model. Implementation is phased; see §6.

## 1. The problem (measured)

Always-on context per session, union across providers (`wc -c` audit 2026-06-09):

| Layer | Size | Loaded by |
|---|---|---|
| Root files (AGENTS 14.7K, SOUL 3.8K, CLAUDE 3.3K, TOOLS, HEARTBEAT, IDENTITY, USER, MEMORY) | ~26 KB | all providers (startup checklist / Codex auto-load) |
| `ClaudeCode/CLAUDE.md` | 13.7 KB | Claude Code |
| `codex/instructions.md` | 11.7 KB | Codex |
| Hook injection (working-context 5.7K + free-work 2.3K + live-status 1.2K) | ~9.2 KB | all, every session |
| **Always-on baseline** | | **~14–15k tokens before any work** |

Two structural problems, not just verbosity:
1. **Blanket injection.** Session context (working-context, free-work, live-status) is injected
   unconditionally every session, whether the prompt needs it or not.
2. **Wrong-tier content.** `AGENTS.md` carries ~10 KB of OpenClaw *assistant* behavior (heartbeats,
   Discord, group-chat etiquette, emoji reactions) that a repo-working agent never uses, yet pays for.
   Protocol detail (doctrine, lifecycle, routing) is duplicated inline across `CLAUDE.md` +
   `codex/instructions.md` + the canonical `docs/process/*` doc.

## 2. Principles (from Anthropic context-engineering guidance)

- **Just-in-time retrieval.** Load lightweight identifiers always; pull the heavy detail only when the
  current activity needs it. (`anthropic.com/engineering/effective-context-engineering-for-ai-agents`)
- **Single canonical source.** Each protocol lives in exactly one provider-neutral doc. Per-provider
  files are thin **routers** that point at it — never re-inline it. Parity is enforced, not copy-pasted.
- **Enforce, don't hope.** When a rule's detail is on-demand, adherence is guaranteed by (a) the kernel
  always *naming* the rule, and (b) a hook that *blocks* the non-compliant action — not by trusting the
  agent to have read prose. This is the answer to "how do we ensure adherence without always-on."
- **Isolate verbose work.** Research/log-heavy/throwaway work runs in subagents or free Ollama lanes so
  its tokens never enter the main window.

## 3. The tier model

### Tier 0 — Kernel (always-on, ALL providers, target ≤ ~2.5k tokens)
The irreducible minimum an agent must hold in context to act safely and know where everything is. Only:
- **Identity** — who/what (condensed IDENTITY + USER).
- **Hard rules, stated tersely** — the 6 act-vs-ask guardrails; red lines; the sign-off *requirement*
  (one line + pointer); the redaction one-liner ("money is never logged").
- **The Router** — an index table: *"for activity X, load pack Y."* This is the heart of the system —
  it makes JIT retrieval reliable because the agent always sees the map even when it doesn't hold the territory.

Replaces the bulk of inline prose now in `ClaudeCode/CLAUDE.md` and `AGENTS.md`.

### Tier 1 — Activity packs (on-demand: skills + canonical docs)
Pulled when the triggering activity begins. Each is ONE canonical doc/skill, provider-neutral:

| Pack | Canonical source | Loaded when |
|---|---|---|
| Decision doctrine (full) | `docs/process/decision-doctrine.md` | rarely — kernel holds the 6 guardrails |
| Session lifecycle | `skills/{start,checkpoint,end,next}` (already skills ✓) | start / checkpoint / close |
| Agent routing + lanes | `docs/process/jay-lanes.md` | delegating to a lane |
| Design guidelines | `docs/design-guidelines.md` | any UI/frontend work |
| Memory standard | `docs/process/memory-standard.md` (extract) | writing a memory file |
| Task lifecycle | `docs/process/task-pickup-and-lifecycle-standard.md` | claim / close a task |
| **Assistant comms** (heartbeat, Discord, group-chat, reactions) | `docs/process/assistant-comms.md` (extract from AGENTS.md) | **only** gateway/heartbeat context — never repo-work sessions |

### Tier 2 — Retrieved session context (JIT-injected, not blanket)
Pulled by activity/keyword via hooks or agent action, instead of unconditional injection:
- **working-context.md** — kept lean; injected (trimmed) for orientation.
- **free-work** — injected only when the prompt signals "what's next" / via `/next`, not every session.
- **live-status** — injected only on a multi-session-pickup signal.
- **memory files** — agent pulls by name from the `MEMORY.md` index when the task touches that area.
- **project docs** — pulled per active project.

## 4. Enforcement layer (how adherence is guaranteed)

Adherence never depends on a rule being always in context. Three mechanisms stack:
1. **Kernel names every hard rule** — the agent always knows the rule *exists* and which pack carries detail.
2. **Hooks are the deterministic backstop** (already partly built): `hook-signoff-gate.sh` blocks
   non-compliant stops; `file-guard`/`checkout-guard` gate edits; `hook-prompt-guard` handles rate/plan.
   Extend the pattern — a **PreToolUse** hook can hard-block an action that violates a protocol whose
   detail is only on-demand (e.g. a commit that skips the sign-off, an edit without a checkout).
3. **Activity-surfacing hook** — a `UserPromptSubmit` hook matches activity keywords in the prompt and
   injects the *pointer* to the relevant Tier-1 pack (retrieval-gated), so the agent loads it before acting.

Net: a rule can live in an on-demand pack and still be impossible to violate silently.

### Enforcement status (audit, 2026-06-10)

Honest accounting of how each protocol is held — mechanical (a hook *blocks* it) vs. judgment (the
kernel names it; the model complies). On-demand placement is only safe when a protocol is either
mechanically enforced or genuinely judgment-shaped (you can't hook-block "should I ask first?").

| Protocol | Enforcement | Mechanism |
|---|---|---|
| Lease/checkout before editing a claimed file | **mechanical** | `checkout-guard.sh` (PreToolUse Edit\|Write — blocks) |
| File-write guards (wrong-dir, concurrent-edit) | **mechanical** | `file-guard.sh` (Pre/PostToolUse) |
| Sign-off block on every stop | **mechanical (Claude)** · self-enforced (Codex) | `hook-signoff-gate.sh` (Stop — blocks). Codex has no Stop-hook → documented delta |
| Context budget (no always-on regrowth) | **mechanical** | `context-budget-check.py` (close-integrity #11 — fails close) |
| Rate-limit / plan-mode nudges | mechanical (advisory) | `hook-prompt-guard.sh`, `hook-plan-nudge.sh` (UserPromptSubmit) |
| Act-vs-ask decision doctrine | judgment | kernel names the 6 guardrails; full doctrine on demand |
| Design guidelines | judgment | path-scoped `.claude/rules/design.md` (auto-loads on UI files) |
| Lane routing | judgment | kernel Router → `jay-lanes.md` |
| **Redaction (money never logged)** | **mechanical** | `hook-redaction-guard.sh` (PreToolUse Edit\|Write — denies). Tightly scoped to personal-log / `#personal` memory writes, so code edits with `$` are untouched; high-confidence money patterns ($-amounts, k/m/bn, money words, comma-grouped thousands) → `deny` with a redact-and-retry reason. |

Every protocol is now either mechanically enforced or genuinely judgment-shaped — no on-demand
placement silently weakens a guarantee. The redaction guard closed the last gap (enforcement-hardening).

## 5. Cross-provider mechanism (reuse what exists)

- **Canonical protocol = `docs/process/*.md`** — one source per protocol, provider-neutral.
- **Per-provider routers** — `ClaudeCode/CLAUDE.md`, `.codex/instructions.md`, lane bootstraps become
  thin kernels + the Router table. Their protocol content is identical (it's just pointers); only the
  invocation surface differs (`/skill` vs `.codex/prompts/` vs lane verbs).
- **Parity enforced** — extend `ClaudeCode/mirror-manifest.json` + `scripts/platform-parity-check.py`
  to assert every provider router exposes the same pack set and points at the same canonical docs.
  This is the cross-PROVIDER analogue of the existing cross-MACHINE mirror check.

## 6. Phased rollout (each phase independently shippable + measurable)

**Phase 1 — Kernel + relocate wrong-tier content.** Formalize the Tier-0 kernel; extract AGENTS.md's
comms/heartbeat/group-chat sections into `assistant-comms.md` (loaded only in gateway context).
Target: always-on ~14.5k → ~7k tokens.
- ✅ Path-scoped design rule (`.claude/rules/design.md`) — UI guidelines off always-on.
- ✅ Root `AGENTS.md` split → kernel + Router (14,727c → 5,854c, −60%); comms/heartbeat/Discord →
  `docs/process/assistant-comms.md` (gateway-only). Parity check green.
- ✅ `Jay/AGENTS.md` trimmed to kernel + comms pointer (220→~45 lines); `Jarry/AGENTS.md` left as-is
  (already lean + genuinely machine-specific, no comms bloat).
- ✅ `codex/instructions.md` doctrine collapsed — Codex also auto-loads the AGENTS.md kernel, so the
  duplicated act-vs-ask prose is now a kernel pointer (priority stack + sign-off block kept inline).
- ◻️ `ClaudeCode/CLAUDE.md` keeps its condensed doctrine on purpose: **Claude Code does not auto-load
  AGENTS.md**, so that file is Claude's only kernel. Not collapsible to an AGENTS.md pointer.
- **Phase 1 essentially complete.** Next high-value lever is Phase 2 (JIT-gate the session-init injection).

**Phase 2 — JIT injection.** Convert `hook-session-init.sh` blanket injection to retrieval-gated:
working-context trimmed + injected; free-work/live-status on-signal only. Add the activity-surfacing
hook. Target: shave the ~2.3k injection to ~0.8k typical.
- ✅ Done. The hook now reads the session's first prompt and branches: **orientation-seeking** prompts
  (`/start`, `/next`, "what's next", "catch me up", bare openers) get the full briefing as before;
  **task-focused** prompts get a trimmed working-context head (~3k cap) + a one-line free-work signal
  and skip live-status. Safety alerts (drift/bloat/mirror/ollama/self-heal/stray-git) surface in both
  modes. Measured: orientation 12,784 chars (unchanged) vs task-focused 7,111 chars (**−44%,
  ~1.4k tokens/session** saved on the common case). Verified with both prompt classes.

**Phase 3 — Cross-provider parity + budget guard.**
- ✅ **Context-budget regression guard** (`scripts/context-budget-check.py`): measures the always-on
  instruction surface per provider (Claude Code / Codex / Jay gateway / shared identity), path-scoped
  `.claude/rules/` correctly excluded, and fails if any group exceeds its char ceiling (current size +
  ~12% headroom). Wired as check #11 in `scripts/close-integrity-check.sh` so silent regrowth fails the
  session-close gate — bumping a ceiling now requires a conscious commit. Negative-tested (trips on
  over-budget) and passing live (claude-code 16,797/19,000 · codex 17,257/19,500 · jay 2,383/3,500 ·
  identity 8,177/9,500).
- ✅ **Pack parity in `platform-parity-check.py`.** The registry now declares `tier1Packs` + `packRouter`;
  the check asserts each pack's canonical doc exists AND is referenced by the shared neutral Router
  (`AGENTS.md`), so every provider that reads it routes to the same pack set. Negative-tested
  (missing doc / unreferenced both fail); live: 5 packs OK.

**Phase 4 — Enforcement hardening.** For each on-demand protocol, confirm a hook backstop exists so
adherence is mechanical, not prose-dependent.
- ✅ Audit complete — see §4 "Enforcement status." Checkout, file-guards, sign-off, and the context
  budget are mechanically enforced; doctrine/design/routing are genuinely judgment-shaped.
- ✅ **Redaction gap closed.** `hook-redaction-guard.sh` (PreToolUse Edit\|Write) denies money amounts
  in personal-log / `#personal` memory writes — scoped so code edits are untouched. Wired into
  `settings.shared.json` + `mirror-manifest.json`. 8-case tested (4 deny / 4 allow). All on-demand
  protocols are now mechanically enforced or genuinely judgment-shaped.

**Success metric:** measured always-on context (via `/context`) at or below target, asserted by the
Phase-3 regression check so it can't silently regrow.

## 7. Verified mechanisms (Claude Code 2.1.170, docs confirmed 2026-06-09)

All load-bearing knobs were checked against the official docs. Confirmed real and used by this design:

| Mechanism | Verified behavior | Used for |
|---|---|---|
| Skill body load | name+description always (~tiny); **body only on invoke** | Tier-1 packs |
| `disable-model-invocation: true` | description hidden from context; loads only on explicit `/name`; also blocks subagent preload | user-only ops (`/end`, `/deploy`) |
| `user-invocable: false` | hide from `/` menu — background knowledge Claude pulls when relevant | reference packs |
| `allowed-tools` / `disallowed-tools` | grant/remove tools while skill active | autonomous/guarded skills |
| **`context: fork` + `agent:`** | run the skill **as an isolated subagent** (own context window) | protocol-heavy ops that shouldn't bloat the main window |
| **Dynamic injection `` !`cmd` ``** | runs a shell command and inlines its output before Claude sees the skill | JIT session context (free-work/live-status on demand, not blanket) |
| `.claude/rules/*.md` + `paths:` | path-scoped rule loads **only when Claude touches matching files** | design-guidelines, area-specific protocol |
| `@path` imports | load **eagerly at launch** (organizational, NOT token-saving) | → we route via pointers/skills instead |
| MCP tool search | **default-on**; `ENABLE_TOOL_SEARCH` = unset/`true`/`auto:N`/`false`; `.mcp.json alwaysLoad:true` per server | defer MCP schemas; pin only always-needed servers |
| `claudeMdExcludes` | skip ancestor CLAUDE.md by glob (local setting) | monorepo / cross-team noise |
| HTML comments in CLAUDE.md | stripped before injection (cost-free maintainer notes) | annotate the kernel without token cost |
| PreToolUse hook | **blocks an action regardless of what the model decides** | the enforcement backbone (§4) |
| `InstructionsLoaded` hook | logs which instruction files loaded, when, why | the Phase-3 context-budget regression check |

**Confirmed: Claude Code reads `CLAUDE.md`, not `AGENTS.md`.** So AGENTS.md's 14.7 KB is auto-loaded by
**Codex**, not by Claude Code — it only enters a Claude session if the startup checklist makes the agent
`Read` it. This sharpens the §8 split: trim AGENTS.md primarily to cut Codex's always-on cost and the
checklist read, and stop the startup checklist from pulling assistant-comms into repo-work sessions.

Invented settings that do **not** exist (the design avoids them): `skillListingBudgetFraction`,
`maxSkillDescriptionChars`, `maxTokensPerResponse`, `includeGitInstructions`.

## 8. Cross-provider capability plan (Claude Code · Codex · OpenClaw lanes)

The tier model is **provider-neutral at the canonical layer, provider-specific at the adapter layer**.
The canonical layer (`docs/process/*.md` + the AGENTS.md kernel) is the single source for every tier and
pack; each provider implements the three jobs — *progressive disclosure*, *JIT session context*, and
*enforcement* — with its own native mechanism. Parity is asserted by `scripts/platform-parity-check.py`.

| Job | Claude Code | Codex | OpenClaw lanes |
|---|---|---|---|
| **Kernel (Tier 0)** | `ClaudeCode/CLAUDE.md` (auto-loaded) | `codex/instructions.md` + AGENTS.md kernel (auto-loaded) | `bootstrap.md` per lane |
| **Activity packs (Tier 1)** | skills (`.claude/skills/`) + path-scoped `.claude/rules/` | `.codex/prompts/` adapters + pointer-pattern doc reads | dispatch injects the pack into the lane prompt per task |
| **JIT session context (Tier 2)** | `context: fork` skills + dynamic `` !`cmd` `` injection | prompt adapters run the same neutral scripts on demand | task payload only (no standing context) |
| **Enforcement** | PreToolUse / Stop hooks (`hook-signoff-gate.sh`, file-guard) — hard block | `~/.codex/hooks.json` (hash-trusted) + self-enforced sign-off | arbiter/warden review gate on lane output |

Design rules that keep the providers in parity:
- **One canonical doc per protocol.** Adapters point at it; they never re-inline it. (Today doctrine +
  sign-off are inlined in *both* `CLAUDE.md` and `codex/instructions.md` — collapse to a shared kernel
  pointer once the canonical docs hold the full text.)
- **Same lifecycle verbs everywhere** (`start/next/checkpoint/end`) over the **same neutral scripts**
  (`free-work.py`, `agent-work.py`, `working-context-update.py`) — only the invocation surface differs.
- **Enforcement parity is explicit, not assumed.** Claude blocks via hooks; Codex has no Stop-hook so its
  sign-off is self-enforced (documented delta) — for any *new* on-demand protocol, add the Codex
  `hooks.json` equivalent where a hard guarantee is required, or record it as a known self-enforced delta.
- **Extend `platform-parity-check.py`** to assert every provider exposes the same pack set and points at
  the same canonical docs — the cross-PROVIDER analogue of the cross-MACHINE mirror check.
