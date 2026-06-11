#!/usr/bin/env python3
"""Registry-backed task runner — the execution core of #153 (run-on-Jay).

Resolves a stable registry key (NOT a free-form command) from
``scripts/run-registry.yaml``, enforces its run-mode against the calling
context, executes the vetted command, and returns a structured result. This is
the one place that turns "a key from a Notion card" into "a process on Jay", so
it is also the security gate: callers pass a KEY, never a command string, and the
registry is the allowlist (reviewed in git like any code).

Two contexts call this:
  - poller   (Pattern A, no human present): autonomous keys only; interactive
             keys are REFUSED.
  - terminal (Pattern B, human present at the dashboard PTY): any key.

The helpers ``load_registry`` / ``validate_registry`` / ``resolve`` /
``check_allowed`` are pure (data in, data/errors out), so the whole security
surface is unit-tested in memory with no subprocess. ``run_entry`` is the only
side-effecting function, and it takes an injectable runner so even it can be
exercised without spawning a process.

CLI:
    run-task.py <key> [--context poller|terminal] [--registry PATH]
                [--timeout SECS] [--dry-run] [--json]
    run-task.py --list [--json]
    run-task.py --validate

Exit codes: 0 when the task finished cleanly (or --dry-run); 1 when it was
refused / failed / timed out; 2 on a usage/registry error (unknown key, invalid
registry). The poller keys off these.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import yaml

# Portable repo root: REPO_ROOT (per-invocation/worktree) -> METIS_HOME
# (canonical) -> self-locating fallback (<this file>/../..). Mirrors the other
# scripts so it survives worktrees and the compat-symlink removal.
ROOT = Path(os.environ.get("REPO_ROOT") or os.environ.get("METIS_HOME") or Path(__file__).resolve().parents[1])
DEFAULT_REGISTRY = ROOT / "scripts/run-registry.yaml"

VALID_MODES = {"autonomous", "interactive"}
VALID_CONTEXTS = {"poller", "terminal"}
_KEY_RE = re.compile(r"[a-z0-9][a-z0-9-]*")
_OUTPUT_TAIL = 4000  # chars of combined stdout+stderr to retain for write-back


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _tail(text: str, limit: int = _OUTPUT_TAIL) -> str:
    if len(text) <= limit:
        return text
    return "…(truncated)…\n" + text[-limit:]


@dataclass
class Entry:
    key: str
    mode: str
    cmd: list
    desc: str = ""


@dataclass
class RunResult:
    key: str
    mode: str
    cmd: list
    context: str
    status: str        # done | failed | refused | timeout | dry-run
    exit_code: int     # process rc; -1 = refused/not-found; -2 = timeout
    output: str
    started_at: str
    finished_at: str
    detail: str = ""


# --- pure helpers (the security surface — fully unit-tested) -----------------

def load_registry(path: Path) -> dict:
    """Parse the registry YAML into ``{key: Entry}``. Structural parsing only;
    semantic checks live in ``validate_registry`` so callers can decide when to
    fail closed."""
    raw = yaml.safe_load(Path(path).read_text()) or {}
    if not isinstance(raw, dict):
        raise ValueError(f"registry {path} must be a mapping of key -> spec")
    registry = {}
    for key, spec in raw.items():
        if not isinstance(spec, dict):
            raise ValueError(f"registry entry {key!r} must be a mapping, got {type(spec).__name__}")
        registry[key] = Entry(
            key=key,
            mode=spec.get("mode"),
            cmd=spec.get("cmd"),
            desc=spec.get("desc", "") or "",
        )
    return registry


def validate_registry(registry: dict) -> list:
    """Return a list of human-readable problems (empty == valid). Keeps the
    allowlist honest: kebab-case keys, a known mode, and an argv list (never a
    shell string)."""
    errors = []
    for key, e in registry.items():
        if not (isinstance(key, str) and _KEY_RE.fullmatch(key)):
            errors.append(f"{key!r}: key must be kebab-case [a-z0-9-]")
        if e.mode not in VALID_MODES:
            errors.append(f"{key!r}: mode must be one of {sorted(VALID_MODES)}, got {e.mode!r}")
        if not (isinstance(e.cmd, list) and e.cmd and all(isinstance(a, str) for a in e.cmd)):
            errors.append(f"{key!r}: cmd must be a non-empty list of strings (argv form, no shell)")
    return errors


# --- parameterized spin family (#246) ----------------------------------------
# A Notion "Agent" card carries Run Key = "spin:<scope>:<id>" so ANY governed
# task/milestone/project becomes spinnable without a per-task registry entry.
# The base command below IS the allowlist for this family (vetted in git); only
# the regex-validated id interpolates. spin-task-agent.py re-validates + refuses
# interactive tasks (defense in depth). No shell, ever.
_SPIN_ID_RE = {
    "task": re.compile(r"^#?\d+$"),
    "project": re.compile(r"^[a-z0-9][a-z0-9-]*$"),
    "milestone": re.compile(r"^([a-z0-9][a-z0-9-]*:)?M\d+$"),
}


def _resolve_spin(key: str):
    """Return a synthesized Entry for a 'spin:<scope>:<id>' key, or None."""
    if not key.startswith("spin:"):
        return None
    parts = key.split(":", 2)
    if len(parts) != 3:
        raise KeyError(f"malformed spin key {key!r}; want spin:<task|milestone|project>:<id>")
    _, scope, ident = parts
    rx = _SPIN_ID_RE.get(scope)
    if rx is None:
        raise KeyError(f"unknown spin scope {scope!r}; want task|milestone|project")
    if not rx.fullmatch(ident):
        raise KeyError(f"invalid id {ident!r} for spin scope {scope!r}")
    cmd = [sys.executable, str(ROOT / "scripts/spin-task-agent.py"), "--scope", scope, "--id", ident]
    return Entry(key=key, mode="autonomous", cmd=cmd, desc=f"spin {scope} {ident}")


def resolve(registry: dict, key: str) -> Entry:
    spin = _resolve_spin(key)
    if spin is not None:
        return spin
    if key not in registry:
        known = ", ".join(sorted(registry)) or "(none)"
        raise KeyError(f"unknown registry key {key!r}; known keys: {known}")
    return registry[key]


def check_allowed(entry: Entry, context: str):
    """The gate. Return a refusal reason string, or None if allowed.

    An interactive task cannot run unattended, so the poller may never launch
    it — only the dashboard terminal (where Ant is present) may."""
    if context not in VALID_CONTEXTS:
        return f"unknown context {context!r} (expected one of {sorted(VALID_CONTEXTS)})"
    if entry.mode == "interactive" and context == "poller":
        return (f"key {entry.key!r} is mode=interactive and cannot run unattended in the "
                f"poller context; launch it from the dashboard terminal instead")
    return None


# --- the one side-effecting function -----------------------------------------

def run_entry(entry: Entry, context: str, timeout: int = 900, dry_run: bool = False,
              _runner=subprocess.run) -> RunResult:
    """Run a resolved entry under its mode gate, capturing output. ``_runner`` is
    injectable so the timeout/exec paths are testable without a real process."""
    started = _now_iso()

    def _result(status, exit_code, output="", detail=""):
        return RunResult(entry.key, entry.mode, list(entry.cmd), context, status,
                         exit_code, output, started, _now_iso(), detail)

    refusal = check_allowed(entry, context)
    if refusal:
        return _result("refused", -1, detail=refusal)
    if dry_run:
        return _result("dry-run", 0, output="(dry-run; command not executed)",
                       detail=" ".join(entry.cmd))
    try:
        proc = _runner(entry.cmd, capture_output=True, text=True, timeout=timeout, cwd=str(ROOT))
    except subprocess.TimeoutExpired:
        return _result("timeout", -2, detail=f"exceeded {timeout}s")
    except FileNotFoundError as ex:
        return _result("failed", -1, detail=f"command not found: {ex}")
    output = _tail((proc.stdout or "") + (proc.stderr or ""))
    status = "done" if proc.returncode == 0 else "failed"
    return _result(status, proc.returncode, output=output)


# --- CLI ---------------------------------------------------------------------

def _print_list(registry: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps({k: {"mode": e.mode, "cmd": e.cmd, "desc": e.desc}
                          for k, e in sorted(registry.items())}, indent=2))
        return
    if not registry:
        print("(registry empty)")
        return
    width = max(len(k) for k in registry)
    for key in sorted(registry):
        e = registry[key]
        print(f"  {key:<{width}}  [{e.mode:<11}] {e.desc}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("key", nargs="?", help="registry key to run")
    ap.add_argument("--context", default="poller", choices=sorted(VALID_CONTEXTS),
                    help="caller context; poller refuses interactive keys (default: poller)")
    ap.add_argument("--registry", default=str(DEFAULT_REGISTRY), help="path to run-registry.yaml")
    ap.add_argument("--timeout", type=int, default=900, help="seconds before the command is killed")
    ap.add_argument("--dry-run", action="store_true", help="resolve + gate but do not execute")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    ap.add_argument("--list", action="store_true", help="list registry keys and exit")
    ap.add_argument("--validate", action="store_true", help="validate the registry and exit")
    args = ap.parse_args(argv)

    try:
        registry = load_registry(Path(args.registry))
    except (OSError, ValueError, yaml.YAMLError) as ex:
        print(f"error: cannot load registry: {ex}", file=sys.stderr)
        return 2

    if args.validate:
        errors = validate_registry(registry)
        if errors:
            print("registry INVALID:", file=sys.stderr)
            for e in errors:
                print(f"  - {e}", file=sys.stderr)
            return 1
        print(f"registry OK ({len(registry)} keys)")
        return 0

    if args.list:
        _print_list(registry, args.json)
        return 0

    if not args.key:
        ap.error("a registry key is required (or use --list / --validate)")

    # Fail closed: never run against an invalid allowlist.
    errors = validate_registry(registry)
    if errors:
        print("error: registry is invalid; refusing to run. Run --validate.", file=sys.stderr)
        return 2

    try:
        entry = resolve(registry, args.key)
    except KeyError as ex:
        print(f"error: {ex}", file=sys.stderr)
        return 2

    result = run_entry(entry, args.context, timeout=args.timeout, dry_run=args.dry_run)

    if args.json:
        print(json.dumps(asdict(result), indent=2))
    else:
        print(f"[{result.status}] {result.key} ({result.mode}) exit={result.exit_code}")
        if result.detail:
            print(f"  {result.detail}")
        if result.output:
            print(result.output.rstrip())

    return 0 if result.status in ("done", "dry-run") else 1


if __name__ == "__main__":
    sys.exit(main())
