#!/usr/bin/env bash
# gitignore-lint.sh — periodic .gitignore hygiene check.
# 1. Flags duplicate non-comment lines within each .gitignore file.
# 2. Asserts every memory/ dir whose policy is "track all" (!memory/**) has
#    no orphan-ignored files — files that are physically present but silently
#    excluded by the root blanket-ignore winning over the re-include.
# Exits 0 if clean, 1 if any issue found.
#
# Usage: bash scripts/gitignore-lint.sh [--quiet]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

PASS=0
FAIL=0
WARNS=()

emit() {
  local sev="$1" msg="$2"
  if [ "$sev" = "PASS" ]; then
    PASS=$((PASS+1))
    if [ "$QUIET" -eq 0 ]; then echo "  PASS  $msg"; fi
  else
    FAIL=$((FAIL+1))
    echo "  FAIL  $msg"
  fi
}

warn() { WARNS+=("$1"); }

cd "$REPO"

# ---------------------------------------------------------------------------
# 1. Duplicate lines within each .gitignore
# ---------------------------------------------------------------------------
# Canonical files only (skip worktrees, venv, caches, submodules)
GITIGNORES=()
while IFS= read -r gi; do
  GITIGNORES+=("$gi")
done < <(find . -name ".gitignore" \
  -not -path "./.git/*" \
  -not -path "./.claude/worktrees/*" \
  -not -path "./.pytest_cache/*" \
  -not -path "./.ruff_cache/*" \
  -not -path "./<<MACHINE_1_ID>>/lanes/*" \
  -not -path "./*/.venv/*" \
  2>/dev/null | sort)

dup_found=0
for gi in "${GITIGNORES[@]}"; do
  # Extract non-comment, non-empty lines
  dupes=$(grep -v '^[[:space:]]*#' "$gi" | grep -v '^[[:space:]]*$' | sort | uniq -d 2>/dev/null) || true
  if [ -n "$dupes" ]; then
    emit FAIL "duplicate lines in ${gi#./}: $(printf '%s' "$dupes" | tr '\n' ' ')"
    dup_found=1
  fi
done
[ "$dup_found" -eq 0 ] && emit PASS ".gitignore files — no duplicate lines"

# ---------------------------------------------------------------------------
# 2. Memory dir orphan-ignored files
# ---------------------------------------------------------------------------
# For each .gitignore that has "!memory/**" (track-all policy), find any
# files under the adjacent memory/ dir that git still considers ignored.
# These are the "orphan ignored" files the task warns about.
orphan_found=0
for gi in "${GITIGNORES[@]}"; do
  # Check if this .gitignore has a track-all re-include
  if grep -q '^!memory/\*\*' "$gi" 2>/dev/null; then
    dir="$(dirname "$gi")"
    mem_dir="$dir/memory"
    [ -d "$mem_dir" ] || continue

    # git check-ignore: any output means the file is still ignored
    ignored_files=$(git -C "$REPO" check-ignore --no-index "$mem_dir"/* 2>/dev/null \
                   | grep -v '^$' || true)
    if [ -n "$ignored_files" ]; then
      while IFS= read -r f; do
        emit FAIL "orphan-ignored in ${dir#./}/memory: ${f##*/} — file exists but is git-ignored despite !memory/**"
        orphan_found=1
      done <<< "$ignored_files"
    fi
  fi
done
[ "$orphan_found" -eq 0 ] && emit PASS "memory/ dirs — no orphan-ignored files under track-all policy"

# ---------------------------------------------------------------------------
# 3. Root blanket-ignore coverage
# ---------------------------------------------------------------------------
# Verify root .gitignore has "memory/" so subdirectory re-includes are meaningful.
if grep -q '^memory/$\|^memory/$' .gitignore 2>/dev/null; then
  emit PASS "root .gitignore — memory/ blanket-ignore present"
else
  warn "root .gitignore missing 'memory/' blanket-ignore — subdirectory re-includes may not work"
  emit FAIL "root .gitignore — memory/ blanket-ignore missing"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [ ${#WARNS[@]} -gt 0 ]; then
  echo ""
  for w in "${WARNS[@]}"; do echo "  WARN  $w"; done
fi

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
