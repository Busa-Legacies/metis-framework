"""Mission packet contract for dispatched lanes.

Local lanes are useful when the work is bounded. This module turns loose
dispatch text into a compact, explicit packet: role contract, task, scope,
constraints, expected artifact, and verification expectation. Callers should
render this packet before passing it through lane_framing.frame_message().
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, asdict
from typing import Any


ROLE_CONTRACTS: dict[str, dict[str, Any]] = {
    "smith": {
        "purpose": "draft code, configs, tests, or docs as text for an applier",
        "allowed_behavior": [
            "Return proposed file content or patch text only.",
            "Do not claim files were edited, saved, tested, or committed.",
            "Treat implementation output as a proposal until Codex/Claude applies and verifies it.",
        ],
        "must_not_do": ["call tools", "mutate files", "run shell commands", "state that work was applied"],
        "expected_artifact": "path plus fenced code block, or a clearly labeled patch proposal",
        "default_risk": "medium",
        "proposal_only": True,
    },
    "scout": {
        "purpose": "research, summarize, compare approaches, and extract patterns",
        "allowed_behavior": [
            "Answer only the requested question.",
            "Label unsupported claims and prefer provided context over prior session memory.",
            "Return concise recommendations with assumptions when evidence is incomplete.",
        ],
        "must_not_do": ["mutate files", "invent citations", "reuse stale persona or output format"],
        "expected_artifact": "brief report, bullet summary, or decision-relevant recommendation",
        "default_risk": "low",
        "proposal_only": True,
    },
    "warden": {
        "purpose": "review code, QA changes, and identify risks",
        "allowed_behavior": [
            "Return findings first, with file/line references when available.",
            "Say clearly when no issues are found.",
            "Separate confirmed issues from assumptions.",
        ],
        "must_not_do": ["mutate files", "approve without evidence", "review files not provided"],
        "expected_artifact": "review findings or explicit no-findings note",
        "default_risk": "low",
        "proposal_only": True,
    },
    "scribe": {
        "purpose": "compose exact artifact prose for logs, memory, or handoff text",
        "allowed_behavior": [
            "Output only the requested artifact body.",
            "Preserve the requested format exactly.",
        ],
        "must_not_do": ["add preamble", "add closing remarks", "change the requested format"],
        "expected_artifact": "artifact body only",
        "default_risk": "medium",
        "proposal_only": False,
    },
    "steward": {
        "purpose": "decompose broad work into ordered queue-ready tasks",
        "allowed_behavior": [
            "Return bounded tasks with dependencies and verification expectations.",
            "Keep each task independently claimable.",
        ],
        "must_not_do": ["mutate files", "mark tasks created", "skip verification fields"],
        "expected_artifact": "ordered task breakdown",
        "default_risk": "medium",
        "proposal_only": True,
    },
    "arbiter": {
        "purpose": "quality gate an artifact with approve / iterate / reject",
        "allowed_behavior": [
            "Return a verdict and concise justification.",
            "Reject outputs that claim unverified application or lack the expected artifact.",
        ],
        "must_not_do": ["mutate files", "rewrite the artifact", "ignore missing evidence"],
        "expected_artifact": "approve / iterate / reject verdict",
        "default_risk": "medium",
        "proposal_only": True,
    },
    "main": {
        "purpose": "strategy and coordination for unclear or multi-step work",
        "allowed_behavior": ["Clarify plan, risks, and next action."],
        "must_not_do": ["take external action without approval"],
        "expected_artifact": "strategy or coordination response",
        "default_risk": "medium",
        "proposal_only": True,
    },
}


HIGH_RISK_TERMS = re.compile(
    r"\b(push|publish|deploy|email|send|post|tweet|delete|remove|drop|credential|secret|auth|token|prod|production)\b",
    re.I,
)
CRITICAL_TERMS = re.compile(r"\b(money|funds|trade|trading|order|withdraw|deposit|live flip|risk params)\b", re.I)
FILE_PATTERN = re.compile(r"(?<![\w./-])(?:[\w.-]+/)+[\w.-]+(?:\.[A-Za-z0-9]+)?")


@dataclass
class MissionPacket:
    schema: int
    role: str
    task: str
    role_contract: dict[str, Any]
    route: dict[str, Any]
    scope: dict[str, Any]
    risk: dict[str, Any]
    context: dict[str, Any]
    constraints: list[str]
    expected_output: str
    verification: str


def infer_risk(role: str, message: str) -> tuple[str, str]:
    if CRITICAL_TERMS.search(message):
        return "critical", "message references money/trading/live-risk terms"
    if HIGH_RISK_TERMS.search(message):
        return "high", "message references external, destructive, credential, or production actions"
    contract = ROLE_CONTRACTS.get(role, ROLE_CONTRACTS["main"])
    return contract["default_risk"], "role default"


def infer_scope(message: str) -> dict[str, Any]:
    files = sorted(set(FILE_PATTERN.findall(message)))
    return {
        "files": files,
        "dirs": sorted({f.rsplit("/", 1)[0] for f in files if "/" in f}),
        "readOnly": True,
        "source": "inferred-from-message" if files else "unconstrained",
    }


def build_mission_packet(
    role: str,
    message: str,
    *,
    engine: str | None = None,
    model: str | None = None,
    thinking: str | None = None,
    runtime: str | None = None,
    route_reason: str | None = None,
    work_type: str | None = None,
    mutation: str | None = None,
    requires_approval: bool | None = None,
    risk_tier: str | None = None,
    risk_reason: str | None = None,
    context_snippets: list[str] | None = None,
    verification: str | None = None,
) -> MissionPacket:
    contract = ROLE_CONTRACTS.get(role, ROLE_CONTRACTS["main"])
    inferred_risk_tier, inferred_risk_reason = infer_risk(role, message)
    risk_tier = risk_tier or inferred_risk_tier
    risk_reason = risk_reason or inferred_risk_reason
    expected = contract["expected_artifact"]
    if verification is None:
        verification = "Caller must verify before task completion; local lane output is not completion evidence by itself."
    constraints = [
        "Use only the task and context in this packet unless explicitly told otherwise.",
        "If required context is missing, state the gap instead of inventing details.",
    ]
    constraints.extend(contract["must_not_do"])
    return MissionPacket(
        schema=1,
        role=role,
        task=message.strip(),
        role_contract=contract,
        route={
            "engine": engine,
            "model": model,
            "thinking": thinking,
            "runtime": runtime,
            "reason": route_reason or ("explicit engine" if engine else "lane default"),
            "workType": work_type,
            "mutation": mutation,
            "requiresApproval": bool(requires_approval),
            "proposalOnly": bool(contract.get("proposal_only", True)),
        },
        scope=infer_scope(message),
        risk={"tier": risk_tier, "reason": risk_reason},
        context={
            "snippets": context_snippets or [],
            "note": "Bounded packet context; no broad memory dump.",
        },
        constraints=constraints,
        expected_output=expected,
        verification=verification,
    )


def packet_to_dict(packet: MissionPacket) -> dict[str, Any]:
    return asdict(packet)


def render_mission_packet(packet: MissionPacket) -> str:
    data = packet_to_dict(packet)
    # JSON is deliberate: it gives small local models a stable schema and makes
    # downstream logs/search easier without asking them to parse prose headings.
    return "MISSION_PACKET_JSON\n" + json.dumps(data, indent=2, ensure_ascii=False)
