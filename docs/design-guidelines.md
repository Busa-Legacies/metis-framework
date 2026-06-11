# Design Guidelines — Metis OS

**Scope:** All UI/frontend work across Metis OS — dashboards, workspace, web UIs, agent tools.  
**Audience:** Claude (via CLAUDE.md auto-load), Jay, Jarry, any agent doing frontend work.  
**Authority:** These are opinionated rules, not suggestions. Follow them unless explicitly overridden.

---

## 1. Aesthetic Direction

**OS-grade command surface.** Metis OS is an operating environment for multi-agent work — the aesthetic should feel like a beautifully designed mission control surface. Not corporate SaaS, not consumer app, not a generic dev tool. Think: a NASA ground control terminal that was also designed by someone who loves craft.

Two contexts exist, both dark:

| Context | Character | Accent |
|---|---|---|
| **Workspace / operational** (Metis Command, agent tools) | Active command surfaces; things are running here | Midnight blue (`#0b1e3f`) brand base · cyan (`#34d3ff`) interactive · amber (`#f59e0b`) highlight |
| **Dashboard / informational** (Metis dashboard, panels) | Status surfaces; you're reading, not commanding | Indigo (`#6366f1`) |

Both contexts share the same surface system, typography, and spacing. Only the accent and background energy differ.

**Universal rules:**
- Dark backgrounds only. Never light mode unless explicitly requested.
- Monospace font (`SF Mono`, `Fira Code`, `JetBrains Mono`) for all UI text — this IS the aesthetic.
- Every screen should feel like it was designed by a developer who cares, not generated.
- Status is always visible. The system state should never be hidden in a drawer.

---

## 2. The Metis Visual Identity

### 2.1 Background canvas

The base canvas is not flat black. It has depth through **aurora gradients** — two radial glows that sit at the corners of the viewport, giving every surface a sense of depth and atmosphere without competing with content.

**Workspace / Metis Command:**
```css
background:
  radial-gradient(circle at 16% 10%, rgba(52, 211, 255, 0.16), transparent 26%),
  radial-gradient(circle at 82% 0%, rgba(167, 139, 250, 0.14), transparent 28%),
  linear-gradient(135deg, #05060a 0%, #080b13 45%, #030409 100%);
```
Cyan glow at top-left (active/interactive energy), violet glow at top-right (atmospheric/system depth). Deep base: `#05060a`.

**Dashboard / informational:**
The dashboard uses a subtler, flatter version — the aurora can be toned down to `0.08` opacity or omitted for denser data surfaces. Base: `#0b0d14`.

### 2.2 Grid overlay

For workspace surfaces, add a subtle 32px grid underneath content panels:
```css
.grid-bg {
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.055) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.055) 1px, transparent 1px);
  background-size: 32px 32px;
}
```
This creates a "command room" feeling — subtle datum lines that signal structure without adding visual weight. Use on the outermost container of workspace UIs, never on individual panels.

### 2.3 Brand mark language

The Metis brand mark pattern: **icon + ultra-wide tracking label**.

```html
<Zap size={16} class="text-cyan-300" />
<span class="text-xs font-black uppercase tracking-[0.22em] text-cyan-100">Metis Command</span>
```

- `tracking-[0.22em]` — instrument panel letter-spacing, not UI label spacing
- `font-black` (900 weight) — maximum authority at small size
- `text-cyan-100` — the text reflects the accent, not pure white
- Icon anchors the label on the left; icon color matches the accent

Product-level headers always use this pattern. Never use normal tracking for system/workspace section identity labels.

### 2.4 Scanline effect (hero elements only)

For terminals, live feed panels, or hero display elements:
```css
.scanline::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(180deg, transparent, rgba(52, 211, 255, 0.045), transparent);
  animation: scan 4s linear infinite;
}
@keyframes scan {
  from { transform: translateY(-100%); }
  to { transform: translateY(100%); }
}
```
Use sparingly — one scanline element per view max. Never on data panels, only on "live terminal" or "active feed" surfaces.

---

## 3. Color System

### 3.1 Accent tiers

| Role | Color | Hex | Use |
|---|---|---|---|
| **Workspace brand / base** | Midnight blue | `#0b1e3f` | The workspace's signature/brand tone and deep base & panel surfaces. Near-black — a *base*, not a foreground accent (it can't pop on `#05060a`). |
| **Primary interactive** (workspace) | Cyan | `#34d3ff` | The bright workspace accent used across Metis Command: active states, CTAs, borders, accent text, cursors, brand chrome. Also the codex agent-identity color. |
| **Workspace highlight** (secondary) | Amber | `#f59e0b` | Secondary highlight for select CTAs / emphasis meant to stand apart from the cyan accent. Distinct from the lighter warning amber `#fbbf24`. |
| **Primary interactive** (dashboard) | Indigo | `#6366f1` | Active states, CTAs, live indicators |
| **Atmospheric / ambient** | Violet | `#a78bfa` | System depth; Claude-tier agent identity; aurora/atmospheric glow |
| **Running / success** | Emerald | `#34d399` | Active agents, passing tests, clean git |
| **Warning / exited** | Amber (light) | `#fbbf24` | Exited agents awaiting review, warnings, dirty git — a *lighter* amber, distinct from the `#f59e0b` workspace highlight |
| **Danger / stopped** | Rose | `#fb7185` | Errors, stopped services, dangerous actions |
| **Evidence / audit** | Indigo (light) | `#a5b4fc` | Evidence counts, audit trails, approval records |

### 3.2 Semantic chip/badge pattern

All status chips use **tinted backgrounds at 10–15% opacity** with matching text at `*-200` level:
```css
bg-cyan-300/15 text-cyan-200     /* review / active */
bg-emerald-300/15 text-emerald-200  /* running / done */
bg-amber-300/15 text-amber-200   /* exited / warning */
bg-rose-300/15 text-rose-200     /* error / stopped */
bg-indigo-300/15 text-indigo-200 /* evidence / audit */
bg-slate-300/10 text-slate-300   /* todo / neutral */
```
Never solid color backgrounds for status chips — they overpower the surface.

### 3.3 Agent/lane color identity

Each agent type has a consistent color identity used across chips, tabs, and lane indicators:
```
claude  → violet-200 / violet-300/40 / violet-300/10
codex   → cyan-100   / cyan-300/40   / cyan-300/10
shell   → emerald-200 / emerald-300/40 / emerald-300/10
gemini  → amber-200  / amber-300/40  / amber-300/10
python  → sky-200    / sky-300/40    / sky-300/10
```
Pattern: `text-{color}-200 border-{color}-300/40 bg-{color}-300/10`

---

## 4. Surface Elevation System (4 levels)

Shadows don't work on dark backgrounds — elevation is communicated through **surface lightness** and **top-edge border highlights**. Panels float over the aurora gradient rather than sitting on a flat field.

| Level | Variable | Workspace hex | Dashboard hex | Use for |
|---|---|---|---|---|
| 0 — Base | `--bg` | `#05060a` | `#0b0d14` | Canvas; log terminals; deepest insets |
| 1 — Panel | `--panel` | `#0b0e15` | `#13161f` | Main panels; glassy overlays over the aurora |
| 2 — Nested | `--panel2` | `#111625` | `#1a1d2a` | Nested elements; hover states; inner cards |
| 3 — Overlay | `--surface3` | `#1a1f32` | `#212435` | Modals; tooltips; deepest hover states |

**Glassy panel style (workspace):**
```css
border: 1px solid rgba(148, 163, 184, 0.16);
background: linear-gradient(180deg, rgba(17, 22, 37, 0.88), rgba(8, 11, 18, 0.92));
box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
```
Panels should feel like frosted glass floating over the aurora gradient, not solid opaque boxes.

**Top-edge highlight rule (dashboard/cards):**
```css
border-top-color: rgba(255,255,255,0.06); /* --border-hi */
```
Workspace panels use the `line` variable (`rgba(148, 163, 184, 0.16)`) uniformly — the aurora already creates implied depth; top-edge highlights are optional.

**Card shadow formula** (dashboard surfaces, two-layer):
```css
box-shadow: 0 1px 3px rgba(0,0,0,0.6), 0 6px 24px rgba(0,0,0,0.35);
```

---

## 5. Typography Hierarchy

Three tiers. If you need a fourth, reconsider structure.

| Tier | Role | Size / Weight / Tracking | Color |
|---|---|---|---|
| T0 — Brand mark | Product/system identity labels | `12px / 900 / 0.22em / uppercase` | `text-cyan-100` |
| T1 — Section label | Tab labels, panel headers, category | `9–10px / 700 / 0.18em / uppercase` | `--muted` / `text-slate-400` |
| T2 — Primary content | Task names, focus titles, key values | `12–13px / 600` | `--text` / `text-white` |
| T3 — Secondary / meta | Paths, timestamps, counts, hints | `10–11px / 400` | `--muted` / `text-slate-500` |

**Rules:**
- Brand mark (T0) is reserved for the product identity label only. Use `tracking-[0.22em]` + `font-black`.
- Section labels (T1) use `tracking-[0.18em]` — wide but not identity-wide.
- Important content (T2) is what draws the eye. Never compete T3 with T2.
- Never use `font-weight: 100` or `300` on dark backgrounds — they disappear.
- Monospace stack: `SF Mono, Fira Code, JetBrains Mono, monospace`. **Never `Inter`, `Roboto`, `Arial`, or `system-ui`.**

---

## 6. Spacing System

Base unit: `4px`. Everything is a multiple of 4.

| Context | Value |
|---|---|
| Inside cards | `16–18px` padding |
| Between cards (grid gap) | `16px` |
| Between rows within a card | `7–8px` margin-bottom |
| Between section header and content | `12–14px` |
| Compact data rows | `3–6px` vertical padding |

**More space = more important.** The focus/primary panel gets more padding. Tight spacing signals "this is just data."

---

## 6.5 Iconography Standard

**Library:** `lucide-react` only — never mix icon sets.

**Size ladder (6 steps, nothing in between, nothing below 12):**

| Size | Role |
|---|---|
| `12` | Inline/decorative: card-title glyphs, metadata markers, status chips |
| `14` | Interactive-in-button: refresh, external-link, toggles, mode-header mark |
| `16` | Desktop nav rail, list controls (collapse/reorder), emphasis glyphs |
| `20` | Mobile primary controls: detail-view close X, primary action bar |
| `24` | Mobile bottom tab bar (HIG tab spec: 24px icon + 12px label) |
| `28` | Empty-state / placeholder hero |

**Semantic rules — one icon, one meaning:**
- **Mode identity is singular**: the icon registered in `control-center-modes.ts` is THE
  mode's glyph — reused in nav rail, bottom tabs, and that mode's header. Never a
  different icon for the same mode in two places, never that icon for anything else
  (e.g. `Bot` = Agents mode; the trading bot card uses `CandlestickChart`, remote
  access uses `Wifi`).
- **Refresh is always `RefreshCw`** (browser reload included). `RotateCcw` is reserved
  for resume/undo semantics.
- **`Cpu` = machine hardware only.** Provider usage cards get distinct glyphs:
  Claude → `Sparkles`, Codex → `Terminal`, Ollama/local host → `Server`.
- Sibling cards in one grid must never share a glyph — if two cards would take the
  same icon, one of them has the wrong icon.

---

## 7. Motion and Animation

**Principle:** Every state change should be visible. Animation communicates that the system heard you.

| Use case | Animation |
|---|---|
| Cards / panels rendering | `fade-in` with staggered `animation-delay` (50ms per card) |
| Live / running indicators | `pulse-dot` or `pulse-live` 1.4–2.4s ease-in-out infinite |
| Button hover | `transform: translateY(-1px)` + shadow deepen |
| Card hover | box-shadow transition 0.2s |
| Active agent/terminal | `scanline` 4s linear infinite (workspace surfaces only) |
| Nav/tab hover | Opacity or color transition 0.15s |

**Rules:**
- No animation longer than 0.3s for UI chrome. Data updates can go to 0.6s.
- CSS-only animations. No JS animation libraries unless Motion is already imported.
- One "hero" animation per page load (staggered card entry). Don't scatter micro-interactions.
- Animate only: `opacity`, `transform`, `box-shadow` — GPU composited, no reflow.
- `scanline` is a single-use dramatic effect, not decoration.

---

## 8. Component Patterns

### Panels (workspace)
```css
border: 1px solid rgba(148, 163, 184, 0.10);
background: rgba(0, 0, 0, 0.20);   /* bg-black/20 */
```
Left rail, right rail, and pane backgrounds float over the aurora. Never opaque.

### Cards (dashboard)
```css
background: var(--surface);
border: 1px solid var(--border);
border-top-color: var(--border-hi);
border-radius: 10px;
padding: 16px 18px;
box-shadow: var(--card-shadow);
```

### Active / selected state
```css
border-color: rgba(52, 211, 255, 0.40);   /* border-cyan-300/40 */
background: rgba(52, 211, 255, 0.10);     /* bg-cyan-300/10 */
```
Active workspace, selected tab, current item: cyan tint. Never fill solid, always transparent.

### Buttons (3-tier hierarchy)
1. **Primary**: gradient background (cyan→indigo, or indigo→purple), glow shadow. One per context max.
2. **Secondary**: transparent bg, border (`border-slate-400/20`), text. Hover fills with accent tint.
3. **Ghost** (`bg-black/30 border-slate-400/15`): nav buttons, toolbar actions. Active on hover.
```css
/* ghost button (most workspace buttons) */
border: 1px solid rgba(148, 163, 184, 0.15);
background: rgba(0, 0, 0, 0.30);
color: text-slate-300;
border-radius: 8px;
padding: 4px 8px;
```

### Status indicators
- Always text + indicator: `● RUNNING` not just a dot.
- Running/active: `pulse-dot` animation on the indicator.
- Never a plain colored circle with no label.

### Keyboard hints
```css
kbd {
  border: 1px solid rgba(148, 163, 184, 0.20);
  background: rgba(0, 0, 0, 0.40);
  border-radius: 4px;
  padding: 1px 4px;
  font-size: 9px;
  font-weight: 600;
  color: text-slate-300;
}
```

---

## 9. Workspace UX Patterns

These patterns come from building Metis Command. Apply them to any operational/command-surface UI.

### 9.1 Workroom, not tabs

A task should open a **focused room** with all its context together: the repo state, the agent lanes, the review checklist, the artifacts. Avoid scattering context across separate tabs or windows.

Layout template:
```
┌──────────────────────────────────────────────────────────┐
│ Header bar: brand mark · workspace switcher · status      │
├─────────┬────────────────────────────────┬───────────────┤
│ Left    │                                │ Right         │
│ rail    │   Pane grid (main content)     │ rail          │
│ (220px) │                                │ (320px)       │
│ nav +   │   Terminals / editors /        │ Operator /    │
│ tasks + │   agent outputs                │ notes /       │
│ files   │                                │ context       │
└─────────┴────────────────────────────────┴───────────────┘
```

### 9.2 Always-visible system status

The header bar always shows live counts:
- Active agents: `N running` (emerald chip)
- Exited agents awaiting review: `N exited` (amber chip)
- Git state per workspace: `⎇ branch · N ✱ dirty` inline in the workspace card

System state should never require navigating somewhere to find. The workspace header is the instrument panel.

### 9.3 Workspace cards show health at a glance

Each workspace card surfaces:
- Active/exited agent counts
- Task status chips (todo/build/review/done)
- Next suggested lane action (cyan chip with label)
- Git branch, dirty count, ahead/behind

This is the "workspace scan" — the operator looks at the card and knows the state without opening anything.

### 9.4 Evidence-first done state

A task is not done until artifacts are linked. "Done" is not a status flip — it's a gate that requires:
- At minimum one evidence row (diff / report / test result / commit)
- Visible checklist before the gate, not a hidden server-side check

The done gate should be visible in the UI as a checklist, not a surprise rejection.

### 9.5 Approval-gate UX

For risky actions (code generation, external mutations), the flow is:
1. Show the **lane plan** before dispatch: goal, role, model, scope, risk tier, estimated cost
2. Low/medium risk: auto-proceeds after showing the plan (brief window to cancel)
3. High/critical: explicit approval button required — visually distinct from other actions

The approval button is never a standard CTA style — it uses a border that makes it feel like a confirmation instrument, not a regular button.

---

## 10. Gestalt Principles Applied

**Proximity:** Group related items within panels by reducing internal spacing between them and increasing spacing between groups.

**Similarity:** All workspace panels use identical border/glass treatment. All workspace cards use identical structure. If something looks different, it should *mean* something different.

**Figure/Ground:** Panels must visually separate from the base canvas. The aurora gradient + glassy panels achieve this; don't undermine it with fully opaque flat panel styles.

**Continuity:** The header bar is a continuous horizontal flow. The three-column workspace grid has consistent rhythm. Navigation rails have consistent visual weight.

---

## 11. Nielsen's Heuristics — Applied

1. **Visibility of system status:** Agent counts in the header, pulse animations on live indicators, git state per workspace card. Status is never hidden.
2. **Match the mental model:** Mission control / workspace metaphor = operator mental model. Monospace, structured data, lane outputs.
3. **User control:** Drag/resize + localStorage persistence. Reset layout. All destructive actions require confirmation.
4. **Consistency:** Same panel treatment everywhere. Same button tiers. Same status chip pattern.
5. **Recognition over recall:** Nav labels always visible. Status indicators always labeled, never just colored dots.
6. **Aesthetic minimalism:** Every border, every color, every icon must earn its place. Nothing decorative.

---

## 12. Anti-Patterns

| Avoid | Instead |
|---|---|
| Flat opaque panel backgrounds | Glassy `rgba` panels floating over the aurora |
| Single flat background color | Aurora radial gradient base canvas |
| Single accent color for everything | Cyan (workspace active) + violet (atmospheric) + indigo (dashboard) |
| `Inter`, `Roboto`, `Arial`, `system-ui` | `SF Mono` / `Fira Code` / `JetBrains Mono` |
| Borders to separate every row | Spacing, background difference, or nothing |
| Every element same font weight | 3-tier typography system |
| `box-shadow` for elevation on dark bg | Top border highlight + surface lightness |
| Hidden system state | Always-visible counts/indicators in header/cards |
| Done = status flip | Done = artifact checklist gate |
| Approval as a dialog box | Approval as a visible lane plan + instrument-style confirm |
| Overusing accent color | Reserve: cyan/indigo for 2–3 uses per panel |
| Animations on everything | One stagger entry + pulse on live only + scanline on terminals |
| Pure `#000000` black | `#05060a` (workspace) or `#0b0d14` (dashboard) — near-black with blue tint |

---

## 13. Implementation Checklist

Before shipping any UI work:

**Foundation:**
- [ ] Background uses aurora gradient (workspace) or flat near-black (dashboard)
- [ ] Workspace containers use `grid-bg` grid overlay
- [ ] Panels use glassy `rgba` backgrounds, not opaque colors
- [ ] Monospace font stack applied

**Color:**
- [ ] Active states use cyan (workspace) or indigo (dashboard) — not both in the same context
- [ ] Status chips use tinted pattern (`bg-*/15 text-*-200`)
- [ ] No more than 3 accent-colored elements per panel

**Typography:**
- [ ] Brand mark labels use T0 (0.22em tracking, font-black)
- [ ] Section labels are T1 (10px/700/0.18em)
- [ ] No competing T3 elements

**Motion:**
- [ ] Live indicators have pulse animation
- [ ] Terminals/feeds use scanline (one per view max)
- [ ] Cards have staggered fade-in on load

**Workspace UX (if applicable):**
- [ ] Header always shows agent counts and system state
- [ ] Workspace cards show health (agents, tasks, git) at a glance
- [ ] Evidence gate visible before done state is reachable
- [ ] High-risk actions show lane plan before execution

---

## Sources

- [Refactoring UI](https://refactoringui.com/) — Wathan & Schoger
- [NN/g — 5 Principles of Visual Design in UX](https://www.nngroup.com/articles/principles-visual-design/)
- [NN/g — Nielsen's 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
- [Muzli — Dark Mode Design Systems](https://muz.li/blog/dark-mode-design-systems-a-complete-guide-to-patterns-tokens-and-hierarchy/)
- Metis Command (`projects/metis-command/`) — visual patterns extracted from the workspace build
- [frontend-design plugin SKILL.md](~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/skills/frontend-design/SKILL.md) — Anthropic official
