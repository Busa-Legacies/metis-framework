# Navore Market — Revenue Initiative Brief (KR3.1)

**Version:** v0.1 draft · **Created:** 2026-06-10 · **OKR:** KR3.1
**Status:** Draft — awaiting Ant's selection of initiative + owner assignment
**Decision needed:** Pick ONE initiative below, assign an owner, and lock the tied measurements.

KR3.1 target: one partnership or operational initiative that measurably increases throughput, reduces
costs, or unlocks institutional markets — with tied measurements. This brief presents three candidates
grounded in (a) Navore's current state per the KR2.2 bottleneck analysis (supply velocity BN-1, hub
throughput ceiling BN-2, financial opacity BN-5, no organic demand flywheel BN-4) and (b) research on
comparable local-food-marketplace revenue models and farm-to-institution partnership patterns.

---

## Candidate 1 — Restaurant-Group Local-Sourcing Partnership ⭐ RECOMMENDED

**Type:** Partnership · unlocks institutional markets

**Target partner / mechanism:** 1–2 San Diego restaurant groups (3+ locations each) sourcing seasonal
produce through the La Jolla hub on a standing weekly order. Entry is direct chef/owner outreach plus
local culinary networks — La Jolla/Bird Rock and UTC have a dense farm-to-table restaurant cluster
that already markets "locally sourced" and currently pays broadline-distributor prices for it.
Structure: a standing weekly order sheet (producers' confirmed availability published Sunday, restaurant
commits Monday, delivery midweek) — no new platform build required to pilot.

**Revenue model:** Wholesale margin of 10–20% on bulk orders (industry-typical for hub-to-restaurant).
Restaurant accounts order weekly year-round, with 30-day payment terms and short-term agreements —
no long procurement cycle. Comparable hubs see restaurant wholesale as their highest-margin
institutional channel because premium/seasonal items command price, and compliance burden is the
lightest of all institutional buyers (liability insurance + food-safety basics; GAP certification
expectations vary by group — [CONFIRM: which target groups require GAP from producers?]).

**Why this fits Navore now:**
- **Fastest institutional revenue:** 3–6 months from first contact to recurring orders (vs 6–12 for
  schools, 12–18 for hospitals/universities).
- **Smooths the hub, doesn't break it:** restaurant deliveries land midweek, complementary to the
  consumer order peak — raises hub utilization without raising the BN-2 throughput ceiling.
- **Pulls producers through BN-1:** a committed weekly wholesale order gives new producers a guaranteed
  first buyer, which accelerates onboarding and retention (BN-6).
- **Roadmap-aligned:** the Q2–Q3 2026 roadmap already commits to "at least one local institutional
  buyer" — this is that line item, made concrete.

**Implementation effort:** LOW-MEDIUM. ~4–6 weeks to pilot: target list (10 groups) → outreach →
2 pilot accounts → standing order sheet (spreadsheet-first, platform later). Needs: wholesale price
list per producer, delivery slot in hub schedule, liability insurance confirmation
[CONFIRM: current coverage and whether it extends to wholesale buyers]. No new tech required for pilot.

**Tied measurements (KR3.1):**
| KPI | Baseline | Target (2 quarters) |
|---|---|---|
| Recurring restaurant accounts (≥3 orders/mo) | 0 | 2+ |
| Wholesale GMV / month | $0 | [CONFIRM: target — suggest 10–15% of total GMV] |
| Gross margin per wholesale order | unknown | measured + ≥ consumer-order margin |
| Producer SKUs moving through wholesale channel | 0 | ≥5 producers participating |

---

## Candidate 2 — Consumer Subscription Box ("Navore Weekly Harvest")

**Type:** Operational initiative · increases throughput + recurring revenue

**Target partner / mechanism:** No external partner — a productized weekly/biweekly subscription box
of seasonal items from hub producers, sold to existing consumers first (upgrade path), then to new
sign-ups. Comparable marketplaces price boxes $25–$40 with a 10–30% platform take.

**Revenue model:** Fixed-price recurring box (suggest $30–35) with Navore margin baked in. Recurring
revenue converts unpredictable one-off orders into committed weekly demand — which is also a demand
*signal* producers can plan against (helps BN-1) and a batchable fulfillment unit (boxes are packed
identically, raising effective hub throughput per labor-hour, easing BN-2).

**Why this fits Navore now:** Directly attacks retention (BN-4 — no retention mechanic exists today)
and creates the first predictable revenue line, which the BN-5 unit-economics work needs. Subscription
GMV is also the cleanest "revenue diversification beyond per-order GMV" story for the grant narrative
and any future raise.

**Implementation effort:** MEDIUM. Requires recurring billing (Stripe Billing or equivalent — buy,
don't build), a box-curation workflow each week, and churn handling. 6–10 weeks to first cohort.
Risk: box curation adds a weekly ops task to an already-manual hub (BN-3) — pilot must cap at
[CONFIRM: 25?] subscribers until packing time-per-box is measured.

**Tied measurements (KR3.1):**
| KPI | Baseline | Target (2 quarters) |
|---|---|---|
| Active subscribers | 0 | [CONFIRM: 50?] |
| Subscription GMV as % of total GMV | 0% | ≥15% |
| Monthly subscriber churn | n/a | <10% |
| Packing labor-minutes per box | unknown | measured, declining trend |

---

## Candidate 3 — Workplace / Community Drop-Point Network

**Type:** Partnership · reduces last-mile cost + acquisition channel

**Target partner / mechanism:** 3–5 employers or community sites (offices, gyms, churches, community
centers) in the delivery zone host a weekly pickup point. Employees/members order individually;
Navore delivers one batched drop instead of N doorstep deliveries. Comparable hubs charge a
convenience fee ($10–20/pickup cycle) or absorb it as a CAC-and-logistics win; some employers
subsidize as a wellness perk.

**Revenue model:** Indirect-heavy: the win is last-mile cost per order collapsing for drop-point
orders (one stop, many orders) plus a warm B2B2C acquisition channel (the host promotes internally).
Direct revenue optional via host-paid wellness subsidy [CONFIRM: pursue paid-host model or free-host
pilot first?].

**Why this fits Navore now:** Cheapest experiment of the three; directly reduces delivery cost (a
BN-5 unit-economics lever) and acquires customers in clusters (BN-4). Weaker as a KR3.1 headline
because revenue impact is second-order — it's a cost/acquisition initiative more than a revenue one.

**Implementation effort:** LOW. 2–4 weeks: host outreach kit, pickup-day SOP, a "choose drop-point at
checkout" option (manual workaround acceptable for pilot). Main risk: unstaffed pickup
no-shows/cold-chain at the drop site — needs a simple sign-out sheet + insulated tote SOP.

**Tied measurements (KR3.1):**
| KPI | Baseline | Target (2 quarters) |
|---|---|---|
| Active drop-points (≥5 orders/cycle) | 0 | 3 |
| Delivery cost per drop-point order vs doorstep | unknown | ≤50% of doorstep cost |
| New customers acquired via drop-point hosts | 0 | [CONFIRM: 30?] |

---

## Considered and deferred

- **K-12 / farm-to-school:** strong mission + grant-narrative fit, but 6–12 month procurement cycle,
  GAP certification + bid thresholds, and school-calendar seasonality put first revenue outside the
  KR3.1 measurement window. Revisit once 2+ restaurant accounts prove the wholesale ops motion.
- **Hospitals/universities:** best volume + multi-year contracts, but 12–18 months to first revenue
  and heavy vendor-compliance lift. A 2027 play, after hub 2.
- **Food bank / GusNIP / CalFresh Market Match:** low-margin but steady, and strong LFPP alignment.
  Worth a parallel low-effort application track [CONFIRM: is Navore CalFresh-eligible today?] — but
  not the KR3.1 headline initiative.
- **Producer SaaS fees:** premature — producer tooling doesn't exist yet (BN-3) and charging producers
  before delivering them reliable demand would worsen BN-6 (retention).

---

## Recommendation

**Pick Candidate 1 — Restaurant-Group Local-Sourcing Partnership.** It is the only candidate that is
simultaneously: an institutional-market unlock (the literal KR3.1 language), achievable inside the
2026 measurement window (3–6 months to revenue), margin-accretive, and load-bearing for two P1
bottlenecks (gives onboarding producers a guaranteed buyer; fills midweek hub capacity). Candidate 2
is the strongest #2 and is *complementary, not competing* — it can start one quarter later using the
same producer availability data the wholesale order sheet creates. Candidate 3 is a cheap parallel
experiment if ops bandwidth allows, but should not be the KR3.1 initiative of record.

**Next decision (Ant):** select initiative + assign owner; if Candidate 1, the first artifact is the
10-restaurant-group target list and outreach one-pager.

---

*Research basis: comparable-marketplace revenue model scan (Market Wagon, GrubMarket, regional food
hubs; subscription/wholesale/SaaS/drop-point take-rate ranges) and farm-to-institution partnership
pattern review (entry mechanisms, compliance requirements, payment terms, time-to-revenue by buyer
class), scouted 2026-06-10. Internal grounding: `strategy/bottlenecks/systemic-bottleneck-analysis.md`
(BN-1..BN-7), `strategy/roadmap/company-roadmap-2026-2027.md` (Q2–Q3 partnerships + revenue lines).*
