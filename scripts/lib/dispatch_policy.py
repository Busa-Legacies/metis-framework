"""Default dispatch engine routing policy.

`scripts/dispatch` accepts explicit `--engine`, but most callers should not need
to remember the engine ladder. This module centralizes the conservative default:
local Qwen for bounded low-risk drafts/summaries, Codex/Sonnet for implementation
and review, and deep engines only when risk/judgment justifies it.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import os
import re
import time


WORK_TYPES = {
    "auto",
    "summary",
    "research",
    "draft",
    "implementation",
    "review",
    "security",
    "planning",
    "decomposition",
    "quality",
    "ops",
    "logs",
    "docs",
}
RISK_HINTS = {"auto", "low", "medium", "high", "critical"}
MUTATION_HINTS = {"auto", "read-only", "proposal-only", "mutates", "external", "live-runtime"}

LOCAL_ENGINE = "qwen-shallow"  # deep local default -> <<MACHINE_1_ID>> 35B. (Ant 2026-09-04 #5305 flipped this to Studio 35B; the placement invariant then DISABLED Studio's 35B — Studio now serves only the single-slot 235B via DEEP_RESEARCH_ENGINE, so the catch-all default belongs on the always-on <<MACHINE_1_ID>> 35B, not a dead :8081. Reconciled 2026-09-05, verified :8081 studio=000.)
DEEP_RESEARCH_ENGINE = "qwen235-studio"  # deep scout RESEARCH -> Studio 235B reasoning lane (Ant 2026-09-04). Batch/async (~15-17 tok/s sole-resident); falls open to <<MACHINE_1_ID>> (qwen-shallow) when dark. Studio's own 35B is DISABLED (one heavy model per box), so the degrade target is <<MACHINE_1_ID>>, not a Studio 35B.
# Light local engine (#1054): the remote 7B, hosted on <<MACHINE_2_ID>> since 2026-08-14 (was the M2 Air —
# see the ENGINE_MAP note in scripts/dispatch for the measured reason it moved). Only SHALLOW scout
# lookups route here; deep/substantive research stays on the more capable 35B (LOCAL_ENGINE). The
# dispatch wrapper fails this open to LOCAL_ENGINE when the light node is dark — which is the common
# case, since <<MACHINE_2_ID>> is the on-demand box.
LIGHT_LOCAL_ENGINE = "qwen7-air"
MINI_CODEX_ENGINE = "5.4m-shallow"
STANDARD_CODEX_ENGINE = "5.4-standard"
DEEP_CODEX_ENGINE = "5.5-deep"
SONNET_ENGINE = "sonnet-standard"

# Frontier tier (#865): the hardest work is *assigned* Claude Fable 5 — but Fable is
# opt-in and MUST NOT be a headless or subagent-fan-out default (~2x Opus burn + a
# separate ~50% weekly sub-cap; see model-effort-and-routing-standard.md). So the queue
# and relay ASSIGN Fable to a pinned main session; they never run it themselves. The
# default model everywhere else stays the current Opus (catalog 'deep' tier).
# Derived from the single-source catalog so these never go stale; fail-soft to current
# known-good ids. (Was hardcoded fable-5 / opus-4-8, both superseded 2026-09.)
try:
    from model_catalog import current as _mc_current
    FRONTIER_MODEL = _mc_current("frontier")
    DEFAULT_MODEL = _mc_current("deep")
except Exception:
    FRONTIER_MODEL = "claude-fable-5-1"
    DEFAULT_MODEL = "claude-opus-5-5"

HIGH_RISK_WORK = {"security", "ops"}
IMPLEMENTATION_WORK = {"implementation"}
REVIEW_WORK = {"review", "quality"}
LOCAL_WORK = {"summary", "research", "draft", "logs", "docs"}

IMPLEMENTATION_TERMS = re.compile(
    r"\b(implement|build|wire|refactor|fix|patch|edit|write tests?|apply|migrate|update code)\b",
    re.I,
)
REVIEW_TERMS = re.compile(r"\b(review|audit|qa|verify|test|check)\b", re.I)
SUMMARY_TERMS = re.compile(r"\b(summarize|summary|extract|draft|compose|log|notes?)\b", re.I)
# Deep-research markers (#1054): a scout brief with any of these — or one long enough to
# be a real investigation — is DEEP research and stays on the capable 35B; anything else
# is a shallow lookup that may offload to the M2 Air 7B (LIGHT_LOCAL_ENGINE).
DEEP_SCOUT_TERMS = re.compile(
    r"\b(deep|investigate|analy[sz]e|analysis|compare|contrast|synthesi[sz]e|comprehensive|"
    r"thorough|exhaustive|audit|survey|landscape|trade-?offs?|evaluate|assess|"
    r"cross-reference|end-to-end|root cause|architecture|design (?:doc|review)|"
    r"distill?(?:ation|ed|ing|s)?)\b",  # #5305: insight distillation reads as deep research -> 235B
    re.I,
)
SHALLOW_SCOUT_MAX_CHARS = 600  # briefs longer than this read as deep research → keep on 35B

# Deep-reasoning markers for the NON-scout hard-reasoning classes (#5305, plan Option A): a
# review/quality or planning brief that is a hard, latency-TOLERANT reasoning job — deep review,
# self-review scoring, premortem, synthesis, insight distillation — routes to the Studio 235B
# (Ant 2026-09-04). Reuses the deep-scout markers plus a few class-specific ones. Bulk/shallow
# review + coordination planning stay on the Codex shield so a fast QA pass isn't slowed by the
# ~20 tok/s 235B; security/critical never reach here (routed high above).
DEEP_REASONING_TERMS = re.compile(
    DEEP_SCOUT_TERMS.pattern
    + r"|\b(pre-?mortem|post-?mortem|retrospective|second-?order|failure modes?|"
      r"what could go wrong|rationale|premises?)\b",
    re.I,
)
SECURITY_TERMS = re.compile(r"\b(security|auth|credential|secret|token|oauth|prod|production)\b", re.I)
# Strong external verbs: an unambiguous external side-effect (git push, publish to
# blog, deploy, send/post to a service). These always signal external scope.
EXTERNAL_TERMS = re.compile(r"\b(push|publish|deploy|email|send|post|tweet)\b", re.I)
# Destructive verbs that are ALSO everyday in-code data-structure operations. They
# only mean an EXTERNAL delete when NOT sitting next to a code/data noun — a spec
# like "remove the project: line" or "entries are dropped on save" describes CODE
# behavior, not an external action. (#812: this false-positive routed the #801
# frontmatter fix to the paid gated path.)
_AMBIG_DESTRUCTIVE = re.compile(
    r"\b(?:delete[ds]?|deleting|remove[ds]?|removing|drop(?:s|ped|ping)?|strip(?:s|ped|ping)?)\b", re.I
)
_CODE_DATA_NOUN = re.compile(
    r"\b(?:lines?|keys?|entr(?:y|ies)|fields?|lists?|items?|elements?|values?|"
    r"propert(?:y|ies)|attributes?|dict|arrays?|map|frontmatter|blocks?|"
    r"char(?:acter)?s?|whitespace|comments?|newlines?|prefix|suffix|nodes?|tokens?)\b",
    re.I,
)
# CRITICAL = genuine money-movement / live-trading EXECUTION / risk-param change —
# the decision-doctrine "money / real funds / risk params" floor.
# Match ACTIONS, not topics. Bare topic-nouns (money, funds, trade, trading, order,
# deposit) were removed 2026-08-09: they matched ordinary prose — "in order to",
# "money is never logged" (the redaction rule an insight task was quoting), "trade-offs",
# "deposit" in a book buy-list — and false-flagged EVERY finance-mentioning task as
# critical. Since smith mutates, critical => approval-required => REFUSED, so the
# queue-runner's top-priority eligible tasks all refused every tick and the whole queue
# made zero progress ("lanes failing"). A genuine execution phrase still trips it; a
# task that merely names a financial topic does not. Regression: test_dispatch_risk_terms.py.
CRITICAL_TERMS = re.compile(
    r"\b(?:"
    r"withdraw|"                                                          # withdraw[al] (funds leave the account)
    r"live[- ]?flip|risk[- ]param(?:eter)?s|position\s+siz(?:e|ing)|"     # live trading toggle / risk knobs
    r"(?:real|client|investor|customer)\s+funds|"                         # touching real capital
    r"(?:move|transfer|wire|send|deposit|withdraw|convert)\s+(?:the\s+)?(?:money|funds|cash|capital|USD|USDC|USDT|BTC|ETH)|"
    r"(?:place|submit|cancel|modify|execute|route|fill|send)\s+(?:a\s+|an\s+|the\s+)?(?:(?:market|limit|stop|buy|sell)\s+)*order|"
    r"(?:execute|place|enter|open|close|live|paper|submit)\s+(?:a\s+|the\s+)?trade|"
    r"(?:live|paper)\s+trading|"
    r"(?:buy|sell|short|long)\s+(?:\$?\d+|shares?\b|[A-Z]{3,4}\b)"        # buy 100 / sell $500 / short BTC
    r")\b",
    re.I,
)


def _has_external_action(message: str) -> bool:
    """True only if the instruction asks for a genuine EXTERNAL side-effect.

    Strong external verbs (push/publish/deploy/email/send/post/tweet) always count.
    The destructive-but-ambiguous verbs (delete/remove/drop/strip) are demoted when a
    code/data noun sits within ~50 chars — that's a spec describing an in-memory edit,
    not an external action. Safety floors are untouched: SECURITY_TERMS and
    CRITICAL_TERMS are evaluated separately and never demoted."""
    if EXTERNAL_TERMS.search(message):
        return True
    for m in _AMBIG_DESTRUCTIVE.finditer(message):
        window = message[max(0, m.start() - 50) : m.end() + 50]
        if _CODE_DATA_NOUN.search(window):
            continue  # destructive verb next to a code/data noun → in-code op
        return True  # standalone destructive verb → real external delete
    return False

# Inlined reference-file content the dispatch prompt quotes for the lane to edit
# (queue-runner #329 TARGET FILE blocks). Risk/work-type/mutation must be inferred
# from the INSTRUCTION, never from the quoted source the instruction references — a
# 66k file with "in order to" in a comment, or "token" 70x as domain vocabulary,
# would otherwise force critical/security classification on a benign edit task.
_REF_BLOCK = re.compile(r"=== TARGET FILE:.*?=== END TARGET FILE ===", re.S)
_REF_MARKER_LINE = re.compile(r"^=== TARGET FILE:.*$", re.M)


def _strip_reference_blocks(message: str) -> str:
    """Remove inlined TARGET FILE reference content before keyword inference."""
    if not message or "=== TARGET FILE:" not in message:
        return message
    stripped = _REF_BLOCK.sub("", message)        # full (file-body) blocks
    stripped = _REF_MARKER_LINE.sub("", stripped)  # leftover bodyless markers
    return stripped


def is_shallow_scout(message: str) -> bool:
    """True when a scout brief is a SHALLOW lookup (offloadable to the M2 Air 7B).

    Conservative bias: only clearly-light work qualifies. A deep-research marker OR a
    long brief keeps it on the capable 35B (LOCAL_ENGINE). Reference-file blocks are
    stripped first so an inlined target file's length/vocabulary can't misclassify."""
    msg = _strip_reference_blocks(message or "").strip()
    if not msg:
        return True  # empty/degenerate brief is trivially shallow
    if DEEP_SCOUT_TERMS.search(msg):
        return False
    if len(msg) > SHALLOW_SCOUT_MAX_CHARS:
        return False
    return True


def is_deep_reasoning(message: str) -> bool:
    """True when a NON-scout review/quality/planning brief is a hard, latency-tolerant reasoning
    job (deep review, self-review scoring, premortem, synthesis, distillation) — the class routed
    to the Studio 235B (#5305). A deep-reasoning marker OR a long brief qualifies; reference-file
    blocks are stripped first so an inlined target's length/vocabulary can't misclassify."""
    msg = _strip_reference_blocks(message or "").strip()
    if not msg:
        return False
    if DEEP_REASONING_TERMS.search(msg):
        return True
    return len(msg) > SHALLOW_SCOUT_MAX_CHARS


@dataclass(frozen=True)
class DispatchPolicyDecision:
    engine: str
    work_type: str
    risk: str
    mutation: str
    reason: str
    requires_approval: bool
    proposal_only: bool


def infer_work_type(role: str, message: str, hint: str = "auto") -> str:
    if hint != "auto":
        return hint
    message = _strip_reference_blocks(message)
    if SECURITY_TERMS.search(message):
        return "security"
    if role == "smith" or IMPLEMENTATION_TERMS.search(message):
        return "implementation"
    if role in {"warden", "arbiter"} or REVIEW_TERMS.search(message):
        return "review" if role == "warden" else "quality"
    if role == "steward":
        return "decomposition"
    if SUMMARY_TERMS.search(message) or role in {"scout", "scribe"}:
        return "summary" if role == "scribe" else "research"
    return "planning" if role == "main" else "research"


def infer_risk(message: str, work_type: str, hint: str = "auto") -> str:
    if hint != "auto":
        return hint
    message = _strip_reference_blocks(message)
    if CRITICAL_TERMS.search(message):
        return "critical"
    if SECURITY_TERMS.search(message) or _has_external_action(message):
        return "high"
    if work_type in HIGH_RISK_WORK:
        return "high"
    if work_type in IMPLEMENTATION_WORK or work_type in {"planning", "decomposition", "quality"}:
        return "medium"
    return "low"


def infer_mutation(message: str, work_type: str, hint: str = "auto") -> str:
    if hint != "auto":
        return hint
    message = _strip_reference_blocks(message)
    if CRITICAL_TERMS.search(message):
        return "live-runtime"
    if _has_external_action(message):
        return "external"
    if work_type in IMPLEMENTATION_WORK or IMPLEMENTATION_TERMS.search(message):
        return "mutates"
    if work_type in REVIEW_WORK or work_type in LOCAL_WORK or work_type == "security":
        return "read-only"
    return "proposal-only"


def _claude_tier_allowed(override: bool | None) -> bool:
    """Anthropic (Claude) is the orchestrator's own usage pool. Unattended daemons
    set DISPATCH_NO_CLAUDE_TIER=1 so autonomous cycles never draw from it — the
    ladder substitutes the equivalent Codex tier instead (Codex is Ant's separate
    ChatGPT quota, with its own <10% fallback to free local). This encodes the
    CLAUDE.md doctrine ("route generation to free/Codex lanes, reserve Claude for
    interactive orchestration") as a mechanical ceiling, not a per-task judgment
    call. `override` (for tests) wins over the env when not None.

    Phase 3 (2026-07-28): the ceiling now ALSO closes on pace. When the weekly
    burn runs far enough ahead of the even day-by-day line that the pace router
    recommends leaving Claude entirely (`rung` = codex/local), dispatched work
    stops drawing from the Claude pool without waiting for a daemon to set the
    env var. A `partner-seat` recommendation does NOT close it here: Partner-seat is still a
    Claude-family account, and account selection is the supervisor's job (this
    function only answers "may this dispatch draw from the Claude pool at all").
    Fails OPEN — an unreadable window leaves the tier allowed."""
    if override is not None:
        return override
    if os.environ.get("DISPATCH_NO_CLAUDE_TIER", "").strip().lower() in {"1", "true", "yes"}:
        return False
    return not _pace_blocks_claude()


def _pace_blocks_claude() -> bool:
    """True only when the pace router affirmatively says to leave Claude."""
    try:
        from pace_router import pace_route  # lazy: keep dispatch_policy import-light
        route = pace_route()
    except Exception:
        return False  # fail open: never strand dispatch on a broken probe
    return bool(route.get("available")) and route.get("rung") in {"codex", "local"}


def _task_tier_tokens(task) -> tuple[str, list[str]]:
    """(tier-field, tag-tokens) lowercased, '#'-stripped — the opt-in surface for frontier."""
    if not isinstance(task, dict):
        return "", []
    tier = str(task.get("modelTier") or task.get("tier") or "").strip().lower()
    tags = task.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    return tier, [str(t).strip().lower().lstrip("#") for t in tags]


def _frontier_marker(task) -> str:
    """The raw frontier marker, ignoring justification: 'frontier-headless' | 'frontier' | ''."""
    tier, tags = _task_tier_tokens(task)
    if tier == "frontier-headless" or "frontier-headless" in tags:
        return "frontier-headless"
    if tier == "frontier" or "frontier" in tags:
        return "frontier"
    return ""


_FRONTIER_WHY_RE = re.compile(r"frontier-why:\s*(.+)", re.I)


def frontier_justification(task) -> str:
    """The author's stated reason this work measurably beats Opus 4.8 ``xhigh`` — the deterministic
    'belt' floor (#880). Read from a ``frontierWhy``/``frontierJustification`` field, or an inline
    ``frontier-why: ...`` in how/summary/why. Empty when absent: an UNJUSTIFIED frontier tag is not
    honored (fail-closed to standard) — this is what stops an automated sweep or a careless author
    from pointing routine work at the 2× Fable tier."""
    if not isinstance(task, dict):
        return ""
    # #4869: a NON-EMPTY string was trivially satisfiable (frontierWhy:"x" passed). Require a
    # minimum substance so a careless one-word tag can't reserve the 2x tier — the arbiter
    # 'beats-Opus?' pre-flight is still the real quality gate; this is just a floor under it.
    _MIN = 16
    for k in ("frontierWhy", "frontierJustification"):
        v = task.get(k)
        if isinstance(v, str) and len(v.strip()) >= _MIN:
            return v.strip()
    for k in ("how", "summary", "why"):
        v = task.get(k)
        if isinstance(v, str):
            m = _FRONTIER_WHY_RE.search(v)
            if m and len(m.group(1).strip()) >= _MIN:
                return m.group(1).strip()
    return ""


def is_frontier_headless(task) -> bool:
    """Opt-in for UNATTENDED Fable execution — a *distinct, stronger* marker than #frontier
    (``modelTier``/``tier`` == 'frontier-headless' or a '#frontier-headless' tag). Honored ONLY
    when the task ALSO carries a justification (see ``frontier_justification``)."""
    return _frontier_marker(task) == "frontier-headless" and bool(frontier_justification(task))


def is_frontier(task) -> bool:
    """Opt-in ONLY — Fable is never inferred from priority. True iff a task marks itself frontier
    (or the stronger frontier-headless) AND carries a justification; an unjustified tag is treated
    as standard so routine work can't reserve the 2× tier."""
    return bool(_frontier_marker(task)) and bool(frontier_justification(task))


# #4869 item 1: a spend gate must not trust a day-old number. claude_budget's ledger serves a
# trusted_7d reading aged up to 24h (_LEDGER_MAX_AGE_S) — fine for advisories, NOT for arming an
# unattended ~2x Fable burn. The headless gate enforces its own much lower ceiling on the age of
# the 7d reading (default 900s, matching the end-of-window drain's freshness bar in
# drain-accounts.json). Env-overridable for tuning, never raised above the ledger cap in spirit.
HEADLESS_FABLE_MAX_READING_AGE_S = int(os.environ.get("HEADLESS_FABLE_MAX_READING_AGE_S", "900"))


def headless_fable_budget_gate(budget=None, spend_account=None, now=None) -> dict:
    """The ONE fail-closed budget core every headless-Fable path consults (#4869 item 2).

    Callers: ``headless_fable_gate`` (queue-runner dispatch), ``run-task.py`` (armed
    frontier-headless registry keys in the poller context). ``fable_batch_run.py`` instead
    requires its DRIVER to declare a passed gate (FABLE_BATCH_CALLER_GATED) — its drivers
    gate via ``should_drain``/structural ceilings before ever spawning Fable.

    Blocks (fail-CLOSED, every uncertainty blocks) on any of:
      - weekly burn over pace (the absolute 7d band can read clear during an overrun);
      - band != 'clear' (caution / prefer_opus / unknown);
      - 7d reading untrusted (not server-derived — e.g. the local usage-snapshot estimate);
      - 7d reading older than HEADLESS_FABLE_MAX_READING_AGE_S, or of unknowable age
        (#4869 item 1: the budget ledger serves readings up to 24h old; a spend gate
        must not arm ~2x unattended burn on a day-old number);
      - `spend_account` given but that account does not own this machine's telemetry
        (#4869 finding 2 wrong-meter guard, via account_budget.probe_account_budget:
        the local reading meters the PRIMARY pool — it proves nothing about the ops/
        Example pool a spawn would actually bill).

    ``spend_account``: {"account": str, "telemetry": "local"|"none"} for the pool the
    spawn will actually bill; None skips the wrong-meter check (caller bills the
    ambient/primary pool). Returns {"allowed", "band", "reason", "advisory"?, "account"?}.
    """
    if _pace_blocks_claude():
        return {"allowed": False, "band": "over-pace",
                "reason": ("weekly burn is over pace — headless Fable (~2x Opus) blocked; "
                           "leaving for a main session")}
    try:
        from claude_budget import fable_routing_advisory, claude_budget_left
        b = budget if budget is not None else claude_budget_left()
        adv = fable_routing_advisory(b)
    except Exception:
        b = budget if isinstance(budget, dict) else {}
        adv = {"verdict": "unknown", "advice": "fable advisory unavailable"}
    band = adv.get("verdict")
    trusted = bool(adv.get("trusted_7d"))
    if band != "clear":
        return {"allowed": False, "band": band, "advisory": adv,
                "reason": f"band={band}: {adv.get('advice', '')} — leaving for a main session"}
    if not trusted:
        # Contract: claude_budget gates on 7d only when trusted_7d is set. An untrusted 'clear'
        # (the local usage-snapshot estimate has read ~clear while the server was ~82% used)
        # must NOT auto-burn Fable at ~2x.
        return {"allowed": False, "band": band, "advisory": adv,
                "reason": ("band=clear but 7d reading is untrusted/stale — fail-closed, "
                           "leaving for a main session")}
    # Freshness floor (#4869 item 1): derive the reading's age from its source string
    # (statusline-metrics = 0s; budget-ledger/fleet-signal embed "(<N>s old)").
    try:
        from account_budget import _seven_day_reading_age
        age = _seven_day_reading_age(adv.get("source") or "")
    except Exception:
        age = None
    if age is None or age > HEADLESS_FABLE_MAX_READING_AGE_S:
        shown = "unknown" if age is None else f"{int(age)}s"
        return {"allowed": False, "band": band, "advisory": adv,
                "reason": (f"trusted 7d reading age {shown} exceeds the headless spend-gate "
                           f"max ({HEADLESS_FABLE_MAX_READING_AGE_S}s) — a stale ledger must "
                           f"not arm ~2x unattended burn; fail-closed, leaving for a main session")}
    if spend_account is not None:
        # Wrong-meter guard (#4869 finding 2): reuse the drain's per-account mechanism.
        try:
            from account_budget import probe_account_budget
            probe = probe_account_budget(spend_account,
                                         time.time() if now is None else now,
                                         reader=lambda: b)
        except Exception as e:
            return {"allowed": False, "band": band, "advisory": adv,
                    "reason": f"spend-account budget probe failed ({e}) — fail-closed"}
        if not probe.get("trusted_7d") or "reading_ts" not in probe:
            return {"allowed": False, "band": band, "advisory": adv,
                    "account": probe.get("account"),
                    "reason": (f"account '{probe.get('account')}' does not own this machine's "
                               f"telemetry — the clear reading meters a DIFFERENT pool "
                               f"(wrong-meter, #4869 finding 2); fail-closed, leaving for a "
                               f"main session")}
    return {"allowed": True, "band": band, "advisory": adv,
            "reason": "weekly window clear (trusted, fresh 7d) — headless Fable allowed"}


def headless_fable_gate(task=None, *, budget=None, headless: bool | None = None,
                        spend_account=None) -> dict:
    """ENFORCED gate (not advisory) for an UNATTENDED Fable run. Two deterministic floors before the
    budget band: (1) the ``#frontier-headless`` marker, (2) a non-empty ``frontier_justification``
    (the belt). Then the weekly-window band, which **fails CLOSED**: only 'clear' (7d ≳ 60%) allows;
    'caution'/'prefer_opus'/'unknown' all block. (The arbiter 'beats-Opus?' pre-flight — the
    suspenders — runs in the queue-runner just before launch.) Past the free ~half-of-weekly Fable
    allotment, spend continues as PAID overage (not a hard block; Claude Team 2026-07-21) — so
    unattended spend past it is real money. We can't read the Fable-specific meter, so we gate on
    the shared 7d proxy and fail closed rather than auto-burn it without confirmed headroom.
    #4869: the band/trust/pace judgment plus the reading-freshness floor and the wrong-meter
    ``spend_account`` check all live in ``headless_fable_budget_gate`` — pass ``spend_account``
    with the pool the spawn will actually bill (the queue-runner does)."""
    if headless is None:
        eligible_marker = _frontier_marker(task) == "frontier-headless"
    else:
        eligible_marker = bool(headless)
    if not eligible_marker:
        return {"allowed": False, "eligible": False, "band": None, "model": DEFAULT_MODEL,
                "route": "main-session", "reason": "not tagged #frontier-headless"}
    if not frontier_justification(task):
        return {"allowed": False, "eligible": False, "band": None, "model": DEFAULT_MODEL,
                "route": "main-session",
                "reason": ("no frontierWhy justification — a #frontier-headless task must state "
                           "which criterion makes it beat Opus 4.8 xhigh")}
    # All budget judgment lives in the ONE shared core (#4869 item 2) — pace, band, trust,
    # reading freshness, and the wrong-meter spend-account check. Nothing here may allow
    # what the core blocks.
    core = headless_fable_budget_gate(budget=budget, spend_account=spend_account)
    allowed = bool(core.get("allowed"))
    out = {"allowed": allowed, "eligible": True, "band": core.get("band"),
           "reason": core.get("reason"),
           "route": "headless" if allowed else "main-session",
           "model": FRONTIER_MODEL if allowed else DEFAULT_MODEL}
    if "advisory" in core:
        out["advisory"] = core["advisory"]
    if "account" in core:
        out["account"] = core["account"]
    return out


def frontier_assignment(task=None, *, frontier: bool | None = None, budget=None) -> dict:
    """The single 'hardest work -> Fable' rule shared by the queue, relay, and routing docs.

    ADVISORY ONLY (same contract as ``fable_routing_advisory``): it recommends a model
    assignment; it never gates and never auto-switches a running model. For opt-in frontier
    work it assigns Claude Fable 5 at ``xhigh`` but marks ``headless_ok=False`` /
    ``route='main-session'`` — the convention forbids Fable as a headless or subagent-fan-out
    default, so the queue-runner and relay must hand frontier work to a pinned main session
    rather than burn Fable (or a free lane) themselves. When the shared 7d window is thin the
    advisory downgrades the assignment to Opus 4.8 ``xhigh`` (``prefer_opus``), so a drawn-down
    week can't exhaust the separate Fable weekly sub-cap."""
    fr = frontier if frontier is not None else is_frontier(task)
    if not fr:
        return {"tier": "standard", "model": DEFAULT_MODEL, "effort": None,
                "headless_ok": True, "route": "lane-or-main", "advisory_only": True}
    try:
        from claude_budget import fable_routing_advisory  # lazy: keep dispatch_policy import-light
        adv = fable_routing_advisory(budget)
    except Exception:
        adv = {"verdict": "unknown",
               "advice": "fable advisory unavailable — route as intended", "advisory_only": True}
    model = DEFAULT_MODEL if adv.get("verdict") == "prefer_opus" else FRONTIER_MODEL
    return {"tier": "frontier", "model": model, "effort": "xhigh",
            "headless_ok": False, "route": "main-session", "advisory": adv,
            "advisory_only": True,
            "note": ("frontier work: assign to a pinned main session — never headless/fan-out. "
                     + adv.get("advice", ""))}


def resolve_default_engine(
    role: str,
    message: str,
    *,
    work_type: str = "auto",
    risk: str = "auto",
    mutation: str = "auto",
    local_failures: int = 0,
    allow_claude_tier: bool | None = None,
) -> DispatchPolicyDecision:
    """Resolve a default engine and guard metadata for a dispatch request."""
    wt = infer_work_type(role, message, work_type)
    rk = infer_risk(message, wt, risk)
    mut = infer_mutation(message, wt, mutation)
    claude_ok = _claude_tier_allowed(allow_claude_tier)

    if local_failures >= 2 and rk in {"low", "medium"}:
        return DispatchPolicyDecision(
            engine=MINI_CODEX_ENGINE,
            work_type=wt,
            risk=rk,
            mutation=mut,
            reason=f"escalated after {local_failures} local failures",
            requires_approval=False,
            proposal_only=True,
        )

    if rk == "critical":
        # Approval gates EXECUTION. A read-only route (warden/arbiter reviewing
        # trading code) can't act on what it reads — keyword-inferred risk from
        # reviewed content must not block the quality gates themselves (the
        # 2026-06-11 incident: every warden/arbiter pass REFUSED, gates skipped).
        return DispatchPolicyDecision(
            engine=DEEP_CODEX_ENGINE,
            work_type=wt,
            risk=rk,
            mutation=mut,
            reason="critical risk requires highest-judgment route",
            requires_approval=(mut != "read-only"),
            proposal_only=True,
        )

    if rk == "high" or mut in {"external", "live-runtime"}:
        # A route that can EXECUTE (mutate/external/live-runtime) is the only one that
        # genuinely needs the paid high-judgment engine + human gate. A high-risk route
        # that is read-only/proposal-only can only DRAFT — it acts on nothing.
        executing = mut in {"mutates", "external", "live-runtime"}
        if wt == "security":
            # Security always needs the highest-judgment engine, even proposal-only.
            engine = DEEP_CODEX_ENGINE
            reason = "high-risk security scope needs the highest-judgment route"
        elif not executing and local_failures < 2:
            # #811: a high-risk READ-ONLY / PROPOSAL-ONLY route drafts only — it can't
            # execute anything (which is exactly why it needs no approval). Route it to
            # the FREE local MLX instead of a paid frontier engine, so a risk-flagged
            # draft (e.g. a fix a keyword flagged "data loss") doesn't hard-fail when
            # the paid provider is down (the Anthropic "extra usage" rejection) or
            # silently burn quota. The local_failures>=2 net still escalates to Codex
            # when local genuinely can't do it.
            engine = LOCAL_ENGINE
            reason = "high-risk proposal-only draft routes to free local MLX (no execution capability; escalates to Codex on repeated local failure)"
        else:
            # Executing high-risk, OR proven repeated local failure → paid high-judgment
            # route. Prefer STANDARD Codex (5.4) over Sonnet even when Claude is allowed:
            # the Claude weekly pool is the constrained resource (2026-07-21 burn audit —
            # Claude maxing weekly, Codex idle ~11d), and these routes are proposal-only +
            # human-gated, so Codex-grade judgment behind the arbiter/approval gate is
            # sufficient. DEEP Codex (5.5) stays RESERVED for security + critical. Falls to
            # free local Qwen only if Codex is itself capped (dispatch codex guard).
            engine = STANDARD_CODEX_ENGINE
            reason = "high-risk executing scope routes to Codex off the constrained Claude pool (proposal-only + human-gated; 5.5-deep reserved for security/critical)"
        return DispatchPolicyDecision(
            engine=engine,
            work_type=wt,
            risk=rk,
            mutation=mut,
            reason=reason,
            # The human gate applies only to routes that can execute.
            requires_approval=executing,
            proposal_only=True,
        )

    if wt in IMPLEMENTATION_WORK or mut == "mutates":
        # When Claude is barred (autonomous daemon), bounded low/medium implementation
        # defaults to FREE local Qwen instead of paid Codex — the `local_failures >= 2`
        # escalation above is the quality net (2 local misses → Codex). Paid Codex is
        # reserved for work local can't do OR external/live-runtime scope. When Claude
        # IS allowed (interactive/attended), keep the Codex-grade code route unchanged.
        if not claude_ok and rk in {"low", "medium"} and mut not in {"external", "live-runtime"}:
            return DispatchPolicyDecision(
                engine=LOCAL_ENGINE,
                work_type=wt,
                risk=max(rk, "medium", key=["low", "medium", "high", "critical"].index),
                mutation=mut,
                reason="autonomous implementation defaults to free local Qwen (no-Claude ceiling); escalates to Codex on repeated local failure",
                requires_approval=False,
                proposal_only=True,
            )
        return DispatchPolicyDecision(
            engine=STANDARD_CODEX_ENGINE,
            work_type=wt,
            risk=max(rk, "medium", key=["low", "medium", "high", "critical"].index),
            mutation=mut,
            reason="implementation or mutation needs Codex-grade code route",
            requires_approval=False,
            proposal_only=True,
        )

    if wt in REVIEW_WORK:
        # Deep, latency-tolerant review/quality reasoning — deep review, self-review scoring,
        # audit synthesis — routes to the Studio 235B (#5305, plan Option A). Only when the brief
        # is a DEEP reasoning job AND read-only/proposal-only (it reaches here only at low/medium
        # risk — security/critical routed high above; local_failures>=2 escalated to Codex above).
        # A different model family from the code author is still a feature (Qwen vs Codex/Claude),
        # and the ~15-17 tok/s cost is acceptable for a deep pass. Fails open to <<MACHINE_1_ID>> when dark.
        if is_deep_reasoning(message) and mut in {"read-only", "proposal-only"}:
            return DispatchPolicyDecision(
                engine=DEEP_RESEARCH_ENGINE,
                work_type=wt,
                risk=rk,
                mutation=mut,
                reason="deep review/quality reasoning routes to the Studio 235B (latency-tolerant; falls open to <<MACHINE_1_ID>> when dark)",
                requires_approval=False,
                proposal_only=True,
            )
        # Bulk/shallow review → STANDARD Codex (5.4) for warden, mini for others, off the
        # constrained Claude pool (2026-07-21 burn audit). Read-only/proposal-only, and a
        # cross-family reviewer is a feature — Codex-grade judgment suffices for a fast pass
        # while Claude weekly stays scarce.
        shield_engine = STANDARD_CODEX_ENGINE
        return DispatchPolicyDecision(
            engine=shield_engine if role == "warden" else MINI_CODEX_ENGINE,
            work_type=wt,
            risk=rk,
            mutation=mut,
            reason="review/quality route uses Codex judgment off the constrained Claude pool",
            requires_approval=False,
            proposal_only=True,
        )

    if wt == "planning":
        # Deep planning reasoning — premortems, second-order/failure-mode analysis, architecture
        # or design reasoning — routes to the Studio 235B (#5305, plan Option A). Only for a DEEP,
        # read-only/proposal-only brief; shallow coordination planning keeps the Codex route. A
        # critical planning brief (live-trading risk params etc.) never reaches here — routed to
        # 5.5-deep with an approval gate above. Fails open to <<MACHINE_1_ID>> (qwen-shallow) when dark.
        if is_deep_reasoning(message) and mut in {"read-only", "proposal-only"}:
            return DispatchPolicyDecision(
                engine=DEEP_RESEARCH_ENGINE,
                work_type=wt,
                risk=rk,
                mutation=mut,
                reason="deep planning/premortem reasoning routes to the Studio 235B (falls open to <<MACHINE_1_ID>> when dark)",
                requires_approval=False,
                proposal_only=True,
            )
        return DispatchPolicyDecision(
            engine=STANDARD_CODEX_ENGINE,
            work_type=wt,
            risk=rk,
            mutation=mut,
            reason="planning/coordination needs non-local judgment",
            requires_approval=False,
            proposal_only=True,
        )

    if role == "scout" and wt == "research" and is_shallow_scout(message):
        # Depth split (#1054): a shallow scout lookup offloads to the light 7B tier, taking
        # that traffic off <<MACHINE_1_ID>>. Deep/substantive research (DEEP_SCOUT_TERMS or a long
        # brief) falls through to the capable 35B below. The dispatch wrapper fails this open
        # to the 35B when the light host is dark, so it never wedges a lookup.
        # NOTE: the engine id `qwen7-air` is historical. The Air's light-lane MLX role was
        # RETIRED in #1497 (2026-08-14) and nothing routes inference there; the light tier now
        # serves from <<MACHINE_2_ID>> (<<MACHINE_2_ID>>-mlx, Qwen2.5-7B on :8081, kept resident by <<MACHINE_2_ID>>'s
        # mlx-keepwarm). VERIFIED live 2026-09-05: a warm qwen7-air scout dispatch routes to
        # <<MACHINE_2_ID>> and returns (~73s on a full scout preamble — the 7B is genuinely slower than
        # <<MACHINE_1_ID>>'s 35B, so keep ONLY genuinely light/short lookups here); a dark/cold <<MACHINE_2_ID>>
        # fails open to <<MACHINE_1_ID>>'s 35B. Ant's posture (2026-09-05): on-demand — route light work
        # here WHEN IT'S ON, never force it always-on. Historically 0 of 91 calls (#4517) because
        # the shallow-scout gate rarely fires, not because the route was broken.
        return DispatchPolicyDecision(
            engine=LIGHT_LOCAL_ENGINE,
            work_type=wt,
            risk=rk,
            mutation=mut,
            reason="shallow scout lookup offloads to the light 7B tier (deep research routes to the Studio 235B; fails open to the 35B when the light host is dark)",
            requires_approval=False,
            proposal_only=True,
        )

    if role == "scout" and wt == "research":
        # Deep research fell past the shallow check -> the Studio 235B reasoning lane
        # (Ant 2026-09-04, #5305: "route deep research to the 235b"). Big-model reasoning
        # for substantive investigations; batch/async speed (~11-20 tok/s). The dispatch
        # wrapper fails this open to <<MACHINE_1_ID>> (qwen-shallow) when the Studio is dark.
        return DispatchPolicyDecision(
            engine=DEEP_RESEARCH_ENGINE,
            work_type=wt,
            risk=rk,
            mutation=mut,
            reason="deep scout research routes to the Studio 235B reasoning lane (falls open to <<MACHINE_1_ID>> when dark)",
            requires_approval=False,
            proposal_only=True,
        )

    return DispatchPolicyDecision(
        engine=LOCAL_ENGINE,
        work_type=wt,
        risk=rk,
        mutation=mut,
        reason="bounded low-risk draft/summary/research routes to the <<MACHINE_1_ID>> 35B (qwen-shallow)",
        requires_approval=False,
        proposal_only=True,
    )


# ── Eval→routing advisory (#3268) ─────────────────────────────────────────────
# Closes the measure→learn→steer loop: the eval-corpus scores every dispatched output
# (curator accept/reject); this lets a MEASURED per-(role, engine) correctness rate bias the
# default engine. Deliberately ADDITIVE + opt-in — it wraps resolve_default_engine's result and
# never touches its control flow, so with the flag off behavior is byte-identical. It only ever
# escalates a LOCAL low/medium route one rung when local MEASURABLY fails that role (enough
# volume + poor accept-rate); it never downgrades, never touches the high/critical/security
# floors, and never acts on thin data. A routing regression is worse than a missed optimization.
EVAL_ROUTING_ENV = "METIS_EVAL_ROUTING"

# Where the advisory escalates TO. Deliberately full Codex, not mini: on the curated corpus
# 5.4m-shallow is measurably WORSE than the local engine it would replace (smith, described-
# instead-of-implemented: 33% vs 27%), while 5.4-standard is the only engine measurably better
# (6% over n=2174). That comparison is conservative — 5.4-standard already carries 67% of
# high-risk smith work against local's 16% and still fails four times less often.
# Ant's call 2026-08-21, made as an explicit cost trade. Kept separate from MINI_CODEX_ENGINE
# so the local-failure net and the warden shield path are unaffected.
EVAL_ADVISORY_TARGET = STANDARD_CODEX_ENGINE


def eval_routing_enabled() -> bool:
    return str(os.environ.get(EVAL_ROUTING_ENV, "")).strip().lower() in {"1", "true", "yes", "on"}


def apply_correctness_advisory(decision: "DispatchPolicyDecision", role: str,
                               *, enabled: bool | None = None, _ec=None) -> "DispatchPolicyDecision":
    """Bias a decision by measured eval correctness. Returns the decision unchanged unless the
    flag is on AND the route is a LOCAL low/medium draft that local measurably fails — in which
    case it escalates one rung to mini-Codex (same target as the local-failure net) with an
    explaining reason. Safe on any decision; never raises (a corpus error just no-ops).
    `_ec` injects the correctness module for tests."""
    if enabled is None:
        enabled = eval_routing_enabled()
    if not enabled:
        return decision
    # Floors are sacrosanct: only advise on the reversible low/medium LOCAL draft path.
    if decision.risk not in {"low", "medium"} or decision.engine != LOCAL_ENGINE:
        return decision
    ec = _ec
    if ec is None:
        try:
            from lib import engine_correctness as ec
        except Exception:
            try:
                import engine_correctness as ec  # when scripts/lib is on the path directly
            except Exception:
                return decision
    def _measured(engine):
        """(rate, n, label) on the SAME metric should_avoid judges by — compliance where the
        corpus supports it, the historical accept-rate otherwise. getattr keeps injected test
        doubles that only implement `correctness` working."""
        fn = getattr(ec, "compliance_rate", None)
        if fn is not None:
            r, k = fn(role, engine)
            if r is not None:
                return r, k, "applyable output"
        r, k = ec.correctness(role, engine)
        return r, k, "accept"

    try:
        if not ec.should_avoid(role, LOCAL_ENGINE):
            return decision
        rate, n, metric = _measured(LOCAL_ENGINE)
        # Never escalate INTO an engine the corpus scores no better than the one we are
        # leaving. should_avoid() is deliberately silent on thin data, so without this guard
        # the advisory can "escalate" into the WORST-measured engine in the table purely
        # because too few rows exist for the rule to object — absence of evidence read as
        # evidence of adequacy. Measured 2026-08-21: smith/5.4m-shallow returns applyable
        # work only 67% of the time against local's 73%, and escaped should_avoid purely on
        # thin volume. A routing regression is worse than a missed optimization — that is
        # this module's whole premise. Compared on the same metric for both sides.
        target_rate, _target_n, _ = _measured(EVAL_ADVISORY_TARGET)
        if rate is not None and target_rate is not None and target_rate <= rate:
            return decision
    except Exception:
        return decision
    pct = f"{rate:.0%}" if rate is not None else "?"
    return replace(
        decision,
        engine=EVAL_ADVISORY_TARGET,
        reason=(decision.reason
                + f" · eval-advisory: local measurably fails {role} ({pct} {metric} over {n}), "
                  f"escalated one rung"),
    )


def resolve_engine_with_correctness(role: str, message: str, **kwargs) -> "DispatchPolicyDecision":
    """resolve_default_engine + the eval-correctness advisory. Drop-in for callers that want the
    self-learning route; identical to resolve_default_engine when the flag is off."""
    decision = resolve_default_engine(role, message, **kwargs)
    return apply_correctness_advisory(decision, role)
