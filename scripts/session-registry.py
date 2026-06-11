#!/usr/bin/env python3
"""
M0: Session registry bootstrap.

Reads live state (ps + tmux + JSONL transcripts + metrics files) and writes
~/.openclaw/sessions.json — the single source of truth for the session supervisor.

Run standalone to inspect, or import get_registry() for programmatic use.
"""
from __future__ import annotations

import glob
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

REGISTRY_PATH = Path.home() / ".openclaw" / "sessions.json"
PROJECTS_DIR = Path.home() / ".claude" / "projects"
METRICS_GLOB = "/tmp/claude-session-*.metrics"

# How old a JSONL last_ts can be (seconds) before we consider the session stale
STALE_THRESHOLD_S = 86400 * 4  # 4 days — matches RETIRE_TTL from the plan


def _run(cmd: str) -> str:
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout.strip()


def _parse_etime(etime: str) -> int:
    """Convert ps etime (DD-HH:MM:SS or HH:MM:SS or MM:SS) to seconds."""
    try:
        if "-" in etime:
            days, rest = etime.split("-", 1)
            base = int(days) * 86400
        else:
            rest = etime
            base = 0
        parts = rest.split(":")
        if len(parts) == 3:
            base += int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        elif len(parts) == 2:
            base += int(parts[0]) * 60 + int(parts[1])
        return base
    except Exception:
        return 0


def get_process_tree() -> dict[int, dict]:
    proc_tree: dict[int, dict] = {}
    for line in _run("ps -eo pid,ppid,etime,command").splitlines()[1:]:
        parts = line.split(None, 3)
        if len(parts) == 4:
            try:
                pid, ppid = int(parts[0]), int(parts[1])
            except ValueError:
                continue
            proc_tree[pid] = {
                "ppid": ppid,
                "etime_str": parts[2],
                "etime_s": _parse_etime(parts[2]),
                "cmd": parts[3].strip(),
            }
    return proc_tree


def get_tmux_pane_map() -> dict[int, dict]:
    """Map pane shell PID -> tmux metadata."""
    pane_map: dict[int, dict] = {}
    fmt = "#{session_name}|#{window_name}|#{pane_pid}|#{pane_current_path}|#{window_active}"
    for line in _run(f"tmux list-windows -a -F '{fmt}' 2>/dev/null").splitlines():
        parts = line.split("|", 4)
        if len(parts) == 5:
            sess, win, ppid_str, path, active = parts
            try:
                pane_map[int(ppid_str)] = {
                    "tmux_session": sess,
                    "tmux_window": win,
                    "tmux_label": f"{sess}:{win}",
                    "pane_cwd": path,
                    "active": active == "1",
                }
            except ValueError:
                pass
    return pane_map


def find_tmux(pid: int, proc_tree: dict, pane_map: dict, depth: int = 0) -> dict | None:
    if depth > 6 or pid <= 1:
        return None
    if pid in pane_map:
        return pane_map[pid]
    parent = proc_tree.get(pid, {}).get("ppid")
    if parent:
        return find_tmux(parent, proc_tree, pane_map, depth + 1)
    return None


def get_metrics_sessions() -> dict[str, dict]:
    sessions: dict[str, dict] = {}
    for f in glob.glob(METRICS_GLOB):
        m = re.search(r"claude-session-([a-f0-9-]+)\.metrics", f)
        if not m:
            continue
        sid = m.group(1)
        data: dict[str, str] = {}
        try:
            for line in Path(f).read_text().splitlines():
                if "=" in line:
                    k, v = line.split("=", 1)
                    data[k] = v.strip()
        except Exception:
            pass
        data["_mtime"] = str(int(Path(f).stat().st_mtime))
        sessions[sid] = data
    return sessions


def get_jsonl_sessions() -> dict[str, dict]:
    """Scan all JSONL transcripts, return session metadata keyed by session_id."""
    sessions: dict[str, dict] = {}
    if not PROJECTS_DIR.exists():
        return sessions

    for proj_dir in PROJECTS_DIR.iterdir():
        if not proj_dir.is_dir():
            continue
        for f in proj_dir.glob("*.jsonl"):
            sid = f.stem
            cwd = ""
            last_ts = ""
            last_human_ts = ""
            last_tool_ts = ""
            first_ts = ""
            slug = ""
            try:
                lines = f.read_text(errors="replace").splitlines()
            except Exception:
                continue
            for line in lines:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                t = o.get("timestamp", "")
                if t:
                    if not first_ts or t < first_ts:
                        first_ts = t
                    if t > last_ts:
                        last_ts = t
                if not cwd and o.get("cwd"):
                    cwd = o["cwd"]
                if not slug and o.get("slug"):
                    slug = o["slug"]
                typ = o.get("type") or o.get("role", "")
                if typ == "user" and t and t > last_human_ts:
                    last_human_ts = t
                if typ == "assistant":
                    msg = o.get("message") or {}
                    if isinstance(msg, dict):
                        for item in msg.get("content") or []:
                            if isinstance(item, dict) and item.get("type") == "tool_use":
                                if t > last_tool_ts:
                                    last_tool_ts = t

            sessions[sid] = {
                "session_id": sid,
                "cwd": cwd,
                "slug": slug,
                "first_ts": first_ts,
                "last_ts": last_ts,
                "last_human_ts": last_human_ts,
                "last_tool_ts": last_tool_ts,
                "jsonl_path": str(f),
            }
    return sessions


def infer_state(entry: dict) -> str:
    """Infer session lifecycle state from available signals.

    This is an approximation for M0 — the supervisor daemon will maintain
    authoritative state once it's running.
    """
    pid = entry.get("pid")
    last_ts_str = entry.get("last_ts", "")
    last_human_str = entry.get("last_human_ts", "")
    last_tool_str = entry.get("last_tool_ts", "")

    if not last_ts_str:
        return "never-engaged" if not pid else "orphan"

    try:
        last_ts = datetime.fromisoformat(last_ts_str.replace("Z", "+00:00"))
        age_s = (datetime.now(timezone.utc) - last_ts).total_seconds()
    except Exception:
        age_s = 999999

    if age_s > STALE_THRESHOLD_S:
        return "D"  # retired — very old

    if not pid:
        # No live process — session is committed/paused or should be retired
        return "C" if age_s < STALE_THRESHOLD_S else "D"

    # Live process exists
    # Check if there's recent tool activity (A2: active unattended)
    if last_tool_str and last_tool_str > last_human_str:
        try:
            last_tool = datetime.fromisoformat(last_tool_str.replace("Z", "+00:00"))
            tool_age_s = (datetime.now(timezone.utc) - last_tool).total_seconds()
            if tool_age_s < 3600:  # tool call within last hour
                return "A2"
        except Exception:
            pass

    # Check recency of any activity
    if age_s < 300:  # active in last 5 min
        return "A"
    if age_s < 3600:  # active in last hour
        return "B"  # idle but likely resumable
    # Older but process still alive
    return "B"  # could be C — supervisor will refine with IDLE_TTL


def build_registry() -> dict:
    proc_tree = get_process_tree()
    pane_map = get_tmux_pane_map()
    metrics = get_metrics_sessions()
    jsonl = get_jsonl_sessions()

    # Claude PIDs
    claude_pids = {
        pid: info
        for pid, info in proc_tree.items()
        if info["cmd"].endswith(" claude") or info["cmd"] == "claude"
    }

    # Build entries: start from JSONL sessions, overlay with live process info
    entries: dict[str, dict] = {}

    for sid, js in jsonl.items():
        entry = {**js, "pid": None, "tmux_label": None, "pane_cwd": None,
                 "metrics": metrics.get(sid, {})}
        entries[sid] = entry

    # Overlay live PIDs: match by cwd (best-effort — PID env not accessible on macOS)
    # Group JSONL sessions by cwd, prefer most-recent last_ts per cwd
    cwd_to_best_session: dict[str, str] = {}
    for sid, entry in entries.items():
        cwd = entry.get("cwd", "")
        if not cwd:
            continue
        existing = cwd_to_best_session.get(cwd)
        if not existing or entry.get("last_ts", "") > entries[existing].get("last_ts", ""):
            cwd_to_best_session[cwd] = sid

    for pid, info in claude_pids.items():
        tmux_info = find_tmux(pid, proc_tree, pane_map)
        pane_cwd = tmux_info["pane_cwd"] if tmux_info else ""
        tmux_label = tmux_info["tmux_label"] if tmux_info else "detached"

        # Find best matching session by pane cwd
        matched_sid = cwd_to_best_session.get(pane_cwd)
        if matched_sid and matched_sid in entries:
            entries[matched_sid]["pid"] = pid
            entries[matched_sid]["etime_s"] = info["etime_s"]
            entries[matched_sid]["etime_str"] = info["etime_str"]
            entries[matched_sid]["tmux_label"] = tmux_label
            entries[matched_sid]["pane_cwd"] = pane_cwd
        else:
            # Unmatched PID — create a placeholder
            placeholder_sid = f"pid-{pid}"
            entries[placeholder_sid] = {
                "session_id": placeholder_sid,
                "pid": pid,
                "etime_s": info["etime_s"],
                "etime_str": info["etime_str"],
                "tmux_label": tmux_label,
                "pane_cwd": pane_cwd,
                "cwd": pane_cwd,
                "slug": "",
                "first_ts": "",
                "last_ts": "",
                "last_human_ts": "",
                "last_tool_ts": "",
                "jsonl_path": "",
                "metrics": {},
            }

    # Infer state and finalize
    now_iso = datetime.now(timezone.utc).isoformat()
    result = []
    for sid, entry in entries.items():
        entry["state"] = infer_state(entry)
        entry["as_of"] = now_iso
        # Trim metrics blob — keep just the key numbers
        m = entry.get("metrics", {})
        entry["rate_5h_pct"] = int(m.get("RATE_5H_PCT", 0) or 0)
        entry["rate_7d_pct"] = int(m.get("RATE_7D_PCT", 0) or 0)
        entry["ctx_pct"] = int(m.get("CTX_PCT", 0) or 0)
        entry.pop("metrics", None)
        result.append(entry)

    result.sort(key=lambda e: e.get("last_ts") or "", reverse=True)
    return {
        "generated_at": now_iso,
        "live_pids": len(claude_pids),
        "sessions": result,
    }


def write_registry(reg: dict) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(reg, indent=2))


def print_registry(reg: dict) -> None:
    live = sum(1 for s in reg["sessions"] if s.get("pid"))
    print(f"\nSession Registry  [{reg['generated_at'][:19]}]")
    print(f"  Live PIDs: {reg['live_pids']}  |  Tracked sessions: {len(reg['sessions'])}  |  With live PID: {live}")
    print()
    state_order = {"A": 0, "A2": 1, "B": 2, "C": 3, "D": 4, "orphan": 5, "never-engaged": 6}
    sorted_sessions = sorted(reg["sessions"], key=lambda s: (state_order.get(s["state"], 9), s.get("last_ts", "") or ""))
    header = f"  {'state':6} {'pid':>7} {'uptime':>10} {'5h%':>4} {'7d%':>4} {'ctx%':>5}  {'last_ts':16}  {'label':22} {'cwd'}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for s in sorted_sessions:
        pid = str(s.get("pid") or "—")
        uptime = s.get("etime_str") or "—"
        last = (s.get("last_human_ts") or s.get("last_ts") or "")[:16].replace("T", " ").replace("+00:00","")
        label = (s.get("tmux_label") or s.get("slug") or s["session_id"][:8])[:22]
        cwd = (s.get("cwd") or s.get("pane_cwd") or "")[-35:]
        r5 = s.get("rate_5h_pct", "")
        r7 = s.get("rate_7d_pct", "")
        ctx = s.get("ctx_pct", "")
        print(f"  {s['state']:6} {pid:>7} {uptime:>10} {str(r5):>4} {str(r7):>4} {str(ctx):>5}  {last:16}  {label:22} {cwd}")


if __name__ == "__main__":
    import sys
    reg = build_registry()
    print_registry(reg)
    if "--write" in sys.argv:
        write_registry(reg)
        print(f"\n  Written to {REGISTRY_PATH}")
