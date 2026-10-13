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

# Which memory CONTENT files to check for the 60-body-line cap.
# SCOPED mode — when file args are passed (the pre-push gate passes the memory files IN this
# push), check ONLY those. A pre-existing over-length file ELSEWHERE in the corpus must not
# RED-block an unrelated push: that is the #438 fleet-outage class the gate already scopes
# memory-health against (autosync_prepush_gate.checks_for), and an over-60 file is NOT
# auto-remediable (memory-maintain --apply can retire MEMORY.md entries but can't trim a file
# body), so a corpus-wide check wedged fleet main-sync until a human trimmed it. The commit
# that GROWS/ADDS a file over the cap is still blocked — its file is in the push's arg set.
# The MEMORY.md byte cap above stays GLOBAL (the real silent-truncation failure).
# FULL-SCAN mode (no args): audit the whole corpus — manual runs / CI / the daily self-heal.
# --scoped forces scoped mode even with ZERO file args: an index-only push (touches MEMORY.md
# but no content file) then checks NO 60-line caps — only the global MEMORY.md byte cap above —
# instead of falling back to a corpus-wide scan that would re-introduce the fleet wedge.
scoped=0
if [ "${1:-}" = "--scoped" ]; then scoped=1; shift; fi
check_files=()
if [ "$scoped" = "1" ] || [ "$#" -gt 0 ]; then
    for a in "$@"; do
        base="$(basename "$a")"
        [ "$base" = "MEMORY.md" ] && continue
        [ "$base" = "MEMORY-archive.md" ] && continue
        case "$a" in *.md) ;; *) continue ;; esac
        if [ -f "$a" ]; then check_files+=("$a")
        elif [ -f "$REPO/$a" ]; then check_files+=("$REPO/$a")
        fi
    done
else
    while IFS= read -r f; do check_files+=("$f"); done \
        < <(find "$MEM" -name '*.md' ! -name MEMORY.md ! -name MEMORY-archive.md 2>/dev/null)
fi

for f in ${check_files[@]+"${check_files[@]}"}; do
    # Count BODY lines only (frontmatter stripped) — the 60-line cap is about durable-fact
    # CONTENT size ("storing code/history that belongs in the repo, not memory"), not YAML
    # metadata weight. The #3416 backfill made the salience: block (6-7 lines) mandatory on
    # every file, which would otherwise tip borderline files over a cap that predates it.
    n=$(awk '
        BEGIN{infm=0; started=0}
        /^---[ \t]*$/ {
            if (!started) { started=1; infm=1; next }
            else if (infm) { infm=0; next }
        }
        infm { next }
        { print }
    ' "$f" | wc -l)
    if [ "$n" -gt 60 ]; then
        bad="${bad}$(basename "$f") is $n body lines (>60, frontmatter excluded) — trim to the durable fact"$'\n'
    fi
done

[ -z "$bad" ] && exit 0
printf '%s' "$bad"
exit 1
