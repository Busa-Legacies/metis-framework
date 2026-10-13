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

# Progress-as-events: mirror the session close to Discord #status as one pulse so the
# comms surface shows session boundaries (docs/process/discord-comms-architecture.md).
# Best-effort + fail-soft — a Discord hiccup must never break the close.
python3 - "$payload" "$SCRIPT_DIR" <<'PY' 2>/dev/null || true
import sys, json
try:
    d = json.loads(sys.argv[1])
    summary = (d.get("summary") or "").strip()
    n_done = len(d.get("done") or [])
    n_next = len(d.get("next") or [])
    frm = d.get("from", "claude-code")
    if not summary and not n_done:
        raise SystemExit(0)
    bits = []
    if n_done:  bits.append(f"{n_done} done")
    if n_next:  bits.append(f"{n_next} queued")
    tail = f" ({', '.join(bits)})" if bits else ""
    line = f"📋 session handoff — {summary or 'session closed'}{tail} · {frm}"
    sys.path.insert(0, sys.argv[2])  # SCRIPT_DIR — locate discord_notify regardless of CWD
    import discord_notify
    discord_notify.notify_raw(line, channel_id=discord_notify.STATUS_CHANNEL)
except Exception:
    pass
PY
exit 0
