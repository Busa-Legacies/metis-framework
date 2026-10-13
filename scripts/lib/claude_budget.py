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
# A file re-rendered by an idle restored session keeps a fresh mtime but a days-old block. Its
# LAST_API_TS (the statusline's turn_start_time) gives it away; 3h leaves room for long live turns.
_METRICS_TURN_STALE_S = int(os.environ.get("CLAUDE_BUDGET_TURN_STALE_S", 3 * 3600))


def _metrics_budget(now: "float | None" = None) -> dict:
    """Server-side budget from the statusline's per-session metrics files.

    The statusline is the single producer of the REAL `rate_limits.*.used_percentage`
    the API reports (written to /tmp/claude-session-<id>.metrics each turn). This is
    the ONLY trustworthy source — the openclaw usage-snapshot's five_hour.pct is a
    LOCAL token-ledger estimate that diverged badly (2026-07-04: snapshot said 2%
    used while the server said 82%). Account-wide values, so any fresh session's
    file works; we take the freshest. Each window's RATE_*_RESETS must be non-empty
    as a PER-WINDOW validity check: the statusline's jq uses `// 0`, so an absent
    rate_limits block writes pct=0 with an empty resets field — serving that as
    "100% left" is exactly the fabricated-value failure this guards against."""
    import glob as _glob
    out = {"5h": None, "7d": None, "reset_5h": None, "reset_7d": None,
           "source": "statusline-metrics"}
    ts_now = time.time() if now is None else now
    # MAX-USED across every fresh file, per window, keyed by reset epoch (2026-10-01). mtime is
    # the statusline RENDER time, not when the server reported rate_limits: idle restored
    # sessions re-render every ~30s with a FROZEN, days-old block, so "freshest file wins" flapped
    # between sessions (7d-left 29..96 in one second) and over-reported headroom to every gate.
    # Within one reset epoch usage only rises, so the highest used% under the latest FUTURE reset
    # is the truest reading; past resets are a previous window and are rejected.
    best = {"5H": None, "7D": None}   # window -> (reset_epoch, used_pct, reset_raw)
    for path in _glob.glob(_METRICS_GLOB):
        try:
            if ts_now - os.path.getmtime(path) > _METRICS_STALE_S:
                continue
            kv = dict(line.strip().split("=", 1) for line in open(path) if "=" in line)
        except (OSError, ValueError):
            continue
        try:
            if ts_now - float(kv.get("LAST_API_TS") or ts_now) > _METRICS_TURN_STALE_S:
                continue      # frozen block re-rendered by an idle session (2026-10-08, #8205)
        except ValueError:
            pass
        for w in ("5H", "7D"):
            raw = kv.get(f"RATE_{w}_RESETS")
            if not raw:
                continue      # absent rate_limits block -> jq `// 0` placeholder, never a reading
            try:
                rep, used = float(raw), int(kv[f"RATE_{w}_PCT"])
            except (KeyError, ValueError):
                continue
            if rep <= ts_now:
                continue      # a previous window's frozen value
            cur = best[w]
            if cur is None or rep > cur[0] or (rep == cur[0] and used > cur[1]):
                best[w] = (rep, used, raw)
    if best["5H"] is not None:
        out["5h"] = max(0, min(100, 100 - best["5H"][1]))
        out["reset_5h"] = best["5H"][2]
        if best["7D"] is not None:
            out["7d"] = max(0, min(100, 100 - best["7D"][1]))
            out["reset_7d"] = best["7D"][2]
        return out
    out["source"] = "statusline-metrics-unavailable"
    return out


HEADLESS_PROBE_FILE = "/tmp/claude-session-headless-probe.metrics"
HEADLESS_PROBE_MODEL = "claude-haiku-4-5-20251001"


def parse_rate_limit_event(stream_lines) -> "dict | None":
    """Pure. From `claude -p --output-format stream-json --verbose` lines, the LAST
    rate_limit_event's unified windows as {"5h": (used_pct, reset), "7d": (used_pct, reset)}.
    used_pct rounds UP (max-used semantics: never under-report spend)."""
    import math
    found = None
    for ln in stream_lines:
        try:
            o = json.loads(ln)
        except (ValueError, TypeError):
            continue
        if o.get("type") != "rate_limit_event":
            continue
        uw = (o.get("rate_limit_info") or {}).get("unifiedWindows") or {}
        out = {}
        for key, w in (("five_hour", "5h"), ("seven_day", "7d")):
            v = uw.get(key) or {}
            if isinstance(v.get("utilization"), (int, float)) and v.get("resetsAt"):
                out[w] = (min(100, math.ceil(round(v["utilization"] * 100, 6))), int(v["resetsAt"]))
        if out:
            found = out
    return found


def refresh_headless_probe(timeout_s: int = 90) -> "dict | None":
    """Refresh the account's server-reported usage WITHOUT an interactive session (2026-10-05).
    The statusline only writes metrics while a session is open, so the end-of-window drain and the
    post-reset report went blind when Ant was offline. A minimal headless Haiku call (no settings
    hooks: --setting-sources local; no MCP) emits a rate_limit_event with exact 5h + 7d utilization;
    it is written in the statusline's metrics format so every existing reader (max-used
    _metrics_budget) picks it up unchanged. Fail-open: any failure returns None, writes nothing."""
    import subprocess
    import tempfile
    claude = os.environ.get("CLAUDE_BIN") or os.path.expanduser("~/.local/bin/claude")
    try:
        with tempfile.TemporaryDirectory() as cwd:
            p = subprocess.run(
                [claude, "-p", "ok", "--setting-sources", "local", "--strict-mcp-config",
                 "--model", HEADLESS_PROBE_MODEL, "--output-format", "stream-json", "--verbose",
                 "--max-turns", "1"],
                cwd=cwd, capture_output=True, text=True, timeout=timeout_s)
        win = parse_rate_limit_event((p.stdout or "").splitlines())
    except Exception:
        return None
    if not win or "5h" not in win:
        return None
    lines = [f"RATE_5H_PCT={win['5h'][0]}", f"RATE_5H_RESETS={win['5h'][1]}"]
    if "7d" in win:
        lines += [f"RATE_7D_PCT={win['7d'][0]}", f"RATE_7D_RESETS={win['7d'][1]}"]
    lines.append(f"LAST_API_TS={int(time.time())}")
    try:
        tmp = HEADLESS_PROBE_FILE + ".tmp"
        with open(tmp, "w") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(tmp, HEADLESS_PROBE_FILE)
    except OSError:
        return None
    return win


# ── Durable last-known-good ledger (#482) ────────────────────────────────────
# The statusline metrics vanish 15 min after the last Claude turn — which is
# EXACTLY when the supervisor needs budget most (Claude capped → no sessions →
# no fresh metrics → probe fell to the snapshot, whose 7d estimate is broken:
# cache-reads counted at full weight read false "0% left", PLAN §8). Window
# percentages move slowly, so the last SERVER-reported reading, aged a few
# hours, beats a live-but-wrong local estimate. Every fresh metrics read is
# persisted here; when metrics go stale we serve the ledger (age-capped) before
# ever falling to the snapshot. 7d readings from metrics/ledger are marked
# trusted_7d=True; snapshot 7d stays advisory-only (never gate on it).
#
# The ledger doubles as the ALLOWANCE-SHIFT detector: Anthropic moves limits
# without notice (5h doubled 2026-05-06; weekly +50% boost expires 2026-07-13).
# Limits are server-side denominators, so a shift shows up as a used%% step-change
# with the SAME reset epoch. On each write we compare against the previous entry
# and page Discord (rate-limited) when a shift signature appears — the system
# hears about allowance changes instead of discovering them at a hard cap.
_LEDGER_PATH = os.path.expanduser("~/.openclaw/logs/claude-budget-ledger.json")
_LEDGER_MAX_AGE_S = int(os.environ.get("CLAUDE_BUDGET_LEDGER_MAX_AGE_S", 24 * 3600))
_SHIFT_ALERT_COOLDOWN_S = 24 * 3600
_SHIFT_WINDOW_S = 6 * 3600      # only compare entries this close together
_SHIFT_DROP_PTS = 10            # used%% fell ≥ this w/ same reset → allowance raised
_SHIFT_JUMP_PTS = 25            # used%% rose ≥ this w/ same reset → burn or reduction
_SHIFT_JUMP_WINDOW_S = 2 * 3600


def _ledger_read() -> dict:
    try:
        with open(_LEDGER_PATH) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _shift_alert(message: str) -> None:
    """Best-effort Discord page via the #074 notify path; never raises."""
    try:
        import importlib.util
        path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "discord_notify.py")
        spec = importlib.util.spec_from_file_location("discord_notify", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        notify = getattr(mod, "notify_raw", None)
        if callable(notify):
            notify(message)
    except Exception:
        pass


def _detect_shift(prev: dict, cur: dict, now: float) -> "str | None":
    """Allowance-shift signature between consecutive server readings, or None."""
    age = now - float(prev.get("ts") or 0)
    if age <= 0 or age > _SHIFT_WINDOW_S:
        return None
    p7, c7 = prev.get("used_7d"), cur.get("used_7d")
    if not isinstance(p7, int) or not isinstance(c7, int):
        return None
    if prev.get("reset_7d") != cur.get("reset_7d") or not cur.get("reset_7d"):
        return None  # window rolled over — a step is expected, not a shift
    if p7 - c7 >= _SHIFT_DROP_PTS:
        return (f"📈 Claude 7d used dropped {p7}%→{c7}% with no window reset — "
                f"Anthropic allowance likely INCREASED. Budget gates now have more headroom.")
    if c7 - p7 >= _SHIFT_JUMP_PTS and age <= _SHIFT_JUMP_WINDOW_S:
        return (f"📉 Claude 7d used jumped {p7}%→{c7}% in {int(age/60)}min with no window "
                f"reset — heavy burn OR an allowance REDUCTION (e.g. a temporary boost "
                f"expiring). Check `metis-status`; expect earlier fallbacks if it holds.")
    return None


def _ledger_update(met: dict, now: "float | None" = None) -> None:
    """Persist a fresh server-side reading; fire the shift detector. Never raises."""
    try:
        ts_now = time.time() if now is None else now
        cur = {
            "ts": ts_now,
            "used_5h": None if met.get("5h") is None else 100 - int(met["5h"]),
            "used_7d": None if met.get("7d") is None else 100 - int(met["7d"]),
            "reset_5h": met.get("reset_5h"),
            "reset_7d": met.get("reset_7d"),
        }
        prev = _ledger_read()
        last_alert = float(prev.get("last_shift_alert_ts") or 0)
        cur["last_shift_alert_ts"] = last_alert
        if prev.get("ts"):
            msg = _detect_shift(prev, cur, ts_now)
            if msg and ts_now - last_alert >= _SHIFT_ALERT_COOLDOWN_S:
                _shift_alert(msg)
                cur["last_shift_alert_ts"] = ts_now
        # Within one reset window usage only rises. A SMALL drop for the same reset is a stale
        # source, so it never overwrites the higher reading (#8205); a drop of _SHIFT_DROP_PTS or
        # more is the allowance-increase signature above and is accepted.
        for w in ("5h", "7d"):
            pu, cu = prev.get(f"used_{w}"), cur[f"used_{w}"]
            if (isinstance(pu, int) and isinstance(cu, int) and 0 < pu - cu < _SHIFT_DROP_PTS
                    and str(prev.get(f"reset_{w}")) == str(cur[f"reset_{w}"])):
                cur[f"used_{w}"] = pu
        os.makedirs(os.path.dirname(_LEDGER_PATH), exist_ok=True)
        tmp = _LEDGER_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cur, f)
        os.replace(tmp, _LEDGER_PATH)
    except Exception:
        pass


def _ledger_budget(now: "float | None" = None) -> dict:
    """Aged last-known-good server reading, or Nones past _LEDGER_MAX_AGE_S."""
    out = {"5h": None, "7d": None, "reset_5h": None, "reset_7d": None,
           "source": "budget-ledger", "age_s": None}
    led = _ledger_read()
    ts = float(led.get("ts") or 0)
    if not ts:
        out["source"] = "budget-ledger-missing"
        return out
    age = (time.time() if now is None else now) - ts
    if age > _LEDGER_MAX_AGE_S:
        out["source"] = "budget-ledger-stale"
        return out
    out["age_s"] = int(age)
    ts_now = time.time() if now is None else now
    for win, key in (("used_5h", "5h"), ("used_7d", "7d")):
        v = led.get(win)
        if isinstance(v, int) and not _reset_passed(led.get(f"reset_{key}"), ts_now):
            out[key] = max(0, min(100, 100 - v))
            out[f"reset_{key}"] = led.get(f"reset_{key}")
    return out


def _reset_passed(reset, now: float) -> bool:
    """A reading whose own window has already reset describes a previous window (#8205)."""
    try:
        return float(reset) <= now
    except (TypeError, ValueError):
        return False


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


# ── Fleet-published signal (#2674) ───────────────────────────────────────────
# The statusline metrics + ledger only exist on a machine with a LIVE interactive
# Claude session (the statusline is the sole producer). Headless nodes (<<MACHINE_1_ID>>) have
# neither, so their only reading is the broken snapshot → they can't see the real
# account-wide budget. This source lets an interactive producer RELAY its fresh
# server-truth reading (via scripts/publish-budget-signal.py, pushed over the tailnet)
# to a shared file the headless node reads. Account-wide values, so any producer's
# reading is valid for any consumer; freshness + non-empty resets are the validity
# guard (same as _metrics_budget). Sits BELOW local metrics/ledger in precedence, so a
# machine with its own live session always prefers local truth (no regression), and
# only a node lacking both falls to the relayed signal instead of the snapshot.
_SIGNAL_PATH = os.path.expanduser("~/.openclaw/budget-signal.json")
_SIGNAL_STALE_S = int(os.environ.get("CLAUDE_BUDGET_SIGNAL_MAX_AGE_S", 90 * 60))


def _shared_signal_budget(now: "float | None" = None) -> dict:
    """Fleet-relayed server-truth reading from ~/.openclaw/budget-signal.json, or an
    empty result if absent/stale/invalid. Fail-soft — never raises."""
    out = {"5h": None, "7d": None, "reset_5h": None, "reset_7d": None,
           "source": "fleet-signal", "age_s": None}
    ts_now = time.time() if now is None else now
    try:
        with open(_SIGNAL_PATH) as f:
            sig = json.load(f)
    except (OSError, ValueError):
        out["source"] = "fleet-signal-absent"
        return out
    ts = sig.get("ts")
    if not isinstance(ts, (int, float)):
        out["source"] = "fleet-signal-no-ts"
        return out
    age = ts_now - ts
    out["age_s"] = int(age)
    if age > _SIGNAL_STALE_S or age < -300:  # stale, or implausibly future-dated
        out["source"] = "fleet-signal-stale"
        return out
    # Same per-window validity guard as metrics: a window is only usable with a
    # non-empty reset (guards against a relayed fabricated "100% left").
    if sig.get("reset_5h") and isinstance(sig.get("5h"), int) and not _reset_passed(sig["reset_5h"], ts_now):
        out["5h"] = max(0, min(100, sig["5h"]))
        out["reset_5h"] = sig["reset_5h"]
    if sig.get("reset_7d") and isinstance(sig.get("7d"), int) and not _reset_passed(sig["reset_7d"], ts_now):
        out["7d"] = max(0, min(100, sig["7d"]))
        out["reset_7d"] = sig["reset_7d"]
    return out


def claude_budget_left(timeout: int = 25) -> dict:
    """Remaining Claude subscription budget per window.

    Returns {"5h": int|None, "7d": int|None, "reset_5h": str|None,
             "reset_7d": str|None, "source": str, "trusted_7d": bool}. `5h`/`7d`
    are integer %-LEFT (0-100) or None when the probe can't determine them —
    callers treat None as 'don't back off', exactly like the Codex guard.

    Per-window source order (#482, #2674): statusline metrics (server-side truth;
    persisted to the ledger on every fresh read) → budget ledger (last server
    reading, age-capped) → fleet-published signal (a peer's relayed server reading,
    for headless nodes with no local producer) → usage snapshot (local estimate; its
    7d over-counts cache-reads, so 7d from here is advisory) → CLI scrape (hangs
    headless). `trusted_7d` is True only when the 7d figure is server-derived
    (metrics, ledger, or a relayed fleet signal) — a caller may GATE decisions on 7d
    only when this flag is set."""
    out = {"5h": None, "7d": None, "reset_5h": None, "reset_7d": None,
           "source": "", "trusted_7d": False}
    used = []

    met = _metrics_budget()
    if met["5h"] is not None or met["7d"] is not None:
        _ledger_update(met)
        for key in ("5h", "7d", "reset_5h", "reset_7d"):
            out[key] = met[key]
        out["trusted_7d"] = met["7d"] is not None
        used.append("statusline-metrics")

    if out["5h"] is None or out["7d"] is None:
        led = _ledger_budget()
        filled = False
        for win, reset in (("5h", "reset_5h"), ("7d", "reset_7d")):
            if out[win] is None and led[win] is not None:
                out[win] = led[win]
                out[reset] = out[reset] or led[reset]
                filled = True
                if win == "7d":
                    out["trusted_7d"] = True
        if filled:
            used.append(f"budget-ledger({led['age_s']}s old)")

    if out["5h"] is None or out["7d"] is None:
        sig = _shared_signal_budget()
        filled = False
        for win, reset in (("5h", "reset_5h"), ("7d", "reset_7d")):
            if out[win] is None and sig[win] is not None:
                out[win] = sig[win]
                out[reset] = out[reset] or sig[reset]
                filled = True
                if win == "7d":
                    out["trusted_7d"] = True  # relayed server reading, not a local estimate
        if filled:
            used.append(f"fleet-signal({sig['age_s']}s old)")

    if out["5h"] is None or out["7d"] is None:
        snap = _snapshot_budget()
        filled = False
        for win, reset in (("5h", "reset_5h"), ("7d", "reset_7d")):
            if out[win] is None and snap[win] is not None:
                out[win] = snap[win]
                out[reset] = out[reset] or snap[reset]
                filled = True
                # snapshot 7d stays untrusted: local estimate, known over-count
        if filled:
            used.append("usage-snapshot")

    if used:
        out["source"] = "+".join(used)
        return out

    out["source"] = "openclaw-models-status"
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
    out["trusted_7d"] = out["7d"] is not None  # CLI echoes the server line
    return out


# --- fail-open telemetry (#6455) -------------------------------------------------------
# gate() fail-opens (PROCEEDs) when the 5h probe can't read a number — correct (unknown must
# never block work), but silent, so a persistently-broken probe looks like a healthy window.
# Emit a structured warning + a durable counter each time it fires. Fail-soft throughout.
_FAILOPEN_COUNTS = os.path.expanduser("~/.openclaw/logs/claude-budget-failopen-counts.json")
_failopen_log = None


def _telemeter_fail_open(rc: str, min_left: int) -> int:
    """Bump the per-class fail-open counter + emit a structured warning; return the count."""
    n = -1
    try:
        os.makedirs(os.path.dirname(_FAILOPEN_COUNTS), exist_ok=True)
        try:
            with open(_FAILOPEN_COUNTS) as fh:
                counts = json.load(fh)
        except Exception:
            counts = {}
        counts[rc] = int(counts.get(rc, 0)) + 1
        n = counts[rc]
        with open(_FAILOPEN_COUNTS, "w") as fh:
            json.dump(counts, fh)
    except Exception:
        pass
    global _failopen_log
    if _failopen_log is None:
        try:
            import sys
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import log as _logmod  # scripts/lib/log.py (#6490)
            _failopen_log = _logmod.get_logger("claude_budget.failopen")
        except Exception:
            _failopen_log = False
    lg = _failopen_log or None
    if lg is not None:
        lg.warning(
            "claude_budget gate fail-open (5h probe unreadable)",
            extra={"resource_class": rc, "min_left": min_left, "count": n},
        )
    return n


def gate(min_left: int, budget: "dict | None" = None) -> tuple[int, dict]:
    """Shared budget gate for scheduled Claude consumers (claude-task, system-audit,
    insights, ...). Returns (exit_code, payload):

      0 = PROCEED — 5h left >= min_left, or the probe can't tell (None → fail-OPEN,
          same contract as everywhere else: unknown must never block work)
      3 = BLOCKED — 5h left is a real number below min_left; the caller should skip
          this scheduled run so the interactive brain keeps the remaining window.

    Exit 3 (not 1) so callers can distinguish "budget-blocked" from a crashed probe."""
    b = budget if budget is not None else claude_budget_left()
    left = b.get("5h")
    fail_open = left is None  # probe couldn't read 5h -> unknown -> fail-open PROCEED (#6455)
    if fail_open:
        _telemeter_fail_open("claude-5h", min_left)
    blocked = isinstance(left, (int, float)) and left < min_left
    payload = dict(b, gate_min_left=min_left, fail_open=fail_open,
                   gate="blocked" if blocked else "proceed")
    return (3 if blocked else 0), payload



# ── Unattended-job token-target banding (#730) ──────────────────────────────
# Scheduled `claude -p` jobs (system-audit etc.) fan out subagents; on 2026-07-04
# a fixed 6-subagent fan-out on the wrong tier ate ~75% of a wake block. The fix
# has two halves: the WRAPPER sizes the run to the real window before launch
# (this banding — skip entirely when the window is thin), and the PROMPT carries
# the resulting "+Nk" token-target directive so the harness's Workflow budget
# (budget.total / budget.remaining()) mechanically caps any fan-out inside the
# run. Bands are deliberately coarse — the goal is self-limiting scale, not
# fabricated precision. Uncertainty (probe returns None) gets the small band,
# never a skip: an unattended job shouldn't standing-die on a probe blip.
_SKIP_BELOW_PCT = int(os.environ.get("CLAUDE_BUDGET_SKIP_BELOW_PCT", 25))
_BANDS = ((75, 300), (50, 200), (25, 100))  # (min %-left, token target in k)
_UNKNOWN_TARGET_K = 100


def token_target_band(pct_left: "int | None") -> "int | None":
    """Token target (k) for an unattended run given 5h %-left; None = skip."""
    if pct_left is None:
        return _UNKNOWN_TARGET_K
    if pct_left < _SKIP_BELOW_PCT:
        return None
    for floor, target_k in _BANDS:
        if pct_left >= floor:
            return target_k
    return None


def band() -> dict:
    """CLI payload for job wrappers: probe once, band the 5h window."""
    b = claude_budget_left()
    target = token_target_band(b.get("5h"))
    return {
        "pct_left_5h": b.get("5h"),
        "token_target_k": target,
        "skip": target is None,
        "source": b.get("source"),
    }


# ── Fable 5 frontier-tier routing advisory (2026-07-20) ──────────────────────
# Fable 5 costs ~2x Opus per token AND Claude Code meters it under a SEPARATE
# weekly sub-cap (~50% of the weekly limit on Max plans) — it can be throttled
# independently of the shared pool. We CANNOT read a live per-model Fable meter:
# the usage snapshot and statusline metrics expose only the shared 5h/7d windows
# (see _snapshot_budget / _metrics_budget). So this is an ADVISORY PROXY on the
# shared 7d window, not a fabricated per-model number. Advisory ONLY (Ant,
# 2026-07-20): it warns; it never auto-switches the model. The default stays
# Opus. If a per-model Fable meter later appears in usage-snapshot.json, wire it
# here as the primary signal ahead of the 7d proxy.
_FABLE_OK_7D_LEFT = int(os.environ.get("FABLE_OK_7D_LEFT", 60))         # >= -> clear
_FABLE_CAUTION_7D_LEFT = int(os.environ.get("FABLE_CAUTION_7D_LEFT", 30))  # >= -> caution


def fable_routing_advisory(budget: "dict | None" = None) -> dict:
    """Advisory (never a gate) for routing a task to Fable 5.

    Fable burns the shared Claude pool at ~2x Opus and is throttled under its own
    ~50% weekly sub-cap, so routing to it when the weekly window is already drawn
    down risks exhausting the frontier tier mid-week. Verdict keys off the shared
    7d %-left (the only weekly-window signal we can trust):

      "clear"       -> 7d headroom ample; Fable fine for genuinely frontier work.
      "caution"     -> weekly window drawing down; reserve Fable for work that
                       measurably beats Opus 4.8 xhigh.
      "prefer_opus" -> weekly window thin; use Opus 4.8 xhigh instead.
      "unknown"     -> probe couldn't read 7d; do NOT back off (fail-open), same
                       contract as the rest of this module.

    ADVISORY ONLY: nothing here changes the model — it surfaces a recommendation
    (metis-status / the routing standard). Default model stays Opus 4.8."""
    b = budget if budget is not None else claude_budget_left()
    left = b.get("7d")
    if not isinstance(left, (int, float)):
        verdict = "unknown"
        advice = ("7d window unreadable — can't advise; not backing off "
                  "(route as intended).")
    elif left >= _FABLE_OK_7D_LEFT:
        verdict = "clear"
        advice = f"7d {int(left)}% left — Fable OK for genuinely frontier work."
    elif left >= _FABLE_CAUTION_7D_LEFT:
        verdict = "caution"
        advice = (f"7d {int(left)}% left — Fable's ~2x burn + ~50% weekly sub-cap are "
                  "getting tight; reserve it for work that measurably beats Opus 4.8 xhigh.")
    else:
        verdict = "prefer_opus"
        advice = (f"7d {int(left)}% left — weekly window thin; prefer Opus 4.8 xhigh. "
                  "Fable risks exhausting the frontier tier mid-week.")
    return {"verdict": verdict, "advice": advice, "pct_left_7d": left,
            "trusted_7d": b.get("trusted_7d", False), "source": b.get("source"),
            "advisory_only": True}


# ── Graduated offload pressure from the weekly runway (#1297) ────────────────
# The offload router's escalation signal for the INTERACTIVE seat (statusline
# advisory) and overflow eagerness. Raw 7d %-left ignores WHERE in the week we
# are — "50% left" is comfortable on Monday and alarming on Saturday. Runway
# normalises it against how much of the 7d window is still open:
#     runway_ratio = (7d %-left / 100) / (fraction of the 7d window remaining)
#   ratio >= FIRM (1.0)  -> on/ahead of an even burn  -> "soft"  (offload is the
#                           always-on default; interactive seat unpressured)
#   HARD (0.6) <= ratio < FIRM -> behind pace          -> "firm"  (advise offload;
#                           overflow rotates more eagerly)
#   ratio < HARD          -> well behind pace           -> "hard"  (strongly advise
#                           offloading everything delegatable)
# HONEST-UNKNOWN + fail-open: when 7d is unreadable (metrics+ledger+snapshot all
# blank) or UNTRUSTED (snapshot-only 7d over-counts cache reads), band="unknown"
# — the always-on autonomous offload default already routes work to a pool, so a
# blind signal never STOPS offload; it just can't ESCALATE (we don't nag Ant or
# force-rotate on no data). Window-edge clamp (premortem #5): as the reset nears,
# fraction-remaining -> 0 would explode the ratio, so it floors at
# _RUNWAY_FRAC_FLOOR — a job minutes from the weekly reset never trips "hard" on
# noise. Thresholds overridable via env for tuning without a code change.
_FIRM_RATIO = float(os.environ.get("FLEET_PRESSURE_FIRM_RATIO", 1.0))
_HARD_RATIO = float(os.environ.get("FLEET_PRESSURE_HARD_RATIO", 0.6))
_RUNWAY_FRAC_FLOOR = 0.05
_WEEK_S = 7 * 86400

# #1590 dual-window offload trigger: below this many %-left in the 5h burst window,
# bias the current burst toward offload even when the 7d runway looks healthy — a
# nearly-spent 5h window strands interactive work if the burst keeps hitting the
# personal seat. Env-tunable; the 7d dimension stays the graduated pressure band.
_BURST_FLOOR_5H = int(os.environ.get("CLAUDE_5H_BURST_FLOOR_PCT", 15))
_OFFLOAD_EAGER_BANDS = frozenset({"firm", "hard"})


def _window_frac_left(reset_epoch, now) -> "float | None":
    """Fraction (floor.._RUNWAY_FRAC_FLOOR..1.0) of the 7d window still remaining."""
    try:
        reset = float(reset_epoch)
    except (TypeError, ValueError):
        return None
    secs_left = reset - now
    if secs_left <= 0:
        return _RUNWAY_FRAC_FLOOR
    return max(_RUNWAY_FRAC_FLOOR, min(1.0, secs_left / _WEEK_S))


def fleet_pressure(budget: "dict | None" = None, now: "float | None" = None) -> dict:
    """Graduated offload pressure band from the weekly (7d) runway.

    Returns {"band": "soft"|"firm"|"hard"|"unknown", "runway_ratio": float|None,
             "pct_left_7d": int|None, "window_frac_left": float|None,
             "trusted_7d": bool, "source": str, "advisory_only": True}.
    ADVISORY ONLY: it never changes the model or blocks a run — the interactive
    statusline reads it to tell Ant when to offload, and the router reads it for
    overflow eagerness. Gates only on server-derived 7d (trusted_7d); an untrusted
    or missing 7d yields band="unknown" (see module note)."""
    ts = time.time() if now is None else now
    b = budget if budget is not None else claude_budget_left()
    left = b.get("7d")
    trusted = bool(b.get("trusted_7d"))
    out = {"band": "unknown", "runway_ratio": None,
           "pct_left_7d": left if isinstance(left, (int, float)) else None,
           "window_frac_left": None, "trusted_7d": trusted,
           "source": b.get("source"), "advisory_only": True}
    if not isinstance(left, (int, float)) or not trusted:
        return out
    frac = _window_frac_left(b.get("reset_7d"), ts)
    if frac is None:
        return out
    ratio = (left / 100.0) / frac
    out["window_frac_left"] = round(frac, 4)
    out["runway_ratio"] = round(ratio, 3)
    if ratio >= _FIRM_RATIO:
        out["band"] = "soft"
    elif ratio >= _HARD_RATIO:
        out["band"] = "firm"
    else:
        out["band"] = "hard"
    return out


def offload_trigger(budget: "dict | None" = None, *, burst_floor: "int | None" = None,
                    now: "float | None" = None) -> dict:
    """Single dual-window offload-eagerness signal (#1590).

    Offload-eager when EITHER window says so:
      - 7d runway PRESSURE band is firm|hard (behind the sustainable even line), OR
      - 5h burst window is at/below `burst_floor` %-left (near-term exhaustion).

    This is the seam the fleet capability router / pace router consume so offload
    eagerness tracks BOTH the window it protects (5h) and the window it must not
    exhaust (7d) — the graduated band alone had zero routing callers, and 5h was
    only a hard per-job floor (gate()), never an eagerness signal.

    Fail-open (matches the rest of the budget stack): an unknown/untrusted band
    AND an unknown-or-healthy 5h yield offload_eager=False — uncertainty never
    forces a route change, it just leaves the always-on offload default in place.

    Returns {"offload_eager": bool, "band": str, "pct_5h": int|None,
             "burst_floor": int, "triggered_by": [str...], "trusted_7d": bool,
             "reason": str, "advisory_only": True}.
    """
    b = budget if budget is not None else claude_budget_left()
    floor = _BURST_FLOOR_5H if burst_floor is None else int(burst_floor)
    pressure = fleet_pressure(b, now=now)
    band = pressure.get("band")
    pct5 = b.get("5h")

    triggered = []
    if band in _OFFLOAD_EAGER_BANDS:
        triggered.append(f"7d band={band}")
    if isinstance(pct5, (int, float)) and pct5 <= floor:
        triggered.append(f"5h {int(pct5)}%<= {floor}% burst floor")

    eager = bool(triggered)
    if eager:
        reason = "offload-eager: " + " OR ".join(triggered)
    else:
        parts = [f"7d band={band or 'unknown'}"]
        parts.append(f"5h={int(pct5)}%>{floor}%" if isinstance(pct5, (int, float))
                     else "5h=unknown")
        reason = "stay: " + ", ".join(parts) + " (neither window eager)"
    return {
        "offload_eager": eager,
        "band": band,
        "pct_5h": pct5 if isinstance(pct5, (int, float)) else None,
        "burst_floor": floor,
        "triggered_by": triggered,
        "trusted_7d": bool(pressure.get("trusted_7d")),
        "reason": reason,
        "advisory_only": True,
    }


if __name__ == "__main__":
    import json
    import sys as _sys
    if len(_sys.argv) > 1 and _sys.argv[1] == "band":
        print(json.dumps(band(), ensure_ascii=False))
    elif len(_sys.argv) > 1 and _sys.argv[1] == "pressure":
        # Graduated weekly-runway offload pressure (advisory). Exit 0 always.
        print(json.dumps(fleet_pressure(), ensure_ascii=False))
    elif len(_sys.argv) > 1 and _sys.argv[1] == "offload-trigger":
        # Dual-window offload-eagerness signal (7d band firm|hard OR 5h burst floor).
        # Advisory only; exit 0 always.
        print(json.dumps(offload_trigger(), ensure_ascii=False))
    elif len(_sys.argv) > 1 and _sys.argv[1] == "fable-advisory":
        # Advisory only: prints a verdict on whether Fable is a wise route given
        # the weekly window. Never changes the model; exit 0 always.
        print(json.dumps(fable_routing_advisory(), ensure_ascii=False))
    elif len(_sys.argv) > 2 and _sys.argv[1] == "--gate":
        # Shared per-job floor gate (#174/2026-07-04 incident): exit 3 = blocked
        # (5h %-left known and below floor), exit 0 = proceed (incl. unknown -> fail-open).
        code, payload = gate(int(_sys.argv[2]))
        print(json.dumps(payload, ensure_ascii=False))
        _sys.exit(code)
    else:
        print(json.dumps(claude_budget_left(), ensure_ascii=False))
