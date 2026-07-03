"""Default dispatch engine routing policy.

`scripts/dispatch` accepts explicit `--engine`, but most callers should not need
to remember the engine ladder. This module centralizes the conservative default:
local Qwen for bounded low-risk drafts/summaries, Codex/Sonnet for implementation
and review, and deep engines only when risk/judgment justifies it.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
import re


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

LOCAL_ENGINE = "qwen-shallow"
MINI_CODEX_ENGINE = "5.4m-shallow"
STANDARD_CODEX_ENGINE = "5.4-standard"
DEEP_CODEX_ENGINE = "5.5-deep"
SONNET_ENGINE = "sonnet-standard"

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
SECURITY_TERMS = re.compile(r"\b(security|auth|credential|secret|token|oauth|prod|production)\b", re.I)
EXTERNAL_TERMS = re.compile(r"\b(push|publish|deploy|email|send|post|tweet|delete|remove|drop)\b", re.I)
CRITICAL_TERMS = re.compile(r"\b(money|funds|trade|trading|order|withdraw|deposit|live flip|risk params)\b", re.I)

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
    if SECURITY_TERMS.search(message) or EXTERNAL_TERMS.search(message):
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
    if EXTERNAL_TERMS.search(message):
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
    call. `override` (for tests) wins over the env when not None."""
    if override is not None:
        return override
    return os.environ.get("DISPATCH_NO_CLAUDE_TIER", "").strip().lower() not in {"1", "true", "yes"}


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
        # No-Claude ceiling: high-risk non-security normally goes to Sonnet; when
        # Claude is barred (unattended daemon), use deep Codex — same high-judgment
        # intent, different (ChatGPT) quota.
        high_engine = SONNET_ENGINE if claude_ok else DEEP_CODEX_ENGINE
        return DispatchPolicyDecision(
            engine=DEEP_CODEX_ENGINE if wt == "security" else high_engine,
            work_type=wt,
            risk=rk,
            mutation=mut,
            reason="high-risk/security/external scope is not local-model default"
            + ("" if claude_ok else " (no-Claude ceiling → Codex)"),
            # Engine still escalates on inferred risk; the human gate applies
            # only to routes that can execute (mutate/external/live-runtime).
            requires_approval=(mut in {"mutates", "external", "live-runtime"}),
            proposal_only=True,
        )

    if wt in IMPLEMENTATION_WORK or mut == "mutates":
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
        # warden review prefers Sonnet's judgment; under the no-Claude ceiling it
        # drops to standard Codex (5.4) — still stronger than a local draft.
        shield_engine = SONNET_ENGINE if claude_ok else STANDARD_CODEX_ENGINE
        return DispatchPolicyDecision(
            engine=shield_engine if role == "warden" else MINI_CODEX_ENGINE,
            work_type=wt,
            risk=rk,
            mutation=mut,
            reason="review/quality route uses stronger judgment than local draft"
            + ("" if claude_ok or role != "warden" else " (no-Claude ceiling → Codex)"),
            requires_approval=False,
            proposal_only=True,
        )

    if wt == "planning":
        return DispatchPolicyDecision(
            engine=STANDARD_CODEX_ENGINE,
            work_type=wt,
            risk=rk,
            mutation=mut,
            reason="planning/coordination needs non-local judgment",
            requires_approval=False,
            proposal_only=True,
        )

    return DispatchPolicyDecision(
        engine=LOCAL_ENGINE,
        work_type=wt,
        risk=rk,
        mutation=mut,
        reason="bounded low-risk draft/summary/research can use local Qwen",
        requires_approval=False,
        proposal_only=True,
    )
