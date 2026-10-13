#!/bin/bash
# hook-docs-index-nudge.sh — Claude Code PreToolUse hook.
#
# Two jobs, one hook (matched on Grep|Glob AND Write):
#
#  1. CONSULT-BEFORE-SEARCH (Grep|Glob): when a session searches docs/ directly
#     without having consulted the structural index this session, nudge it to
#     skim docs/DOC-INDEX.yaml first (id/path/title/concepts/components per doc)
#     so it jumps to the right file instead of grepping blindly. Advisory,
#     once-per-session. Pattern from safishamsi/graphify's "consult the graph
#     before reading raw files" mechanic — rationale in
#     docs/research/graphify-knowledge-graph-learnings.md (Learning 1).
#
#  2. CREATE-GATE (Write, #3412): creating a NEW canonical doc (any docs/ path the
#     shared classifier calls canonical — scripts/lib/doc_index_classify.py) that is
#     NOT in DOC-INDEX.yaml is DENIED — the one enforced index must not go stale by
#     silent doc creation. Escape hatches: (a) add the index entry first (run
#     scripts/build-doc-index.py), or (b) it's genuinely not a canonical doc (generated
#     state / dated one-off) — the classifier already excludes those, so file it where
#     the standard puts it (workspace/state, a dated sub-dir) and the gate lets it through.
#     Editing an existing doc is never gated (the file already exists).
#
# Zero-LLM, pure regex + a scoped python check. Fires only inside the metis-os
# repo (where DOC-INDEX.yaml lives); silent everywhere else.

# Only meaningful where the index exists (run from repo root via cwd).
[ -f docs/DOC-INDEX.yaml ] || exit 0

payload="$(cat)"
[ -n "$payload" ] || exit 0

# Decision log (observability: implemented != firing). File-only, never stdout; never alters exit.
_LOG="${DOCS_INDEX_NUDGE_LOG:-$HOME/.openclaw/logs/docs-index-nudge.jsonl}"
_log(){ { mkdir -p "$(dirname "$_LOG")" && printf '{"ts":"%s","hook":"docs-index-nudge","decision":"%s","detail":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >>"$_LOG"; } 2>/dev/null || true; }

tool="$(printf '%s' "$payload" | python3 -c 'import sys,json;
try: print(json.load(sys.stdin).get("tool_name",""))
except Exception: pass' 2>/dev/null)"

# ---------------------------------------------------------------------------
# JOB 2 — CREATE-GATE on Write to a new top-level canonical doc.
# ---------------------------------------------------------------------------
if [ "$tool" = "Write" ]; then
  # Intentional-edit escape hatch (#3412): a session that genuinely means to create an
  # un-indexed canonical doc (e.g. mid-refactor, index regenerated in the same change)
  # sets DOC_INDEX_GATE=off to pass. Any value other than the empty string / "on"/"1"
  # disables the deny; the consult nudge (JOB 1) is unaffected.
  case "${DOC_INDEX_GATE:-on}" in
    off|OFF|0|false|no) exit 0 ;;
  esac
  # Extract the target file_path; emit a repo-relative path only if it is a canonical
  # doc (shared classifier) that does NOT yet exist on disk.
  rel="$(printf '%s' "$payload" | python3 -c '
import sys, os, json
sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "lib"))
try:
    from doc_index_classify import is_canonical_doc
except Exception:
    sys.exit(0)   # classifier absent → fail open, never block on our own tooling gap
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
ti = d.get("tool_input", {}) or {}
fp = str(ti.get("file_path") or ti.get("path") or "")
if not fp:
    sys.exit(0)
cwd = os.getcwd()
# normalise to repo-relative
rel = os.path.relpath(fp, cwd) if os.path.isabs(fp) else fp
rel = rel.replace(os.sep, "/")
# gate any NEW canonical doc (generated state / dated one-offs are excluded by the classifier)
if not is_canonical_doc(rel):
    sys.exit(0)
# editing an existing doc is never gated
if os.path.exists(os.path.join(cwd, rel)):
    sys.exit(0)
print(rel)
' 2>/dev/null)"

  [ -n "$rel" ] || exit 0

  # Is it already in the index? (gate helper exits 0 when indexed.)
  if python3 scripts/doc-index-verify.py --indexed "$rel" 2>/dev/null; then
    _log allow "canonical-doc-indexed"
    exit 0
  fi

  # Not indexed → deny creation with an actionable message.
  _log deny "unindexed-canonical-doc"
  cat <<JSON
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "DOC-INDEX create-gate: '${rel}' is a new canonical doc not listed in docs/DOC-INDEX.yaml, and an un-indexed canonical doc is unfinished. Either (a) create the file, then run 'python3 scripts/build-doc-index.py' to add its entry (it auto-derives id/path/title/type); or (b) if this is NOT a canonical doc (generated state, a dated one-off report), file it where the standard puts it — workspace/state/ or a dated sub-dir — and the classifier will let it through. Escape a false positive by setting DOC_INDEX_GATE=off for the write. Verify: python3 scripts/doc-index-verify.py --strict-unindexed"}}
JSON
  exit 0
fi

# ---------------------------------------------------------------------------
# JOB 1 — CONSULT-BEFORE-SEARCH nudge on Grep|Glob scoped to docs/.
# ---------------------------------------------------------------------------
# Decide: is this a Grep/Glob whose search target is scoped to docs/ ?
# On match, prints the session id (canonical source is the stdin JSON's
# "session_id"). Falls back to the env var, then a fixed token, so the
# once-per-session marker stays per-session.
sid="$(printf '%s' "$payload" | CLAUDE_SESSION_ID="${CLAUDE_SESSION_ID:-}" python3 -c '
import sys, os, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
tool = d.get("tool_name", "")
if tool not in ("Grep", "Glob"):
    sys.exit(0)
ti = d.get("tool_input", {}) or {}
# Fields that can carry a docs/ scope for either tool.
targets = [str(ti.get(k, "")) for k in ("path", "glob", "pattern")]
if not any("docs" in t for t in targets):
    sys.exit(0)
sid = d.get("session_id") or os.environ.get("CLAUDE_SESSION_ID") or "nosession"
print(sid)
' 2>/dev/null)"

[ -n "$sid" ] || exit 0

# Fire at most once per session (sanitize sid for use in a filename).
sid="$(printf '%s' "$sid" | tr -c 'A-Za-z0-9_.-' '_')"
marker="${TMPDIR:-/tmp}/.claude-docs-index-nudge-${sid}"
[ -e "$marker" ] && exit 0
: > "$marker" 2>/dev/null

_log warn "consult-before-search"
cat <<'JSON'
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "CONSULT-BEFORE-SEARCH: you're searching docs/ directly. docs/DOC-INDEX.yaml is the structural index of every canonical doc (id, path, title, concepts, components) — skim it first to jump straight to the right file instead of grepping blindly; it's the cheaper path. This is a one-time per-session reminder; proceed with your search after."}}
JSON

exit 0
