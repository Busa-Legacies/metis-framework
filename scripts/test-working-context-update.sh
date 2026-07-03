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

# 3. budget trim sheds OWN oldest, never another session's fresher thread
f="$TMP/trim.md"
{ echo "# Working Context — 2026-06-05"; echo; echo "## Active focus"; echo f
  echo; echo "## Open threads"
  for i in $(seq 0 40); do echo "- **[A$i]** filler   <!-- own:sessA ts:$((1000+i)) -->"; done
  echo "- **[B-fresh]** fresh   <!-- own:sessB ts:99999 -->"
  echo; echo "## Blockers"; echo "- #001 x"; echo; echo "## Next action"; echo n
} > "$f"
CLAUDE_CODE_SESSION_ID=sessA python3 "$HELPER" --file "$f" --enforce-budget >/dev/null 2>&1
rc=$?
grep -q 'B-fresh' "$f" && [ "$rc" -eq 0 ] \
  && ok "trim sheds own, keeps other's fresher (exit 0)" || bad "trim dropped B-fresh or wrong rc=$rc"

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

echo "---- $pass passed, $fail failed ----"
[ "$fail" -eq 0 ]
