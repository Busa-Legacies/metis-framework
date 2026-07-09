#!/usr/bin/env bash
# close-integrity-check.sh — Run at end of every session close before declaring done.
# Exits 1 if any check fails.

set -euo pipefail
. "$(dirname "$0")/lib/paths.env"
REPO="$METIS_HOME"
PASS=0; FAIL=0; WARN=0

# --selftest (#352): prove the canonical checks are false-PASS-resistant (a dirty
# fixture must FAIL) without touching live state. Used by this task's doneWhen.
if [ "${1:-}" = "--selftest" ]; then
  exec python3 "$REPO/scripts/lib/close_integrity_canonical.py" --selftest
fi

check() {
  local label="$1" result="$2"
  if [ "$result" = "ok" ]; then
    echo "  PASS  $label"
    PASS=$((PASS+1))
  elif [ "${result#warn:}" != "$result" ]; then
    # "warn:<msg>" — surfaced but non-blocking (doesn't fail the close). For
    # conditions a session can't always resolve alone (e.g. shared-file budgets
    # inflated by concurrent sessions' legitimate entries).
    echo "  WARN  $label — ${result#warn:}"
    WARN=$((WARN+1))
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
# Graduated budget: the 35-line target is enforced at WRITE time by
# working-context-update.py --enforce-budget (which refuses to clobber concurrent
# sessions' threads). When several active sessions each legitimately own threads the
# file can sit just over 35 — that's a WARN (prune your done threads), not a hard FAIL.
# Only a genuine runaway (>45) fails the close.
wc_lines=$(wc -l < "$REPO/workspace/memory/working-context.md" 2>/dev/null || echo 999)
if [ "$wc_lines" -le 35 ]; then
  check "working-context.md ≤35 lines (${wc_lines})" "ok"
elif [ "$wc_lines" -le 45 ]; then
  check "working-context.md line budget (${wc_lines})" "warn:over the 35-line target — acceptable under concurrent multi-session load; prune your own done threads (ops-only, never clobber others')"
else
  check "working-context.md ≤45 lines" "${wc_lines} lines — runaway; prune completed threads (--remove, ops-only)"
fi

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

# 2. MEMORY.md — no orphaned files, no stale entries. The index is TIERED
#    (reference_memory_index_lifecycle): MEMORY.md = HOT (auto-loaded), MEMORY-archive.md
#    = COLD (recall-only). A file referenced in EITHER index is legitimately tracked —
#    so both indexes count, and both index files are excluded from the on-disk set.
memory_dir="$REPO/ClaudeCode/memory"
orphans=$(python3 - "$memory_dir" <<'PYEOF'
import os, sys, re
d = sys.argv[1]
INDEXES = ("MEMORY.md", "MEMORY-archive.md")
referenced = set()
for idx in INDEXES:
    p = os.path.join(d, idx)
    if os.path.exists(p):
        text = open(p).read()
        referenced |= set(re.findall(r'\]\(([^)]+\.md)\)', text))
        # Compact index format (db97c4bd): "- filename.md — hook" (no markdown link)
        referenced |= set(re.findall(r'^\s*-\s+([\w.-]+\.md)\b', text, re.M))
on_disk = {f for f in os.listdir(d) if f.endswith('.md') and f not in INDEXES}
orphaned = on_disk - referenced
stale    = referenced - on_disk
msgs = []
if orphaned: msgs.append("orphaned files (in neither MEMORY.md nor MEMORY-archive.md): " + ", ".join(sorted(orphaned)))
if stale:    msgs.append("stale entries (file missing): " + ", ".join(sorted(stale)))
print("|".join(msgs))
PYEOF
)
[ -z "$orphans" ] \
  && check "MEMORY.md cross-reference clean" "ok" \
  || { IFS='|' read -ra issues <<< "$orphans"
       for issue in "${issues[@]}"; do check "MEMORY.md" "$issue"; done; }

# 3. ID counter consistency (#352) — read CANONICAL task-counter.json + tasks.json
#    via scripts/lib/close_integrity_canonical.py, not the task-naming-convention.md
#    mirror / task-queue.md / OPEN_TASKS.md projections. Flags: highest id > counter
#    (regression), duplicate active ids (concurrent-alloc race), active∩archived reuse.
id_check=$(python3 "$REPO/scripts/lib/close_integrity_canonical.py" id-counter)
if [ -z "$id_check" ]; then
  check "ID counter (canonical task-counter.json + tasks.json)" "ok"
else
  while IFS= read -r line; do check "ID counter" "$line"; done <<< "$id_check"
fi

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

# 5d. Metis Command responsive parity — if a session touched the app UI, prove
#     the core desktop+mobile contracts still hold. When the tree is clean (the
#     normal /end path after commit), the gate inspects the last commit.
if bash "$REPO/scripts/metis-command-parity-gate.sh" >/tmp/metis-command-parity.out 2>&1; then
  check "metis-command desktop/mobile parity gate" "ok"
else
  check "metis-command desktop/mobile parity gate" "$(tail -20 /tmp/metis-command-parity.out | tr '\n' ' ')"
fi

# 6. Task fields completeness (#352) — every OPEN task must carry project + area,
#    read from CANONICAL tasks.json (not the task-queue.md fields line).
missing_fields=$(python3 "$REPO/scripts/lib/close_integrity_canonical.py" fields)
if [ -z "$missing_fields" ]; then
  check "task fields completeness (project+area on all open tasks, canonical)" "ok"
else
  while IFS= read -r line; do
    check "task fields" "$line — set via update-tier1-state.py task-update"
  done <<< "$missing_fields"
fi

# 7. Task body completeness (#352) — every OPEN task must carry summary + why + how,
#    read from CANONICAL tasks.json (not the task-queue.md body).
missing_body=$(python3 "$REPO/scripts/lib/close_integrity_canonical.py" body)
if [ -z "$missing_body" ]; then
  check "task body completeness (summary+why+how on all open tasks, canonical)" "ok"
else
  while IFS= read -r line; do
    check "task body" "$line — set via update-tier1-state.py task-update"
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
if [ "$WARN" -gt 0 ]; then
  echo "  $PASS passed, $WARN warned, $FAIL failed"
else
  echo "  $PASS passed, $FAIL failed"
fi
[ "$FAIL" -eq 0 ]
