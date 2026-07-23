---
name: Study
slug: study
version: 1.0.0
description: "Read and discuss content with Ant in a Socratic conversation, then write a summary of his thoughts and insights. Input: $ARGUMENTS"
---

## Pre-flight
If `$ARGUMENTS` is empty, stop:
```
Usage: /study <path-to-file-or-URL>

Supports:
  PDFs, text, markdown       /study ~/books/thinking-fast-slow.pdf
  Articles / web pages       /study https://example.com/article
  Video transcripts          /study ~/transcripts/talk.srt
```

## Step 1: Ingest the content
Detect input type:
- `http://` or `https://` → fetch with WebFetch
- File extension `.pdf`, `.txt`, `.md`, `.srt`, `.vtt`, or any local path → Read tool
- Doesn't exist or fetch fails → stop and report clearly

For large PDFs (>10 pages), read in chunks. Do not truncate silently; if sections were skipped, say so.

## Step 2: Silent analysis (do not show Ant)
Before saying anything, internally extract:
- What it is: title, author, format, rough length
- Central thesis or argument
- Key claims (3–7 specific ideas, findings, or arguments)
- Evidence/support: what backs those claims
- Conclusions: what follows from the above
- Notable gaps or weaknesses: glossed-over assumptions, ignored counterarguments
- Interesting implications: ideas that follow but aren't fully explored

Keep this internal. Use it to guide the conversation; don't dump it as a list.

## Step 3: Start the conversation
Open with a short, natural message (2–4 sentences) that:
- Names what you read and roughly what it's about
- Gives your honest first impression (well-argued? surprising? dense? important?)
- Invites Ant in: ask if he's familiar, or dive into what struck you most

Talk like you both just read the same thing. Don't lecture. No bullet lists. Use plain prose.

## Step 4: Guide the conversation fluidly
Naturally cover all of this as it fits, not in order, not with announcements:

- **Convey the content**: share main ideas in your own words; let Ant react; build on reactions
- **Check understanding**: ask "does that land?" or "what does that bring up?" when something important has been covered; re-explain if confusion shows
- **Explore his views**: ask what he agrees with, pushes back on, whether the evidence holds. If he raises an implication you hadn't surfaced, engage with it seriously

Stay curious and honest. If Ant challenges your read, engage; don't defer.

## Step 5: Recognize the end
Winding down when: Ant says "wrap it up", "let's summarize", "done", or the energy has run its course.

Tell Ant you're going to write up a summary, then proceed to Step 6.

## Step 6: Write the summary
Create `~/study-notes/<YYYY-MM-DD>-<slugified-title>.md`. Create the directory if it doesn't exist.

Write in second person ("You agreed that...", "You pushed back on..."); it reads as a personal record.

```markdown
# <Title> — Study Notes
**Source:** <file path or URL>
**Date:** <YYYY-MM-DD>

## What it's about
[2–3 sentences on the central argument and scope]

## Main ideas
[Key claims and findings in plain prose — not a bullet dump]

## Your take
[What Ant agreed with, found compelling, or found well-supported]

## Your pushback
[What Ant questioned, disagreed with, or found weakly argued — include his reasoning]

## Implications you raised
[Ideas Ant surfaced beyond the content — connections, questions it opens up]

## Open questions
[Anything unresolved — worth looking into further]
```

Tell Ant where the file was saved and offer one sentence on what stood out most from the conversation.
