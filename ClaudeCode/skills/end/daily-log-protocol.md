# Daily Log Protocol — Step 6 of /end

Echo composes the prose; Claude Code persists it. Never let Echo write the file directly — it has written to the wrong directory and echoed instruction text as content.

## (a0) Git roll-up first

Find the range since the last close:
```bash
# Get boundary SHA from the most recent daily log
grep -h 'closed-at:' Jay/memory/*.md 2>/dev/null | tail -1 | awk '{print $2}'
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
python3 scripts/self-review.py --latest
```
Any actionable signals not already queued become tasks per step 7.

## (a) Route Echo to compose

```bash
~/.local/bin/jlane --agent echo --message "OUTPUT ONLY THE LOG FILE BODY — no preamble, no 'I have composed', no closing remarks. First word of your response = first word of the file.

Compose a daily-log entry for $(date +%Y-%m-%d). Format: # Daily Log — YYYY-MM-DD, then ## What happened / ## Ant preferences noted / ## Open threads / ## Lessons (omit sections with nothing to say).

Session summary: [summary]"
```

**Important:** Call jlane by its absolute path `~/.local/bin/jlane` — the bare `jlane` alias is interactive-shell-only and is `command not found` in Claude Code's non-interactive Bash.

Treat Echo's return as *draft prose*, not a confirmed write. Add anything Echo missed.

## (b) Claude Code writes the file

Path: `Jay/memory/YYYY-MM-DD.md`
- Append if it exists (with `# Daily Log — YYYY-MM-DD` header already present)
- Create with `# Daily Log — YYYY-MM-DD` header if it does not exist

Use Echo's prose plus anything Echo missed. **Cite the short SHA(s)** of the commit(s) this entry describes (from the roll-up `--oneline` list) — the gap guard in step (c) keys off these.

## (c) Guard the roll-up gap, then mark boundary

```bash
scripts/close-boundary-advance.sh Jay/memory/YYYY-MM-DD.md
```

This loops the gap-check + auto-attribution cycle until the range is fully covered, then **immediately** writes `closed-at: SHA` to the log. The tight check→write window (milliseconds) defeats the concurrent-commit race.

- Exit 0 → boundary written; continue
- Exit 1 → >10 iterations (very unlikely); fall back to the manual path in the script's error message

Then assert: `test -f Jay/memory/YYYY-MM-DD.md && grep -q "$(date +%Y-%m-%d)" Jay/memory/YYYY-MM-DD.md`

If the file doesn't exist or doesn't contain today's date: **STOP and surface the failure** — do not silently continue the close.
