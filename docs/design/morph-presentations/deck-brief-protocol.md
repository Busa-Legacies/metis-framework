# Deck Brief & Direction Protocol

Every deck starts from a **brief**, not a blank engine. This is the standard intake that makes theme, content, and visuals intentional — fill it in (or answer it conversationally) *before* building. It pairs with the morph engine in [`/decks/`](../../../decks/) and the teardown in [`README.md`](README.md).

> TL;DR workflow: **Brief → research & lock the brand → outline content → map to the engine → browser-review every slide → iterate → host.**

---

## 1. The Deck Brief (answer these first)

| # | Question | Why it matters |
|---|---|---|
| 1 | **Subject + purpose** in one sentence | Focuses the whole deck |
| 2 | **The single takeaway** — if the viewer remembers one thing, what is it? | Forces a point of view |
| 3 | **Audience & venue** — investor / sales demo / social reel / internal / conference talk | Drives length, density, auto-advance, tone |
| 4 | **Format & output** — web (responsive shareable link) or `.pptx` (editable handoff)? Aspect: 16:9 or vertical 9:16 (reels)? Auto-advance for a self-running loop? | Decides the build target |
| 5 | **Brand** — does one already exist? Palette (hex), fonts, logo, official site/handles | If yes we **mirror** it; if no we define one (don't improvise per-deck) |
| 6 | **Tone** — three adjectives | Sets voice + visual weight |
| 7 | **Visual motif** — what should the silhouette scene + orb *mean*? (forest, farmland + harvest sun, data horizon, mountains = roadmap…) Anything to avoid? | Keeps visuals symbolic, not decorative |
| 8 | **Content map** — cover + **4 sections** (the persistent nav taxonomy). Per section: hero word · secondary label · headline · 1–2 sentence body | This is the deck's spine |
| 9 | **References** — decks/sites you like | Calibrates taste fast |

Keep bodies to **≤ ~30 words**. One focal point per slide.

---

## 2. Brand research (when a brand already exists)

**Be intentional: study the real brand before choosing a single color.** Don't guess what the current Example deck did as a placeholder — that's exactly the gap this step closes.

Checklist:
- [ ] **View the official site.** Use `scripts/review.sh https://brand.com /tmp/brand.png` to screenshot it once the domain is reachable. (Note: the web sandbox's TLS proxy only allows infra hosts — npm/github/google-storage — so most external brand sites 403 from here. Until a domain is allowlisted, fall back to search/press coverage, the brand's social images, or a hex sampled by hand.)
- [ ] Capture **primary + secondary colors as hex**, heading & body **fonts**, the **logo** (wordmark style + symbol), the **tagline**, and the **voice**.
- [ ] Pull **proof points from the brand's own words** — real names, places, numbers. Cite sources. **Never invent figures**, and keep sensitive internal numbers (funding, etc.) off anything outward-facing unless cleared.
- [ ] Mirror the palette into the deck's CSS variables: `--accent --accent2 --accent3 --warm --ridge1/2/3 --orb-from/mid/to --grid --hero-from/to`.

If there's **no** brand: pick one structural rule and hold it — e.g. *cool field + one warm focal pop* (the hmpt move) — then choose hues to fit the subject.

---

## 3. Map the brief to the engine

In the deck's `index.html`:
- **Palette** → the `<style> :root{…}` variable overrides (comment the source/decision).
- **Content** → the `window.DECK` object: `brand`, `pill`, `credit`, `nav[4]`, `slides[]` (slide `[0]` = cover).
- **Motif** → ridge colors + orb gradient + per-slide `orb:{t,l,d}` positions (move the orb so it frames, never fights, the text).

---

## 4. Review gate (do not skip)

Screenshot **every slide** and actually look at it before calling it done:
```bash
scripts/review.sh decks/<deck>/index.html /tmp/s0.png            # cover
scripts/review.sh decks/<deck>/index.html /tmp/s2.png advance=2  # nth slide
```
Quality bar:
- [ ] Text legible over the orb (scrim on; bump `orb` away from the column if still tight)
- [ ] One focal point per slide · hero travels · nav row pinned & correct item active
- [ ] Mobile checked (`width=390 height=844`)
- [ ] Copy sourced, no invented numbers, ≤ ~30 words/body
- [ ] Palette matches the real brand (or the chosen system)

---

## 5. Worked example — the two decks here

| | Métis | Example |
|---|---|---|
| Brand source | our house system (`design-guidelines.md`) | navoremarket.com + press (palette interpretive — confirm hex) |
| Motif | indigo data-horizon, orb = the system | harvest sun rising over SD farmland |
| Takeaway | "an autonomous agent framework" | "San Diego's local food marketplace" |
| Nav taxonomy | orchestrator · lanes · memory · surfaces | farms · shop · mission · impact |
| Voice | precise, technical, confident | warm, community, fresh |

*New deck? Copy this protocol's brief, fill it in, then copy an existing deck under `decks/` to `decks/<new>` and reskin.*
