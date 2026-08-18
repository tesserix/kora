# ADR 0001: Keep AI quotas authoritative in Kora Postgres

Status: accepted

Date: 2026-08-19

## Context

Every provider-backed Kora AI request must have a verified Firebase user and must be bounded for the free tier. Kora already records provider usage and estimated cost in `ai_usage_events`, but its monthly check is a read followed later by a provider call. Concurrent requests can all observe the same remaining allowance and exceed the cap.

The Agent Gateway adds private provider routing, workload authentication, guardrails, token optimization, and telemetry. It must not become a second entitlement or billing ledger. Cache and personal-alias hits do not call a provider and remain free. Provider failures and timeouts consume a reservation because they consume provider capacity.

Initial sizing assumptions are 10 requests/second peak, request bodies no larger than 256 KiB, and three small counter writes per provider-backed user request. At 10,000 monthly active users, daily, weekly, and monthly fixed windows create at most about 4.3 million rows in 12 months and 12.9 million rows in 36 months before retention cleanup. The AI path targets 99.9% monthly availability; the quota decision targets less than 20 ms p99 of Kora-side latency.

## Options considered

1. Use gateway-local or Valkey counters. This is fast, but cache loss, gateway retries, and multiple entry points can produce inconsistent entitlement decisions. Valkey is not the source of truth.
2. Use only `ai_usage_events`. This preserves one ledger but a sum/count check cannot reserve capacity atomically before an external provider call.
3. Add fixed-window reservation counters in Kora Postgres while retaining `ai_usage_events` for actual provider usage and cost. This keeps the decision and its concurrency control in the existing system of record.

## Decision

Kora Postgres is the sole quota authority.

- Every public AI endpoint remains inside the authenticated `/v1` Firebase and Kora-user middleware boundary. Identity is derived from the verified session, never from request fields or forwarding headers.
- Provider-backed requests reserve all applicable free-tier windows in one short transaction before contacting a provider: 20 requests per UTC day, 100 per ISO week beginning Monday UTC, and 300 per UTC calendar month.
- A per-user transaction advisory lock serializes reservations for one user. All three counters are checked and incremented together; any exhausted window rolls the transaction back so partial reservations cannot occur.
- Existing per-user monthly estimated cost (`$5`) and global monthly estimated cost (`$500`) caps remain. Cost is known only after a provider response, so these cost caps can overshoot by concurrent in-flight calls; the request counters bound that exposure.
- A database or quota-check failure fails closed for provider-backed AI. Cached resolutions and personal aliases short-circuit before reservation and remain available.
- A provider failure or timeout consumes the reservation. It is not released or retried by Kora merely to recover quota.
- `ai_usage_events` remains the actual usage/cost ledger and the reconciliation source for gateway telemetry. Quota counters contain no prompts, response bodies, tokens, or credentials.
- Barcode and deterministic/manual paths do not reserve AI quota because they do not contact a model.
- Existing user-facing degradation remains stable in this change: resolve and coach return their manual/try-later fallback, while recipe parsing returns its existing budget-exhausted response. A separately versioned usage-status contract will expose remaining windows and reset times.

## Trust boundaries and failure behavior

The internet-to-Kora boundary verifies Firebase authentication before user resolution or AI work. The future Kora-to-agent/gateway boundary must authenticate the exact workload identity and overwrite any client-supplied identity header with server-derived subject context. The gateway may apply stricter token or safety policy, but it cannot grant quota or infer a paid tier.

When Postgres is unavailable, a provider-backed request does not reach the provider. When the gateway or optimizer is unavailable, the separately gated gateway rollout determines failover; it does not bypass Kora quota reservation. When usage recording fails after a provider call, the reservation remains consumed and telemetry reports the recording failure.

## Paid entitlement extension

Paid plans are deliberately not represented by client-supplied plan names or speculative columns. A later server-owned entitlement resolver will select a quota policy after App Store or Play verification. If entitlement lookup fails, the free policy is the safe default. Administrative overrides require an audited, expiring server-side record.

## Migration and rollback

The forward migration adds `ai_quota_windows` and backfills current counters from existing attributable `ai_usage_events`, conservatively treating each historical provider event as one reservation. The down migration drops only the derived counter table; `ai_usage_events` is unchanged.

Code can roll back independently: the added table is backward compatible and ignored by older binaries. Rolling the schema back while quota-aware code is live is unsafe and is not part of an application rollback. No Vertex or Agent Gateway traffic cutover is included in this decision.

## Consequences

Quota correctness depends on Postgres, which is already a critical Kora dependency. The per-user lock limits contention to one user's concurrent requests; unrelated users proceed independently. Three fixed windows provide predictable product semantics but are intentionally not rolling windows. Historical counter rows need a retention policy before scale materially exceeds the 36-month estimate.

The simplest alternative, a single monthly count in `ai_usage_events`, was rejected because it neither satisfies daily and weekly limits nor closes the concurrent-check race.
