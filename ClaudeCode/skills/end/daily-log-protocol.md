# Daily Log Protocol — Step 6 of /end

Scribe composes the prose; Claude Code persists it. Never let Scribe write the file directly — it has written to the wrong directory and echoed instruction text as content.

## (a0) Git roll-up first

Find the range since the last close:
```bash
# Boundary SHA from the NEWEST date-named daily log. Iterate newest-first — a bare
# `grep -h ... | tail -1` across the glob returned a 10-day-stale boundary on 2026-07-15.
for f in $(ls -r workspace/memory/2[0-9][0-9][0-9]-*.md 2>/dev/null); do
  sha=$(grep 'closed-at:' "$f" | tail -1 | awk '{print $2}'); [ -n "$sha" ] && echo "$sha" && break
done
```

If SHA found: range = `<sha>..HEAD`
If absent: fall back to `--since <log-date>`
If no daily log exists at all: use `--since=yesterday` and note "no close boundary found"

List intentional commits (filter auto-sync snapshots):
```bash
git log <sha>..HEAD --invert-grep --grep='\[auto-sync\]' --oneline
git diff <sha>..HEAD --stat
```

Also run friction/miss signal check:
```bash
[ -f scripts/self-review.py ] && python3 scripts/self-review.py --latest || true
```
Any actionable signals not already queued become tasks per step 7.

## (a) Route Scribe to compose

```bash
~/.local/bin/jlane --agent scribe --message "OUTPUT ONLY THE LOG FILE BODY — no preamble, no 'I have composed', no closing remarks. First word of your response = first word of the file.

Compose a daily-log entry for $(date +%Y-%m-%d). Format: # Daily Log — YYYY-MM-DD, then ## What happened / ## Ant preferences noted / ## Open threads / ## Lessons (omit sections with nothing to say).

Session summary: [summary]"
```

**Important:** Call jlane by its absolute path `~/.local/bin/jlane` — the bare `jlane` alias is interactive-shell-only and is `command not found` in Claude Code's non-interactive Bash.

Treat Scribe's return as *draft prose*, not a confirmed write. Add anything Scribe missed.

## (b) Claude Code writes the file

Path: `workspace/memory/YYYY-MM-DD.md`
- Append if it exists (with `# Daily Log — YYYY-MM-DD` header already present)
- Create with `# Daily Log — YYYY-MM-DD` header if it does not exist

Use Scribe's prose plus anything Scribe missed. **Cite the short SHA(s)** of the commit(s) this entry describes (from the roll-up `--oneline` list) — the gap guard in step (c) keys off these.

**Budget gate (write-time #270 enforcement, #2357).** After writing the file, run:
```bash
python3 scripts/lint-daily-log-budget.py workspace/memory/$(date +%Y-%m-%d).md
```
Exit 1 = the log is over the 60-line contract. **DISTILL, don't truncate** — route history/detail to its home (task notes, memory, working-context) and keep only distilled lessons/threads, then re-run until exit 0. This catches an over-budget log while you're still here to fix it, instead of the daily `daily-log-budget` self-heal meter flagging it the next morning (the detective→preventive fix).

## (c) Guard the roll-up gap, then mark boundary

```bash
scripts/close-boundary-advance.sh workspace/memory/YYYY-MM-DD.md
```

This loops the gap-check + auto-attribution cycle until the range is fully covered, then **immediately** writes `closed-at: SHA` to the log. The tight check→write window (milliseconds) defeats the concurrent-commit race.

- Exit 0 → boundary written; continue
- Exit 1 → >10 iterations (very unlikely); fall back to the manual path in the script's error message

Then assert: `test -f workspace/memory/YYYY-MM-DD.md && grep -q "$(date +%Y-%m-%d)" workspace/memory/YYYY-MM-DD.md`

If the file doesn't exist or doesn't contain today's date: **STOP and surface the failure** — do not silently continue the close.
