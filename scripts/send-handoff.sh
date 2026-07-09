#!/usr/bin/env bash
# send-handoff.sh — POST /end cross-session handoff to <<MACHINE_1_ID>>'s gateway.
#
# Usage (pass JSON via arg or stdin):
#   scripts/send-handoff.sh '{"done":[...],"next":[...],"blockers":[...],"summary":"..."}'
#   echo '...' | scripts/send-handoff.sh
#
# from:claude-code is injected automatically if absent.
# Exits 0 always — <<MACHINE_1_ID>> unreachable is non-blocking.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
JAY_ENDPOINT="$("$SCRIPT_DIR/service-url.py" get dashboard.api --context tailnet --path api/handoff 2>/dev/null || true)"
if [ -z "$JAY_ENDPOINT" ]; then
  . "$SCRIPT_DIR/lib/network.env"
  JAY_ENDPOINT="http://${JAY_IP}:8080/api/handoff"
fi

payload="${1:-$(cat 2>/dev/null)}"
[[ -z "$payload" ]] && { echo "send-handoff: no payload (pass JSON arg or pipe)"; exit 1; }

payload=$(python3 -c "
import sys, json
d = json.loads(sys.argv[1])
d.setdefault('from', 'claude-code')
print(json.dumps(d))
" "$payload" 2>/dev/null) || { echo "send-handoff: invalid JSON payload"; exit 1; }

if curl -sf --max-time 5 -X POST "$JAY_ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "$payload" >/dev/null 2>&1; then
    echo "handoff → <<MACHINE_1_ID>>: sent"
else
    echo "handoff → <<MACHINE_1_ID>>: unreachable at ${JAY_ENDPOINT} (non-blocking, continuing close)"
fi
exit 0
