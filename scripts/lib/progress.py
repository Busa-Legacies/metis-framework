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
