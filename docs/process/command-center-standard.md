# Control Center — Schema & Edge Standard

The standard for the Notion **Control Center** DB: Tony's single pane of glass across all
life + work domains. This doc is the authority for its fields, taxonomy, edges, and
field-logging rules. Vet here before any live-schema change.

- **Database ID:** `9de6612f-b176-41cd-aa3d-452cbdd8f500`
- **Data source:** `collection://6a82d8f4-5d9e-4592-82ab-cb9ad6d77d4c`
- **First item:** CC-1 "The Leverage Paradox" (calibration piece #1)

---

## 1. Model — Aggregator (not replacement)

Control Center is an **aggregating hub**, not a new system of record. Canonical task
stores stay where they are; Control Center mirrors them into one calm surface:

| Source (canonical) | Holds | Mirrors via |
|---|---|---|
| Existing Notion **Tasks** DB (`27977493…`) | life/personal/career tasks | manual or sync |
| metis-os **tasks.json** | engineering work | sync job (Tier-3, later) |
| **projects/writing/drafts/** | drafts (body in page) | the fold-back loop (§6) |

**Rule:** never gut the old Tasks DB — it runs Tony's life (14 views, templates,
relations). Migration into Control Center is **opt-in**, never automatic.

---

## 2. Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| **Name** | title | ✓ | |
| **Type** | select | ✓ | Task · Draft · Idea · Note |
| **Domain** | select | ✓ | the 7 in §3 — closed taxonomy |
| **Status** | select | ✓ | the 8-state set in §4 (mirrors old Tasks DB) |
| **Priority** | select | | Low · Medium · High · Urgent |
| **Pillar** | select | | drafts only: ai-tech · reading-response · personal-reflective · strategy-crossover |
| **Due** | date | | the deadline |
| **Followup** | date | | next date you must *act/check* — distinct from Due |
| **Source** | relation | | back-link to canonical origin (§5 Tier 1) |
| **Project** | relation | | initiative this belongs to (§5 Tier 1) |
| **Org** | relation | | optional connective tissue (§5 Tier 1) |
| **People** | relation | | (§5 Tier 1) |
| **Parent/Sub** | self-relation | | hierarchy (§5 Tier 1) |
| **Item ID** | unique_id (CC-N) | auto | |
| **Created** | created_time | auto | |

Taxonomy is **always a select, never a relation** (§5 explains why).

---

## 3. Domain taxonomy (7) + collapse rules

Replaces the old three overlapping relational axes (DB Base / Project / Org-Group all
answered "what is this about?"). One closed select now owns categorization:

| Domain | Absorbs |
|---|---|
| **Example** | Example initiatives, startup orgs |
| **Career** | job-hunt (old Status 2 / Position), ROMBA, Deloitte orgs |
| **Engineering** | metis-os / OpenClaw (mirrors tasks.json) |
| **Writing** | drafts + pillars |
| **Finance** | reimbursements, rent, car loan, credit, timesheets (absorbs old "Admin") |
| **Personal** | logistics, relationships, life hubs |
| **Health** | therapy, yoga, daily review |

**Collapse rules (old → new):**
- old **DB Base** hub → a **Domain** if it's a life-area; a **Project** if it's an initiative.
- old **Org/Group** → keep as an **Org relation** if a real entity; else drop to People.
- old **Status 2 / Position** (job pipeline) → stays in the old Career DB; Control Center
  shows only the broad Status.

Domains are adjustable as needs evolve — closed, but not frozen.

---

## 4. Status vocabulary (8, mirrors old Tasks DB)

`Not Started · Planning · Waiting · Paused · In Progress · Canceled · Done · Archived`
grouped **To-do / In Progress / Complete**. Writing-loop states collapse into these:
"Ready for Ant" → In Progress; "fold it" → a checkbox/flag, **not** a status (§6).

---

## 5. Edges — three tiers

Match the mechanism to what the edge must *do*. Treating them as interchangeable is what
made the old DB sprawl.

| Tier | Mechanism | Use when | Analytics |
|---|---|---|---|
| **1 Structured** | two-way **relation property** | you filter / group / roll up / traverse it | full (rollups, API, group-by) |
| **2 Associative** | in-page **@-mention** | one-off contextual recall link | backlinks only |
| **3 Derived** | external **graph/RAG sync** (later) | multi-hop "what connects X to Y" | highest (graphRAG traversal) |

**Tier-1 relations (keep small, named, two-way):** Project · Org · People · Source · Parent/Sub.

**Decision rule (the standard):**
> Will I ever filter, roll up, or traverse it? → **relation.**
> Contextual recall only? → **@-mention.**
> Unsure and it's an entity? → start as **@-mention**, promote to a relation only when a
> real analytics need appears.

That promotion path is what keeps columns from sprawling again.

**Why taxonomy is never a relation:** a label has no node on the other end — it's a
select. Selects give group-by analytics for free with zero entry friction. Relations cost
a column and a navigation; reserve them for real entities.

**Tier-3 (future):** a sync reads Notion's hand-drawn relations via the API into the
metis-os RAG, so the agents can answer cross-domain graph questions Notion can't traverse
natively. Tony's manual edges become a higher-quality graph than auto-extraction would
yield — no LLM guessing the relationships.

---

## 6. Writing fold-back loop

1. Claude pushes a **fact-checked** draft → `Status = In Progress`, body in page content.
2. Tony edits on phone → flips a **"fold it"** flag (checkbox).
3. On session start, Claude queries for any item with the flag set → diffs Tony's edits
   vs the repo canonical (`Source` path) → folds voice-deltas into
   `projects/writing/voice-profile.md` → clears the flag, sets `Status = Done`.

Flipping the flag **is** the signal — Tony shouldn't have to say anything.

**Canonical rule:** the repo `.md` is the source of truth; Notion is an editable mirror.
**Always re-fetch after a push and verify it rendered faithfully** (a prior loose push
silently corrupted line 1 and dropped a section). Fact-check is a **built-in pipeline
step** — no unverified stat reaches Tony's review.

---

## 7. Field-logging standard

| Field | How to fill it |
|---|---|
| **Link / Source** | for our work, the **GitHub permalink** (`github.com/…/blob/<sha>/path`), not a local path; for external refs, the source URL |
| **Followup** | a date you next need to act/check — leave empty unless genuinely waiting on a future touch |
| **Due** | the actual deadline — not a soft target |
| **Domain** | exactly one of the 7; if it feels like two, the task is really two items |
| **Project / Org** | only when a real entity exists on the other end |
| **Pillar** | drafts only |

---

## Open / deferred
- Apply these changes to the live Notion schema (add Source; demote Org to optional;
  align Status to the 8-state set; add Domain select; add "fold it" flag).
- Tier-3 RAG sync job — design later.
- Opt-in migration of existing life-tasks — only on Tony's go.
