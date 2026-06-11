#!/usr/bin/env python3
"""session-workstreams.py — Group free/blocked work into workstream lanes for /start.

Projects canonical task state (free-work.py --json) onto workstream lanes using the
existing domain map (task-domain.py). Renders strongly-separated lanes so a session
can see, at a glance, which streams are live and what is pickable under each.

Usage:
  python3 scripts/session-workstreams.py            # render for this machine
  python3 scripts/session-workstreams.py --machine antfox
  python3 scripts/session-workstreams.py --width 80
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

# Reuse the canonical label->workstream mapping rather than re-deriving it.
import importlib

_td = importlib.import_module("task-domain")
get_section = _td.get_section
get_concern = _td.get_concern

# Status tags are fixed-width so lanes always align regardless of terminal font.
TAG = {
    "ready": "[READY]",
    "block": "[BLOCK]",
    "ant":   "[ ANT ]",
    "held":  "[HELD!]",
}
# Sort rank within a lane: actionable first, then waiting, then gated.
STATUS_RANK = {"ready": 0, "held": 1, "block": 2, "ant": 3}
PRIORITY_RANK = {"P1": 0, "P2": 1, "P3": 2, "": 9}

# Lane display order — most-leverage streams first; unknown sinks to the bottom.
LANE_ORDER = [
    "Trading Bot",
    "OpenClaw Infrastructure",
    "Automation",
    "Self-Review",
    "Dashboard",
    "Navore Market",
    "Personal Site",
    "Remote Access",
    "unknown",
]
LANE_TITLE = {"unknown": "Unclassified"}


def load_buckets(machine: str | None) -> dict:
    cmd = [sys.executable, str(ROOT / "scripts" / "free-work.py"), "--json"]
    if machine:
        cmd += ["--machine", machine]
    out = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT)
    if out.returncode != 0 or not out.stdout.strip():
        sys.stderr.write("[session-workstreams] free-work.py failed:\n" + out.stderr)
        sys.exit(1)
    return json.loads(out.stdout)


def load_personal_threads() -> list[str]:
    """Return open personal thread bullets from Jay/memory/personal-log.md. Fails gracefully."""
    log_path = ROOT / "Jay" / "memory" / "personal-log.md"
    try:
        text = log_path.read_text()
    except FileNotFoundError:
        return []
    in_threads = False
    threads = []
    for line in text.splitlines():
        if line.strip().startswith("## Open threads"):
            in_threads = True
            continue
        if in_threads:
            if line.startswith("## ") or line.startswith("---"):
                break
            if line.startswith("- "):
                threads.append(line[2:].strip())
    return threads


def load_task_details() -> dict:
    """Return taskId -> {agent, why_snippet} from tasks.json. Fails gracefully."""
    tasks_path = ROOT / "docs" / "process" / "state" / "tasks.json"
    try:
        with open(tasks_path) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    details: dict = {}
    for t in data.get("tasks", []):
        tid = t.get("taskId", "")
        if not tid:
            continue
        why = (t.get("why") or t.get("summary") or "").strip()
        # Cap at 60 chars — simple truncation beats sentence-splitting (avoids
        # breaking at abbreviations like "e.g." mid-clause).
        why_short = why[:60].rsplit(" ", 1)[0] + "…" if len(why) > 60 else why
        details[tid] = {
            "agent": t.get("agent", ""),
            "why": why_short,
        }
    return details


def is_ant_gated(blocker: str) -> bool:
    b = (blocker or "").lower()
    days = ("saturday", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday")
    return "ant " in b or "ant availability" in b or "ant-present" in b or any(d in b for d in days)


def collect(buckets: dict, task_details: dict) -> tuple[dict, list, list]:
    """Return (lanes, held, recommended). lanes: section -> list of task dicts."""
    lanes: dict[str, list] = {}
    held = []

    # WIP = leases this machine already holds. Collect their identifiers first so a
    # held task is never also rendered as READY — a stale lease can still surface in
    # free-work's `free` bucket, which would otherwise double-list it.
    held_keys: set[str] = set()
    for w in buckets.get("wip", []):
        title = w.get("title") or w.get("branch") or w.get("claimId", "?")
        held.append(title)
        for tok in title.replace("#", " ").split():
            held_keys.add(tok.lower())

    def is_held(label, tid) -> bool:
        key = f"{tid or ''} {label}".lower()
        return any(k in key for k in held_keys if len(k) > 2)

    def add(label, tid, prio, owner, status, note=""):
        if status == "ready" and is_held(label, tid):
            status, note = "held", "you already hold this lease"
        section = get_section(label) or "unknown"
        td = task_details.get(tid or "", {})
        lanes.setdefault(section, []).append(
            {"id": tid or "—", "prio": prio or "", "label": label,
             "owner": owner or "", "agent": td.get("agent", ""),
             "why": td.get("why", ""),
             "status": status, "note": note}
        )

    for t in buckets.get("free", []):
        add(t["label"], t.get("id"), t.get("priority"), t.get("owner", ""), "ready")

    for t in buckets.get("blocked", []):
        status = "ant" if is_ant_gated(t.get("blocker", "")) else "block"
        note = "waiting on Ant" if status == "ant" else _short_blocker(t.get("blocker", ""))
        add(t["label"], t.get("id"), t.get("priority"), t.get("owner", ""), status, note)

    # Recommendation: highest-priority READY task across all lanes.
    ready = [r for lst in lanes.values() for r in lst if r["status"] == "ready"]
    ready.sort(key=lambda r: PRIORITY_RANK.get(r["prio"], 9))
    rec = ready[0] if ready else None
    if rec:
        rec["note"] = "recommended next pick"
    return lanes, held, rec


def _short_blocker(b: str) -> str:
    b = (b or "").strip()
    if "Done when:" in b:
        b = "dep unmet"
    return (b[:38] + "…") if len(b) > 39 else b


def render(lanes: dict, held: list, rec, machine: str, width: int,
           personal_threads: list | None = None) -> str:
    L = []
    bar = "═" * width
    L.append(bar)
    n_ready = sum(1 for lst in lanes.values() for r in lst if r["status"] == "ready")
    n_total = sum(len(lst) for lst in lanes.values())
    L.append(f" WORKSTREAMS — {machine}   ·   {n_ready} ready / {n_total} surfaced   ·   pick one lane")
    L.append(bar)

    if held:
        L.append("")
        L.append(f" ⚠ THIS MACHINE HOLDS {len(held)} LEASE(S) — release/finish before claiming more:")
        for h in held:
            L.append(f"     · {h}")

    ordered = [s for s in LANE_ORDER if s in lanes] + \
              [s for s in lanes if s not in LANE_ORDER]

    for section in ordered:
        rows = lanes[section]
        rows.sort(key=lambda r: (STATUS_RANK.get(r["status"], 9),
                                 PRIORITY_RANK.get(r["prio"], 9)))
        title = LANE_TITLE.get(section, section).upper()
        concern = get_concern(rows[0]["label"]) if rows else "—"
        ready_here = sum(1 for r in rows if r["status"] == "ready")
        meta = f"{concern} · {ready_here} ready / {len(rows)} total"

        # Strong left-anchored lane header bar; no right border (alignment-safe).
        head = f"━━ {title} "
        pad = width - len(head) - len(meta) - 1
        L.append("")
        L.append(head + ("━" * max(pad, 3)) + " " + meta)

        for r in rows:
            tag = TAG[r["status"]]
            star = "★ " if r is rec else ""
            # Compact [machine·lane] badge — omit empty parts.
            parts = [p for p in (r.get("owner", ""), r.get("agent", "")) if p]
            badge = ("  [" + "·".join(parts) + "]") if parts else ""
            # Inline note: status info for non-ready rows; rec star for ready.
            inline_note = f"   {star}{r['note']}" if (r["note"] or star) else ""
            L.append(f"   {tag}  {r['id']:<5} {r['prio']:<2}  {r['label']}{badge}{inline_note}")
            # Second line: why snippet for ready tasks only (blocked rows already have
            # their blocker reason as the inline note; why is the task rationale).
            if r.get("why") and r["status"] in ("ready", "held"):
                L.append(f"            › {r['why']}")

    if personal_threads:
        L.append("")
        L.append("━━ PERSONAL THREADS " + "━" * (width - 21) + " Jay/memory/personal-log.md")
        for pt in personal_threads:
            snippet = (pt[:width - 7] + "…") if len(pt) > width - 6 else pt
            L.append(f"   · {snippet}")

    L.append("")
    L.append(bar)
    if rec:
        L.append(f" ▶ RECOMMENDED: {rec['id']} {rec['label']}  ({rec['prio']})  —  claim with /next or  claim {rec['id'].lstrip('#')}")
    L.append(" legend: [READY] free · [BLOCK] dep unmet · [ ANT ] needs Ant · [HELD!] you already hold")
    L.append(bar)
    return "\n".join(L)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--machine", help="override detected machine (antfox/abusa)")
    ap.add_argument("--width", type=int, default=76, help="render width (default 76)")
    args = ap.parse_args()
    buckets = load_buckets(args.machine)
    task_details = load_task_details()
    personal_threads = load_personal_threads()
    lanes, held, rec = collect(buckets, task_details)
    print(render(lanes, held, rec, buckets.get("machine", "?"), args.width, personal_threads))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
