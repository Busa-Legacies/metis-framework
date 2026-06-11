#!/usr/bin/env bash
# Shared maintenance-window helpers for Jay. Source this — no side effects.
#
#   source "$(dirname "$0")/lib/maintenance.sh"
#
# The marker file is the SINGLE SOURCE OF TRUTH that the rest of the system
# reads to know Jay is in a planned-downtime window. Consumers:
#   - scripts/heartbeat.sh + scripts/tailscale-watchdog.sh  -> suppress alerts
#   - dashboard /api/architecture (_maintenance)            -> show "maintenance"
# so a scheduled restart never pages us with a false "Jay down" alarm.

# Resolve METIS_HOME via the canonical self-locating helper when present.
_mw_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$_mw_lib_dir/paths.env" ] && . "$_mw_lib_dir/paths.env"

MAINTENANCE_MARKER="${MAINTENANCE_MARKER:-$HOME/.openclaw/state/jay-maintenance.json}"
MW_DISCORD_CHANNEL="${MW_DISCORD_CHANNEL:-1489674856579600455}"  # #status-log

# maintenance_active -> exit 0 if a window is currently active and not expired.
maintenance_active() {
  [ -f "$MAINTENANCE_MARKER" ] || return 1
  python3 - "$MAINTENANCE_MARKER" <<'PY' 2>/dev/null
import json, sys, time
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if d.get("active") and time.time() < float(d.get("until", 0)) else 1)
PY
}

maintenance_reason() {
  [ -f "$MAINTENANCE_MARKER" ] || { echo "scheduled maintenance"; return; }
  python3 - "$MAINTENANCE_MARKER" <<'PY' 2>/dev/null || echo "scheduled maintenance"
import json, sys
print(json.load(open(sys.argv[1])).get("reason", "scheduled maintenance"))
PY
}

# maintenance_begin <reason> <grace_minutes> — open a window valid for N minutes.
maintenance_begin() {
  local reason="${1:-scheduled maintenance}" mins="${2:-25}"
  mkdir -p "$(dirname "$MAINTENANCE_MARKER")"
  python3 - "$MAINTENANCE_MARKER" "$reason" "$mins" <<'PY'
import json, sys, time, socket
path, reason, mins = sys.argv[1], sys.argv[2], float(sys.argv[3])
now = time.time()
json.dump(
    {"active": True, "reason": reason, "started": now,
     "until": now + mins * 60, "host": socket.gethostname()},
    open(path, "w"),
)
PY
}

maintenance_clear() { rm -f "$MAINTENANCE_MARKER" 2>/dev/null || true; }

# mw_notify <message> — best-effort Discord post to #status-log.
mw_notify() {
  local msg="$1" token
  token=$(python3 "$_mw_lib_dir/../discord-token.py" 2>/dev/null || echo "")
  [ -z "$token" ] && return 0
  curl -s -X POST "https://discord.com/api/v10/channels/${MW_DISCORD_CHANNEL}/messages" \
    -H "Authorization: Bot $token" -H "Content-Type: application/json" \
    -d "{\"content\": \"$msg\"}" >/dev/null 2>&1 || true
}
