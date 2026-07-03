"""Project progress / goal roll-up / attention scoring (#221).

Pure functions over the projects.json schema. See docs/process/project-progress-contract.md.
Honesty floor: a milestone counts as fully done ONLY when status == "done"; non-done
milestones contribute their `fill` (partial credit) and can never read as complete.
"""
from __future__ import annotations
from datetime import date, datetime

PRIORITY_W = {"P1": 3, "P2": 2, "P3": 1}


def _parse_day(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except Exception:
        return None


def project_progress(proj: dict) -> tuple[float | None, int, int]:
    """Return (progress 0..1 | None, shipped_count, total_milestones).

    progress = Σ(weight × credit) / Σ(weight), credit = 1.0 if done else fill.
    None when the project has no milestones (evergreen/unseeded) — excluded from rollups.
    """
    ms = proj.get("milestones") or []
    if not ms:
        return (None, 0, 0)
    total_w = sum(float(m.get("weight", 1)) for m in ms)
    if total_w <= 0:
        return (None, 0, len(ms))
    num = 0.0
    shipped = 0
    for m in ms:
        w = float(m.get("weight", 1))
        if m.get("status") == "done":
            num += w
            shipped += 1
        else:
            num += w * float(m.get("fill", 0.0))
    return (num / total_w, shipped, len(ms))


def current_milestone(proj: dict) -> dict | None:
    """First non-done milestone in declared order — the project's live front."""
    for m in proj.get("milestones") or []:
        if m.get("status") != "done":
            return m
    return None


def days_since_movement(proj: dict, today: date | None = None) -> int:
    """Days since the most recent observable movement (milestone completedAt / project updatedAt)."""
    today = today or date.today()
    candidates = [_parse_day(proj.get("updatedAt"))]
    for m in proj.get("milestones") or []:
        candidates.append(_parse_day(m.get("completedAt")))
    days = [(today - d).days for d in candidates if d is not None]
    return min(days) if days else 999


def staleness_w(proj: dict, today: date | None = None) -> float:
    """1.0 (fresh) → 2.0 (stalled ≥14d)."""
    return 1.0 + min(days_since_movement(proj, today) / 14.0, 1.0)


def attention_score(proj: dict, today: date | None = None) -> float:
    """priority × distance-from-done × staleness. Higher = needs attention more."""
    prog, _, _ = project_progress(proj)
    if prog is None:
        return 0.0
    pw = PRIORITY_W.get(proj.get("priority", "P3"), 1)
    return pw * (1.0 - prog) * staleness_w(proj, today)


def goal_rollup(projects: list[dict], goal: str) -> float | None:
    """Priority-weighted mean of a goal's active, non-evergreen, non-paused, seeded projects."""
    num = den = 0.0
    for p in projects:
        if p.get("goal") != goal:
            continue
        if p.get("evergreen") or p.get("status") == "paused":
            continue
        prog, _, _ = project_progress(p)
        if prog is None:
            continue
        pw = PRIORITY_W.get(p.get("priority", "P3"), 1)
        if p.get("weight") is not None:
            pw = float(p["weight"])
        num += pw * prog
        den += pw
    return (num / den) if den else None


def classify(proj: dict) -> str:
    """Bucket a project: decision | attention | moving | paused | evergreen | done."""
    if proj.get("evergreen"):
        return "evergreen"
    if proj.get("status") == "paused":
        return "paused"
    cur = current_milestone(proj)
    if cur is None:
        return "done"  # all milestones shipped
    if proj.get("status") == "blocked" or cur.get("status") == "blocked":
        return "decision"
    # active vs moving: fresh movement (<7d) reads as moving, else needs attention
    return "moving" if days_since_movement(proj) < 7 else "attention"


def bar(frac: float | None, width: int = 10) -> str:
    if frac is None:
        return "—" * width
    filled = int(round(frac * width))
    return "█" * filled + "░" * (width - filled)


def domain_coverage(projects: list[dict], taxonomy: dict) -> list[dict]:
    """Per-domain coverage summary for neglect/activity signals.

    Returns one entry per domain in taxonomy (sorted: active first, neglected last):
    {domain, label, active_count, paused_blocked_count, evergreen_count,
     campaigns (sorted list), stale_signal, neglected}

    'neglected' = zero active/paused/blocked/evergreen projects in this domain.
    'stale_signal' = all active projects are stale (>14d) and none are fresh.
    Never emits completion percentages — domains have no end state.
    """
    domains_vocab = taxonomy.get("domains") or {}
    project_domain_map = taxonomy.get("project_domain") or {}
    campaigns_map = taxonomy.get("campaigns") or {}
    today = date.today()

    by_domain: dict[str, dict] = {
        d: {
            "domain": d, "label": desc,
            "active_count": 0, "paused_blocked_count": 0, "evergreen_count": 0,
            "_campaigns": set(), "_has_stale": False, "_has_fresh": False,
        }
        for d, desc in domains_vocab.items()
    }

    for p in projects:
        slug = p.get("slug", "")
        goal = p.get("goal")
        status = p.get("status", "active")
        if status == "done":
            continue
        domain = project_domain_map.get(slug) or (campaigns_map.get(goal) or {}).get("domain")
        if not domain or domain not in by_domain:
            continue
        d = by_domain[domain]
        if goal:
            d["_campaigns"].add(goal)
        if p.get("evergreen"):
            d["evergreen_count"] += 1
        elif status == "active":
            d["active_count"] += 1
            if days_since_movement(p, today) > 14:
                d["_has_stale"] = True
            else:
                d["_has_fresh"] = True
        elif status in ("paused", "blocked"):
            d["paused_blocked_count"] += 1

    out = []
    for d in by_domain.values():
        entry = {
            "domain": d["domain"],
            "label": d["label"],
            "active_count": d["active_count"],
            "paused_blocked_count": d["paused_blocked_count"],
            "evergreen_count": d["evergreen_count"],
            "campaigns": sorted(d["_campaigns"]),
            "neglected": (
                d["active_count"] == 0 and
                d["evergreen_count"] == 0 and
                d["paused_blocked_count"] == 0
            ),
            "stale_signal": (
                d["_has_stale"] and not d["_has_fresh"] and d["active_count"] > 0
            ),
        }
        out.append(entry)

    def _sort_key(e: dict) -> tuple:
        if e["neglected"]:
            return (3, e["domain"])
        if e["stale_signal"]:
            return (2, e["domain"])
        if e["active_count"] > 0:
            return (0, e["domain"])
        return (1, e["domain"])  # evergreen-only or paused-only

    out.sort(key=_sort_key)
    return out
