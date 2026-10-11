# ADR 0003: Paid AI top-ups on top of the free allowance

Status: accepted

Date: 2026-08-22

## Context

ADR 0001 made Kora Postgres the sole authority for AI quota and fixed the free allowance at 20 requests per UTC day, 100 per ISO week, and 300 per UTC month, plus a $5 per-user and $500 global monthly estimated-cost cap. A user who spends that allowance can only wait for it to reset. There is no way to buy more, and no way to see what buying more would cost.

Kora's provider list prices are proxies rather than real spend (`internal/ai/pricing.go`), and work out at roughly ₹1.45 per provider-backed request. Any pack priced below that would sell requests at a loss even against the proxy.

Indian consumers pay GST on this supply (SAC 998434, online information and database access services), and the payment gateway is Cashfree.

## Decision

Paid top-ups are strictly additive. The free allowance is unchanged, keeps resetting on its own schedule, and is always consumed first.

### Prices

Advertised prices are the pre-tax pack price. A 2% platform fee is added on top, and 18% GST applies to the sum of the two. Every amount is integer paise; rounding is half-up, once, per line.

| Pack | Base | Platform fee (2%) | Taxable | GST (18%) | Payable | Requests | Daily cap | ₹/request |
|---|---|---|---|---|---|---|---|---|
| Spark | ₹50.00 | ₹1.00 | ₹51.00 | ₹9.18 | **₹60.18** | 25 | 10 | 2.00 |
| Steady | ₹150.00 | ₹3.00 | ₹153.00 | ₹27.54 | **₹180.54** | 85 | 20 | 1.76 |
| Strong | ₹350.00 | ₹7.00 | ₹357.00 | ₹64.26 | **₹421.26** | 210 | 40 | 1.67 |
| Boundless | ₹1050.00 | ₹21.00 | ₹1071.00 | ₹192.78 | **₹1263.78** | unlimited | none | — |

Every pack is valid for 30 days from payment. ₹50 and ₹1050 are the floor and ceiling the product asked for, both stated before GST and platform fee. Price per request falls as the pack grows and never drops below the ₹1.45 proxy cost — both properties are asserted by `TestPricePerRequestFallsWithPackSizeAndStaysAboveCost`, so a future price edit that breaks either fails the build rather than shipping.

Only the top pack is unlimited. Every other pack is bounded on both a total grant and a daily cap, so a cheap pack cannot be spent in one burst and cannot exceed what it was priced for.

### Spending order

A request checks the global monthly cost cap first. That cap is **not** purchasable: it protects Kora's own bill, and no payment lifts it.

Then the free windows are checked. If any free window (or the per-user monthly cost cap) is exhausted, the request falls through to an active entitlement, which is spent under a row lock inside the same transaction that reserves the free windows. Free windows are still incremented either way, so their reset behaviour is exactly what ADR 0001 specified.

### Money and trust

- The server prices every order. The app sends a pack code and a phone number, never an amount.
- The order is registered with Cashfree using Kora's own order id, so the two systems reconcile in one direction without a mapping table.
- Settlement happens only from Cashfree's signed webhook or an explicit status fetch. The user's return from the hosted checkout is a deep link and is never trusted.
- The webhook signature is verified over the raw request bytes with a ±5 minute timestamp window; failures answer 401 with no detail.
- A settled amount that does not match the stored order grants nothing and is logged for a human.
- Settlement is idempotent: a redelivered webhook yields the same invoice number, the same `paid_at`, and one entitlement.
- The phone number is passed to the gateway and never stored by Kora.

### Invoices

Each paid order gets a serial `KORA/<FY>/<000000>` from the `ai_invoice_serial` sequence, where FY follows the Indian April–March financial year. The invoice shows base, platform fee and GST separately, because a GST bill has to state the tax collected, not only the total charged.

## Consequences

- The app renders itemised paise from the API and computes no tax itself. A rate change is a server change.
- Kora needs its own Cashfree merchant credentials. The Cashfree secrets currently in GCP Secret Manager belong to HomeChef; reusing them would settle Kora revenue into another product's merchant account and issue Kora's GST invoices under that merchant's identity. Kora-scoped credentials must be provisioned before this is enabled in production, and the webhook URL (`POST /webhooks/cashfree`) registered against them.
- Payment routes are mounted only when Cashfree is configured, so an environment without credentials answers 404 rather than offering a checkout that cannot complete.
