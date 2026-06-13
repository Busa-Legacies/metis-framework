#!/usr/bin/env bash
# close-integrity-check.sh — Run at end of every session close before declaring done.
# Exits 1 if any check fails.

set -euo pipefail
. "$(dirname "$0")/lib/paths.env"
REPO="$METIS_HOME"
PASS=0; FAIL=0

check() {
  local label="$1" result="$2"
  if [ "$result" = "ok" ]; then
    echo "  PASS  $label"
    PASS=$((PASS+1))
  else
    echo "  FAIL  $label — $result"
    FAIL=$((FAIL+1))
  fi
}

# 0. Reap orphaned background tasks (#087) — run first so stale Lane/dispatch
#    processes from prior sessions don't emit spurious notifications into the close.
#    Not a gate failure — reaper is best-effort and must never block the close.
reap_out=$("$REPO/scripts/reap-bg-tasks.sh" --kill --quiet 2>&1) || true
check "orphaned bg-task reaper" "ok"
[ -n "$reap_out" ] && echo "  reap: $reap_out"

# 1. working-context.md line count
wc_lines=$(wc -l < "$REPO/<<MACHINE_1_ID>>/memory/working-context.md" 2>/dev/null || echo 999)
[ "$wc_lines" -le 35 ] \
  && check "working-context.md ≤35 lines (${wc_lines})" "ok" \
  || check "working-context.md ≤35 lines" "${wc_lines} lines"

# 1b. dotfiles/tmux.conf parses — validate on an isolated socket (-L cfgcheck) so a
#     bad edit can't break new claude-<N>/ccc tmux sessions and never touches the
#     live server. Skipped silently if tmux isn't installed.
if command -v tmux >/dev/null 2>&1 && [ -f "$REPO/dotfiles/tmux.conf" ]; then
  if tmux -L cfgcheck -f "$REPO/dotfiles/tmux.conf" start-server \; kill-server 2>/dev/null; then
    check "dotfiles/tmux.conf parses" "ok"
  else
    check "dotfiles/tmux.conf parses" "tmux rejected the config — check syntax"
  fi
fi

# 2. MEMORY.md — no orphaned files, no stale entries
memory_dir="$REPO/ClaudeCode/memory"
orphans=$(python3 - "$memory_dir" <<'PYEOF'
import os, sys, re
d = sys.argv[1]
index = os.path.join(d, "MEMORY.md")
referenced = set(re.findall(r'\]\(([^)]+\.md)\)', open(index).read())) if os.path.exists(index) else set()
on_disk = {f for f in os.listdir(d) if f.endswith('.md') and f != 'MEMORY.md'}
orphaned = on_disk - referenced
stale    = referenced - on_disk
msgs = []
if orphaned: msgs.append("orphaned files (not in MEMORY.md): " + ", ".join(sorted(orphaned)))
if stale:    msgs.append("stale entries (file missing): " + ", ".join(sorted(stale)))
print("|".join(msgs))
PYEOF
)
[ -z "$orphans" ] \
  && check "MEMORY.md cross-reference clean" "ok" \
  || { IFS='|' read -ra issues <<< "$orphans"
       for issue in "${issues[@]}"; do check "MEMORY.md" "$issue"; done; }

# 3. ID counter consistency — Last assigned counter must be >= highest #NNN across
#    task-queue.md AND task-archive.md. Counter ahead of the highest visible id is
#    legitimate (#089 archiving moves terminal #NNN blocks out of the queue, and
#    alloc-id can reserve ids before a task entry is written), so only flag when the
#    highest id EXCEEDS the counter (a true regression) or when an id is duplicated.
id_check=$(python3 - "$REPO/docs/process/task-naming-convention.md" "$REPO/docs/process/task-queue.md" "$REPO/docs/process/task-archive.md" "$REPO/<<MACHINE_1_ID>>/state/OPEN_TASKS.md" <<'PYEOF'
import os, re, sys
convention = open(sys.argv[1]).read()
queue = open(sys.argv[2]).read()
archive = open(sys.argv[3]).read() if os.path.exists(sys.argv[3]) else ""
board = open(sys.argv[4]).read() if os.path.exists(sys.argv[4]) else ""
m = re.search(r'\*\*Last assigned: #(\d+)\*\*', convention)
if not m:
    print("cannot parse Last assigned counter")
    sys.exit(0)
counter = int(m.group(1))
ids = [int(x) for x in re.findall(r'- \*\*#(\d+)', queue + archive)]
# OPEN_TASKS.md is a projection — sharing an id with the queue is legitimate.
# Only duplicates WITHIN the board (one id assigned to two open items) are bugs.
board_ids = [int(x) for x in re.findall(r'^- \[P\d\] \[[ ~]\] \*\*#(\d+)', board, re.M)]
if not ids and not board_ids:
    sys.exit(0)
highest = max(ids + board_ids)
dupes = [i for i in set(ids) if ids.count(i) > 1]
board_dupes = [i for i in set(board_ids) if board_ids.count(i) > 1]
msgs = []
if highest > counter:
    msgs.append(f"counter says #{counter} but highest task id is #{highest} — counter regressed, update task-naming-convention.md")
if dupes:
    msgs.append(
        f"duplicate IDs across queue+archive: {sorted(dupes)} "
        "— likely a concurrent-close counter race (two sessions read the same "
        "'Last assigned' before either wrote back); renumber the later task with "
        "update-tier1-state.py correct-state --reason, do not blind-close"
    )
if board_dupes:
    msgs.append(
        f"duplicate IDs within OPEN_TASKS.md board: {sorted(board_dupes)} "
        "— a batch was minted without agent-work.py alloc-id; renumber the "
        "later-added entries to fresh ids (alloc-id) and fix any @blocked-by refs"
    )
print("|".join(msgs))
PYEOF
)
[ -z "$id_check" ] \
  && check "ID counter matches task-queue.md (no drift, no dupes)" "ok" \
  || { IFS='|' read -ra issues <<< "$id_check"
       for issue in "${issues[@]}"; do check "ID counter" "$issue"; done; }

# 4. Lane wrapper symlink smoke test — verify ~/.local/bin wrappers resolve imports
#    correctly when invoked via their symlink path (not the canonical scripts/ copy).
#    The failure mode: a sibling import resolved via os.path.abspath(__file__) breaks
#    when __file__ is the symlink path, not the real scripts/ location (d656029).
#    --help exercises the full import graph without touching Ollama.
for wrapper in jlane lane-debug lane-health; do
  wpath="$HOME/.local/bin/$wrapper"
  if [ ! -e "$wpath" ]; then
    check "lane wrapper symlink: $wrapper" "MISSING at $wpath — run bootstrap or re-symlink"
    continue
  fi
  if "$wpath" --help >/dev/null 2>&1; then
    check "lane wrapper symlink invocation: $wrapper --help" "ok"
  else
    check "lane wrapper symlink invocation: $wrapper --help" "exited non-zero via symlink path — symlink-path import regression (see d656029)"
  fi
done

# 5. Hook symlinks
for hook in hook-alerts.sh hook-session-init.sh hook-prompt-guard.sh statusline.sh; do
  [ -L "$HOME/.claude/$hook" ] \
    && check "symlink: ~/.claude/$hook" "ok" \
    || check "symlink: ~/.claude/$hook" "MISSING — run bootstrap-claude-memory.sh"
done

# 5b. Skills directory symlink — ~/.claude/skills must point at ClaudeCode/skills/
[ -L "$HOME/.claude/skills" ] \
  && check "symlink: ~/.claude/skills → ClaudeCode/skills/" "ok" \
  || check "symlink: ~/.claude/skills" "MISSING — run bootstrap-claude-memory.sh"

# 5c. Codex command/skill surface — generated from ClaudeCode/skills + commands.
if python3 "$REPO/scripts/sync-codex-surface.py" --check >/tmp/codex-surface-check.out 2>&1; then
  check "codex surface sync (.agents/skills + .codex/prompts)" "ok"
else
  check "codex surface sync (.agents/skills + .codex/prompts)" "$(tr '\n' ' ' </tmp/codex-surface-check.out)"
fi

# 6. Task fields completeness — every open task must have Why:, Plan:, goal:, and project:
missing_fields=$(python3 - "$REPO/docs/process/task-queue.md" <<'PYEOF'
import re, sys

path = sys.argv[1]
text = open(path).read()
blocks = re.split(r'\n(?=- \*\*#)', text)
bad = []
for block in blocks:
    fields_line = next((l for l in block.split('\n') if 'type:' in l and 'status:' in l), '')
    if not re.search(r'status:(open|queued|in-progress|blocked|needs-review|monitoring|partially-fixed)', fields_line):
        continue
    header = re.search(r'- \*\*#(\d+)[^*]*\*\*', block)
    if not header:
        continue
    task_id = header.group(1)
    missing = []
    if not re.search(r'goal:G\d', fields_line):   missing.append('goal:GN')
    if not re.search(r'project:\S+', fields_line): missing.append('project:slug')
    if missing:
        bad.append(f"#{task_id}: missing {', '.join(missing)} in fields line")
print('\n'.join(bad))
PYEOF
)
if [ -z "$missing_fields" ]; then
  check "task fields completeness (goal+project on all open tasks)" "ok"
else
  while IFS= read -r line; do
    check "task fields" "$line — add per task-naming-convention.md + projects.md"
  done <<< "$missing_fields"
fi

# 7. Task body completeness — every open task must have Why: and Plan:
missing_body=$(python3 - "$REPO/docs/process/task-queue.md" <<'PYEOF'
import re, sys

path = sys.argv[1]
text = open(path).read()

# Split into task blocks: lines starting with "- **#"
blocks = re.split(r'\n(?=- \*\*#)', text)
bad = []
for block in blocks:
    # Only check open/queued tasks — match status on the fields line only
    fields_line = next((l for l in block.split('\n') if 'type:' in l and 'status:' in l), '')
    if not re.search(r'status:(open|queued|in-progress|blocked|needs-review|monitoring|partially-fixed)', fields_line):
        continue
    header = re.search(r'- \*\*#(\d+)[^*]*\*\*\s*—\s*(.+)', block)
    if not header:
        continue
    task_id = header.group(1)
    # Accept bold (**Why:**) or plain (Why:) and common pre-protocol synonyms
    has_why  = bool(re.search(r'\*?\*?(Why[\s(:]|Summary:)', block))
    has_plan = bool(re.search(r'\*?\*?(Plan|Fix|Approach|Next action|Summary):', block))
    if not has_why or not has_plan:
        missing = []
        if not has_why:  missing.append('Why')
        if not has_plan: missing.append('Plan')
        bad.append(f"#{task_id}: missing {', '.join(missing)}")

print('\n'.join(bad))
PYEOF
)
if [ -z "$missing_body" ]; then
  check "task body completeness (Why+Plan on all open tasks)" "ok"
else
  while IFS= read -r line; do
    check "task body" "$line — add Why:/Plan: per task-writing-protocol.md"
  done <<< "$missing_body"
fi

# 8. Canonical-state invariants (reconcile I1-I8). FAIL only on fail-severity
#    (I1 live-lease-on-done / I2 dup-lease / I6 counter-regress|dup-id) — the
#    structural breaks. I3/I4/I5/I7/I8 are warns: surfaced as a count, never a
#    gate failure, so the close gate doesn't cry wolf on routine projection lag.
#    Defensive: a crash in reconcile must not abort the whole close (set -e), so
#    the call is guarded and an empty/garbled result is a soft FAIL, not a trap.
recon_json=$(python3 "$REPO/scripts/agent-work.py" reconcile --json 2>/dev/null) || true
if [ -z "$recon_json" ]; then
  check "reconcile invariants (I1-I8)" "reconcile could not run — check scripts/reconcile.py"
else
  recon_summary=$(python3 - "$recon_json" <<'PYEOF'
import sys, json
try:
    d = json.loads(sys.argv[1])
except Exception as e:
    print(f"unparseable reconcile output: {e}")
    sys.exit(0)
fails = [v for v in d.get("violations", []) if v.get("severity") == "fail"]
warns = [v for v in d.get("violations", []) if v.get("severity") == "warn"]
if d.get("ok") and not fails:
    print(f"OK::{len(warns)} warn(s) — see `agent-work.py reconcile` for detail")
else:
    print("FAIL::" + "; ".join(f"{v['id']} {v['detail']}" for v in fails))
PYEOF
)
  case "$recon_summary" in
    OK::*)  check "reconcile invariants (I1-I8) — ${recon_summary#OK::}" "ok" ;;
    *)      check "reconcile invariants (I1-I8)" "${recon_summary#FAIL::}" ;;
  esac
fi

# 9. .gitignore hygiene — duplicates + memory/ orphan-ignored files
lint_out=$("$REPO/scripts/gitignore-lint.sh" --quiet 2>&1) || gitignore_fail=1
gitignore_fail=${gitignore_fail:-0}
if [ "$gitignore_fail" -eq 0 ]; then
  check ".gitignore lint (duplicates + memory orphan-ignored)" "ok"
else
  while IFS= read -r line; do
    case "$line" in FAIL*) check ".gitignore lint" "${line#*FAIL  }" ;; esac
  done <<< "$lint_out"
fi

# 10. Strategy-doc task coverage — dangling refs (FAILs only; gaps are WARNs)
coverage_out=$(python3 "$REPO/scripts/coverage-lint.py" --quiet 2>&1) || coverage_fail=1
coverage_fail=${coverage_fail:-0}
if [ "$coverage_fail" -eq 0 ]; then
  check "strategy-doc coverage (dangling refs)" "ok"
else
  while IFS= read -r line; do
    case "$line" in FAIL*) check "strategy-doc coverage" "${line#*FAIL  }" ;; esac
  done <<< "$coverage_out"
fi

# 11. Context-budget guard — always-on instruction surface stays within budget (no silent regrowth)
ctxbudget_out=$(python3 "$REPO/scripts/context-budget-check.py" 2>&1) || ctxbudget_fail=1
ctxbudget_fail=${ctxbudget_fail:-0}
if [ "$ctxbudget_fail" -eq 0 ]; then
  check "context-budget (always-on surface within budget)" "ok"
else
  over=$(printf '%s\n' "$ctxbudget_out" | grep -E '^\[OVER\]' | sed 's/^\[OVER\][[:space:]]*//' | tr '\n' ';')
  check "context-budget" "${over:-over budget — run scripts/context-budget-check.py}"
fi

# 12. End-durability gate (#311) — refuse a close that banked work only via [auto-sync].
#     Catches the #219 signature: tracked source/governance files moved this session
#     but no intentional commit captured the intent (auto-sync swept them into a
#     snapshot the roll-up filters out). SKIPs cleanly when no baseline / diverged.
durability_out=$(python3 "$REPO/scripts/durability-check.py" --repo "$REPO" --quiet 2>&1) || durability_fail=1
durability_fail=${durability_fail:-0}
if [ "$durability_fail" -eq 0 ]; then
  check "end-durability (intentional commit banked this session's work)" "ok"
else
  files=$(printf '%s\n' "$durability_out" | grep -E '^[[:space:]]+•' | sed 's/^[[:space:]]*•[[:space:]]*//' | tr '\n' ' ')
  check "end-durability" "un-banked work landed only via auto-sync: ${files:-see durability-check.py}"
fi

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
