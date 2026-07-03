#!/usr/bin/env python3
"""
M1: Session idle detector.

For each live session (has a process PID in the registry), reads the tail
of its JSONL transcript and writes LAST_TOOL_TS to its metrics file so the
M2 lifecycle daemon can gate A/A2→B transitions on real activity.

Usage:
    python3 session-idle.py [--update-metrics] [session-id]

  --update-metrics   Write LAST_TOOL_TS into each session's metrics file
  session-id         Print is_busy verdict for one session (exit 0=busy, 1=idle)

Import surface:
    from session_idle import get_last_tool_ts, is_busy
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

IDLE_TTL_S = 3600          # 60 min — see PLAN-session-supervisor.md §Timers
METRICS_GLOB_TMPL = "/tmp/claude-session-{}.metrics"
TAIL_BYTES = 32768         # 32 KB tail — enough for ~100 recent JSONL lines


def get_last_tool_ts(jsonl_path: str | Path) -> float | None:
    """Return epoch float of the most recent tool_use call in the JSONL, or None."""
    path = Path(jsonl_path)
    if not path.exists():
        return None
    try:
        with path.open(errors="replace") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - TAIL_BYTES))
            tail = fh.read()
    except Exception:
        return None

    last_tool_ts: float | None = None
    for line in tail.splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") != "assistant":
            continue
        ts_str = obj.get("timestamp", "")
        if not ts_str:
            continue
        msg = obj.get("message") or {}
        content = msg.get("content") or []
        if not isinstance(content, list):
            continue
        has_tool = any(
            isinstance(item, dict) and item.get("type") == "tool_use"
            for item in content
        )
        if not has_tool:
            continue
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
            if last_tool_ts is None or ts > last_tool_ts:
                last_tool_ts = ts
        except Exception:
            continue
    return last_tool_ts


def is_busy(session_id: str, jsonl_path: str | Path, idle_ttl_s: int = IDLE_TTL_S) -> bool:
    """True if there was a tool call within the last idle_ttl_s seconds."""
    ts = get_last_tool_ts(jsonl_path)
    if ts is None:
        return False
    return (time.time() - ts) < idle_ttl_s


def update_metrics(session_id: str, last_tool_ts: float | None) -> None:
    """Write LAST_TOOL_TS into the session's /tmp metrics file."""
    path = Path(METRICS_GLOB_TMPL.format(session_id))
    if not path.exists():
        return
    try:
        lines = path.read_text(errors="replace").splitlines()
        # Remove any existing LAST_TOOL_TS line
        lines = [l for l in lines if not l.startswith("LAST_TOOL_TS=")]
        if last_tool_ts is not None:
            lines.append(f"LAST_TOOL_TS={int(last_tool_ts)}")
        path.write_text("\n".join(lines) + "\n")
    except Exception:
        pass


def _load_registry() -> dict:
    """Load session registry, tolerating hyphenated module filename."""
    try:
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location(
            "session_registry",
            Path(__file__).parent / "session-registry.py",
        )
        if spec and spec.loader:
            mod = _ilu.module_from_spec(spec)
            spec.loader.exec_module(mod)  # type: ignore[arg-type]
            return mod.build_registry()  # type: ignore[attr-defined]
    except Exception:
        pass
    return {"sessions": []}


def run_all(update: bool = False) -> list[dict]:
    """Scan all sessions with live PIDs and return idle status for each."""
    reg = _load_registry()

    results = []
    for entry in reg.get("sessions", []):
        sid = entry.get("session_id", "")
        pid = entry.get("pid")
        jsonl_path = entry.get("jsonl_path", "")
        if not pid or not jsonl_path:
            continue

        last_tool_ts = get_last_tool_ts(jsonl_path)
        busy = is_busy(sid, jsonl_path)
        age_s = int(time.time() - last_tool_ts) if last_tool_ts else None

        result = {
            "session_id": sid,
            "pid": pid,
            "is_busy": busy,
            "last_tool_ts": last_tool_ts,
            "idle_s": age_s,
            "state": entry.get("state"),
            "tmux_label": entry.get("tmux_label"),
        }
        results.append(result)

        if update:
            update_metrics(sid, last_tool_ts)

    return results


if __name__ == "__main__":
    import os

    update_metrics_flag = "--update-metrics" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]

    if args:
        # Single-session mode: print is_busy verdict and exit
        session_id = args[0]
        # Find jsonl from registry or glob
        jsonl_path: Path | None = None
        projects_dir = Path.home() / ".claude" / "projects"
        for proj in projects_dir.iterdir():
            candidate = proj / f"{session_id}.jsonl"
            if candidate.exists():
                jsonl_path = candidate
                break

        if not jsonl_path:
            print(f"session {session_id}: no JSONL found", file=sys.stderr)
            sys.exit(2)

        ts = get_last_tool_ts(jsonl_path)
        busy = is_busy(session_id, jsonl_path)
        age_str = f"{int(time.time() - ts)}s ago" if ts else "never"
        print(f"session {session_id}: {'BUSY' if busy else 'IDLE'} (last tool: {age_str})")
        if update_metrics_flag:
            update_metrics(session_id, ts)
        sys.exit(0 if busy else 1)

    # All-sessions mode
    os.chdir(Path(__file__).parent)
    results = run_all(update=update_metrics_flag)
    if not results:
        print("No live sessions found.")
        sys.exit(0)

    print(f"\nIdle detector  [{datetime.now(timezone.utc).isoformat()[:19]}]")
    print(f"{'session_id':36} {'pid':>7} {'state':6} {'busy':5}  {'idle_s':>8}  label")
    print("-" * 90)
    for r in results:
        idle_str = f"{r['idle_s']}s" if r["idle_s"] is not None else "never"
        busy_str = "YES" if r["is_busy"] else "no"
        print(f"  {r['session_id']:36} {r['pid']:>7} {r['state']:6} {busy_str:5}  {idle_str:>8}  {r['tmux_label'] or ''}")
