# Design — Kora food data administration

Date: 2026-08-05. Touches `kora` (admin BFF + endpoints + jobs) and
`tesserix-home` (client + pages). Follows
`2026-08-05-kora-admin-surface-design.md`, which specified Phase 1 (Overview).

**Status: designed with the user, decisions recorded below.** Every choice in
this document was made explicitly, not inferred.

## Purpose

Manage the nutrition index from the admin portal: browse it, correct it, add to
it, and — the part that matters operationally — get the embedding backlog
cleared and *see* that it happened.

The motivating defect is unchanged from Phase 1 and still live: **4,078 of
7,898 food items have no embedding**, and nothing reports it, because
`cmd/embed` exits 0 when it gives up so its Kubernetes Job reports `Complete`
(#97). A backfill Job ran on 2026-08-05 and moved the count by zero while
reporting success.

## Access path: one signed BFF, no direct database

The Phase 3 section of the Phase 1 design said: *"if Phase 3 ships read-only,
take the mark8ly route and skip the BFF entirely. The moment it needs one
write, build the BFF and put everything through it — once it exists, routing
reads over it too is nearly free, and maintaining two access paths is not worth
it."*

This work needs writes, so **the BFF is built and reads go over it too.**

The consequence is that this design is *simpler* than a read-only one would
have been: no cross-namespace Istio egress rule, no `kora_platform_admin` DB
role, no ExternalSecret carrying database credentials into the portal. The
portal gains no database access to Kora at all.

**Why writes cannot go direct anyway.** Kora keeps a Redis resolve cache whose
entries embed a food's nutrition, and `foodlog` carries idempotency invariants
the offline queue (#22) depends on. A direct SQL update would leave per-user
cache entries stale with nothing to evict them — the portal would look like it
worked while Kora went on serving the old macros. The mark8ly cross-DB runbook
effectively concedes this by instructing operators to hand-write `audit_events`
rows, precisely because direct writes skip the product's own side effects.

### What is built in `kora`

- `bff_auth` HMAC-SHA256 middleware mirroring
  `homechef-api/apps/api/middleware/bff_auth.go`, which binds **method, path,
  body hash, timestamp and caller identity** into the MAC. Mirror it; do not
  design a new scheme.
- `KORA_BFF_HMAC_KEY` in GCP Secret Manager, delivered by the existing
  `kora-api-secrets` ExternalSecret (which already carries `database_url`,
  `gemini_api_key`, `openai_api_key`, `expo_access_token`).
- Admin endpoints under `/v1/admin/foods`.
- `kora_admin_events` — the audit table.
- `food_embedding_jobs` — the durable job queue.

### What is built in `tesserix-home`

- `lib/api/kora-admin.ts`, mirroring `lib/api/homechef-admin.ts`.
- Pages under `app/admin/apps/kora/`: `foods`, `foods/upload`, `embedding`,
  `audit`, plus nav entries in `components/admin/sidebar.tsx` (hand-written per
  product — see the Phase 1 design; `lib/products/types.ts` claims otherwise
  and is wrong).

## Three invariants that are easy to miss

These are the failure modes a naive implementation will hit. Each is stated
here because none is obvious from the code.

**1. Editing a name must re-queue that food's embedding.** The vector is
derived from `normalized_name`. An edited name with a stale vector degrades
resolution silently — the same class of failure as the 4,078 backlog, but
*harder* to see, because `kora_food_index_embedded` still counts the row as
embedded. Renames therefore clear the embedding and enqueue a job in the same
transaction.

**2. Editing macros must evict the resolve cache.** A cached `ai.Resolution`
carries the food's nutrition, so without eviction the API serves the old macros
for up to 24h. `foodlog.Service` already holds an optional, nil-safe cache
invalidator wired to the *same* cache instance `ai.Resolver` reads (verified:
one variable in `main.go` passed to both `NewResolver` and
`Deps.ResolveCache`). Reuse it. Do not introduce a second eviction path.

**3. Delete is a soft delete.** `food_logs.food_item_id` references
`food_items`, so hard-deleting a referenced food destroys a user's history.
Rows gain `deleted_at timestamptz`; resolution and search exclude them; the
detail page shows how many logs reference the food before you delete it.
`kora_food_index_items` must exclude soft-deleted rows, or the Phase 1 gauge
silently starts counting invisible records.

## Embedding: a durable job, because it takes days

**Decision: a job table drained by a worker, with quota state surfaced.**

Gemini's free tier caps `embed_content` at **1,000 requests/day per project per
model**, and live resolve traffic shares that quota. Clearing the current 4,078
backlog is therefore a **four-to-five day** process. Any UI that models it as an
operation rather than a process will lie.

`food_embedding_jobs` records: the requesting operator, the selection (all
missing / a single food / an uploaded batch), counts of queued, embedded and
failed, the quota consumed today, and a terminal state.

**`quota_exhausted` is a first-class terminal state, distinct from
`completed`.** This is the entire point. `cmd/embed` logs *"entire batch of 100
rows failed to embed; stopping"* and returns success; the portal must never
reproduce that. A job that stopped early reports how far it got and when the
quota resets — it does not report success.

The portal shows queued / embedded today / quota remaining / estimated
completion date. Estimated completion is derived from the remaining count and
the daily cap, and is explicitly an estimate.

**Not solved here:** `cmd/embed` discards the `Usage` it receives, so embedding
spend appears in neither `ai_usage_events` nor `kora_ai_calls_total`. The new
worker should record usage through `billing.Meter` so this stops being true for
work it performs. The existing `cmd/embed` is out of scope.

## Bulk upload

**Decision: a curated CSV the operator supplies.** USDA and OpenFoodFacts cover
most of the index; this exists for the gap — regional foods those sources miss.
Expected scale is tens to low hundreds of rows, not tens of thousands, so
validation is synchronous with a preview.

Flow: upload → parse and validate every row → show a preview listing accepted
rows and **rejected rows with per-row reasons** → operator confirms → insert →
enqueue embedding for the inserted rows.

Dedup is free: `nutrition.Repository.Insert` (repository.go:72) already skips a
row whose barcode, or `(name, brand)`, already exists. An upload therefore
cannot clobber USDA data, and re-uploading the same file is a no-op. That
property is the reason `cmd/seed` is safe around the Postgres restore, and it is
inherited here rather than reimplemented.

Validation rejects, at minimum: missing name, non-numeric macros, negative
values, and macros that are not per-100g-shaped. Rejections are reported per
row with the offending value; the upload is all-or-nothing only if the operator
chooses that in the preview.

## Audit

**Decision: audit every admin mutation.**

`kora_admin_events` records operator identity (from the BFF's authenticated
caller), action, target food id, before/after values, and timestamp — written
**inside the same transaction as the mutation**, so an audit row cannot go
missing when the write succeeds.

This is cheap while the endpoints are being written and impossible to
reconstruct afterwards. In a nutrition app, *"why did this food's macros
change?"* is a question that eventually gets asked, and the answer has to exist.

Surfaced as `app/admin/apps/kora/audit`.

## Implementation slices

Each ships something usable on its own.

| Slice | Contents | What it proves |
|---|---|---|
| **1** | `bff_auth`, `KORA_BFF_HMAC_KEY`, `GET /v1/admin/foods` (list + search), `kora-admin.ts`, the food index page | The signed path end to end, with nothing destructive |
| **2** | `kora_admin_events`, create / update / soft-delete, cache eviction, re-embed-on-rename, audit page | Mutations and their side effects |
| **3** | `food_embedding_jobs`, worker, quota accounting, embedding page | Kills #97's false green |
| **4** | CSV upload, validation, preview, insert + enqueue | Ingest |

Slice 1 first is deliberate: it de-risks the HMAC plumbing before any mutation
exists, and it is the dependency for three other planned Kora admin surfaces
(failed-capture explorer, user visibility, resolution quality), each of which is
a read-only query once the authenticated path is there.

## Out of scope

- **User management** (suspend, delete accounts). Separate concern; see the
  user-visibility design.
- **Editing `food_logs`.** Users' own history is not an admin surface.
- **Changing `cmd/seed` or `cmd/embed`.** The new worker supersedes `cmd/embed`
  for admin-triggered work; the batch commands are left alone.
- **Enabling Gemini billing.** Would remove the quota constraint entirely and
  make this design much simpler, but is a cost decision, not a design one.

## Facts established while designing this (verified 2026-08-05)

- Prod row counts: `food_items` 7,898 · `ai_usage_events` 124 · `users` 6 ·
  `food_logs` 3 · `food_aliases` 0 · `coach_turns` 0.
- The portal has `MARK8LY_DB_*` and `HOMECHEF_DB_*` credentials and **no Kora
  database access whatsoever** — which this design deliberately keeps true.
- `food_logs` has `provenance` and `source` but **no `match_tier` or
  `match_score`** — resolution quality is not answerable from stored data today.
- Kora's app still reads `kora_db` on the shared `global-postgres`. The
  dedicated `kora-postgres` cluster exists and is healthy but the data migration
  has not run (`docs/runbooks/kora-postgres-cutover.md`). Admin endpoints run
  inside `kora-api` and therefore follow whatever `DATABASE_URL` points at —
  this design needs no change at cutover.
