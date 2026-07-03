#!/usr/bin/env bash
# pre-commit-bash32-portability-guard.sh — block staged bash scripts that use
# bash-4+ features or the inline-python heredoc/stdin collision pattern. (#264)
#
# WHY THIS EXISTS
# ---------------
# macOS ships /bin/bash 3.2.57. `bash -n` does NOT catch missing builtins like
# mapfile/readarray, and inline `cmd | python3 - <<'PY'` quietly drops stdin
# because the heredoc already owns fd0. Both failures were caught only after the
# fact in production-ish scripts. This guard stops those patterns at commit time.
#
# WHAT IT MATCHES
# ---------------
# For staged `*.sh` files whose shebang targets bash:
#   - syntax that fails `bash -n` under /bin/bash
#   - bash-4+ features: mapfile/readarray, associative arrays, ${var^^}/${var,,}, &>>
#   - piped inline-python heredocs: `... | python3 - <<'PY'`
#
# Exit 0 = clean, exit 1 = portability hazard found (commit blocked).

set -euo pipefail

staged=$(git diff --cached --name-only --diff-filter=ACMR -- '*.sh' 2>/dev/null || true)
if [[ -z "$staged" ]]; then
    exit 0
fi

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

blocked=0

report_issue() {
    local path="$1"
    local title="$2"
    local details="$3"
    echo "✗ COMMIT BLOCKED (#264): $title in staged bash script $path" >&2
    printf '%b' "$details" >&2
    echo "" >&2
}

while IFS= read -r path; do
    [[ -z "$path" ]] && continue

    if ! blob=$(git show ":$path" 2>/dev/null); then
        continue
    fi

    first_line=$(printf '%s\n' "$blob" | sed -n '1p')
    if [[ "$first_line" != *"bash"* ]]; then
        continue
    fi

    tmp="$tmpdir/$(basename "$path")"
    printf '%s' "$blob" > "$tmp"
    if ! /bin/bash -n "$tmp" >/dev/null 2>&1; then
        syntax_output=$(/bin/bash -n "$tmp" 2>&1 || true)
        report_issue "$path" "bash syntax rejected by /bin/bash" "$syntax_output"
        blocked=1
        continue
    fi

    if [[ "$path" == "scripts/git-hooks/pre-commit-bash32-portability-guard.sh" ]]; then
        continue
    fi

    scan_blob=$(printf '%s\n' "$blob" | grep -nEv '^[[:space:]]*#' || true)
    issues=""

    if hits=$(printf '%s\n' "$scan_blob" | grep -E '(^|[^[:alnum:]_])(mapfile|readarray)([[:space:]]|$)' || true) && [[ -n "$hits" ]]; then
        issues="${issues}  - bash 3.2 lacks mapfile/readarray:\n${hits}\n"
    fi
    if hits=$(printf '%s\n' "$scan_blob" | grep -E 'declare[[:space:]]+-A([[:space:]]|$)' || true) && [[ -n "$hits" ]]; then
        issues="${issues}  - bash 3.2 lacks associative arrays:\n${hits}\n"
    fi
    if hits=$(printf '%s\n' "$scan_blob" | grep -E '\$\{[^}]*(\^\^|,,)' || true) && [[ -n "$hits" ]]; then
        issues="${issues}  - bash 3.2 lacks \${var^^}/\${var,,} case modifiers:\n${hits}\n"
    fi
    if hits=$(printf '%s\n' "$scan_blob" | grep '&>>' || true) && [[ -n "$hits" ]]; then
        issues="${issues}  - bash 3.2 lacks &>> redirection:\n${hits}\n"
    fi
    if hits=$(printf '%s\n' "$scan_blob" | grep -E '\|[[:space:]]*python3?[[:space:]]+-[[:space:]]*<<' || true) && [[ -n "$hits" ]]; then
        issues="${issues}  - inline python heredoc is stealing piped stdin:\n${hits}\n"
    fi

    if [[ -n "$issues" ]]; then
        report_issue "$path" "bash-3.2 portability / heredoc-stdin hazard" "$issues"
        blocked=1
    fi
done <<< "$staged"

if [[ "$blocked" -ne 0 ]]; then
    echo "  Fix the script for /bin/bash 3.2 compatibility before committing." >&2
    echo "  References: ClaudeCode/memory/feedback_macos_bash32.md and" >&2
    echo "  ClaudeCode/memory/feedback_heredoc_stdin_collision.md." >&2
    exit 1
fi

exit 0
