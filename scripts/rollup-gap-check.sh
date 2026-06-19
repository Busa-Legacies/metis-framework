#!/usr/bin/env bash
# rollup-gap-check.sh — close-time guard against the multi-session roll-up gap.
#
# THE GAP: each /end daily-log entry narrates only its own session's work, but the
# git range <last-closed-at>..HEAD can include intentional commits authored by a
# *concurrent* session. When this session advances the closed-at boundary, those
# unmentioned commits are swallowed — they land in no daily log, ever. (Real case:
# the /restart-fix commits f3ce759/50432c4 sat unlogged because another session's
# close advanced the boundary past them.)
#
# THE FIX: before advancing the boundary, every intentional commit in the open
# range must be referenced (by abbreviated SHA) in a daily-log file. This guard
# enforces that — run it during /end step 6 BEFORE writing the new closed-at.
# Anything it flags must be logged (a one-line attribution with the short SHA is
# enough) so the boundary only ever advances over captured work.
#
# Convention this depends on: daily-log entries cite the short SHA(s) of the
# commit(s) they describe. The git roll-up already lists them with --oneline;
# paste those SHAs into the entry and this check passes cleanly.
#
# Exit 0 = range empty or fully attributed. Exit 1 = unattributed commits found.
#
# --append-to <log>: instead of failing on unattributed commits, write a one-line
# SHA attribution for each directly into <log> (created if absent) and exit 0.
# Point it at a workspace/memory daily log so future runs see the SHAs and pass cleanly.
# Use during /end to auto-close the gap rather than hand-pasting each SHA.

set -euo pipefail

APPEND_TO=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --append-to)
            APPEND_TO="${2:?--append-to requires a <log> path}"
            shift 2
            ;;
        --append-to=*)
            APPEND_TO="${1#*=}"
            shift
            ;;
        -h | --help)
            grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "[rollup-gap] unknown argument: $1" >&2
            exit 2
            ;;
    esac
done

cd "$(git rev-parse --show-toplevel)"

LOG_DIR="workspace/memory"

# Current open-range start = the most recent closed-at across the daily logs.
# Shell glob expands in alphabetical order, which for YYYY-MM-DD.md is chronological,
# so the last closed-at line is the newest boundary.
last_closed=$(grep -h '^closed-at:' "$LOG_DIR"/*.md 2>/dev/null | tail -1 | awk '{print $2}')
if [[ -z "$last_closed" ]]; then
    echo "[rollup-gap] No closed-at boundary found — cannot scope a range. Treating as clean."
    exit 0
fi

# Intentional commits in range: exclude [auto-sync] durability snapshots and merges.
# (read loop instead of mapfile — macOS ships bash 3.2, which lacks mapfile.)
commits=()
while IFS= read -r line; do
    [[ -n "$line" ]] && commits+=("$line")
done < <(git log "${last_closed}..HEAD" --no-merges \
    --invert-grep --grep='\[auto-sync\]' --format='%h %s' 2>/dev/null)

if [[ ${#commits[@]} -eq 0 ]]; then
    echo "[rollup-gap] No intentional commits in ${last_closed}..HEAD — clean."
    exit 0
fi

gaps=()
for line in "${commits[@]}"; do
    sha="${line%% *}"
    if ! grep -hqF "$sha" "$LOG_DIR"/*.md 2>/dev/null; then
        gaps+=("$line")
    fi
done

if [[ ${#gaps[@]} -eq 0 ]]; then
    echo "[rollup-gap] OK — all ${#commits[@]} in-range commit(s) referenced in $LOG_DIR."
    exit 0
fi

# --append-to: write the attributions directly instead of failing, so the boundary
# can advance over now-captured work. One line per gap commit, SHA-first so a later
# grep -F on the short SHA matches.
if [[ -n "$APPEND_TO" ]]; then
    mkdir -p "$(dirname "$APPEND_TO")"
    {
        echo "## rollup-gap auto-attribution ($(date '+%Y-%m-%d %H:%M'))"
        echo "_Commits in ${last_closed}..HEAD that no daily log referenced; captured here so the roll-up boundary does not swallow them._"
        printf -- '- %s\n' "${gaps[@]}"
        echo
    } >>"$APPEND_TO"
    echo "[rollup-gap] Appended ${#gaps[@]} attribution(s) to ${APPEND_TO}:"
    printf '  %s\n' "${gaps[@]}"
    exit 0
fi

echo "[rollup-gap] WARNING: ${#gaps[@]} of ${#commits[@]} intentional commit(s) in ${last_closed}..HEAD"
echo "             are NOT referenced in any daily log:"
printf '  %s\n' "${gaps[@]}"
echo
echo "These will be SWALLOWED when the closed-at boundary advances past them. Add a"
echo "one-line attribution (with the short SHA) for each to the daily log before"
echo "writing the new closed-at, then re-run this check. Or re-run with"
echo "--append-to <workspace/memory/YYYY-MM-DD.md> to capture them automatically."
exit 1
