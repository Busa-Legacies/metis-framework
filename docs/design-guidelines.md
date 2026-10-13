# Design Guidelines: Metis OS

**Scope:** All UI/frontend work across Metis OS: dashboards, workspace, web UIs, agent tools.  
**Audience:** Claude (via CLAUDE.md auto-load), <<MACHINE_1_ID>>, <<MACHINE_2_ID>>, any agent doing frontend work.  
**Authority:** These are opinionated rules, not suggestions. Follow them unless explicitly overridden.

---

## 0. Metis Command: Reinvisioned Design Language (2026-06, #437), CANONICAL

> **This section supersedes §§1–9 for the Control Center.** Sections 1–9 document the legacy
> dark "command surface" identity (dark-only, monospace-everything, grid/scanline) that shipped
> through mid-2026. The #437 reinvision replaces it. Where §0 conflicts with §§1–9 for the
> Control Center, **§0 wins.** Legacy sections stay until the Three-Rooms refactor (W2/W7) removes
> the surfaces they describe. Reference: `docs/plans/PLAN-metis-command-reinvision.md`,
> `docs/reviews/metis-os-ux-reinvision-audit-2026-06-22.md`.

**Direction locked (2026-06-23): "d1: Console."** Ant picked d1 of the three W1 directions: the cleanest
balance of actionable-insight density with minimal clutter. The tokens and layout below are d1's *actual*
values (source: `docs/plans/w1-design-directions/d1-console.html`), now canonical.

**Aesthetic: "Calm Focus": light, airy, editorial.** A surface Ant *wants to live in*, not a dense
console he tolerates. The metric is adoption, not decoration: the UI's job is to tell him what's
happening, what needs him, and how to act, with as little friction as possible, on desktop and phone.

**The attention principle (the one rule everything else serves).** The base is calm neutral (slate on
near-white); **color is signal, never decoration.** Two layers carry it in d1: (1) each needs-you item is
**typed by action color** (the §0.2 taxonomy, Decide=amber, Review=blue, Unblock=rose…), so the color
tells Ant *how* to act, not just *that* something waits; (2) the **rose `#be123c` count badge** on a room
icon is the at-a-glance "something needs you here." When nothing needs him: no badges, no warm color: the
surface rests ("All systems nominal"). *(This refines the earlier single-coral-accent draft to match what
d1 actually does; flag if you'd rather a single global accent instead of typed action-colors.)*

### 0.1 Color tokens *(d1 actual values)*
| Token | Value | Use |
|---|---|---|
| `--rail` / `--rail-2` | `#0f172a` / `#1e293b` | **dark slate nav rail** + active-item bg (the console contrast) |
| `--canvas` | `#f5f7fb` | app canvas (cool near-white) |
| `--card` | `#ffffff` | cards, rows, table |
| `--ink` / `--ink-2` / `--ink-3` | `#0f1b2d` / `#465a76` / `#8494b0` | primary / secondary / tertiary text (**blue-slate**, re-biased 2026-08-06) |
| `--line` | `#e4eaf3` | hairline borders + dividers |
| `--blue` / `--blue-soft` | `#2563eb` / `#eff4ff` | primary action · Review |
| `--amber` / `--amber-soft` | `#b45309` / `#fef3e2` | Decide · waiting |
| `--rose` / `--rose-soft` | `#be123c` / `#fdeef1` | **needs-you badge** · Blocked / Unblock |
| `--green` / `--green-soft` | `#15803d` / `#e9f7ef` | system-healthy |
| `--brand-grad` | `linear-gradient(135deg,#3b82f6,#22d3ee)` | logo + progress bars (the one ornament) |
| `--radius` | `14px` | cards; buttons 8px, pills/badges 6px |

The signature is **dark rail + light canvas**: not all-light. Light content is the default and the norm
(overrides §1's "dark only"); the rail is the one dark surface. A full dark theme may come later as an
option, not the base.

**Neutrals are blue-slate, never flat gray (Ant 2026-08-06).** Gray is Ant's least-favorite color and reads
as unconsidered. The neutral tokens above are re-biased toward blue so even secondary/tertiary text reads as
*chosen*. **Gray is never an accent, fill, or indicator color**, meaning is carried by brand/signal color
(`--blue`/`--amber`/`--rose`/`--green`) or `--brand-grad`; gray only ever appears as (blue-biased) neutral
text and hairlines. Dark-theme neutral targets: `--canvas #0a1322` · `--card #141f30` · `--ink-2 #9db0ca` ·
`--ink-3 #6b7d9c` · `--line #243349`. Application = swap `.d1` tokens in `projects/metis-command/app/globals.css`
(+ dashboard) and **QA at ~390px in both themes** before done (§0 visual-QA gate).

### 0.2 Action-type taxonomy (new reusable primitive)
Every item that needs Ant is **typed by the interaction it wants**, and renders the matching control
inline. This is the core component of the reinvision: used in the Pulse briefing, inbox, and anywhere
work surfaces to Ant. Knowing *that* something needs him is useless without knowing *how* to act.

| Mode | What it asks for | Inline control | Color |
|---|---|---|---|
| **Decide** | pick one of N | option chips | amber `#b8780f` / `#fdf3e0` |
| **Answer** | type a reply | text field + Send | indigo `#5160d6` / `#eef0fc` |
| **Approve** | yes / no | Approve · Reject | violet `#8b5cf6` / `#f4effe` |
| **Direct** | open-ended steer | "Give direction →" (opens prompt) | blue `#2563eb` / `#eef4ff` |
| **Run** | run a command | command + ▶ Run on `<host>` / Open terminal (mobile: live terminal) | teal `#0e8a7a` / `#e6f6f3` |
| **Review** | read & edit | Review → · Approve as-is | sage `#5b7a6b` / `#eef3f0` |
| **Unblock** | grant access/scope/credential | Unblock (states what's needed) | rose `#d6455f` / `#fdecef` |

Each item shows: a **mode tag** (color-coded), a one-line *"what you need to do,"* and the affordance.
Mode colors are for the tag/control only: they do not compete with `--attn` for the eye.

### 0.3 Typography *(d1 scale)*
System/`Inter` sans for all UI text (this overrides §1's monospace mandate). Monospace
(`ui-monospace`, `SFMono`, `Menlo`) is reserved for **code, terminals, task IDs, and lane/model names**.
d1 scale (canonical floor, reconciled 2026-09-01, #5100; supersedes the §5 legacy tiers and any
11–13px body sizing): **14px is the floor for all functional + body text** (task names, values, row/list
text, hints) / line-height 1.5; **briefing H1 22px** (slightly tight, `-.01em`); **non-body chrome only**
may drop to **12px**: uppercase, `.1em`-tracked card-section eyebrows + tab labels (`--ink-3`); **11px is
the hard minimum**, for micro-badges/counts only. **Nothing renders below 11px**: the old 10px `.badge`
is retired. Real hierarchy without sprawl; let text breathe.

### 0.4 Spacing & density
Airy by default. Card padding 16–20px; 12–24px gaps between sections; max content width ~1080px so lines
don't sprawl. White space is a feature: never pack to fill. The "mission control" north star means
dense in **information**, not pixels: high signal per screen and status always visible, with white space
separating the groups (Ant 2026-10-12).

### 0.5 Layout *(d1)*
- **Front door = a briefing** (the Pulse room, RoomId `watch`), never an empty terminal. d1's briefing leads with a
  greeting + "since you were away" line, then System chips, a Dispatch field, Needs-you, Goal progress,
  and Active agents, answering "is it running / what needs me / what's next" above the fold.
- **Slim dark rail** (`--rail`, ~212px desktop) with two labeled groups: **Rooms** (**Pulse · Health ·
  Money · Home · Personal · Command**, the shipped IA v2; the old **Steer / Plan / Studio / System are
  NOT rooms**, they fold into **Command** as its sub-tabs) then **Context** (the **Personal ↔ Example**
  toggle, the existing binary `workspace` context, surfaced here instead of buried in Settings), plus
  Settings (a room-less utility) and a foot status line (`● All systems nominal`). Mobile: bottom tab bar.
  A rose count badge on a room icon = needs-you there. **Canonical source of the room set + mode→room
  mapping is `projects/metis-command/lib/control-center-rooms.ts`**: this doc describes it, never leads it.
- **⌘K command palette is global** (any room), the fast path for navigation + dispatch; a search field
  ("⌕ Search anything… ⌘K") also sits in the top bar.
- Status is always visible (this §1 rule survives), but calm: a quiet health row, not a dense HUD.

### 0.6 Components
- **Cards/rows:** white on `--bg`, `--line` border, 14–16px radius, no heavy shadows (at most `0 1px 2px rgba(0,0,0,.03)`).
- **Buttons:** neutral outline default; the *primary action of a typed item* uses that mode's color;
  the global attention/CTA uses `--attn`. Max one filled button per row.
- **Action Queue:** the §0.2 primitive: the canonical way work is presented to Ant.
- **Confirms:** in-app `ConfirmActionButton`, never `window.confirm()` (which also breaks the aesthetic).
- **Back affordance (#450):** every drill-in surface (Studio inner screens, detail panes, line/task
  detail) returns via the ONE shared `<BackButton>`: an arrow **plus the named destination**
  ("← Studios", never a bare arrow), pinned to the **fixed left** of the header so it never scrolls
  off on a phone, with a ≥44px touch target there. Never bury it at the end of a scrolling toolbar.
- **Progressive disclosure (#450):** a surface leads with its **primary action**; secondary and rare
  controls collapse behind a single overflow ("⋮") rather than a wall of unlabeled icons. Decorative,
  label-less icons are noise: drop them (especially on mobile). On a phone the header's action cluster
  must **wrap or collapse to overflow**: it may never run off the viewport edge.
- **Drill-in by default, every tile/card/panel is clickable (#458, CANONICAL):** progressive
  disclosure is not just header layout: it is the **core navigation contract of the OS**. Any tile,
  stat card, or panel that summarizes something with a richer view **must be clickable as a whole** to
  open that view: the *entire* card is the target (it renders as a real `<button>` carrying an
  `actionHint` like "Open Ops"), never a buried "details →" link. **Mechanism:** pass
  `onClick={() => nav.goto('<mode>'[, opts])}` to the shared `StatusCard`/panel primitive: the
  hover/focus affordance + `actionHint` tooltip come for free; bespoke cards must replicate the same
  button semantics. A surface stays non-clickable **only when it is a genuine leaf** (no deeper view
  exists): that is the rare, self-evident exception, not the default. This rule is **retroactive
  (audit and fix existing tiles), present, and binding on all future UI.** Constraints: a button can't
  nest buttons, when a card needs inner row-level actions, make the card *header/body* the nav target
  and keep row actions as sibling affordances (see OverviewSummary "Active Work"). Keyboard/touch: real
  button → Enter/Space activatable, ≥44px target. Pair with the Back affordance above so every drill-in
  returns cleanly.

### 0.7 Motion
Restrained and quick (≤150ms ease): fades and small slides for state changes; the attention accent may
use a single subtle pulse when a *new* needs-you item arrives, then rest. No ambient/looping motion in
the workspace. (Marketing/public surfaces are out of scope here, see `feedback_motion_context_scope`.)

**Reduced-motion contract ("calm workspace, lively moments", Ant, 2026-07-15).** Ant runs OS Reduce
Motion **ON**, so this contract is his lived default, not an edge case. Under
`prefers-reduced-motion: reduce`: **ambient workspace chrome stills** (skeleton shimmer, scanline,
card-entrance stagger, loader breathe; Tailwind `animate-spin` becomes a calm opacity pulse, see the
globals.css reduce block), while **intentional one-shot moments still play**: the boot compass
(gentler sweep variant), room-switch fade, lock/confirm beats. New ambient motion must join the reduce
block; new "moments" must stay brief, bounded, and one-shot to qualify. Verify motion work under
`reducedMotion: 'reduce'` emulation before reporting done (qa-ui gate #4).

### 0.8 Mobile (full parity)
Bottom tab bar (the IA-v2 rooms, Pulse/Health/Money/Home/Personal/Command) with the context toggle + Settings under a "You"/overflow;
thumb-sized targets (≥44px); the Action Queue stacks vertically; **full live terminals** on mobile
(xterm.js + a keyboard toolbar: Tab/Ctrl-C/Esc/arrows). The phone is a first-class surface, not a
read-only companion.

### 0.8b Interaction is assumed (Ant 2026-07-17, #810, ALL systems, not just the CC)
Interactivity must be **intuitive and assumed, never labeled and clunky**: a tap, pinch, or swipe
should do to a component exactly what a user would expect it to do, without an instruction label,
a dedicated button, or a mode. Concretely:
- **Tap** a summary element (KPI tile, chip, list row) → it selects, expands, or drills into the
  thing it summarizes (this generalizes §0.6 "drill-in by default" from cards to every element).
- **Swipe horizontally on a chart** → shift the visible time window through history (drag right =
  earlier, drag left = back toward now). Vertical pan stays with the page (`touch-action: pan-y`).
- **Pinch on a chart** → zoom the time axis (in = shorter window, out = longer); the y-axis
  auto-fits the visible data, which is what vertical zoom means in practice.
- Explicit controls (dropdowns, ‹ › pagers) remain as the discoverable/accessible twin of every
  gesture: gestures are an accelerator, never the only path (a11y floor).
Scope: every surface we build, across all systems: dashboard, CC, public sites. When adding a new
component ask "what would a user expect a tap/swipe/pinch to do here?" and wire exactly that.

### 0.8b-i Swipe-to-reveal actions + symbol-first, minimal-text UI (Ant 2026-07-31, #1596, ALL systems)
Two standards that make the UI maximally intuitive with as little text as possible:

**Swipe-to-reveal row actions.** An actionable list row (a workout, exercise, set, task, message,
any editable/removable row) exposes its actions by **swipe-left**, not a permanent button cluster.
- Use the `SwipeableRow` primitive (`components/ui/SwipeableRow.tsx`): swipe-left (or mouse-drag)
  **slides the row content left in place** so a typed action strip rides into the freed space **on the
  same line** (the native iOS feel, Ant 2026-08-07, not a menu dropped on a new line below; the row
  never grows taller); swipe-right dismisses it. Actions are `{key,label,icon,onSelect,destructive?}`.
- **Discoverable/accessible twin (a11y floor, non-negotiable):** a persistent `⋯` trigger toggles the
  same tray, so the actions are reachable by tap, mouse, keyboard, and assistive tech: the gesture is
  an accelerator, never the only path (same rule as §0.8b's chart gestures).
- **Destructive actions confirm inline** (two-tap) so a mis-swipe never deletes.
- Honor reduced motion (Ant runs Reduce Motion ON): the slide is an **instant transform swap**, not an
  animated glide, under `motion-reduce:`: never a JS media query.

**Symbol-first, minimal text.** Prefer an icon to a word wherever the meaning is unambiguous; show a
text label only when the icon alone would be ambiguous (or alongside the icon for a primary action).
- Every icon-only control still carries its label as the **accessible name** (`aria-label` + `title`):
  symbol-first is a *visual* reduction, never an information reduction.
- Keep the icon taxonomy consistent across the app (same verb → same glyph): edit=pencil, delete=trash,
  resume/start=play, more=⋯, add=plus, etc. A given action looks the same everywhere.
Goal: the least text that stays fully intuitive and fully accessible. Roll across all list surfaces;
fitness rows (workout/exercise/set) are the first adopter.

### 0.8c Detail pages are dashboards: progressive disclosure down the scroll (Ant 2026-07-17, #810 r9)
A drill-down page (and each category/lens it offers) reads like a small dashboard as you scroll:
**summary at the top, trends in the middle, details below.**
- **Summary**: a KPI strip scoped to the visible window (averages/totals/extremes over the selected
  block), so the page answers "how is this going?" before any chart is read.
- **Trends**: the charts, sharing the page's time window and gesture layer (§0.8b).
- **Details**: per-row precision at the bottom: recent-day tables, event/session lists, leaf KPIs.
  The reader who scrolls all the way down earns the raw numbers; nobody pays for them up front.
When a page has trend categories (§ r8 control-bar explorer), every category follows the same
anatomy, switching category swaps summary, charts, and details together.

### 0.8d Loading is never a blank: show a shape-matched skeleton (Ant 2026-07-19, #810 r12)
If a surface is fetching content, it shows a **loading indicator, never a blank or half-broken
surface** ("if a page is loading we need an indicator, not just missing"). Prefer a **skeleton that
matches the shape of what's coming** over a bare "loading…" or a lone spinner: a chart section loads a
chart silhouette, a KPI strip loads KPI tiles, a list loads rows, so the layout previews itself and
the wait reads as intentional. Reusable primitives live in `components/ui/Skeleton.tsx`
(`Skeleton` · `KpiSkeleton` · `ChartSkeleton` · `RowsSkeleton` · `DetailChartSkeleton`); the branded
`MetisLoader` (breathing compass) is the spinner for **actions** (sync/save), not content loads.
- **Reduced-motion (§0.7, Ant runs it ON):** the shimmer is `motion-reduce:animate-none`, settling to a
  calm static placeholder, still clearly "content here", never a pulsing distraction.
- **A11y:** every skeleton carries `role="status"` + an `aria-label` so the wait is announced.
- Gate on **`loading && !data`** (not bare `loading`) so a refetch over existing data doesn't flash a
  skeleton: the current view stays until the new data replaces it.

### 0.8e Information-design principles (Ant 2026-08-06, entry-card review, ALL surfaces)
Distilled from the nutrition entry-card review; these are **general metis rules**, not card-specific.

- **Original identity, never a clone.** Don't copy a competitor product's layout *or* palette ("make it
  less an MFP copy"). Borrow patterns only after they're re-expressed in the metis language.
- **No emoji: clean icons only.** `lucide-react` / inline `<svg stroke="currentColor">` for indicators
  & buttons; delete purely decorative glyphs. (Full rule in `.claude/rules/design.md`.)
- **No redundant decoration.** Don't add a chart/ring or a legend that only restates numbers already
  shown; when items are self-labeled, drop the key.
- **A key/label matches the format of the data it labels**: else simplify or remove it.
- **Align a label/figure to the data it describes**: a per-segment stat sits directly under its segment.
- **Order by the user's mental model, not the data model.** Sequence a screen by what the user *has →
  wants → needs to decide* (put yourself in their shoes doing the task).
- **Headline metric top-right.** The single most important number sits top-right beside the title on a
  detail/entry card (calories by the food name).
- **Progressive disclosure.** Demote rarely-changed controls (date/time) behind a collapsible line; keep
  the primary controls prominent. Pairs with §0.8b-i (symbol-first, minimal-text).
- **Primary action reachable without scrolling.** The main action (Save/Confirm) must be reachable
  without scrolling: a **top-header action on short screens**, or a **sticky footer / floating action on
  screens meant to scroll**. Assess per page; **ask when ambiguous** (Ant 2026-08-06).
- **Smart defaults from context.** Pre-fill fields from context (meal from time-of-day, date = today) so
  the common case needs zero input; always editable.
- **Target/budget displays lead with what's *left*.** Show remaining first (per-item colored), with
  consumed/target secondary, when logging against a goal, "how much room is left" is the question.
- **Verified badge = green-circle check**, shown *only* when the data is genuinely verified-accurate.

### 0.9 Design lint (impeccable): advisory (#462)
We run [pbakaus/impeccable](https://github.com/pbakaus/impeccable)'s deterministic detector as an
**advisory** check on the Control Center, not a blocking gate: `cd projects/metis-command && npm run
design:lint` (wraps `impeccable detect components app`). It catches the AI-generated-UI tells §0 already
bans (off-palette gradients, overused fonts, dated bounce easing) and surfaced real drift we'd merged
(indigo progress bars, Inter, an overshoot boot pop), all since fixed.

- **Config:** `projects/metis-command/.impeccable/config.json`. `gray-on-color` is **waived repo-wide**:
  every hit was a false positive (the detector reads a bright bg + slate text in one `className` string,
  but ours sit on opposite branches of an active/inactive ternary and it ignores the `/10`–`/15` opacity
  modifier). `layout-transition` stays **active/advisory** (the 2 current hits are intentional
  progress-bar `transition: width` in `SystemMapPanel`).
- **Not a CI gate, and the edit-time hook is OFF**: until the detector can parse Tailwind conditionals +
  opacity, gating would block on false positives. Revisit promotion to a gate when that lands (#462).
- **Other surfaces:** the portfolio site is scanned separately on <<MACHINE_1_ID>> via the `impeccable-portfolio-scan`
  relay key (#463); impeccable is also on the frontier-scan `design-quality` watch list so new releases surface.

---

## 1. Aesthetic Direction

**OS-grade command surface.** Metis OS is an operating environment for multi-agent work: the aesthetic should feel like a beautifully designed mission control surface. Not corporate SaaS, not consumer app, not a generic dev tool. Think: a NASA ground control terminal that was also designed by someone who loves craft.

Two contexts exist, both dark:

| Context | Character | Accent |
|---|---|---|
| **Workspace / operational** (Metis Command, agent tools) | Active command surfaces; things are running here | Midnight blue (`#0b1e3f`) brand base · cyan (`#34d3ff`) interactive · amber (`#f59e0b`) highlight |
| **Dashboard / informational** (Metis dashboard, panels) | Status surfaces; you're reading, not commanding | Indigo (`#6366f1`) |

Both contexts share the same surface system, typography, and spacing. Only the accent and background energy differ.

**Universal rules:**
- Dark backgrounds only. Never light mode unless explicitly requested.
- Monospace font (`SF Mono`, `Fira Code`, `JetBrains Mono`) for all UI text: this IS the aesthetic.
- Every screen should feel like it was designed by a developer who cares, not generated.
- Status is always visible. The system state should never be hidden in a drawer.

---

## 2. The Metis Visual Identity

### 2.1 Background canvas

The base canvas is not flat black. It has depth through **aurora gradients**: two radial glows that sit at the corners of the viewport, giving every surface a sense of depth and atmosphere without competing with content.

**Workspace / Metis Command:**
```css
background:
  radial-gradient(circle at 16% 10%, rgba(52, 211, 255, 0.16), transparent 26%),
  radial-gradient(circle at 82% 0%, rgba(167, 139, 250, 0.14), transparent 28%),
  linear-gradient(135deg, #05060a 0%, #080b13 45%, #030409 100%);
```
Cyan glow at top-left (active/interactive energy), violet glow at top-right (atmospheric/system depth). Deep base: `#05060a`.

**Dashboard / informational:**
The dashboard uses a subtler, flatter version: the aurora can be toned down to `0.08` opacity or omitted for denser data surfaces. Base: `#0b0d14`.

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
This creates a "command room" feeling: subtle datum lines that signal structure without adding visual weight. Use on the outermost container of workspace UIs, never on individual panels.

### 2.3 Brand mark language

The Metis brand mark pattern: **icon + ultra-wide tracking label**.

```html
<Zap size={16} class="text-cyan-300" />
<span class="text-xs font-black uppercase tracking-[0.22em] text-cyan-100">Metis Command</span>
```

- `tracking-[0.22em]`: instrument panel letter-spacing, not UI label spacing
- `font-black` (900 weight): maximum authority at small size
- `text-cyan-100`: the text reflects the accent, not pure white
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
Use sparingly: one scanline element per view max. Never on data panels, only on "live terminal" or "active feed" surfaces.

---

## 3. Color System

### 3.1 Accent tiers

| Role | Color | Hex | Use |
|---|---|---|---|
| **Workspace brand / base** | Midnight blue | `#0b1e3f` | The workspace's signature/brand tone and deep base & panel surfaces. Near-black: a *base*, not a foreground accent (it can't pop on `#05060a`). |
| **Primary interactive** (workspace) | Cyan | `#34d3ff` | The bright workspace accent used across Metis Command: active states, CTAs, borders, accent text, cursors, brand chrome. Also the codex agent-identity color. |
| **Workspace highlight** (secondary) | Amber | `#f59e0b` | Secondary highlight for select CTAs / emphasis meant to stand apart from the cyan accent. Distinct from the lighter warning amber `#fbbf24`. |
| **Primary interactive** (dashboard) | Indigo | `#6366f1` | Active states, CTAs, live indicators |
| **Atmospheric / ambient** | Violet | `#a78bfa` | System depth; Claude-tier agent identity; aurora/atmospheric glow |
| **Running / success** | Emerald | `#34d399` | Active agents, passing tests, clean git |
| **Warning / exited** | Amber (light) | `#fbbf24` | Exited agents awaiting review, warnings, dirty git: a *lighter* amber, distinct from the `#f59e0b` workspace highlight |
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
Never solid color backgrounds for status chips: they overpower the surface.

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

Shadows don't work on dark backgrounds: elevation is communicated through **surface lightness** and **top-edge border highlights**. Panels float over the aurora gradient rather than sitting on a flat field.

| Level | Variable | Workspace hex | Dashboard hex | Use for |
|---|---|---|---|---|
| 0: Base | `--bg` | `#05060a` | `#0b0d14` | Canvas; log terminals; deepest insets |
| 1: Panel | `--panel` | `#0b0e15` | `#13161f` | Main panels; glassy overlays over the aurora |
| 2: Nested | `--panel2` | `#111625` | `#1a1d2a` | Nested elements; hover states; inner cards |
| 3: Overlay | `--surface3` | `#1a1f32` | `#212435` | Modals; tooltips; deepest hover states |

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
Workspace panels use the `line` variable (`rgba(148, 163, 184, 0.16)`) uniformly: the aurora already creates implied depth; top-edge highlights are optional.

**Card shadow formula** (dashboard surfaces, two-layer):
```css
box-shadow: 0 1px 3px rgba(0,0,0,0.6), 0 6px 24px rgba(0,0,0,0.35);
```

---

## 5. Typography Hierarchy

> **SUPERSEDED (2026-09-01, #5100).** The sizes in this legacy table (9–13px) are NON-authoritative:
> **§0.3 governs**: 14px floor for functional/body text, 12px for non-body chrome only, 11px hard minimum,
> no 10px. The tier *roles* below still hold; read their sizes as the §0.3 floor, not the old numbers.

Three tiers. If you need a fourth, reconsider structure.

| Tier | Role | Size / Weight / Tracking | Color |
|---|---|---|---|
| T0: Brand mark | Product/system identity labels | `12px / 900 / 0.22em / uppercase` | `text-cyan-100` |
| T1: Section label | Tab labels, panel headers, category | `9–10px / 700 / 0.18em / uppercase` | `--muted` / `text-slate-400` |
| T2: Primary content | Task names, focus titles, key values | `12–13px / 600` | `--text` / `text-white` |
| T3: Secondary / meta | Paths, timestamps, counts, hints | `10–11px / 400` | `--muted` / `text-slate-500` |

**Rules:**
- Brand mark (T0) is reserved for the product identity label only. Use `tracking-[0.22em]` + `font-black`.
- Section labels (T1) use `tracking-[0.18em]`: wide but not identity-wide.
- Important content (T2) is what draws the eye. Never compete T3 with T2.
- Never use `font-weight: 100` or `300` on dark backgrounds: they disappear.
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

**Library:** `lucide-react` only: never mix icon sets.

**Size ladder (6 steps, nothing in between, nothing below 12):**

| Size | Role |
|---|---|
| `12` | Inline/decorative: card-title glyphs, metadata markers, status chips |
| `14` | Interactive-in-button: refresh, external-link, toggles, mode-header mark |
| `16` | Desktop nav rail, list controls (collapse/reorder), emphasis glyphs |
| `20` | Mobile primary controls: detail-view close X, primary action bar |
| `24` | Mobile bottom tab bar (HIG tab spec: 24px icon + 12px label) |
| `28` | Empty-state / placeholder hero |

**Semantic rules: one icon, one meaning:**
- **Mode identity is singular**: the icon registered in `control-center-modes.ts` is THE
  mode's glyph: reused in nav rail, bottom tabs, and that mode's header. Never a
  different icon for the same mode in two places, never that icon for anything else
  (e.g. `Bot` = Agents mode; the trading bot card uses `CandlestickChart`, remote
  access uses `Wifi`).
- **Refresh is always `RefreshCw`** (browser reload included). `RotateCcw` is reserved
  for resume/undo semantics.
- **`Cpu` = machine hardware only.** Provider usage cards get distinct glyphs:
  Claude → `Sparkles`, Codex → `Terminal`, Ollama/local host → `Server`.
- Sibling cards in one grid must never share a glyph, if two cards would take the
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
- Animate only: `opacity`, `transform`, `box-shadow`: GPU composited, no reflow.
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

This is the "workspace scan": the operator looks at the card and knows the state without opening anything.

### 9.4 Evidence-first done state

A task is not done until artifacts are linked. "Done" is not a status flip: it's a gate that requires:
- At minimum one evidence row (diff / report / test result / commit)
- Visible checklist before the gate, not a hidden server-side check

The done gate should be visible in the UI as a checklist, not a surprise rejection.

### 9.5 Approval-gate UX

For risky actions (code generation, external mutations), the flow is:
1. Show the **lane plan** before dispatch: goal, role, model, scope, risk tier, estimated cost
2. Low/medium risk: auto-proceeds after showing the plan (brief window to cancel)
3. High/critical: explicit approval button required: visually distinct from other actions

The approval button is never a standard CTA style: it uses a border that makes it feel like a confirmation instrument, not a regular button.

---

## 10. Gestalt Principles Applied

**Proximity:** Group related items within panels by reducing internal spacing between them and increasing spacing between groups.

**Similarity:** All workspace panels use identical border/glass treatment. All workspace cards use identical structure. If something looks different, it should *mean* something different.

**Figure/Ground:** Panels must visually separate from the base canvas. The aurora gradient + glassy panels achieve this; don't undermine it with fully opaque flat panel styles.

**Continuity:** The header bar is a continuous horizontal flow. The three-column workspace grid has consistent rhythm. Navigation rails have consistent visual weight.

---

## 11. Nielsen's Heuristics: Applied

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
| Pure `#000000` black | `#05060a` (workspace) or `#0b0d14` (dashboard): near-black with blue tint |

---

## 13. Implementation Checklist

Before shipping any UI work:

**Foundation:**
- [ ] Background uses aurora gradient (workspace) or flat near-black (dashboard)
- [ ] Workspace containers use `grid-bg` grid overlay
- [ ] Panels use glassy `rgba` backgrounds, not opaque colors
- [ ] Monospace font stack applied

**Color:**
- [ ] Active states use cyan (workspace) or indigo (dashboard): not both in the same context
- [ ] Status chips use tinted pattern (`bg-*/15 text-*-200`)
- [ ] No more than 3 accent-colored elements per panel

**Typography:**
- [ ] Brand mark labels use T0 (0.22em tracking, font-black)
- [ ] Section labels are 12px/700/0.18em uppercase (§0.3 floor; NOT the old 10px)
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

**Metis Command responsive parity:**
- [ ] Desktop and mobile both have a reachable path to the changed behavior, or the single-surface exception is explicit
- [ ] Shared-first implementation: viewport branches only encode layout/interaction differences
- [ ] `cd projects/metis-command && npm run verify:parity` passes for changes under `app/`, `components/`, or `lib/`
- [ ] New behavior adds/updates a parity e2e assertion when it changes a cross-surface contract

---

## Sources

- [Refactoring UI](https://refactoringui.com/): Wathan & Schoger
- [NN/g: 5 Principles of Visual Design in UX](https://www.nngroup.com/articles/principles-visual-design/)
- [NN/g: Nielsen's 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
- [Muzli: Dark Mode Design Systems](https://muz.li/blog/dark-mode-design-systems-a-complete-guide-to-patterns-tokens-and-hierarchy/)
- Metis Command (`projects/metis-command/`): visual patterns extracted from the workspace build
- [frontend-design plugin SKILL.md](~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/skills/frontend-design/SKILL.md): Anthropic official
