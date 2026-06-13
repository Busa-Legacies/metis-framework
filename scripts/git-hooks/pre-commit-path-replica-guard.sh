#!/usr/bin/env bash
# pre-commit-path-replica-guard.sh — block commits where a file was written to
# an absolute-path replica inside the repo. (#076)
#
# WHY THIS EXISTS
# ---------------
# Scribe (and occasionally other lanes) wrote output files using absolute paths
# (~session 7: created files under $HOME/Ant-openclaw-framework/ inside the
# repo tree, producing paths like
#   projects/dashboard$HOME/Ant-openclaw-framework/Jay/memory/2026-xx.md).
# Auto-sync committed them silently, polluting the repo with duplicated content.
#
# WHAT IT MATCHES
# ---------------
# Staged paths that contain /Users/<name>/ or /home/<name>/ as a directory
# component anywhere in the relative path — a clear sign an absolute path was
# joined into a repo-relative path.
#
# Exit 0 = clean, exit 1 = path-replica found (commit blocked).

set -u

staged=$(git diff --cached --name-only 2>/dev/null)
if [[ -z "$staged" ]]; then
    exit 0
fi

replica_paths=""
while IFS= read -r path; do
    # Match paths that include a Users/ or home/ directory component,
    # which indicates an absolute path was incorrectly embedded.
    if echo "$path" | grep -qE '(^|/)Users/[^/]+/|(^|/)home/[^/]+/'; then
        replica_paths="${replica_paths:+$replica_paths
}$path"
    fi
done <<< "$staged"

if [[ -n "$replica_paths" ]]; then
    echo "✗ COMMIT BLOCKED (#076): staged paths look like absolute-path replicas." >&2
    echo "" >&2
    echo "  These paths contain /Users/<name>/ or /home/<name>/ as a directory" >&2
    echo "  component, which means an absolute path was written into the repo." >&2
    echo "  This typically means an agent wrote to an absolute path instead of a" >&2
    echo "  repo-relative path." >&2
    echo "" >&2
    echo "  Affected staged paths:" >&2
    while IFS= read -r p; do
        echo "    $p" >&2
    done <<< "$replica_paths"
    echo "" >&2
    echo "  To fix: git restore --staged <path>, delete the wrong file, and write" >&2
    echo "  to the correct repo-relative path." >&2
    echo "  To bypass (rare, deliberate): git commit --no-verify" >&2
    exit 1
fi

exit 0
