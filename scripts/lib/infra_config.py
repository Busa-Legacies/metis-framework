"""Loader for config/infrastructure.json — the single seam where a consuming org
declares its machines, agents, model, and domains. Core scripts call these helpers
instead of hardcoding a specific topology.

Tolerant by design: if the config is still a template (placeholder `<<...>>`
values) or missing, the helpers fall back to a minimal generic default so the
scripts load and run rather than crashing. A consuming org fills in
config/infrastructure.json once and the values flow everywhere.
"""
import json
import os
from pathlib import Path

_HOME = os.environ.get("METIS_HOME") or os.environ.get("METIS_CORE") or str(Path(__file__).resolve().parents[2])
_CONFIG_PATH = Path(_HOME) / "config" / "infrastructure.json"


def _is_placeholder(v) -> bool:
    return isinstance(v, str) and v.startswith("<<") and v.endswith(">>")


def load() -> dict:
    try:
        return json.loads(_CONFIG_PATH.read_text())
    except (OSError, ValueError):
        return {}


def machines() -> list:
    """List of machine dicts with real (non-placeholder) ids."""
    ms = load().get("machines", []) or []
    return [m for m in ms if isinstance(m, dict) and not _is_placeholder(m.get("id"))]


def machine_agents() -> dict:
    """{machine_id: set(agent_identities)} — ownership/WIP map.
    Falls back to a single generic primary machine if config is unfilled."""
    out = {}
    for m in machines():
        mid = m.get("id")
        agents = {a for a in (m.get("agents") or []) if not _is_placeholder(a)}
        agents.add(mid)
        agents.add("claude")
        out[mid] = agents
    return out or {"primary": {"primary", "claude"}}


def primary_machine() -> str:
    """Default machine id for this install: the one marked role 'primary', else the
    first declared machine, else a generic 'primary' (matches machine_agents()'s key).
    Lets scripts default to the org's own topology instead of a hardcoded host."""
    ms = machines()
    for m in ms:
        if m.get("role") == "primary" and m.get("id"):
            return m["id"]
    if ms and ms[0].get("id"):
        return ms[0]["id"]
    return "primary"


def dispatchable_agents() -> set:
    a = load().get("agents", {}) or {}
    vals = {x for x in (a.get("dispatchable") or []) if not _is_placeholder(x)}
    return vals  # empty set = nothing auto-dispatched until the org declares lanes


def dispatchable_machines() -> set:
    a = load().get("agents", {}) or {}
    vals = {x for x in (a.get("dispatchableMachines") or []) if not _is_placeholder(x)}
    vals.add("either")
    return vals


def domains() -> list:
    # Canonical shape is {"domains": {"list": [...]}}, but tolerate a bare
    # {"domains": [...]} list since that's an easy way for a consumer to fill it in.
    d = load().get("domains", {}) or {}
    raw = d if isinstance(d, list) else (d.get("list") or [])
    return [x for x in raw if not _is_placeholder(x)] or ["uncategorized"]


def model_host_machine() -> str:
    """Machine id marked as the model/inference host (modelHost: true), else primary.
    Lets scripts ask 'is this the host that serves local models?' without a hardcoded
    hostname check."""
    for m in machines():
        if m.get("modelHost") and m.get("id"):
            return m["id"]
    return primary_machine()


def detect_machine(override: str | None = None) -> str:
    """Identify THIS machine's id from host signals, matched against the declared
    topology — no hardcoded hostnames. Resolution order: explicit override >
    METIS_MACHINE / FREE_WORK_MACHINE env > a machine whose id/user/hostname appears
    in the host signals (scutil LocalHostName, $USER, $HOME, gethostname) > primary."""
    import socket
    import subprocess
    if override and not _is_placeholder(override):
        return override.lower()
    env = os.environ.get("METIS_MACHINE") or os.environ.get("FREE_WORK_MACHINE")
    if env:
        return env.lower()
    user = (os.environ.get("USER") or "").lower()
    home = str(Path.home()).lower()
    namesig = ""
    try:
        r = subprocess.run(["scutil", "--get", "LocalHostName"],
                           capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            namesig += " " + r.stdout.strip().lower()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    try:
        namesig += " " + socket.gethostname().lower()
    except OSError:
        pass
    ms = machines()
    # 1. Exact unix-user match — the most reliable discriminator between hosts.
    #    (Substring matching would misfire: a short user id can be a substring of
    #    another host's longer hostname, so require an exact user match here.)
    for m in ms:
        if user and (m.get("user") or "").lower() == user:
            return (m.get("id") or "").lower()
    # 2. Machine id or hostname appears in the host's name signals (specific tokens).
    for m in ms:
        mid = (m.get("id") or "").lower()
        host = (m.get("hostname") or "").lower()
        if (mid and mid in namesig) or (host and host in namesig):
            return mid
    # 3. Home-path user component (e.g. /users/<user>/...).
    for m in ms:
        mu = (m.get("user") or "").lower()
        if mu and f"/{mu}" in home:
            return (m.get("id") or "").lower()
    return primary_machine()


if __name__ == "__main__":
    # CLI shim so shell scripts can resolve topology without hardcoding personas:
    #   python3 scripts/lib/infra_config.py detect-machine [override]
    import sys
    _arg = sys.argv[1] if len(sys.argv) > 1 else ""
    if _arg == "detect-machine":
        print(detect_machine(sys.argv[2] if len(sys.argv) > 2 else None))
    elif _arg == "primary-machine":
        print(primary_machine())
    elif _arg == "model-host":
        print(model_host_machine())
    elif _arg == "domains":
        print(" ".join(domains()))
    else:
        sys.exit("usage: infra_config.py {detect-machine|primary-machine|model-host|domains}")
