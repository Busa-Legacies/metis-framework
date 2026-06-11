#!/usr/bin/env bash
# commit-or-intent.sh — commit or emit an intent commit when auto-sync frontruns.
#
# WHY (#133, 2026-06-06): the 300s auto-sync daemon snapshots staged files before
# /checkpoint or /end can author a descriptive commit. The /end roll-up filters
# [auto-sync] commits, so without this helper the whole feature is invisible to the
# daily-log roll-up.
#
# USAGE: scripts/commit-or-intent.sh --message-file <file> -- [paths...]
#   or:  scripts/commit-or-intent.sh --message-file <file>   (no paths, any staged)
#
# Behaviour:
#   1. Try git commit with the staged files.
#   2. If "nothing to commit", scan recent [auto-sync] commits (last 5) for the
#      given paths. If found → emit --allow-empty intent commit referencing the SHA.
#   3. If the paths are not found in any recent auto-sync commit → report truly empty
#      (nothing staged and no auto-sync capture) and exit 0 (no-op is OK for idempotent
#      checkpoint/end calls).
#
# Exit codes: 0 = success (committed or intent committed or genuinely empty).
#             1 = error (message file missing, git failure, etc.)

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || exit 1

MSG_FILE=""
declare -a PATHS=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --message-file) MSG_FILE="$2"; shift 2 ;;
        --) shift; PATHS=("$@"); break ;;
        *) echo "commit-or-intent: unknown arg: $1" >&2; exit 1 ;;
    esac
done

if [[ -z "$MSG_FILE" ]]; then
    echo "commit-or-intent: --message-file required" >&2
    exit 1
fi
if [[ ! -f "$MSG_FILE" ]]; then
    echo "commit-or-intent: message file not found: $MSG_FILE" >&2
    exit 1
fi

# Try the real commit first.
if git commit -F "$MSG_FILE" 2>&1; then
    echo "commit-or-intent: committed."
    exit 0
fi

# Nothing to commit. Look for paths in recent auto-sync commits.
AUTOSYNC_SHA=""
AUTOSYNC_FOUND_PATHS=""

# Check last 5 auto-sync commits.
while IFS= read -r sha; do
    if [[ -z "$sha" ]]; then continue; fi
    changed=$(git diff-tree --no-commit-id -r --name-only "$sha" 2>/dev/null)
    if [[ ${#PATHS[@]} -eq 0 ]]; then
        # No explicit paths: any file in the auto-sync commit counts.
        if [[ -n "$changed" ]]; then
            AUTOSYNC_SHA="$sha"
            AUTOSYNC_FOUND_PATHS="$changed"
            break
        fi
    else
        # Check if any of the specified paths appear in this commit.
        for p in "${PATHS[@]}"; do
            if echo "$changed" | grep -qF "$p"; then
                AUTOSYNC_SHA="$sha"
                AUTOSYNC_FOUND_PATHS="${AUTOSYNC_FOUND_PATHS:+$AUTOSYNC_FOUND_PATHS }$p"
            fi
        done
        if [[ -n "$AUTOSYNC_SHA" ]]; then break; fi
    fi
done < <(git log --oneline --grep='\[auto-sync\]' -5 --format="%H")

if [[ -z "$AUTOSYNC_SHA" ]]; then
    echo "commit-or-intent: nothing staged and no auto-sync capture found — OK (idempotent)."
    exit 0
fi

SHORT_SHA=$(git rev-parse --short "$AUTOSYNC_SHA")

# Build an intent commit message that references the auto-sync capture.
INTENT_FILE="$(mktemp)"
{
    # Read the original message as the subject/body.
    cat "$MSG_FILE"
    echo ""
    echo "auto-sync frontrun: this work was captured in [auto-sync] $SHORT_SHA"
    echo "before the intent commit could be authored. This commit preserves the"
    echo "descriptive history entry so the /end roll-up includes it."
    echo "paths: ${AUTOSYNC_FOUND_PATHS:-<unknown>}"
} >"$INTENT_FILE"

echo "commit-or-intent: auto-sync captured work in $SHORT_SHA; emitting intent commit."
git commit --allow-empty -F "$INTENT_FILE"
EXIT=$?
rm -f "$INTENT_FILE"
exit $EXIT
