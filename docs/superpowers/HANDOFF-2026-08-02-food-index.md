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

---

# UPDATE — 2026-08-02, later: tiers now fire in prod (#73)

## Root cause was not what this handoff assumed

`match_score` was a **constant**. `ts_rank` with the default normalization flag
ignores document length and `plainto_tsquery` ANDs every term, so the rank
depended only on **how many terms the query had** — 0.71662 for one, 0.72615 for
two. The "0.717–0.726 band" was those two numbers, not a distribution. Within a
query *every candidate tied exactly*, so `ORDER BY rank DESC` was arbitrary.

That means the two "separate" problems above were one bug, and **direction (2) —
retuning the 0.90/0.70 floors — was a dead end**: you cannot re-threshold a
constant. Calibration later confirmed the floors were always correct.

It also means SR Legacy's near-duplicates were *not* why "chicken breast"
resolved wrongly; the tie-break was. A display-vs-search name would not have
fixed it.

## Measured in prod, same 18 queries, before and after

Before: **every** query `confirm` / `full_text`, three distinct scores.
After: auto 5 · confirm 1 · follow_up 12, range 0.3885–1.0000.

| query | before | after |
|---|---|---|
| `milk` | Potatoes, mashed, dehydrated (0.7205, confirm) | **2% milk** (0.5568, follow_up) |
| `apple` | Pie, Dutch Apple (0.7166, confirm) | **Apple** (1.0000, auto) |
| `cheese` | Macaroni and cheese, box mix (0.7205, confirm) | Cheese, colby (0.4350, follow_up) |
| `chicken breast` | Fast Foods, Fried Chicken, Breast, meat and skin and breading (0.7261, confirm) | **Chicken breast, roasted** (0.4970, follow_up) |
| `almonds` | Almonds, raw (0.7166, confirm) | **Almonds** (1.0000, auto) |
| `salmon` | Sushi, salmon roll (0.7166, confirm) | Fish oil, salmon (0.3885, follow_up) |

## Two things that are NOT done — read before assuming this is finished

**1. The estimate path discards all of it.** `decomposeAndEstimate` still
hardcodes `Tier: TierConfirm` per ingredient regardless of `MatchScore`
(`ai/resolver.go`). Verified live: `brekkie of two eggs on toast` returns
`Crackers, rusk toast` at **0.3830 labelled `confirm`**, and `salmon` returns
`Butter, without salt` at **0.3602 labelled `confirm`**. Bare `chicken breast`
also takes this path. So on decompose, the fix is not merely inert — it is
actively misleading, and the uncertain-row UI still never appears. The original
rationale ("none was individually identified with confidence") is now obsolete:
per-item confidence exists. Fix is roughly one line — call `TierFor` there too —
plus a test.

**2. The embedding tier is still unverified in prod.** All calibration ran
against a DB with **zero** embeddings, and `/v1/foods` passes a nil vector so it
*structurally cannot* emit `match_tier: embedding`. On `/v1/resolve/text`, which
does pass a real vector, every candidate still came back `full_text` —
consistent with only 302/7,856 rows embedded. The "22/22 never confidently
wrong" result does not cover that path.

## Deploy gotcha that cost a cycle

The `ghcr-remote` GAR **pull-through mirror served a stale `:latest`**. The
migrate Job reported `Complete` in 10s having pulled the *old* digest
(`sha256:86d678ba…`), and prod stayed on schema v20 with `pg_trgm` absent —
another "Complete is not the work happened". Pinning the Job to the immutable
commit-SHA tag (`d90cc815…`) pulled `sha256:2b130d26…` and applied 000021.
A later `rollout restart` on `:latest` then picked up the new digest, so the
staleness is TTL-dependent and intermittent — `imagePullPolicy: Always` is not
sufficient protection. **Verify the running digest, not the rollout status.**
Consider pinning `image.tag` to the commit SHA in the ArgoCD app.

Also: ArgoCD reported `Job/kora-api-migrate` **Synced** while `kubectl` showed
it absent (stale cluster cache); neither a hard refresh nor a sync operation
recreated it. Rendering the chart's Job with `helm template` and applying it
directly was the way through.

## Still open (unchanged or newly recorded)

- **Head-noun weakness.** Token precision `|Q∩D|/|D|` rewards short docs, so
  `Oil, almond` ties `Almonds, raw` and `Strudel, apple` beats a raw apple. USDA
  puts the head noun first in generics, last in derivatives; a head-token signal
  would fix almond/banana/beef/apple/salmon. Surfaces as `follow_up`, never as a
  confident wrong answer — which is why it did not gate #73.
- **`cmd/embed` quota bug** — unchanged: exits 0 having embedded 302 of 7,856.
- **`vegemite`** is absent from the ingested index despite this handoff citing
  it as #72-verified.
- Runner-up candidates still never leave the server (`resolver.go` keeps
  `cands[0]`), so the resolution-level `follow_up` question still shows no list.

---

# UPDATE 2 — 2026-08-02: the estimate path now tiers too (#74)

#73 made `match_score` discriminate, but **the estimate path discarded it**.
`decomposeAndEstimate` hardcoded `Tier: TierConfirm`, and `ResolveText` falls
through to decompose precisely when `resolveGuesses` returns `follow_up` — so
every uncertain resolution was relabelled confident on the way out and #71's
uncertain-row UI still could not appear. The blocker had moved up a layer, not
gone away.

#74 tiers each decomposed ingredient from its own `MatchScore`, **capped at
`confirm`** (they are LLM inferences — `Olive oil` and `Butter` were invented by
the decompose step — so a perfect match must not become a one-tap `auto`, but a
weak one must be free to fall to `follow_up`). Resolution tier is now the max
across items.

## Verified live after deploy (digest sha256:329f8f1d)

`grilled chicken breast` — one meal, mixed tiers, which is the whole point:

| ingredient | score | tier |
|---|---|---|
| Chicken breast, roasted | 0.4970 | **follow_up** |
| Olive oil | 1.0000 | confirm *(capped, not auto)* |
| Butter, without salt | 0.3602 | **follow_up** |
| Spices, pepper, black | 0.8053 | confirm |

`xylophone stew` (not a food) is now `follow_up` throughout — it previously read
as `confirm` with banana, fish broth and carrots. `match_tier: embedding` was
also observed here, so **the embedding tier does fire in prod**; it needs
lexical to fail first, which is why `/v1/foods` never shows it (that endpoint
passes a nil vector and structurally cannot).

## Client fix that had to ship with it

`AskAgainSheet.tsx` branched on `tier === "follow_up"` alone. The new
empty-question resolution would have hit a blank prompt plus "Search manually
instead" and discarded the candidates — the exact dead-end the server change
avoids in `capture.tsx`. That combination was unreachable before #74. Now
guarded by a shared `asksQuestion` predicate and a mutation-verified test.

## Deploy: the stale mirror bit AGAIN, and how it is now pinned

`rollout restart` on `:latest` reported "successfully rolled out" while still
running #73's digest (`sha256:2b130d26`). Second time in one session. **Verify
the running digest, never the rollout status.**

Fixed properly: the parent app-of-apps already sets `ignoreDifferences` on
`/spec/source/helm/parameters` so a promoter can write `image.tag` on the child
Application without being reverted (intended for Kargo, which is not wired up
for Kora yet — the parameter was sitting on the `"latest"` placeholder). That
slot now holds the commit SHA `2847559e…`, so the Deployment, the Application
parameter and the running pod all agree and `selfHeal` has nothing to revert.

**Next deploy must bump that parameter** (or wire up Kargo / repoint CI, per the
manifest's own TODO). Leaving it on a commit SHA means `:latest` no longer
drives Kora.

## Still open

- **Head-noun weakness** — unchanged. `Oil, almond` ties `Almonds, raw`;
  `Strudel, apple` beats a raw apple; `salmon` → `Fish oil, salmon`. Surfaces as
  `follow_up`, never as a confident wrong answer.
- **kcal display inconsistency (new, minor)** — for estimates the headline total
  uses `kcal_low`/`kcal_high` verbatim, but `DetectedCard` hides a `follow_up`
  row's kcal while it still counts toward that total, so itemised rows no longer
  visibly sum. Wrong-looking, not a wrong number.
- **`cmd/embed` quota bug** — unchanged, 302 of 7,856.
- **`vegemite`** absent from the index despite being cited as #72-verified.
- Runner-up candidates still never leave the server.
- **Simulator pass still not done.** All evidence above is API-level.
