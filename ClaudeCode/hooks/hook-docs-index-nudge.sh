#!/bin/bash
# hook-docs-index-nudge.sh — Claude Code PreToolUse hook (Grep|Glob).
#
# Consult-before-search. When a session searches docs/ directly without having
# consulted the structural index this session, nudge it to skim
# docs/DOC-INDEX.yaml first (id / path / title / concepts / components per doc)
# so it jumps to the right file instead of grepping blindly.
#
# Pattern adapted from safishamsi/graphify's PreToolUse "consult the graph
# before reading raw files" mechanic — applied to the structural index we
# already own rather than a generated knowledge graph.
# Rationale: docs/research/graphify-knowledge-graph-learnings.md (Learning 1).
#
# Zero-LLM, pure regex. Fires at most ONCE per session, only inside the metis-os
# repo (where DOC-INDEX.yaml lives), and stays silent on every other search.

# Only meaningful where the index exists (run from repo root via cwd).
[ -f docs/DOC-INDEX.yaml ] || exit 0

payload="$(cat)"
[ -n "$payload" ] || exit 0

# Decide: is this a Grep/Glob whose search target is scoped to docs/ ?
# Looks at path + glob (Grep) and path + pattern (Glob). On match, prints the
# session id (canonical source is the stdin JSON's "session_id" — the env var
# CLAUDE_SESSION_ID is NOT present in the hook runtime). Falls back to the env
# var, then to a fixed token, so the once-per-session marker stays per-session.
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

cat <<'JSON'
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "CONSULT-BEFORE-SEARCH: you're searching docs/ directly. docs/DOC-INDEX.yaml is the structural index of every doc (id, path, title, concepts, components) — skim it first to jump straight to the right file instead of grepping blindly; it's the cheaper path. This is a one-time per-session reminder; proceed with your search after."}}
JSON

exit 0
