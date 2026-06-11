#!/usr/bin/env bash
# Canonical, SELF-DETECTING machine-identity hook (UserPromptSubmit additionalContext).
# One script, installed identically on both machines via mirror-apply.sh; it keys on
# $USER to emit the CORRECT identity for whichever machine it runs on. This replaces
# the old per-machine variants (Jay's inline echo / Jarry's hardcoded script) so the
# identity can be mirrored without ever telling a machine it is the other one.
#
# Jay  = antfox-macbook,        user Ant,   64GB M1 Max, primary always-on, local Ollama host
# Jarry= anthonys-macbook-pro,  user abusa, 32GB,        secondary/on-demand, routes to Jay

JAY_IP="<<MACHINE_1_TAILSCALE_IP>>"     # antfox-macbook Tailscale IP — update if it ever changes
JARRY_IP="<<MACHINE_2_TAILSCALE_IP>>"  # anthonys-macbook-pro Tailscale IP — update if it ever changes

live_ip=$(tailscale ip -4 2>/dev/null | head -1)

case "$(id -un)" in
  Ant)
    [ -n "$live_ip" ] && JAY_IP="$live_ip"
    identity="MACHINE IDENTITY (read this first): You are running on JAY — antfox-macbook, user Ant, 64GB M1 Max MacBook Pro, Tailscale ${JAY_IP}. This is the primary always-on OpenClaw agent and the SOLE local-model host (Ollama qwen3-coder:30b). JARRY is the OTHER machine: anthonys-macbook-pro, user abusa, 32GB, Tailscale ${JARRY_IP} — secondary/on-demand, routes its lanes to THIS machine's Ollama. When Ant says \"Jay\" he means HERE (antfox-macbook). When he says \"Jarry\" he means the anthonys-macbook-pro machine. Never confuse the two. To reach Jarry: ssh -i ~/.ssh/jarry_access abusa@${JARRY_IP}"
    ;;
  abusa)
    [ -n "$live_ip" ] && JARRY_IP="$live_ip"
    identity="MACHINE IDENTITY (read this first): You are running on JARRY — anthonys-macbook-pro, user abusa, 32GB MacBook Pro, Tailscale ${JARRY_IP}. This is the secondary/on-demand OpenClaw agent; it routes its lanes to JAY's Ollama rather than running local models. JAY is the OTHER machine: antfox-macbook, user Ant, 64GB M1 Max, Tailscale ${JAY_IP} — primary always-on agent and local-model host. When Ant says \"Jarry\" he means HERE (anthonys-macbook-pro). When he says \"Jay\" he means the antfox-macbook machine. Never confuse the two. To reach Jay: ssh -i ~/.ssh/jay_access Ant@${JAY_IP} or Jay gateway at ${JAY_IP}:18789"
    ;;
  *)
    identity="MACHINE IDENTITY: unrecognized user '$(id -un)' — neither Jay (Ant) nor Jarry (abusa). Verify which machine this is before acting on cross-machine instructions."
    ;;
esac

python3 -c "import json,sys; print(json.dumps({'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit', 'additionalContext': sys.argv[1]}}))" "$identity"
