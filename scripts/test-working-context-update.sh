#!/usr/bin/env bash
# Regression net for working-context-update.py (#124).
# Protects the keystone contract: a writer never silently drops another
# session's fresher thread; worst case it refuses with exit 2.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$HERE/working-context-update.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()   { echo "  ok: $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL: $1"; fail=$((fail+1)); }

base() { cat > "$1" <<EOF
# Working Context — 2026-06-05

## Active focus
focus

## Open threads
- **[#100]** existing thread   <!-- own:sessA ts:1000 -->

## Blockers
- #001 a blocker

## Next action
next
EOF
}

# 1. round-trip preserves an untouched thread
f="$TMP/rt.md"; base "$f"
CLAUDE_CODE_SESSION_ID=sessA python3 "$HELPER" --file "$f" >/dev/null 2>&1
grep -q '#100' "$f" && ok "round-trip preserves thread" || bad "round-trip dropped thread"

# 2. explicit remove cuts the thread; upsert adds with provenance
f="$TMP/op.md"; base "$f"
CLAUDE_CODE_SESSION_ID=sessA python3 "$HELPER" --file "$f" \
  --remove '#100' --upsert '#124::new' >/dev/null 2>&1
{ ! grep -q '#100' "$f"; } && grep -q '#124.*own:sessA' "$f" \
  && ok "remove cuts + upsert adds provenance" || bad "remove/upsert wrong"

# Pin the digest dir at an empty fixture. Freshness has two independent signals (provenance ts
# and the owner's session-digest mtime); leaving the digest dir at the real board would let a
# live session on this machine decide these outcomes.
export METIS_SESSION_DIGESTS="$TMP/digests"; mkdir -p "$METIS_SESSION_DIGESTS"
NOW=$(date +%s)

# 3. budget trim sheds DONE-marked own threads, never another session's live thread.
#
# This asserted "sheds OWN oldest" until #3441 deliberately narrowed it: a blocked-but-running
# thread reads as done to the marker heuristic, so trimming by age alone could evict another
# session's live state to fit the budget. Auto-trim now takes ONLY threads carrying an explicit
# DONE/RESOLVED/CLOSED marker, and refuses when there are none. The old fixture's filler threads
# carried no marker, so the current code correctly refused and the assertion read that as a bug.
f="$TMP/trim.md"
{ echo "# Working Context — 2026-06-05"; echo; echo "## Active focus"; echo f
  echo; echo "## Open threads"
  for i in $(seq 0 40); do echo "- **[A$i]** filler DONE   <!-- own:sessA ts:$((1000+i)) -->"; done
  echo "- **[B-fresh]** live work   <!-- own:sessB ts:$NOW -->"
  echo; echo "## Blockers"; echo "- #001 x"; echo; echo "## Next action"; echo n
} > "$f"
CLAUDE_CODE_SESSION_ID=sessA python3 "$HELPER" --file "$f" --enforce-budget >/dev/null 2>&1
rc=$?
lines=$(wc -l < "$f")
grep -q 'B-fresh' "$f" && [ "$rc" -eq 0 ] && [ "$lines" -le 35 ] \
  && ok "trim sheds own DONE threads to budget, keeps other's live thread (exit 0)" \
  || bad "trim: rc=$rc lines=$lines B-fresh=$(grep -c 'B-fresh' "$f")"

# 3b. the #3441 case itself, which nothing covered: the only DONE-marked candidate belongs to a
# session that is still live. It must be protected rather than auto-dropped, named in the refusal
# so the operator can see WHY the budget could not be met, and the run must fail loudly (exit 2).
f="$TMP/protect.md"
{ echo "# Working Context — 2026-06-05"; echo; echo "## Active focus"; echo f
  echo; echo "## Open threads"
  for i in $(seq 0 40); do echo "- **[A$i]** filler   <!-- own:sessA ts:$((1000+i)) -->"; done
  echo "- **[B-done]** phase 1 DONE, still running   <!-- own:sessB ts:$NOW -->"
  echo; echo "## Blockers"; echo "- #001 x"; echo; echo "## Next action"; echo n
} > "$f"
CLAUDE_CODE_SESSION_ID=sessA python3 "$HELPER" --file "$f" --enforce-budget >"$TMP/p.out" 2>"$TMP/p.err"
rc=$?
grep -q 'B-done' "$f" && [ "$rc" -eq 2 ] \
  && ok "a DONE-marked thread owned by a LIVE session is not auto-dropped (exit 2)" \
  || bad "foreign-live DONE thread: rc=$rc present=$(grep -c 'B-done' "$f")"
grep -q 'protected as foreign-live' "$TMP/p.err" && grep -q 'B-done' "$TMP/p.err" \
  && ok "refusal names the protected thread" \
  || bad "refusal did not name the protected thread: $(tr '\n' ' ' < "$TMP/p.err" | cut -c1-160)"

# 4. refuses (exit 2) when only fresher-unowned threads remain to trim
f="$TMP/refuse.md"
{ echo "# Working Context — 2026-06-05"; echo; echo "## Active focus"; echo f
  echo; echo "## Open threads"
  echo "- **[A-only]** old   <!-- own:sessA ts:1000 -->"
  for i in $(seq 0 40); do echo "- **[B$i]** fresher   <!-- own:sessB ts:$((9000+i)) -->"; done
  echo; echo "## Blockers"; echo "- #001 x"; echo; echo "## Next action"; echo n
} > "$f"
CLAUDE_CODE_SESSION_ID=sessA python3 "$HELPER" --file "$f" --enforce-budget >/dev/null 2>&1
rc=$?
all_b=1; for i in $(seq 0 40); do grep -q "\[B$i\]" "$f" || all_b=0; done
[ "$rc" -eq 2 ] && [ "$all_b" -eq 1 ] \
  && ok "refuses (exit 2), keeps all fresher-unowned" || bad "expected exit 2 + all B kept (rc=$rc all_b=$all_b)"

# 6. a write stamps today's date into the header (it sat a month stale before)
f="$TMP/date.md"; base "$f"
CLAUDE_CODE_SESSION_ID=sessA python3 "$HELPER" --file "$f" --focus x >/dev/null 2>&1
head -1 "$f" | grep -q "$(date +%Y-%m-%d)" && ok "write stamps today's header date" \
  || bad "header date not refreshed: $(head -1 "$f")"

# 7. --remove-blocker that matches nothing fails loudly (was a silent no-op)
f="$TMP/blk.md"; base "$f"
CLAUDE_CODE_SESSION_ID=sessA python3 "$HELPER" --file "$f" --remove-blocker '#999' >/dev/null 2>&1
rc=$?
[ "$rc" -eq 2 ] && grep -q '#001' "$f" && ok "unmatched --remove-blocker exits 2" \
  || bad "expected exit 2 on unmatched blocker (rc=$rc)"

# 8. --upsert never replaces another session's thread (it overwrote a newer AMIS
#    update on 2026-10-05); --take-over is the deliberate override
f="$TMP/own.md"; base "$f"
CLAUDE_CODE_SESSION_ID=sessB python3 "$HELPER" --file "$f" --upsert '#100::clobber' >/dev/null 2>&1
rc=$?
[ "$rc" -eq 2 ] && grep -q 'existing thread.*own:sessA' "$f" && ! grep -q clobber "$f" \
  && ok "upsert refuses another session's thread (exit 2, text kept)" || bad "foreign upsert not refused (rc=$rc)"
CLAUDE_CODE_SESSION_ID=sessA python3 "$HELPER" --file "$f" --upsert '#100::own edit' >/dev/null 2>&1 \
  && grep -q 'own edit' "$f" && ok "owner can still upsert its thread" || bad "owner upsert blocked"
CLAUDE_CODE_SESSION_ID=sessB python3 "$HELPER" --file "$f" --take-over --upsert '#100::taken' >/dev/null 2>&1 \
  && grep -q 'taken.*own:sessB' "$f" && ok "--take-over replaces deliberately" || bad "--take-over failed"

echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ]
