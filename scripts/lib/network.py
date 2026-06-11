"""Canonical Tailscale IPs for standalone Python scripts (jlane, lane-debug,
self-review, memory_rag). Env-overridable — `export JAY_IP=...` wins; the literal
is only the fallback for a bare invocation. Mirrors scripts/lib/network.env (shell)
and projects/dashboard/app/core/config.py (dashboard package)."""
import os

JAY_IP = os.environ.get("JAY_IP") or "<<MACHINE_1_TAILSCALE_IP>>"      # antfox-macbook (primary)
JARRY_IP = os.environ.get("JARRY_IP") or "<<MACHINE_2_TAILSCALE_IP>>"  # anthonys-macbook-pro (secondary)
