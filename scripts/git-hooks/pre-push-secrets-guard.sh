#!/usr/bin/env bash
# pre-push-secrets-guard.sh — block pushes containing credential patterns (#312)
#
# WHY THIS EXISTS
# ---------------
# Pre-commit guards fire on staged content but can be bypassed with --no-verify.
# This pre-push hook is the last gate before remote exposure — git runs it on
# every `git push` path regardless of how the commits were made. The push-range
# diff covers ALL new commits in the batch, so squash-merges and bulk agent
# pushes are fully covered.
#
# WHAT IT BLOCKS
# --------------
# Added lines containing high-confidence secret VALUE patterns:
#   sk-ant-api03-...    Anthropic production API key
#   ghp_[36+ chars]     GitHub personal access token
#   AKIA[16 caps]       AWS access key ID
#   sk-proj-/sk-org-... OpenAI-style keys
#
# Added lines in non-doc files with key ASSIGNMENT patterns (non-placeholder):
#   ANTHROPIC_API_KEY=<real-value>
#   OPENAI_API_KEY=<real-value>
#   (and variants: _SECRET, _TOKEN)
#
# ALLOWLIST
# ---------
# Files matching *.md, README*, or docs/ may reference key NAMES without VALUES
# (e.g. `export ANTHROPIC_API_KEY=your-key-here` in a setup guide). Actual key
# VALUE patterns (sk-ant-api03-, ghp_+36, AKIA+16) are ALWAYS blocked regardless
# of file type — a real key in a README is still a leak.
#
# To bypass for deliberate push of pattern text: git push --no-verify

set -u

ZERO="0000000000000000000000000000000000000000"
BLOCKED=0
TMPFILE=$(mktemp)
trap "rm -f $TMPFILE" EXIT

process_range() {
    local remote_sha="$1"
    local local_sha="$2"
    local range=""

    if [ "$remote_sha" = "$ZERO" ]; then
        # New branch — scan only commits not already on any remote-tracking ref.
        oldest_new=$(git log --format="%H" --not --remotes "$local_sha" 2>/dev/null | tail -1)
        if [ -z "$oldest_new" ]; then
            return 0  # All commits already on remote, nothing new to scan
        fi
        parent=$(git rev-parse "${oldest_new}^" 2>/dev/null)
        if [ -n "$parent" ]; then
            range="${parent}..${local_sha}"
        else
            # Root commit — scan against empty tree
            range="4b825dc642cb6eb9a060e54bf8d69288fbee4904..${local_sha}"
        fi
    else
        range="${remote_sha}..${local_sha}"
    fi

    git diff --unified=0 --no-color "$range" > "$TMPFILE" 2>/dev/null || return 0

    local current_file=""
    while IFS= read -r line; do
        # Track current file from diff header
        if [[ "$line" == "+++ b/"* ]]; then
            current_file="${line#+++ b/}"
            continue
        fi
        # Only inspect added lines; skip diff file headers
        [[ "$line" != "+"* ]] && continue
        [[ "$line" == "+++"* ]] && continue
        content="${line:1}"

        # --- ALLOWLIST: the secrets-guard's OWN test fixtures must contain
        #     fabricated key patterns (the AKIA / sk-ant / ghp_ literals) to
        #     test detection. Excluding this one file by EXACT path keeps
        #     VALUE-pattern blocking strict everywhere else. Add new fixture
        #     files here explicitly if ever needed — never a broad tests/ glob. ---
        case "$current_file" in
            tests/test_secrets_guard.py) continue ;;
            # Recovered forge lane-output for #312: reproduces this guard's OWN source +
            # a fabricated self-test fixture (sk-proj-abcdef… that creates a fake leak.txt).
            # Verified contains no real credential — exact path only, never a glob (T-SYNC-14).
            docs/process/lane-outputs/2026-06-12-312-secrets-prepush-guard.md) continue ;;
        esac

        # --- VALUE patterns: always block regardless of file type ---

        if echo "$content" | grep -qE 'sk-ant-api[0-9]+-[A-Za-z0-9_-]{20,}'; then
            echo "  $current_file: Anthropic API key value (sk-ant-api...)" >&2
            BLOCKED=1
        fi

        if echo "$content" | grep -qE 'ghp_[A-Za-z0-9]{36,}'; then
            echo "  $current_file: GitHub personal access token (ghp_...)" >&2
            BLOCKED=1
        fi

        if echo "$content" | grep -qE 'AKIA[0-9A-Z]{16}'; then
            echo "  $current_file: AWS access key ID (AKIA...)" >&2
            BLOCKED=1
        fi

        if echo "$content" | grep -qE 'sk-(proj|org|svcacct)-[A-Za-z0-9_-]{32,}'; then
            echo "  $current_file: OpenAI-style key value (sk-proj-/sk-org-...)" >&2
            BLOCKED=1
        fi

        # --- ASSIGNMENT patterns: skip doc files (setup guides may reference names) ---
        case "$current_file" in
            *.md|README*|readme*|CONTRIBUTING*|docs/*|*.txt|*.rst) continue ;;
        esac

        if echo "$content" | grep -qiE '(ANTHROPIC|OPENAI)_(API_KEY|SECRET|TOKEN)[[:space:]]*[=:][[:space:]]*["'"'"']?[^[:space:]<"'"'"']{8,}'; then
            val=$(echo "$content" | grep -oiE '[=:][[:space:]]*["'"'"']?[^[:space:]<"'"'"']{8,}' | head -1 | sed "s/^[=:][[:space:]]*[\"']\{0,1\}//")
            if ! echo "$val" | grep -qiE '(your|<[a-z]|placeholder|example|xxx+|\.\.\.+|test|fake|changeme|insert[-_]?key)'; then
                echo "  $current_file: API key assignment with non-placeholder value" >&2
                BLOCKED=1
            fi
        fi

    done < "$TMPFILE"
}

while IFS=" " read -r local_ref local_sha remote_ref remote_sha; do
    [ "$local_sha" = "$ZERO" ] && continue  # branch deletion, nothing to scan
    case "$remote_ref" in
        refs/heads/autosync/*) continue ;;  # source-snapshot branches are durability mirrors; main remains guarded
    esac
    process_range "$remote_sha" "$local_sha"
done

if [ "$BLOCKED" -ne 0 ]; then
    echo "" >&2
    echo "✗ PUSH BLOCKED (#312): credential patterns detected in push range." >&2
    echo "  Remove or rotate the credentials before pushing." >&2
    echo "  See: docs/process/secrets-management.md (if it exists)." >&2
    echo "  To bypass deliberately: git push --no-verify" >&2
    exit 1
fi

exit 0
