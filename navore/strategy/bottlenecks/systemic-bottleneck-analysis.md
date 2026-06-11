# Navore Market — Systemic Bottleneck Analysis (KR2.2)

**Version:** v0.1 draft · **Created:** 2026-06-07 · **OKR:** KR2.2
**Status:** Draft — [CONFIRM: review and fill all `[CONFIRM: ...]` fields; owner assignments use role names, not individuals]

This document identifies Navore Market's top systemic bottlenecks as of mid-2026, six months post La Jolla hub launch. The analysis covers five dimensions: supply (producer onboarding), demand (consumer acquisition + retention), distribution (hub capacity), technology (manual workflow gaps), and financial (unit economics + grant dependency). Each bottleneck includes a mitigation plan with owner and target quarter. Priority: P1 = blocks scaling, P2 = slows growth, P3 = long-term drag.

---

## BN-1: Producer Onboarding Velocity (P1)

**Category:** Supply

**Current state:** Producer onboarding is largely manual and untested. The `producer-onboarding/` directory has template benchmarks but no actual data — time-to-activation, training success rate, and 30/60/90-day revenue ramp are all empty. [CONFIRM: How many active producers are on the hub right now? What is the average time from first contact to first order?]

**Impact:** Directly caps supply capacity. Without enough producers with consistent volume, consumer demand cannot be reliably met at scale — the hub ceiling becomes a supply ceiling, not a demand ceiling.

**Root cause:** No formalized onboarding checklist, no tracked handoff from recruitment to activation, and no feedback loop to identify where producers drop off or underperform.

**Mitigation plan:**
1. Write and publish producer onboarding checklist and training materials (Q3 2026)
2. Pilot with 5 producers — time each step, find the friction points (Q3 2026)
3. Implement minimum-activity standard: define what "active producer" means (e.g., ≥10 orders/month) (Q3 2026)
4. Build or configure a producer onboarding dashboard tracking time-to-activation and early-order ramp (Q4 2026)

**Owner:** Founder/Ops
**Target quarter:** Q3 2026

---

## BN-2: Hub Throughput Ceiling (P1)

**Category:** Distribution

**Current state:** Hub can handle approximately [CONFIRM: 50–70?] orders/day under current SOPs. Target before second hub opens is 100+ orders/day. No data on average processing time per order, packing bottlenecks, or delivery route optimization. [CONFIRM: What is the actual current daily order volume and where does it break down?]

**Impact:** Blocks revenue scaling and expansion readiness. A second hub launch while the first hub has unresolved throughput issues duplicates the problem.

**Root cause:** Manual fulfillment with no SOPs written yet. No delivery route optimization. Inventory tracking is not real-time.

**Mitigation plan:**
1. Write hub SOPs: open/close, packing sequence, handoff, issue escalation (Q3 2026)
2. Time the current process per order — identify the single biggest time sink (Q3 2026)
3. Implement delivery route optimization (even manually with Maps first, then tooling) (Q3 2026)
4. Real-time inventory tracking: producers update stock, hub knows what's available before picking (Q4 2026)

**Owner:** Founder/Ops
**Target quarter:** Q3 2026

---

## BN-3: Manual Workflow Throughput Cap (P1)

**Category:** Technology

**Current state:** Core ops tasks — order tracking, producer inventory updates, consumer notifications, reporting — are manual or absent. The ops architecture exists as design docs but has not been implemented into tooling. [CONFIRM: What are the 2-3 most time-consuming manual tasks per day at the hub?]

**Impact:** Staff time is consumed by tasks that should be automated, creating a throughput ceiling tied to human hours rather than system capacity.

**Root cause:** Technology investment has not kept pace with operational needs. Templates exist but tooling hasn't been built or integrated.

**Mitigation plan:**
1. Audit: list every recurring manual task and time estimate per task per day (Q3 2026)
2. Automate the top-3 highest-time-cost items first (order confirmation, inventory update, notification) (Q3-Q4 2026)
3. Build or buy producer self-service for inventory updates — removes the phone-call loop (Q4 2026)
4. Ops dashboard for founders: daily order volume, fulfillment rate, outstanding issues (Q4 2026)

**Owner:** Founder/Tech
**Target quarter:** Q3–Q4 2026

---

## BN-4: Consumer Acquisition without Organic Flywheel (P2)

**Category:** Demand

**Current state:** Consumer acquisition is primarily paid or word-of-mouth with no structured organic or referral mechanism. Retention is not measured. [CONFIRM: What is the current cost per acquisition? What % of customers reorder within 30 days?]

**Impact:** Growth stalls when marketing spend slows. Without retention data, it's impossible to know if the product is working.

**Root cause:** No referral system, no email automation, no retention metric defined. Consumer feedback is informal.

**Mitigation plan:**
1. Define retention metric: % re-ordering within 30 days — start measuring now (Q3 2026)
2. Launch referral program: existing consumer gets credit for introducing a new one (Q3 2026)
3. Email/SMS automation for post-order follow-up and re-engagement (Q3 2026)
4. Consumer feedback loop: short survey after first order, review quarterly (Q4 2026)

**Owner:** Founder/Tech + Marketing
**Target quarter:** Q3 2026

---

## BN-5: Financial Model Opacity (P2)

**Category:** Financial

**Current state:** Unit economics are not tracked. Cost per order, margin per producer, hub break-even point, and cost per acquisition are unknown. Business currently depends on LFPP grant runway. [CONFIRM: What is the current monthly burn? Is there a model showing break-even without the grant?]

**Impact:** Without unit economics, there is no validated path to profitability and no credible fundraising narrative. Grant dependency without visibility into the P&L is a planning risk.

**Root cause:** No financial tracking system implemented at the order level. Revenue and cost visibility is high-level, not granular enough to make unit-economics decisions.

**Mitigation plan:**
1. Instrument financials at the order level: revenue per order, cost of fulfillment per order (Q3 2026)
2. Model hub P&L at current volume and at 100 orders/day — what does break-even look like? (Q3 2026)
3. Build a simple financial dashboard: GMV, margin, cost per acquisition, monthly burn (Q4 2026)
4. If break-even requires volume that isn't achievable in 2026, surface that gap to the board/advisors now (Q4 2026)

**Owner:** Founder/Strategy
**Target quarter:** Q3 2026

---

## BN-6: Producer Retention Unmeasured (P2)

**Category:** Supply

**Current state:** No producer retention data. Producer satisfaction, churn rate, and reasons for disengagement are unknown. [CONFIRM: Have any producers left the platform? Why?]

**Impact:** A stable supply base is a competitive moat. Unchecked churn erodes supply quality and volume, and is harder to fix once producers leave.

**Root cause:** No systematic relationship management for producers beyond ad-hoc communication.

**Mitigation plan:**
1. Define "churned producer" — has not submitted an order in 60 days (Q3 2026)
2. Monthly producer pulse: simple check-in via WhatsApp/email, surface issues early (Q3 2026)
3. Quarterly producer scorecard: reliability rate, volume consistency, issue history — shared with producer (Q4 2026)
4. Exit interviews with any producer who disengages — structured, mandatory (ongoing)

**Owner:** Founder/Ops
**Target quarter:** Q3 2026

---

## BN-7: Ops Metrics Infrastructure Missing (P3)

**Category:** Technology

**Current state:** All tracking systems in `ops/`, `producer-onboarding/`, and `distribution/` are empty templates. Key metrics (order volume, fulfillment rate, producer count, consumer retention) are not systematically collected anywhere. [CONFIRM: Where is the current source of truth for weekly order volume?]

**Impact:** Without data, bottleneck identification is qualitative. Decisions are made on gut feel rather than evidence. This slows improvement cycles.

**Root cause:** The template infrastructure was built, but the data collection layer and tooling integration were not completed.

**Mitigation plan:**
1. Pick a single source of truth for weekly order volume and fulfillment rate — even a spreadsheet — and commit to updating it (Q3 2026)
2. Fill the producer-onboarding benchmarks table with real targets and current actuals (Q3 2026)
3. Define the 5 operational KPIs that will be reviewed weekly by founders (Q3 2026)
4. Once the 5 KPIs are stable and being tracked, evaluate whether to build a custom dashboard or use an off-the-shelf tool (Q4 2026)

**Owner:** Founder/Ops + Founder/Tech
**Target quarter:** Q3 2026

---

## Summary Table

| # | Name | Category | Priority | Owner | Target Quarter |
|---|---|---|---|---|---|
| BN-1 | Producer onboarding velocity | Supply | P1 | Founder/Ops | Q3 2026 |
| BN-2 | Hub throughput ceiling | Distribution | P1 | Founder/Ops | Q3 2026 |
| BN-3 | Manual workflow throughput cap | Technology | P1 | Founder/Tech | Q3–Q4 2026 |
| BN-4 | Consumer acquisition without organic flywheel | Demand | P2 | Founder/Tech | Q3 2026 |
| BN-5 | Financial model opacity | Financial | P2 | Founder/Strategy | Q3 2026 |
| BN-6 | Producer retention unmeasured | Supply | P2 | Founder/Ops | Q3 2026 |
| BN-7 | Ops metrics infrastructure missing | Technology | P3 | Founder/Ops + Tech | Q3 2026 |

---

## Cross-Reference: Roadmap Alignment

These bottlenecks feed directly into the KR2.1 company roadmap. The Q3 2026 targets above should be reflected as dependencies in the roadmap's Q2–Q3 2026 phase. BN-1 and BN-2 are prerequisites for the Q4 2026 producer expansion and hub scaling phases.

See: `../roadmap/company-roadmap-2026-2027.md`
