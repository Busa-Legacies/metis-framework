#!/usr/bin/env bash
# Canonical, SELF-DETECTING machine-identity hook (UserPromptSubmit additionalContext).
# One script, installed identically on every machine via mirror-apply.sh; it keys on
# $USER to emit the CORRECT identity for whichever machine it runs on, so the same
# file can be mirrored without ever telling a machine it is the other one.
#
# Topology is read from config/infrastructure.json (machines[]). Each machine entry:
#   { "id": "...", "role": "primary|secondary", "user": "<unix-user>",
#     "tailscaleIp": "...", "modelHost": true|false }
# The live Tailscale IP overrides the configured one when available.

ROOT="${METIS_HOME:-${METIS_CORE:-$(cd "$(dirname "$0")/../.." && pwd)}}"
CONFIG="$ROOT/config/infrastructure.json"
live_ip=$(tailscale ip -4 2>/dev/null | head -1)
me="$(id -un)"

identity=$(CONFIG="$CONFIG" ME="$me" LIVE_IP="$live_ip" python3 <<'PY'
import json, os
cfg_path, me, live_ip = os.environ["CONFIG"], os.environ["ME"], os.environ.get("LIVE_IP", "")
try:
    machines = json.load(open(cfg_path)).get("machines", []) or []
except Exception:
    machines = []
def real(v): return isinstance(v, str) and not (v.startswith("<<") and v.endswith(">>"))
mine = next((m for m in machines if m.get("user") == me), None)
if not mine:
    print(f"MACHINE IDENTITY: unrecognized user '{me}' — not in config/infrastructure.json machines[]. "
          "Verify which machine this is before acting on cross-machine instructions.")
else:
    ip = live_ip or (mine.get("tailscaleIp") if real(mine.get("tailscaleIp")) else "?")
    others = [m for m in machines if m is not mine]
    host = "the SOLE local-model host" if mine.get("modelHost") else "a model-host client (routes to the primary host)"
    parts = [f"MACHINE IDENTITY (read this first): You are running on '{mine.get('id')}' "
             f"(role={mine.get('role','?')}, user {me}, Tailscale {ip}). This machine is {host}."]
    for o in others:
        oip = o.get("tailscaleIp") if real(o.get("tailscaleIp")) else "?"
        parts.append(f"OTHER machine: '{o.get('id')}' (role={o.get('role','?')}, user {o.get('user','?')}, "
                     f"Tailscale {oip}). Never confuse the two.")
    print(" ".join(parts))
PY
)

python3 -c "import json,sys; print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': sys.argv[1]}}))" "$identity"
