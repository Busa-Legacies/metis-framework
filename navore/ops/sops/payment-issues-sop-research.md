# SOP Research: Payment & Payrix Issues

**Status:** RESEARCH — Pending stakeholder input before drafting
**Owner:** Anthony Abusa
**KR:** KR1.2 — SOPs & Risk Framework
**Date:** 2026-04-23
**Target SOP:** Payment & Payrix Issues SOP (single combined SOP)

---

## How Payrix Works at Navore (Research Summary)

Payrix is a **PayFac-as-a-Service** platform (now owned by Worldpay). Navore operates as the **master merchant / partner**. Each producer is a **sub-merchant** under Navore's umbrella.

### Key Architecture
- Navore = Partner (master merchant, collects platform fee)
- Each producer = Sub-merchant (their own Payrix account, handles their own payouts)
- Producers are solely responsible for refunds, returns, and customer service on their products
- Producers have the option to reject refunds (per Navore's platform design)
- Platform fee (6.5%) is collected by Navore at checkout; producers receive the net amount

### Producer Onboarding & Boarding Status
New producer accounts go through this flow:
1. Account created → **Boarding Status: Not Ready**
2. Producer can access Payrix portal but cannot process payments yet
3. Payrix underwriting team reviews (manual review, typically fast)
4. Once approved → **Boarding Status: Successfully Boarded** → can process payments

**Common friction point:** Producers try to accept orders before their account is fully boarded.

### Payouts & Settlement
- Payrix batches settle daily at **9:30 PM ET**
- Funds hit producer's FBO (For Benefit Of) account the **next business day**
- Disbursement sent to producer's bank at **6 PM ET** the following day
- Funds available in producer's bank account the **morning after disbursement** (timing varies by bank)
- Example: Order placed Monday → batch closes Monday 9:30 PM → funded Tuesday → bank account Wednesday morning
- Withdrawal schedules are configurable: daily, weekly, bi-weekly, monthly (most producers default to 100% daily)

### Refunds
- Producers handle refunds directly through the Payrix portal
- Refund must be applied to a Captured or Settled transaction
- Credit card refunds take **3–8 business days** to reach the customer
- The refund amount is deducted from the producer's available balance; if insufficient, it pulls from their linked bank account
- **Important:** Refunding a previously disputed transaction requires Payrix risk department approval — this is a fraud-flagged scenario

### Disputes & Chargebacks
- Initiated by the cardholder's bank (not Navore or the producer)
- Common reasons: unauthorized charge, goods not received, item not as described, refund not processed
- When a chargeback is filed: funds are reversed from the producer's Payrix account immediately
- Producer must provide evidence to contest (proof of delivery, communication logs, etc.)
- **Authorization disputes**: happen when a merchant captures payment with an expired authorization code — a timing issue common in pre-order scenarios

---

## Questions for Producer Specialists

These inform the day-to-day operational procedures and what's actually happening on the ground.

### Refunds
1. When a customer asks for a refund, what does the current process look like from start to finish?
2. Who initiates the refund — the producer directly in their Payrix portal, or does Producer Relations handle it?
3. Have producers rejected refund requests? If so, what happens next — does it escalate to us?
4. What's the most common reason customers request refunds? (wrong item, didn't arrive, quality issue, etc.)
5. How long does it typically take from a customer complaint to a refund being issued?
6. Do producers know they can access the Payrix portal to issue refunds themselves?

### Payrix Portal & Onboarding
7. What's the most common issue new producers have when they first try to accept orders?
8. Have you seen producers stuck in "Not Ready" boarding status? How was it resolved?
9. Do producers know how to log into their Payrix portal? Do they use it regularly or do they rely on us?
10. What Payrix-related questions come up most often from producers?

### Payouts
11. How often do producers ask about when they'll receive their money?
12. Have there been cases where a producer's payout was delayed or missing? What caused it?
13. Do producers understand the payout timeline (2 business days from order to bank)?

### Disputes & Chargebacks
14. Have any producers experienced chargebacks? How was it handled?
15. Do producers know they're responsible for contesting chargebacks and what evidence to provide?
16. Has there been a case where a customer filed a dispute after a refund was already issued?

### General
17. What payment-related issue takes up the most of your time right now?
18. Are there recurring issues that you handle the same way every time but don't have a written process for?

---

## Questions for CEO

These inform policy decisions, authority thresholds, and Navore's overall Payrix configuration.

### Policy & Authority
1. What is the approved refund threshold producers can issue without escalation? (e.g., under $X, no approval needed)
2. What's Navore's current policy on producers rejecting refund requests — is there a timeframe or criteria they must follow?
3. If a producer refuses a valid refund, what is Navore's obligation to the customer? Do we step in?
4. Are there scenarios where Navore (not the producer) should issue a refund directly?

### Platform Configuration
5. Who at Navore has admin/partner-level access to the Payrix partner portal?
6. How is the 6.5% platform fee handled in Payrix — is it split automatically at checkout, or does it settle to Navore separately?
7. Does the $4 delivery fee flow through Payrix the same way as the platform fee?
8. Are wholesale transactions ($100/mo plan, no platform fee) handled differently in Payrix?

### Risk & History
9. Has Navore had chargeback issues? What's our current chargeback rate and is it within acceptable thresholds?
10. Have there been any Payrix compliance flags, holds, or risk reviews on Navore's account?
11. Are there any known Payrix limitations or workarounds we're currently dealing with?

### Escalation
12. If a producer's Payrix account is frozen or flagged, who at Navore handles that conversation with Payrix?
13. What's the escalation path if a payment issue can't be resolved at the Producer Relations level?

---

## Draft SOP Scope (post-answers)

One combined SOP covering all payment and Payrix issue types, organized by scenario:
- Producer boarding failures (can't accept orders)
- Producer payout questions and delays
- Customer refund requests
- Producer refund processing
- Disputes and chargebacks (customer-initiated and producer response)
- Producer portal access issues
- Escalation path for unresolved payment issues

---

*Sources: [Payrix Resource Center](https://resource.payrix.com), [Payrix PayFac Overview](https://www.payrix.com/insights/blog/a-birds-eye-view-of-the-payfac-journey), [Dispute Management](https://resource.payrix.com/docs/dispute-management), [Transaction Funding](https://resource.payrix.com/docs/transaction-funding), [Disbursement Timeline](https://resource.payrix.com/docs/disbursement-processing-cycle-and-timeline)*
