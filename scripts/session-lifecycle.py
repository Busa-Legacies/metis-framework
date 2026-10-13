#!/usr/bin/env python3
"""
M2: Session lifecycle daemon — PAUSE-first state machine (A/A2→B, non-destructive).

Reads the registry (M0), applies idle detection (M1), labels each window with its
topic, and moves sessions between states. Called by a LaunchAgent every POLL_INTERVAL.

KILL vs PAUSE (Ant 2026-07-14): "pause" ≠ "kill". By default (REAP_MODE="off") this
daemon NEVER kills a session or closes a window. A long-idle session is PAUSED — left
alive, reattachable, its window kept and labelled ⏸ — and is only ever closed by an
explicit `tmux kill-session`. Coming back to a live, labelled window beats coming back
to an empty one. Context is durable regardless (the JSONL transcript survives anything).

Transition rules:
  A/A2 → B  : IDLE_TTL elapses with no tool call AND no streaming turn → mark PAUSED
  B    → C  : ONLY when REAP_MODE="suspend" (opt-in) — frees the process on deep idle
              but STILL keeps the window (never a bare empty window)
  C    → D  : RETIRE_TTL elapses  (already dead; bookkeeping only)
  never-engaged: blank spawn reaped only when REAP_MODE != "off"

Two hard floors protect live sessions from any reap: (1) a session can't be "idle"
longer than its own process has been alive (fixes resumed/--continue sessions that
inherit OLD transcript timestamps), and (2) a tmux-attached session is never reaped.
The busy gate is also strictly enforced: is_busy() True → no transition.

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
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ── Timer defaults (override via ~/.openclaw/supervisor.json) ─────────────────
_DEFAULTS = {
    "IDLE_TTL": 3600,          # 60 min: A/A2 → B (active → paused; NON-destructive)
    "ABANDON_TTL": 14400,      # 4 hr:  B → C (only fires when REAP_MODE != "off")
    "RETIRE_TTL": 259200,      # 72 hr: C → D (already dead, bookkeeping)
    "NEVER_ENGAGED_TTL": 1800, # 30 min: blank spawn reap (only when REAP_MODE != "off")
    "POLL_INTERVAL": 60,
    # KILL vs PAUSE (Ant 2026-07-14): "off" = the daemon NEVER auto-kills a session.
    # Long-idle sessions are PAUSED — left alive, reattachable, window kept — and are
    # only ever closed by an explicit `tmux kill-session`. Transcripts are durable
    # either way, so context is never lost. "suspend" (opt-in, needs claude-tmux.sh
    # pause-banner support) would free the process on deep idle but STILL keep the
    # window + a resume banner — never a bare empty window.
    "REAP_MODE": "off",
    # Rename each claude-<N> tmux window to its topic (▶ active / ⏸ paused) so
    # `tmux ls` and the cca picker show WHAT each window is, never a wall of 'bash'.
    "LABEL_WINDOWS": True,
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


def _parse_etime(s: str) -> float:
    """Parse BSD/macOS `ps -o etime` — format [[dd-]hh:]mm:ss — into seconds.
    (Linux `etimes` gives raw seconds directly but is NOT supported by macOS ps.)"""
    s = s.strip()
    if not s:
        return 0.0
    days = 0
    if "-" in s:
        d, s = s.split("-", 1)
        days = int(d)
    parts = [int(x) for x in s.split(":")]
    if len(parts) == 3:
        h, m, sec = parts
    elif len(parts) == 2:
        h, m, sec = 0, parts[0], parts[1]
    else:
        h, m, sec = 0, 0, parts[0]
    return days * 86400 + h * 3600 + m * 60 + sec


def _proc_uptime(pid: int) -> float:
    """Wall-clock seconds since this PID started, or 0.0 if unknown.

    CRITICAL for correctness: idle/abandon timers must be floored by how long the
    session's PROCESS has actually been alive. The registry derives last_ts/first_ts
    from the TRANSCRIPT, so a `claude --continue`/`--resume` session (the restart
    loop, the pane-died respawn hook, and reboot-restore all resume) inherits its
    prior run's OLD timestamps and reads as instantly-abandoned — the daemon then
    kills it on the next 60s tick, the tmux hook respawns it, and they war forever.
    A process that started N seconds ago cannot have been idle for hours. Unknown
    uptime returns 0.0 so the bias is always toward PRESERVING the session (never
    over-kill on uncertainty — over-killing was the entire bug)."""
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "etime="],
            capture_output=True, text=True,
        ).stdout.strip()
        return _parse_etime(out) if out else 0.0
    except Exception:
        return 0.0


def _attached_tmux_sessions() -> set[str]:
    """Set of tmux session names with a client currently attached. A session the
    user is actively looking at is never 'abandoned', no matter its transcript age."""
    try:
        out = subprocess.run(
            ["tmux", "list-sessions", "-F", "#{session_name} #{session_attached}"],
            capture_output=True, text=True,
        ).stdout
        return {ln.split()[0] for ln in out.splitlines() if ln.strip().endswith(" 1")}
    except Exception:
        return set()


def _is_attached(tmux_label: str, attached: set[str]) -> bool:
    if not tmux_label or tmux_label == "detached":
        return False
    return tmux_label.split(":", 1)[0] in attached


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


_LABEL_LEADINS = (
    "lets ", "let's ", "can you ", "can we ", "could you ", "would you ",
    "please ", "i want to ", "i need to ", "i'm ", "im ", "help me ",
)
_SID_RE = re.compile(r"--resume\s+([0-9a-fA-F-]{36})")


def _topic_for_session_id(sid: str) -> str:
    """First substantive human message of a session's transcript → short topic.
    Reliable (not render/width-dependent): the transcript is authoritative."""
    for p in (Path.home() / ".claude" / "projects").glob(f"*/{sid}.jsonl"):
        try:
            with p.open(errors="replace") as fh:
                for line in fh:
                    try:
                        o = json.loads(line)
                    except Exception:
                        continue
                    if o.get("type") != "user":
                        continue
                    c = (o.get("message") or {}).get("content")
                    if isinstance(c, str):
                        t = c
                    elif isinstance(c, list):
                        t = " ".join(x.get("text", "") for x in c
                                     if isinstance(x, dict) and x.get("type") == "text")
                    else:
                        t = ""
                    t = " ".join(t.split())
                    if not t or t.startswith("<"):
                        continue
                    low = t.lower()
                    for pre in _LABEL_LEADINS:
                        if low.startswith(pre):
                            t = t[len(pre):]
                            break
                    return t[:34].strip()
        except Exception:
            pass
    return ""


def _label_all_windows() -> None:
    """Label every claude-<N> tmux WINDOW with its session's topic so `tmux ls` / the
    cca picker show WHAT each window is instead of a wall of 'bash'. Source = the
    `--resume <id>` in the pane's start command (what tmux authoritatively knows) →
    that transcript's first human message. Reliable, unlike parsing rendered status
    lines (truncated at pane width). Renames the WINDOW only (the wrapper keys
    reattach on SESSION name) and pins automatic-rename off so the label sticks."""
    try:
        panes = subprocess.run(
            ["tmux", "list-panes", "-a", "-F",
             "#{session_name}\t#{window_index}\t#{pane_start_command}"],
            capture_output=True, text=True,
        ).stdout
    except Exception:
        return
    for line in panes.splitlines():
        parts = line.split("\t")
        if len(parts) < 3 or not parts[0].startswith("claude-"):
            continue
        sess, widx, startcmd = parts[0], parts[1], "\t".join(parts[2:])
        m = _SID_RE.search(startcmd)
        topic = _topic_for_session_id(m.group(1)) if m else ""
        name = f"▶ {topic}" if topic else f"· {sess}"
        target = f"{sess}:{widx}"
        try:
            subprocess.run(["tmux", "set-option", "-w", "-t", target,
                            "automatic-rename", "off"], capture_output=True)
            subprocess.run(["tmux", "rename-window", "-t", target, name[:44]],
                           capture_output=True)
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
    REAP_MODE = str(cfg.get("REAP_MODE", "off")).lower()
    LABEL_WINDOWS = bool(cfg.get("LABEL_WINDOWS", True))

    reg = registry_mod.build_registry()
    now = time.time()
    attached = _attached_tmux_sessions()
    if LABEL_WINDOWS and not dry_run:
        _label_all_windows()
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

        # Wall-clock floor: a session cannot have been idle/unengaged longer than
        # its own process has been alive. Without this, any resumed session (old
        # transcript timestamps, brand-new PID) reads as instantly-abandoned and is
        # reaped on the next tick — the root cause of both the overnight mass-death
        # and the "dies if you don't type in the first few seconds" bug.
        uptime = _proc_uptime(pid) if pid else 0.0
        is_attached = _is_attached(label, attached)

        # (Window labeling is done once per tick by _label_all_windows() — driven off
        # tmux directly, not this registry loop, which collapses same-cwd sessions.)

        # An attached session is one the user is actively looking at — never reap it.
        if is_attached and state in ("never-engaged", "A", "A2", "B") and pid:
            if verbose:
                print(f"  {short}: {state} attached — never reap")
            continue

        # ── never-engaged: spawned with no first human turn ─────────────────
        if state == "never-engaged" and pid:
            eff_first = min(first_age, uptime)
            if eff_first > NEVER_ENGAGED_TTL and REAP_MODE != "off":
                _log(f"never-engaged → reap: {short} ({label}) no first turn in {first_age:.0f}s")
                transitions.append(f"{short}: never-engaged → reap")
                _kill_process(pid, label, dry_run)
                # NOTE: never _close_tmux_window — a bare empty window is exactly
                # what we're preventing. (Only reached when REAP_MODE != "off".)
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
            # Floor by process uptime: a just-(re)spawned session hasn't been idle
            # for its transcript's age — don't even move it to B yet.
            eff_idle = min(last_any_age, uptime)
            if eff_idle <= IDLE_TTL:
                if verbose:
                    print(f"  {short}: {state} young (uptime {uptime:.0f}s) — no transition")
                continue
            # Idle TTL elapsed and not busy
            _log(f"{state} → B: {short} ({label}) idle {eff_idle:.0f}s > IDLE_TTL {IDLE_TTL}s")
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
            eff_idle = min(last_any_age, uptime)
            # PAUSE, don't kill (Ant 2026-07-14). In the default REAP_MODE="off" a
            # long-idle session simply STAYS in B: alive, reattachable, window kept and
            # labelled ⏸ above. It is never killed and its window is never closed —
            # you only ever lose a session by an explicit `tmux kill-session`. This is
            # the whole point of the kill-vs-pause split: coming back to a live,
            # labelled window beats coming back to an empty one every time.
            if REAP_MODE == "off":
                if verbose:
                    print(f"  {short}: B paused (idle {eff_idle:.0f}s) — pause-only, never reaped")
                continue
            # REAP_MODE == "suspend" (opt-in): free the process on deep idle to reclaim
            # RAM, but STILL keep the window (never _close_tmux_window) so claude-tmux.sh
            # can show a '⏸ paused — press Enter to resume' banner. NOTE: the wrapper
            # pause-banner is not yet wired, so until it is, suspend just frees RAM and
            # the restart loop re-continues on next attach — do not enable blindly.
            if eff_idle > ABANDON_TTL:
                _log(f"B → C (suspend): {short} ({label}) idle {eff_idle:.0f}s (uptime {uptime:.0f}s) > ABANDON_TTL {ABANDON_TTL}s — syncing then suspending PID {pid}")
                transitions.append(f"{short}: B → C (suspend)")
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
                    print(f"  [dry-run] would sync {short} in {cwd} before suspend")
                _kill_process(pid, label, dry_run)
                # DELIBERATELY no _close_tmux_window — a bare empty window is the bug
                # we are fixing. The window survives; the transcript is durable.
            elif verbose:
                print(f"  {short}: B (idle {eff_idle:.0f}s / ABANDON_TTL {ABANDON_TTL}s, PID {pid})")
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
