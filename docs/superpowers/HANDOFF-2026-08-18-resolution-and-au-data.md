# Handoff — 2026-08-18: food resolution (kora#212 complete) + Australian data

Paste the section below into a fresh session. Everything here was measured, not assumed.

---

## Context

You are taking over Kora mid-thread. The previous session closed out the Vertex
migration and all four phases of the resolution architecture, then spent the
back half on **Australian food data**. One workstream is genuinely finished; the
rest is data, not code.

## HARD RULES — violating these costs hours

- **`cmd/ingest` has NINE path flags and the seed Job's command must pass ALL of
  them.** Defaults are repo-relative (`data/food/*.json`) and nothing is mounted
  there in the image, so a source added without a matching line in
  `tesserix-k8s` `charts/apps/kora-api/values.yaml` makes prod's seed Job exit 1
  and crash-loop. **This happened THREE times in one day** — `-ifct`, `-ausnut`,
  `-aliases`. A comment warning about it did not prevent the second or third.
  **Fixing the shape is priority #1 below.**
- **Run `go test -p 1` locally.** Go runs packages in parallel and
  `internal/nutrition` + `internal/ai` share one dev database, so tests
  asserting global counts flake. Measured on clean `main`: 3 runs, 2 failures,
  a different test each time. A parallel failure is not evidence of a real
  break — re-run with `-p 1` before believing it.
- **Never `go test ./...` in `api/`** (kora#151). The `TRUNCATE food_items`
  statements are inside rolled-back transactions so a targeted run survives, but
  a run that dies before rollback destroys the dev index. Count rows before
  rebuilding: `go run ./cmd/ingest` (NOT `cmd/seed`, which is 61 curated rows).
- **Prod data is `kora-postgres-1` in the `kora` namespace, database `kora_db`.**
  Not `global-postgres-1`, which still answers and is a stale copy. No `psql` on
  this laptop — use `kubectl exec kora-postgres-1 -c postgres -- psql -U postgres
  -d kora_db`.
- **Do NOT delete the `vertex-aiplatform` DNS zone**, and do not re-try
  `hostNetwork` or `ip-masq-agent` for Vertex. Both were tried and are not the
  fix; hostNetwork in particular bypasses Workload Identity so every call 403s.
- **Never paste API secrets into chat.** FatSecret creds are in `api/.env`
  (gitignored). Prod secrets go via GCP Secret Manager → ESO → `secretEnv`.

## What is DONE (do not redo)

**kora#209 + kora#202 — Vertex, closed.** The blocker was never the PSC
endpoint: `allow-<ns>-egress` permitted `0.0.0.0/0 except 10.0.0.0/8` on 443,
which excludes `10.255.0.2`. Both recorded diagnoses were disproved by
measurement. Resolve engine AND embed now run on Vertex via Workload Identity.
**The personal Gemini key is off the critical path** — safe to revoke, but
remove it from the embed Job's fallback first or that path fails rather than
degrades.

**kora#212 — all four phases merged.** entity_type (#213), type-aware retrieval
+ the ambiguity invariant (#218), structured query (#221), locale (#222/#223).
See `docs/superpowers/` and the issue for detail; the architecture is recorded in
the `kora-resolution-architecture` memory.

**kora#184, #219 (partial), #160, #215, #217, #220, #224, #225, #228** all
merged. Data added: IFCT 523 Indian rows, AUSNUT 3,238 Australian rows, 310 USDA
embedded brands extracted, 4 curated aliases.

## Prod state, verified 2026-08-18

```
food_items  18,878    AU 10,557 | US 7,740 | IN 569
ausnut       3,238    global aliases 4     migrations at 37
```

Embedding of the AUSNUT rows was still finishing at handoff — **check
`SELECT count(*) FROM food_items WHERE embedding IS NULL`** and re-run the seed
Job if it stalled.

## Open work, in priority order

### 1. Make the ingest/chart coupling impossible to get wrong

Three prod incidents in one day. `cmd/ingest` should take a single `-food-dir`
(default `data/food`, chart sets `/usr/local/share/kora/food`) with sources as
filenames under it. Adding a source would then need no chart change at all.
Touches `api/cmd/ingest/main.go` and the seed command in
`charts/apps/kora-api/values.yaml`.

### 2. Real user queries for the ranking harness

**This is the binding constraint on all resolution work.** The harness
(`KORA_EVAL=1 ... go test -tags eval ./internal/ai/ -run TestEvalRanking`) now
scores **12 of 31 cases**, up from 1 — but every query in it was chosen by
Claude, not observed. It caught a real regression (Coke Zero) and also passed
clean on a real flaw (a Woolworths row answering a query naming El Janah) that
was only found by reading candidate lists by hand.

Ask the user for 15–30 things they would actually type. Do not invent them.

### 3. kora#227 — zero-energy foods (PR OPEN, CI green, unmerged)

The loader dropped `kcal <= 0`, conflating "no data" with "no energy", so the
index had **zero** rows at 0 kcal and `water` resolved to `Coconut Water`
(15.3 kcal). Fixed in the loader and the AFCD converter. **Just needs merging.**

### 4. kora#219 — still open, and read it before touching ranking

Precision now measures against a food's identity. **Both approaches the issue
itself proposed were implemented, measured NET HARMFUL, and reverted** —
second-segment heads promote `Kheer, rice` for "rice"; identity-based trigram
collapses `Milk, canned, evaporated` and plain `Milk` to the same identity and
produces 11 bad top-1 changes. Do not re-attempt either without new evidence.
`flat white` → `Iced Flat White` is the remaining known instance.

### 5. Brand-level AU chain data — the real gap

AUSNUT gives generic takeaway (`Pizza, meat & vegetable (e.g. supreme),
takeaway`) but **never brands**. Measured: McDonald's 45 rows all US, KFC 23/1
AU, Grill'd / GYG / Zambrero / Red Rooster / Hungry Jack's / Oporto **zero**.

- No open dataset exists. FoodSwitch is packaged-only. Chains publish JS
  calculators, not tables — six fetch attempts across two methods all failed.
- **FatSecret** is the only realistic route. Creds are in `api/.env`; auth
  WORKS (token acquired). Blocked on IP allowlisting: add `104.30.167.39`
  (laptop, a VPN egress that may change) and `35.207.236.200` (GKE Cloud NAT).
  **Open question the user was checking: whether AU data is Enterprise-only** —
  if the free tier is US-only it adds nothing over the USDA chain rows we have.
  Also unresolved: whether their terms permit STORING results. If not, it is a
  runtime lookup inside a 1.5s budget, not an ingest source.

### 6. Smaller, well-scoped

- **AUSNUT Food measures** — 9,816 real serving sizes, unused; all 3,238 rows
  currently fall through to the flat 100 g default.
- **INDB** (1,014 cooked Indian dishes) — still blocked on a licence email, and
  now a *prerequisite* for the colloquial-name layer, see below.
- **kora#151** — several instances fixed; worth closing or updating.

## Findings that will save you time

**Aliases resolve at score 1.0 (auto-log).** The IFCT `lang` column offers ~7,700
transliterations and importing them in bulk is **UNSAFE**: IFCT is raw
commodities while people type cooked dishes, so `moong dal` → `Green gram, dal`
is 325 kcal/100g against ~120 cooked. That would 3× users' calories at auto
confidence. Item 2 therefore depends on INDB. Only 4 hand-audited synonyms
shipped; bare `chips` is deliberately NOT aliased (hot chips vs crisps, ~226 vs
~500 kcal — real ambiguity to ask about).

**Atwater vetting works, and the energy model matters.** AUSNUT scored median
2.31% under plain 4/4/9 but **1.01% under the AU convention** (fibre 8 kJ/g,
alcohol 29 kJ/g). Running both is what PROVES the convention rather than
assuming it. Do not drop rows on deviation alone: near-zero foods give
meaningless relative error, and polyols/organic acids are real energy Atwater
cannot model. IFCT's dropped chicken row was genuinely wrong (its siblings
disagreed); AUSNUT's four outliers are genuinely right.

**Raw-vs-cooked bites repeatedly.** `rice` → raw rice, `barramundi` → raw. The
fix was already in the codebase: identify returns `cooking_method` and the
resolver had never received it. Now wired as `cookingMethodBonus`.

**Ambient mesh hides NetworkPolicy drops.** `nc -z` from a pod ALWAYS succeeds —
it reaches ztunnel's local redirect socket, not the destination. Trust ztunnel's
access log (`bytes_sent=0 ... deadline has elapsed`) over a pod-side TCP check.

## Repos

- `~/personal/tesserix-new/kora` — Go API + Expo mobile
- `~/personal/tesserix-new/tesserix-k8s` — Helm/ArgoCD. Chart changes REQUIRE a
  `Chart.yaml` version bump. `main-protection` needs an approving review, so
  merges use `--admin`. Seed Job is sync-wave 1 (after the Deployment, so
  migrations land first) with `Replace=true,Force=true` because a Job's
  `spec.template` is immutable.
