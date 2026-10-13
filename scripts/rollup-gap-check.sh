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
# NOT glob order (#798, full-sweep-2026-07-16): the alphabetical glob put every
# daily-log-YYYY-MM-DD.md AFTER every YYYY-MM-DD.md, so a stale boundary from the
# legacy scheme shadowed newer ones; and hand-written lines (`backticked` SHAs,
# "closed-at: LIVE") made git-log ranges fail silently -> a FALSE "clean" pass.
# The boundary is the newest-by-commit-time VALID closed-at SHA, scheme-agnostic.
last_closed=""
last_ts=0
skipped=0
while IFS= read -r sha; do
    sha="${sha//\`/}"                               # tolerate backtick-wrapped SHAs
    if [[ ! "$sha" =~ ^[0-9a-f]{7,40}$ ]]; then     # reject non-SHA values (e.g. LIVE)
        skipped=$((skipped + 1))
        continue
    fi
    git cat-file -e "${sha}^{commit}" 2>/dev/null || { skipped=$((skipped + 1)); continue; }
    ts=$(git show -s --format=%ct "$sha" 2>/dev/null || echo 0)
    if ((ts > last_ts)); then
        last_ts=$ts
        last_closed=$sha
    fi
done < <(grep -h '^closed-at:' "$LOG_DIR"/*.md 2>/dev/null | awk '{print $2}')
[[ "$skipped" -gt 0 ]] && echo "[rollup-gap] note: skipped $skipped invalid/unresolvable closed-at line(s)"
if [[ -z "$last_closed" ]]; then
    echo "[rollup-gap] No valid closed-at boundary found — cannot scope a range. Treating as clean."
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
# can advance over now-captured work.
#
# #1020 root-cause: this used to write ONE LINE PER GAP COMMIT straight into the
# human daily log. A stale boundary (multi-day gap, or just a busy multi-session
# day) can mean hundreds of gap commits, and a raw one-line-per-commit dump blew
# the #270 60-line daily-log distillation contract in a single append (confirmed:
# 2026-07-20.md hit 290 lines from exactly this, then sat over-budget for a week
# because nothing ever revisits it). The anti-swallow invariant only needs each
# SHA to appear *somewhere* in $LOG_DIR/*.md (grep -F is substring, not
# line-scoped) — it doesn't need one line per commit. So: full SHA+subject detail
# goes to a non-budget-checked raw archive (matching the existing
# workspace/state/audits/daily-log-raw/ convention from earlier manual distillation
# passes); the daily log itself gets a compact chunked-SHA reference that keeps
# future gap-checks passing without the line-count blowup.
if [[ -n "$APPEND_TO" ]]; then
    mkdir -p "$(dirname "$APPEND_TO")"
    # cwd is already the repo root (set at top of script via `cd "$(git rev-parse --show-toplevel)"`).
    RAW_DIR="workspace/state/audits/daily-log-raw"
    mkdir -p "$RAW_DIR"
    RAW_FILE="$RAW_DIR/$(basename "$APPEND_TO")"

    {
        echo "## rollup-gap auto-attribution ($(date '+%Y-%m-%d %H:%M'))"
        echo "_Commits in ${last_closed}..HEAD that no daily log referenced; captured here so the roll-up boundary does not swallow them._"
        printf -- '- %s\n' "${gaps[@]}"
        echo
    } >>"$RAW_FILE"

    {
        echo "## rollup-gap auto-attribution ($(date '+%Y-%m-%d %H:%M'))"
        echo "_${#gaps[@]} commit(s) in ${last_closed}..HEAD captured (SHA-only, chunked, to stay inside the 60-line daily-log contract); full subjects in \`workspace/state/audits/daily-log-raw/$(basename "$APPEND_TO")\`._"
        chunk=""
        n=0
        for line in "${gaps[@]}"; do
            sha="${line%% *}"
            chunk+="${sha} "
            n=$((n + 1))
            if ((n % 20 == 0)); then
                echo "- $chunk"
                chunk=""
            fi
        done
        [[ -n "$chunk" ]] && echo "- $chunk"
        echo
    } >>"$APPEND_TO"

    echo "[rollup-gap] Appended ${#gaps[@]} attribution(s): full detail -> ${RAW_FILE}, compact SHA refs -> ${APPEND_TO}"
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
