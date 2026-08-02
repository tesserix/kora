# HANDOFF — 2026-08-02 (food index live; tiers still inert)

## TL;DR

Five PRs merged across two repos. The food index went from 85 items and zero
embeddings to **7,856 items** live in prod. But the thing all of it was meant to
enable — the confidence-tier system doing real work — **still does not fire**,
and the reason turned out to be structural rather than a data problem.

## Merged

**kora:** `#69` onboarding trap · `#70` push-token crash · `#71` per-item
confidence tiers · `#72` embed binary + 7,756 USDA foods + 61 curated AU/Indian
dishes.

**tesserix-k8s:** `#144` seed Job runs embed with the Gemini key · `#145` let
ArgoCD replace the immutable Jobs.

## Verified in prod

- `paneer` 4 hits, `dal tadka` 1, `biryani` 2, `lasagne` 1 — all were **0** before.
- "chicken breast and lasagne" no longer silently drops the lasagne. That was a
  real defect observed in the app; it is fixed.

## The open problem — read this before adding more data

**The embedding tier never fires, and more coverage made it worse.**

`match_score` has three sources: alias `1.0`, full-text `0.7 + 0.29*s` (clamped
to `[0.70, 0.99]`), embedding `sim * 0.7` — the only sub-0.70 source. `TierFor`
takes `min(identifyConf, matchScore)`, so `follow_up` needs an embedding match.

The repository tries alias → full-text → **embedding only when full-text returns
nothing**. Growing the index to ~7,856 lexically-matchable rows makes full-text
succeed more often, so embeddings fire *less*. Every candidate measured after
the deploy: `full_text`, 0.717–0.726, `confirm`.

So #71's per-item tiers remain correct and inert. The fix is not more data:

1. Make embedding a parallel/blended signal rather than a full-text fallback, or
2. revisit the 0.90/0.70 floors against the real distribution (a narrow band
   around 0.72).

## Two other real findings

**`cmd/embed` is quota-capped and exits 0 anyway.** Gemini free tier allows 100
embed requests/minute. `cmd/embed` has no rate limiting, exhausts the quota,
trips its own "entire batch failed; stopping" guard, and **reports success**.
The prod run embedded **302 of ~7,856** while the Job showed Complete. It
resumes on re-run (selects only rows missing an embedding) but needs ~26 runs.
Fix: rate-limit to ~90/min honouring the API's `retryDelay`, or batch-embed.

**Coverage cost match quality.** "chicken breast" now resolves to *"Fast Foods,
Fried Chicken, Breast"* instead of *"Grilled chicken breast"*. SR Legacy's
clinical near-duplicates are the cause. Ingesting names verbatim was deliberate
(see the design doc) — this is its bill. A separate display-vs-search name is
the honest fix.

## Process lessons worth keeping

- **A green CI check said nothing about deployability.** `helm lint`, `ct lint`,
  ArgoCD Validation and Validate Helm Templates all passed on #144, and the
  deploy still broke: a chart version bump lands in `spec.template` labels, which
  are **immutable** on an existing Job, so ArgoCD aborted at wave −1 and the seed
  Job never ran. All four checks validate rendered manifests in isolation; none
  compares against live cluster state. Fixed by `sync-options: Replace=true,Force=true`.
- **Mutation-test the fixture, not just the code.** The kJ-vs-kcal check
  (USDA 1062 is kJ, 1008 is kcal) *appeared* to pass while asserting nothing: only
  one fixture record carried a 1062 value, so swapping the constant made the other
  record vanish and tripped an unrelated count. Against the real file — where all
  7,793 records carry both — it would have passed silently with every calorie
  inflated 4.184x. It is not enough that the mutation fails; it must fail on the
  assertion you claimed.
- **"The Job completed" is not "the work happened."** 302/7,856 with exit 0.

## Environment

Metro is **not** running (kill/restart cycled several times; start it fresh with
`EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app npx expo start --port 8082
--dev-client`). Docker `kora-pg-test` on 55432 still up. Test accounts
`korasim1`–`korasim4@tesserix.dev` (`KoraSim2026x`) live in prod Firebase;
korasim3/4 are onboarded.

**Not done:** the simulator pass of Task 6 (log an Indian dish end to end). The
API-level evidence above is the load-bearing part and it is complete.
