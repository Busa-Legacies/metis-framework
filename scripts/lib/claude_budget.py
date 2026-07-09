"""Claude (Anthropic) subscription budget probe — Phase 0 of the Metis brain
fallback ladder (PLAN-metis-brain-fallback.md).

Mirror of `codex_5h_left()` in scripts/dispatch, for the layer above the lanes:
the orchestrator brain runs on Claude/Opus and is the one driver with no
failover. To hand the seat down (claude→codex→local) *proactively* we first need
a trustworthy read of how much Claude budget is left in each window.

Cheapest viable signal (verified on <<MACHINE_1_ID>> 2026-07-01): `openclaw models status`
prints an `anthropic usage:` line in the SAME shape it prints for `openai-codex`:

    - anthropic usage: 5h 31% left ⏱1h 58m · Week 93% left ⏱1d 3h

We scrape both the 5h-rolling and Week (7-day) percentages, plus the reset ETAs
(useful for promote-back timing). Philosophy matches the Codex guard: when we
genuinely can't tell, return None for that window — a caller MUST treat None as
"can't tell, do NOT back off", never as 0.

    from claude_budget import claude_budget_left
    b = claude_budget_left()   # {"5h": 89, "7d": 0, "reset_5h": "<epoch>",
                               #  "reset_7d": "<epoch>", "source": "usage-snapshot"}

Source order: the headless-safe usage snapshot is tried FIRST (no keychain hang);
the CLI scrape is the fallback only when the snapshot yields nothing for both
windows. `source` names which path answered.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time

# Cache-first headless source (verified 2026-07-01): openclaw already writes a
# usage snapshot that carries per-window Claude %-USED, so the supervisor can read
# budget WITHOUT the CLI's headless keychain hang. Shape:
#   { "ts": <epoch>, "data": { "claude": {
#       "five_hour": {"pct": 11, "resets_at": "<epoch>", "as_of_age_s": 0},
#       "seven_day": {"pct": 100, "resets_at": "<epoch>", "estimated": true, ...} }}}
# `pct` is %-USED → %-LEFT = 100 - pct. We gate on freshness (now - ts) so a stale
# snapshot never masquerades as live; a stale/missing/malformed file yields None
# (→ don't back off) and we fall through to the CLI scrape.
_SNAPSHOT_PATH = os.path.expanduser("~/.openclaw/usage-snapshot.json")
_SNAPSHOT_STALE_S = 900  # 15 min; older than this = don't trust, return None

# The anthropic usage line. Both windows parsed from the SAME line so we never
# accidentally read the codex line's "Week NN% left". Reset ETAs are optional
# (the ⏱ glyph + duration) — absence must not fail the percentage parse.
_USAGE_RE = re.compile(
    r"anthropic usage:\s*5h\s*(\d+)%\s*left"      # 5h pct  (group 1)
    r"(?:\s*\N{STOPWATCH}?\s*([0-9hdm ]+?))?"       # 5h reset eta (group 2, optional)
    r"\s*[·].*?Week\s*(\d+)%\s*left"               # week pct (group 3)
    r"(?:\s*\N{STOPWATCH}?\s*([0-9hdm ]+))?",       # week reset eta (group 4, optional)
    re.IGNORECASE,
)


def _openclaw_bin() -> str:
    """Resolve the openclaw binary; prefer PATH, fall back to the Homebrew path."""
    return shutil.which("openclaw") or "/opt/homebrew/bin/openclaw"


def _status_text(timeout: int = 15) -> str:
    """Raw `openclaw models status` text (stdout+stderr), or '' on any failure."""
    try:
        r = subprocess.run(
            [_openclaw_bin(), "models", "status"],
            capture_output=True, text=True, timeout=timeout,
        )
        return (r.stdout or "") + (r.stderr or "")
    except Exception:
        return ""


# HEADLESS CONSTRAINT (<<MACHINE_1_ID>>, 2026-07-01): `openclaw models status` completes in
# seconds under a TTY (perl-exec) but HANGS ~30s+ with no usage line when stdout is
# a pipe (subprocess/PTY) — it blocks on the "read anthropic credentials from claude
# cli keychain" step. So this probe is reliable interactively but returns
# source="unavailable" (→ None → don't back off) from a headless supervisor. The
# existing codex_5h_left() shares this pattern and likely has the same blind spot.
# Two cached, headless-safe signals exist for the Phase-0 calibration lane to wire
# as a faster primary source (schema/windowing needs reverse-engineering first, so
# not trusted here — no fabricated values): ~/.openclaw/rate-limit-cache.json
# (limit_5h / limit_7d caps + a 7d ref pct/ts) and ~/.openclaw/usage-snapshot.json
# (live per-model/tier token ledger, the plan's candidate-signal #3).
def _pct_left(window: dict) -> "int | None":
    """%-LEFT (100 - pct-used) from a snapshot window dict, or None if unusable."""
    if not isinstance(window, dict):
        return None
    pct = window.get("pct")
    if not isinstance(pct, (int, float)):
        return None
    return max(0, min(100, 100 - int(pct)))


_METRICS_GLOB = "/tmp/claude-session-*.metrics"
_METRICS_STALE_S = 900


def _metrics_budget(now: "float | None" = None) -> dict:
    """Server-side budget from the statusline's per-session metrics files.

    The statusline is the single producer of the REAL `rate_limits.*.used_percentage`
    the API reports (written to /tmp/claude-session-<id>.metrics each turn). This is
    the ONLY trustworthy source — the openclaw usage-snapshot's five_hour.pct is a
    LOCAL token-ledger estimate that diverged badly (2026-07-04: snapshot said 2%
    used while the server said 82%). Account-wide values, so any fresh session's
    file works; we take the freshest. RATE_5H_RESETS must be non-empty as a
    validity check (statusline writes pct=0 when rate_limits is absent from ctx)."""
    import glob as _glob
    out = {"5h": None, "7d": None, "reset_5h": None, "reset_7d": None,
           "source": "statusline-metrics"}
    ts_now = time.time() if now is None else now
    candidates = [(os.path.getmtime(p), p) for p in _glob.glob(_METRICS_GLOB)
                  if os.path.isfile(p)]
    for mtime, path in sorted(candidates, reverse=True):
        if ts_now - mtime > _METRICS_STALE_S:
            break
        try:
            kv = dict(line.strip().split("=", 1) for line in open(path)
                      if "=" in line)
        except (OSError, ValueError):
            continue
        if not kv.get("RATE_5H_RESETS"):
            continue
        try:
            out["5h"] = max(0, min(100, 100 - int(kv["RATE_5H_PCT"])))
            out["7d"] = max(0, min(100, 100 - int(kv["RATE_7D_PCT"])))
        except (KeyError, ValueError):
            continue
        out["reset_5h"] = kv.get("RATE_5H_RESETS") or None
        out["reset_7d"] = kv.get("RATE_7D_RESETS") or None
        return out
    out["source"] = "statusline-metrics-unavailable"
    return out


def _snapshot_budget(now: "float | None" = None) -> dict:
    """Headless-safe budget read from ~/.openclaw/usage-snapshot.json.

    Returns the same shape as claude_budget_left(). 5h/7d are None when the file
    is missing, malformed, or STALE (older than _SNAPSHOT_STALE_S) — callers must
    treat None as 'can't tell, don't back off'. reset_* carry the window resets_at
    epoch (string) when present."""
    out = {"5h": None, "7d": None, "reset_5h": None, "reset_7d": None,
           "source": "usage-snapshot"}
    try:
        with open(_SNAPSHOT_PATH) as f:
            snap = json.load(f)
        ts = float(snap.get("ts", 0))
        age = (time.time() if now is None else now) - ts
        if age > _SNAPSHOT_STALE_S:
            out["source"] = "usage-snapshot-stale"
            return out
        claude = snap.get("data", {}).get("claude", {})
        fh, sd = claude.get("five_hour", {}), claude.get("seven_day", {})
        out["5h"] = _pct_left(fh)
        out["7d"] = _pct_left(sd)
        out["reset_5h"] = str(fh.get("resets_at")) if isinstance(fh, dict) and fh.get("resets_at") else None
        out["reset_7d"] = str(sd.get("resets_at")) if isinstance(sd, dict) and sd.get("resets_at") else None
        if out["5h"] is None and out["7d"] is None:
            out["source"] = "usage-snapshot-empty"
    except FileNotFoundError:
        out["source"] = "usage-snapshot-missing"
    except (OSError, ValueError, TypeError):
        out["source"] = "usage-snapshot-unreadable"
    return out


def claude_budget_left(timeout: int = 25) -> dict:
    """Remaining Claude subscription budget per window.

    Returns {"5h": int|None, "7d": int|None, "reset_5h": str|None,
             "reset_7d": str|None, "source": str}. `5h`/`7d` are integer %-LEFT
    (0-100) or None when the probe can't determine them — callers treat None as
    'don't back off', exactly like the Codex guard.

    Source order: statusline metrics (server-side truth) → usage snapshot
    (local estimate; 7d/resets still useful) → CLI scrape (hangs headless)."""
    met = _metrics_budget()
    if met["5h"] is not None or met["7d"] is not None:
        return met
    snap = _snapshot_budget()
    if snap["5h"] is not None or snap["7d"] is not None:
        return snap

    out = {"5h": None, "7d": None, "reset_5h": None, "reset_7d": None,
           "source": "openclaw-models-status"}
    text = _status_text(timeout)
    if not text:
        out["source"] = "unavailable"
        return out
    m = _USAGE_RE.search(text)
    if not m:
        out["source"] = "no-anthropic-usage-line"
        return out
    out["5h"] = int(m.group(1))
    out["7d"] = int(m.group(3))
    out["reset_5h"] = (m.group(2) or "").strip() or None
    out["reset_7d"] = (m.group(4) or "").strip() or None
    return out


if __name__ == "__main__":
    import json
    print(json.dumps(claude_budget_left(), ensure_ascii=False))
