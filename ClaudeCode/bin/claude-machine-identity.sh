#!/usr/bin/env bash
# Canonical, SELF-DETECTING machine-identity hook (UserPromptSubmit additionalContext).
# One script, installed identically on every machine; it keys on $USER against the
# org's machines[] declared in config/infrastructure.json and emits the CORRECT
# identity for whichever machine it runs on — so the identity can be mirrored
# without ever telling a machine it is the other one. Nothing here is org-specific:
# a consuming org fills in infrastructure.json once and this hook just reads it.

CONFIG="${METIS_HOME:-$HOME/metis-os}/config/infrastructure.json"
[ -f "$CONFIG" ] || CONFIG="$(cd "$(dirname "$0")/../.." && pwd)/config/infrastructure.json"

live_ip=$(tailscale ip -4 2>/dev/null | head -1)

identity=$(LIVE_IP="$live_ip" python3 - "$CONFIG" <<'PY' 2>/dev/null
import json, os, sys
try:
    cfg = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
machines = cfg.get("machines", [])
me = os.environ.get("USER", "")
mine = next((m for m in machines if m.get("user") == me), None)
if not mine:
    print(f"MACHINE IDENTITY: unrecognized user '{me}' — no machines[] entry in "
          "config/infrastructure.json matches. Verify which machine this is before "
          "acting on cross-machine instructions.")
    sys.exit(0)
live = os.environ.get("LIVE_IP")
if live:
    mine["tailscaleIp"] = live
def desc(m):
    host = "local model host" if m.get("modelHost") else "routes to the model host"
    return (f"{m.get('id', '?')} — user {m.get('user', '?')}, {m.get('role', '?')}, "
            f"{host}, Tailscale {m.get('tailscaleIp', '?')}")
line = (f"MACHINE IDENTITY (read this first): You are running on {desc(mine)}.")
others = [m for m in machines if m is not mine]
if others:
    line += (" The OTHER machine(s): " + "; ".join(desc(m) for m in others) +
             ". Never confuse them.")
print(line)
PY
)

[ -z "$identity" ] && exit 0
python3 -c "import json,sys; print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': sys.argv[1]}}))" "$identity"
