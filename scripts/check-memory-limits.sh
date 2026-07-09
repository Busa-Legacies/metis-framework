#!/usr/bin/env bash
# Enforce the memory-frontmatter standard's hard limits (docs: MEMORY.md max 200 lines,
# individual memory files max 60). Over-limit files mean memory is storing code/history
# that belongs in the repo. Exit 0 if all within limits; else prints offenders + exit 1.
# Repo-relative so it works on any machine (memory dir is symlinked into ClaudeCode/memory).
#
# MEMORY.md AND MEMORY-archive.md are INDEXES (one line per memory), not content files — they
# grow with the corpus by design, so the 60-line content cap does not apply to them. The hot
# index (MEMORY.md) is capped at 200; the cold archive is unbounded (its whole job is to hold
# the dead tail moved OFF the hot index). See reference_memory_index_lifecycle.
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && git rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR/..")"
MEM="$REPO/ClaudeCode/memory"
bad=""

idx="$MEM/MEMORY.md"
if [ -f "$idx" ]; then
    # BYTE cap is the REAL failure mode: the harness loads MEMORY.md WHOLE each session at a hard
    # ~24.4KB limit and SILENTLY TRUNCATES the overflow (lost memory). Guard the bytes first. The
    # line count is a loose secondary sanity bound (~260, well above what 24.4KB of compact entries
    # yields). Retire #active from closed work first (drop #active → memory-maintain.py --apply moves
    # it cold); trimming healthy hot lines is a last resort (continuous compaction hurts context).
    b=$(wc -c < "$idx")
    if [ "$b" -gt 24400 ]; then
        bad="${bad}MEMORY.md is ${b} bytes (>24400 hard cap) — TRUNCATING at load; retire a closed #active entry"$'\n'
    elif [ "$b" -gt 23500 ]; then
        bad="${bad}MEMORY.md is ${b} bytes (>23500, approaching the 24400 cap) — retire a closed #active entry soon"$'\n'
    fi
    n=$(wc -l < "$idx")
    [ "$n" -gt 260 ] && bad="${bad}MEMORY.md is $n lines (>260) — prune/merge a stale entry"$'\n'
fi

while IFS= read -r f; do
    n=$(wc -l < "$f")
    if [ "$n" -gt 60 ]; then
        bad="${bad}$(basename "$f") is $n lines (>60) — trim to the durable fact"$'\n'
    fi
done < <(find "$MEM" -name '*.md' ! -name MEMORY.md ! -name MEMORY-archive.md 2>/dev/null)

[ -z "$bad" ] && exit 0
printf '%s' "$bad"
exit 1
