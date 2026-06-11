#!/usr/bin/env python3
"""
M2: Session lifecycle daemon — state machine transitions A/A2→B→C→D.

Reads the registry (M0), applies idle detection (M1), fires transitions
based on timer thresholds. Called by a LaunchAgent every POLL_INTERVAL.

Transition rules (from PLAN-session-supervisor.md):
  A/A2 → B  : IDLE_TTL elapses with no tool call AND no streaming turn
  B    → C  : ABANDON_TTL elapses (kill process; transcript is durable)
  C    → D  : RETIRE_TTL elapses  (already dead; this is just bookkeeping)
  never-engaged: spawned >NEVER_ENGAGED_TTL ago with no first human turn → kill

The busy gate is strictly enforced: if is_busy() returns True, no transition
fires regardless of elapsed time.

Usage:
    python3 session-lifecycle.py [--dry-run] [--verbose]

  --dry-run  Print transitions without executing them
  --verbose  Print all sessions, not just ones that changed

Logs every transition to ~/.openclaw/logs/session-lifecycle.log.
"""
from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ── Timer defaults (override via ~/.openclaw/supervisor.json) ─────────────────
_DEFAULTS = {
    "IDLE_TTL": 3600,          # 60 min: A/A2 → B
    "ABANDON_TTL": 14400,      # 4 hr:  B → C (kill process)
    "RETIRE_TTL": 259200,      # 72 hr: C → D (already dead, bookkeeping)
    "NEVER_ENGAGED_TTL": 1800, # 30 min: spawn → reap if no first turn
    "POLL_INTERVAL": 60,
}

LOG_PATH = Path.home() / ".openclaw" / "logs" / "session-lifecycle.log"
SUPERVISOR_CONFIG = Path.home() / ".openclaw" / "supervisor.json"


def _load_config() -> dict:
    cfg = dict(_DEFAULTS)
    try:
        if SUPERVISOR_CONFIG.exists():
            cfg.update(json.loads(SUPERVISOR_CONFIG.read_text()))
    except Exception:
        pass
    return cfg


def _log(msg: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).isoformat()[:19]
    line = f"[{ts}] {msg}\n"
    try:
        with LOG_PATH.open("a") as f:
            f.write(line)
    except Exception:
        pass
    print(line, end="")


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
        return None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[arg-type]
    return mod


def _kill_process(pid: int, label: str, dry_run: bool) -> bool:
    if dry_run:
        print(f"  [dry-run] would kill PID {pid} ({label})")
        return True
    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)
        try:
            os.kill(pid, 0)  # still alive?
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        _log(f"killed PID {pid} ({label})")
        return True
    except ProcessLookupError:
        _log(f"PID {pid} already dead ({label})")
        return True
    except Exception as e:
        _log(f"ERROR killing PID {pid} ({label}): {e}")
        return False


def _close_tmux_window(tmux_label: str, dry_run: bool) -> None:
    """Close tmux window if it still exists."""
    if not tmux_label or tmux_label == "detached":
        return
    # tmux_label format: session:window
    parts = tmux_label.split(":", 1)
    if len(parts) != 2:
        return
    sess, win = parts
    cmd = ["tmux", "kill-window", "-t", f"{sess}:{win}"]
    if dry_run:
        print(f"  [dry-run] would run: {' '.join(cmd)}")
        return
    try:
        subprocess.run(cmd, capture_output=True)
    except Exception:
        pass


def run(dry_run: bool = False, verbose: bool = False) -> None:
    scripts_dir = Path(__file__).parent
    registry_mod = _load_module("session_registry", scripts_dir / "session-registry.py")
    idle_mod = _load_module("session_idle", scripts_dir / "session-idle.py")

    if not registry_mod or not idle_mod:
        _log("ERROR: could not load session_registry or session_idle modules")
        sys.exit(1)

    cfg = _load_config()
    IDLE_TTL = int(cfg["IDLE_TTL"])
    ABANDON_TTL = int(cfg["ABANDON_TTL"])
    RETIRE_TTL = int(cfg["RETIRE_TTL"])
    NEVER_ENGAGED_TTL = int(cfg["NEVER_ENGAGED_TTL"])

    reg = registry_mod.build_registry()
    now = time.time()
    transitions: list[str] = []

    for entry in reg.get("sessions", []):
        sid = entry.get("session_id", "")
        short = sid[:8]
        pid = entry.get("pid")
        state = entry.get("state", "")
        label = entry.get("tmux_label") or entry.get("slug") or short
        jsonl_path = entry.get("jsonl_path", "")
        last_human_str = entry.get("last_human_ts", "") or ""
        last_ts_str = entry.get("last_ts", "") or ""
        first_ts_str = entry.get("first_ts", "") or ""

        def _age(ts_str: str) -> float:
            """Seconds since this ISO timestamp, or large number if missing."""
            if not ts_str:
                return 1e9
            try:
                dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                return now - dt.timestamp()
            except Exception:
                return 1e9

        last_human_age = _age(last_human_str)
        last_any_age = _age(last_ts_str)
        first_age = _age(first_ts_str)

        # ── never-engaged: spawned with no first human turn ─────────────────
        if state == "never-engaged" and pid:
            if first_age > NEVER_ENGAGED_TTL or (not last_human_str and first_age > NEVER_ENGAGED_TTL):
                _log(f"never-engaged → reap: {short} ({label}) no first turn in {first_age:.0f}s")
                transitions.append(f"{short}: never-engaged → reap")
                _kill_process(pid, label, dry_run)
                _close_tmux_window(label, dry_run)
            elif verbose:
                print(f"  {short}: never-engaged (waiting for first turn, {first_age:.0f}s old)")
            continue

        # ── Active states (A/A2): check idle gate ───────────────────────────
        if state in ("A", "A2") and pid:
            if not jsonl_path:
                if verbose:
                    print(f"  {short}: {state} (no jsonl, skipping)")
                continue
            busy = idle_mod.is_busy(sid, jsonl_path, IDLE_TTL)
            if busy:
                if verbose:
                    print(f"  {short}: {state} BUSY — no transition")
                continue
            # Idle TTL elapsed and not busy
            _log(f"{state} → B: {short} ({label}) idle {last_any_age:.0f}s > IDLE_TTL {IDLE_TTL}s")
            transitions.append(f"{short}: {state} → B")
            # M3 (sync-on-pause) would fire here; not yet implemented
            if verbose:
                print(f"  {short}: {state} → B (idle {last_any_age:.0f}s)")
            continue

        # ── B (idle, resumable): check abandon timer ────────────────────────
        if state == "B" and pid:
            # Guard: if session is actually busy, don't transition
            if jsonl_path and idle_mod.is_busy(sid, jsonl_path, IDLE_TTL):
                if verbose:
                    print(f"  {short}: B → actually busy, should be A2")
                continue
            if last_any_age > ABANDON_TTL:
                _log(f"B → C: {short} ({label}) idle {last_any_age:.0f}s > ABANDON_TTL {ABANDON_TTL}s — syncing then killing PID {pid}")
                transitions.append(f"{short}: B → C")
                # M3: sync before kill — commit dirty tracked files to current branch
                cwd = entry.get("cwd") or entry.get("pane_cwd") or ""
                sync_script = Path(__file__).parent / "sync-session.sh"
                if cwd and sync_script.exists() and not dry_run:
                    try:
                        subprocess.run(
                            ["/bin/bash", str(sync_script), sid, cwd],
                            capture_output=False, timeout=60,
                        )
                    except Exception as e:
                        _log(f"WARN sync failed for {short}: {e}")
                elif dry_run:
                    print(f"  [dry-run] would sync {short} in {cwd} before kill")
                _kill_process(pid, label, dry_run)
                # Close the tmux window so claude-tmux.sh's restart loop cannot
                # respawn Claude immediately and re-enter the kill cycle.
                _close_tmux_window(label, dry_run)
            elif verbose:
                print(f"  {short}: B (idle {last_any_age:.0f}s / ABANDON_TTL {ABANDON_TTL}s, PID {pid})")
            continue

        # ── C (abandoned, committed, no process): check retire timer ────────
        if state == "C" and not pid:
            if last_any_age > RETIRE_TTL:
                _log(f"C → D: {short} ({label}) age {last_any_age:.0f}s > RETIRE_TTL {RETIRE_TTL}s")
                transitions.append(f"{short}: C → D")
                # Nothing to kill; transcript stays in ~/.claude/projects
            elif verbose:
                print(f"  {short}: C (age {last_any_age:.0f}s / RETIRE_TTL {RETIRE_TTL}s)")
            continue

        if verbose:
            print(f"  {short}: {state} (no action)")

    # Summary
    if transitions:
        _log(f"cycle complete — {len(transitions)} transitions: {', '.join(transitions)}")
    else:
        if verbose:
            print(f"\nNo transitions this cycle.")


if __name__ == "__main__":
    dry_run = "--dry-run" in sys.argv
    verbose = "--verbose" in sys.argv or "--dry-run" in sys.argv
    run(dry_run=dry_run, verbose=verbose)
