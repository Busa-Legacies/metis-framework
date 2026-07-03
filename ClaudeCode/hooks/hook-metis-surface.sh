#!/usr/bin/env bash
# UserPromptSubmit hook — injects METIS_UI_SURFACE into session context when
# Claude is running inside a Metis Command pane (set at spawn time by pty-server.ts).
#
# Resolves the "this/here/the pane" ambiguity: when Ant says "check the pane"
# or "run this in the terminal", an agent with METIS_UI_SURFACE set knows it is
# running inside Metis Command and can act accordingly (e.g. recognise an
# eyes-on verification as an in-pane action, not an unknown artifact).
#
# Output: {"systemMessage": "..."} if METIS_UI_SURFACE is set and non-empty.
# Exit 0 silently when not in a Metis surface (no output = no injection).

[ -z "$METIS_UI_SURFACE" ] && exit 0

# Emit a short, factual context line — not a system prompt essay.
printf '{"systemMessage": "Running inside Metis Command (surface: %s). When Ant references the pane, terminal, or current surface, this is it."}\n' "$METIS_UI_SURFACE"
