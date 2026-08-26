# ADR 0004: StoreKit In-App Purchase is the required rail for AI top-ups on iOS

Status: accepted

Date: 2026-08-26

Supersedes the payment-rail and tax parts of ADR 0003. The quota model, spending
order and entitlement semantics in 0003 are unaffected.

## Context

ADR 0003 sells AI top-up packs through a hosted gateway checkout: the app calls
`POST /v1/ai/orders`, receives a `checkout_url`, and opens it with
`Linking.openURL`. kora#478 added Stripe behind the same seam.

Two premises in 0003 turned out not to describe Kora:

1. **The Indian tax model was inherited, not chosen.** 0003 prices in paise,
   charges 18% GST under SAC 998434, and numbers invoices on the Indian
   April–March financial year. That belongs to HomeChef, which ships to India
   only. Kora's parent company is **Australian**, revenue settles to an
   Australian bank account, and the intended release is **worldwide**.
2. **The rail itself is not permitted on Kora's own storefronts.**

## What Apple actually requires

App Store Review Guideline **3.1.1** requires In-App Purchase for digital
content used inside the app, and names **credits** explicitly. Kora's packs are
AI request credits consumed in-app, so they fall squarely inside it.

External purchase links are a **regional exception**, not a general one:

| storefront | external link for digital goods | source |
|---|---|---|
| **EU / EEA** | allowed, with the StoreKit External Purchase Link Entitlement | Apple's `allowed-regions` list is the EU/EEA set |
| **United States** | allowed since May 2025 **without** an entitlement, following the Epic injunction | Apple guideline update, 2025-05-01 |
| South Korea | allowed under a separate framework | — |
| **Australia** | **not permitted.** No entitlement exists; external-link UI is a violation | — |
| India | not permitted | — |

**Australia is Kora's home market and the closed-beta cohort's storefront**, and
it has no external-purchase entitlement. A worldwide release makes IAP the
requirement across the large majority of storefronts.

The ACCC has been granted leave to intervene in Epic v Apple in the Federal
Court, with the relief hearing resuming 28 April 2026. That may change the
Australian position later. **It has not changed it yet**, and shipping against a
rule that might relax is not a plan.

Google Play imposes an equivalent requirement for in-app digital goods, so this
is not an iOS-only constraint.

## Decision

**AI top-up packs on iOS are sold through StoreKit In-App Purchase.**

Consequences that follow, rather than needing separate decisions:

- **Apple owns currency, tax and receipts.** Price tiers are chosen once; Apple
  localises them per storefront, collects and remits the applicable tax, and
  issues the receipt. There is no Kora GST calculation, no `gst_paise`, and no
  Kora-issued tax invoice for an IAP sale.
- **The AUD-only question largely dissolves for this surface.** Pricing is set
  in tiers, not in a currency Kora hardcodes. `currency DEFAULT 'INR'` and the
  `*_paise` columns stop describing anything real for new IAP orders.
- **The invoice series stops applying to IAP sales.** `KORA/<FY>/<serial>` on an
  Indian financial year has no basis for an Australian company, and Apple is the
  merchant of record for these transactions regardless.
- **Kora still verifies server-side.** The App Store server notification and
  receipt validation replace the gateway webhook, but the rule from 0003 is
  unchanged and load-bearing: *the client never states an amount, and nothing
  grants an entitlement except a server-verified signal.*

### Pricing has to be re-derived, not converted

0003's floor is ~₹1.45 per request against proxy cost, asserted by
`TestPricePerRequestFallsWithPackSizeAndStaysAboveCost`. Under IAP, **Apple takes
15%** (Small Business Program, under $1M annual revenue — Kora qualifies) or 30%
above that.

A currency conversion alone would silently sell below cost, because the
commission is a new subtraction the existing floor never accounted for. **That
test must be restated in the new currency AND net of commission**, not deleted.
It is the guard that stops a future price edit shipping at a loss.

## What Stripe is still for

kora#478 is not wasted, and is **not** reverted:

- A **web** checkout has no Apple constraint. Selling top-ups on a website is
  explicitly permitted provided the app does not link to or promote it.
- The provider seam, the amount-verification rule, the replay bound and the
  idempotent settlement path are all rail-independent and already tested.
- If the ACCC intervention changes the Australian position, the external rail is
  already built.

Stripe stays configured-off (`stripe.enabled: false`, tesserix-k8s#647) until
there is a web surface to sell from.

## What this does NOT block

**The closed beta (kora#328) does not depend on any of this.** TestFlight
purchases run against the StoreKit sandbox and move no money, and the free
allowance from ADR 0001 is what testers will actually exercise. Billing is not
an entry criterion; nutrition quality is.

## Consequences

- Cashfree stays mounted and works, unchanged, until IAP ships. Nothing is
  turned off on the strength of a proposal.
- `ai_payment_orders` keeps its existing rows readable exactly as they are.
  Historical INR orders and their invoice numbers are not rewritten — the same
  rule kora#479 already sets for the Cashfree wind-down.
- A follow-up issue covers the StoreKit work: product IDs, receipt validation,
  App Store server notifications, and restoring purchases.

## Open questions

0. **Consumable packs or an auto-renewable subscription?** Settled in the
   implementation issue, not here: this ADR fixes the RAIL (StoreKit), and the
   product shape is a separate decision with different retention, pricing and
   restore consequences. ADR 0003's packs map most directly to consumables, but
   an auto-renewable subscription is the conventional shape for recurring AI
   usage and is what Apple's tooling (trials, offer codes, grace periods,
   Family Sharing) is built around.
1. **Confirm the commission tier.** 15% assumes enrolment in the Small Business
   Program. Worth checking rather than assuming.
2. **Consumable or non-renewing subscription?** Packs grant N requests valid for
   30 days, which is not cleanly either. This affects restore behaviour and how
   an unfinished transaction is handled.
3. **Does the web surface exist?** If not, Stripe has nothing to sell from yet
   and stays off indefinitely.
