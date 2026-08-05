# Kora food-data admin — Slice 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a platform admin create, correct and retire Kora food records through the signed BFF path, with every mutation audited in the same transaction and every downstream side effect actually taken.

**Architecture:** Slice 1's `bffauth` middleware and `/v1/admin` route group already exist and are live. This slice adds write endpoints behind them, a `kora_admin_events` audit table written inside the mutating transaction, a `deleted_at` soft-delete column that every read path must honour, and a cache-generation counter that makes a cross-user cache flush O(1). The portal gains edit/create/delete affordances and an audit page.

**Tech Stack:** Go 1.26 + Gin + GORM + golang-migrate (kora-api) · Next.js 16 + React 19 (tesserix-home) · Helm + ArgoCD + Istio (tesserix-k8s).

**Spec:** `docs/superpowers/specs/2026-08-05-kora-food-data-admin-design.md`, slice 2 row: *`kora_admin_events`, create / update / soft-delete, cache eviction, re-embed-on-rename, audit page — proves mutations and their side effects.*

**Slice 1 is merged and deployed** (kora `fc8fca8`, tesserix-home `d75e63a`, tesserix-k8s #159). `GET /v1/admin/foods` answers 200 to a signed request in production.

---

## Global Constraints

- **The wire format is frozen.** `bffauth.Compute`'s canonical string, the two pinned hex vectors, `ADMIN_PREFIX`, and the header names are pinned by matching tests in two repos. Do not touch them. Mutating endpoints send a JSON body, which the existing signature already covers via the body hash.
- **The admin body cap is 16 KiB** (`maxAdminBodyBytes` in `bffauth`). Single-food mutations are far below it. Do not raise it here — slice 4's CSV upload needs its own path, and that is recorded in the comment.
- **The operator identity comes from the middleware**, `bffauth.CtxAdminID` and `CtxAdminEmail` on the Gin context. Never accept an actor id from the request body.
- **Every audit row is written inside the same transaction as the mutation it describes.** An audit row that can go missing when the write succeeds is worse than no audit table, because it will be trusted.
- **Prod and local are both at migration v22.** This slice adds `000023`. golang-migrate does not checksum, so if you amend a migration after committing it, the branch MUST be squash-merged.
- Single-line conventional commits, no body, no trailers, no signature. Branch before committing; never commit to `main`.
- Go tests run in the FOREGROUND: `cd api && go vet ./... && TEST_DATABASE_URL=postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable go test -race -p 1 -count=1 ./...`
- Portal tests run from the tesserix-home REPO ROOT: `pnpm --filter web test:unit`. It is a pnpm workspace with `node-linker=hoisted`; running from `apps/web` fails with a misleading MODULE_NOT_FOUND. Tests are CO-LOCATED and must be named `.test.ts` — the vitest `include` glob silently drops `.test.tsx`.
- `beforeEach(() => mock.mockReset())` is broken in this vitest; always use a block body.

## House rules

- **Mutation-verify every test.** Break the behaviour it names, confirm it fails on that test's OWN assertion, revert, confirm a clean `git diff`. Confirm the mutation actually applied — BSD `sed` silently no-ops on the `0,/re/s//` form.
- **Every "must reject" needs its "must accept" twin**, and vice versa.
- **Ambient database state is a vacuity source, in three proven shapes.** The shared `kora-pg-test` DB holds ~88 `food_items` rows, zero embedded; CI's table is EMPTY because CI runs only `go run ./cmd/migrate`. A test that reads its expectation from row counts passes locally and fails in CI (or vice versa), and a fixture sized *below* the threshold it tests can never test it. Seed controlled rows inside a `db.Begin()` transaction with `t.Cleanup` registering the rollback immediately.
- **The Go LSP emits stale false "undefined symbol" diagnostics.** Trust the compiler.
- Namespace briefs and reports under `.superpowers/sdd/food-data-slice-2/`.

## Two decisions taken with the user before planning

**1. Cache invalidation is a generation counter, not a targeted delete.** The resolve cache key is `kind:userID:phrase` — it carries no food id — while a cached `ai.Resolution` embeds the food's nutrition. So an admin edit must invalidate entries across *all* users and *all* phrases referencing that food, which the existing per-user invalidator structurally cannot do. A single generation integer folded into every cache key makes that an O(1) `INCR`. Prior entries become unreachable immediately and age out on their existing TTL.

Note that **Redis is not reachable in production today** — `REDIS_URL` is unset, the pod logs `connection refused` on a loop, and the resolver falls back to `ai.NoCache{}`. The mechanism is therefore inert in prod right now. That is exactly why it must be correct: it will be switched on later by someone who assumes it always worked.

**2. The gateway exposure is closed in this slice.** `/v1/admin/*` is currently reachable from the internet, defended only by the HMAC, because the existing ingress DENY matches `/api/v1/admin/*` and Kora mounts at `/v1/admin/*`. Read-only GET made that tolerable; DELETE does not. Task 7 adds a path-based DENY bound to the ingressgateway, which *can* enforce L7 — unlike the ztunnel-bound namespace policies, which strip HTTP attributes and become deny-all.

## One judgment call I made rather than asking

**A rename clears the embedding; it does not enqueue a job.** The spec says renames "clear the embedding and enqueue a job in the same transaction", but `food_embedding_jobs` is slice 3. Setting `embedding = NULL` is sufficient and self-reporting: the row immediately appears in `kora_food_index_missing`, which is already gauged and already the input to the existing backfill. Slice 3 replaces that with a durable queue. If you disagree, say so in your report rather than pulling slice 3's table forward.

## File Structure

**kora** (branch `feat/kora-admin-mutations`)

| File | Responsibility |
|---|---|
| `api/internal/database/migrations/000023_admin_mutations.{up,down}.sql` | `deleted_at`/`updated_at` on `food_items`; `kora_admin_events`. |
| `api/internal/admin/events.go` | The audit row type and its transactional writer. |
| `api/internal/admin/mutations.go` | Create / update / soft-delete, each in one transaction with its audit row. |
| `api/internal/admin/handler.go` | *Modify* — POST / PATCH / DELETE handlers, request validation. |
| `api/internal/admin/repository.go` | *Modify* — exclude soft-deleted from listing. |
| `api/internal/ai/cache.go` | *Modify* — generation counter folded into `CacheKey`. |
| `api/internal/nutrition/repository.go`, `alias.go` | *Modify* — exclude soft-deleted from EVERY read path. |
| `api/internal/metrics/foodindex.go` | *Modify* — gauge must exclude soft-deleted. |
| `api/internal/server/router.go` | *Modify* — mount the three new routes. |

**tesserix-k8s** (branch `feat/kora-admin-gateway-deny`) — one AuthorizationPolicy.

**tesserix-home** (branch `feat/kora-foods-mutations`) — client methods, an edit sheet, a create form, a delete confirmation, and the audit page.

---

## Task 1: migration — soft delete, updated_at, and the audit table

**Files:**
- Create: `api/internal/database/migrations/000023_admin_mutations.up.sql`
- Create: `api/internal/database/migrations/000023_admin_mutations.down.sql`
- Test: `api/internal/nutrition/migration_test.go` (*modify* — follow whatever that file already does)

**Interfaces:**
- Produces: `food_items.deleted_at timestamptz NULL`, `food_items.updated_at timestamptz NOT NULL DEFAULT now()`, and table `kora_admin_events`.

**Why soft delete, stated correctly.** The design justified it by `food_logs`, which is the weakest case — that FK is `ON DELETE SET NULL`, so a log survives a hard delete with its own denormalised macros and merely loses the link. The real destruction is elsewhere, and I verified all four constraints against the live schema:

| Referencing table | Constraint |
|---|---|
| `food_aliases` | `ON DELETE CASCADE` — destroys the user's taught corrections, undoing issue #20 |
| `pins` | `ON DELETE CASCADE` |
| `saved_meal_items` | `ON DELETE CASCADE` — can leave a saved meal with missing items |
| `food_logs` | `ON DELETE SET NULL` |

Put that in the migration's comment. Anyone who later thinks "why not just delete it" needs to meet those three CASCADEs.

- [ ] **Step 1: Write the up migration**

```sql
-- Admin mutations (slice 2 of the food-data admin design).
--
-- deleted_at exists because a HARD delete is destructive in three ways the
-- food_logs FK does not show. Verified against the live schema:
--   food_aliases.food_item_id      ON DELETE CASCADE  -- destroys a user's taught
--                                                     -- corrections (issue #20)
--   pins.food_item_id              ON DELETE CASCADE
--   saved_meal_items.food_item_id  ON DELETE CASCADE  -- can gut a saved meal
--   food_logs.food_item_id         ON DELETE SET NULL -- log survives, orphaned
-- Every read path must therefore filter deleted_at IS NULL, including the
-- kora_food_index_* gauges, or retired rows silently keep being counted.
ALTER TABLE food_items ADD COLUMN deleted_at timestamptz NULL;
ALTER TABLE food_items ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Partial index: every read path filters deleted_at IS NULL, and retired rows
-- are expected to be a tiny minority, so indexing only the live rows keeps the
-- index small and matches the predicate the queries actually carry.
CREATE INDEX idx_food_items_live ON food_items (id) WHERE deleted_at IS NULL;

-- kora_admin_events is written INSIDE the transaction that performs the
-- mutation, so an audit row cannot go missing when the write succeeds.
-- actor_* come from the BFF-verified identity on the Gin context, never from
-- the request body.
CREATE TABLE kora_admin_events (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id     text        NOT NULL,
    actor_email  text        NOT NULL,
    action       text        NOT NULL,
    target_type  text        NOT NULL,
    target_id    uuid        NULL,
    before       jsonb       NULL,
    after        jsonb       NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_kora_admin_events_created ON kora_admin_events (created_at DESC);
CREATE INDEX idx_kora_admin_events_target ON kora_admin_events (target_id, created_at DESC);
```

**Note on `jsonb`:** this repo has had ZERO jsonb usage until now, and an earlier slice deliberately chose a child table over jsonb for that reason. This case is different and the difference is worth stating: `before`/`after` are opaque snapshots that nothing queries structurally — they are read back whole, for a human. A child table would mean one row per changed field and a join to render one audit line. If you find yourself needing to query *inside* these columns, that is the signal the choice was wrong.

- [ ] **Step 2: Write the down migration**

```sql
DROP INDEX IF EXISTS idx_kora_admin_events_target;
DROP INDEX IF EXISTS idx_kora_admin_events_created;
DROP TABLE IF EXISTS kora_admin_events;
DROP INDEX IF EXISTS idx_food_items_live;
-- Rolling back RESURRECTS every soft-deleted row into all read paths, because
-- the column carrying the retirement disappears. That is the correct and only
-- possible behaviour for a down migration, but it is not a no-op — anything
-- retired while this migration was applied becomes live again.
ALTER TABLE food_items DROP COLUMN IF EXISTS updated_at;
ALTER TABLE food_items DROP COLUMN IF EXISTS deleted_at;
```

- [ ] **Step 3: Verify the chain on a FRESH throwaway database**

Do not test this incrementally against `kora-pg-test` alone — a fresh chain is what CI runs and what prod will run.

```bash
docker exec kora-pg-test psql -U kora -d postgres -c 'CREATE DATABASE kora_mig_probe;'
cd api && DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora_mig_probe?sslmode=disable' go run ./cmd/migrate
docker exec kora-pg-test psql -U kora -d kora_mig_probe -tAc \
  "select version,dirty from schema_migrations;
   select column_name from information_schema.columns where table_name='food_items' and column_name in ('deleted_at','updated_at');
   select count(*) from kora_admin_events;"
```
Expected: `23|f`, both columns listed, `0`. Then DROP the probe database and confirm it is gone. Then migrate `kora-pg-test` itself to 23 so the rest of the tasks have it.

- [ ] **Step 4: Commit**

```bash
git checkout -b feat/kora-admin-mutations
git add api/internal/database/migrations/
git commit -m "feat(api): soft delete, updated_at and the admin audit table"
```

---

## Task 2: exclude soft-deleted rows from EVERY read path

**Files:**
- Modify: `api/internal/nutrition/repository.go` (several query sites)
- Modify: `api/internal/nutrition/alias.go`
- Modify: `api/internal/admin/repository.go`
- Modify: `api/internal/metrics/foodindex.go`
- Test: the co-located test file for each

**Interfaces:** no signature changes. Behaviour only.

**THE TRAP, and it is the whole reason this is its own task.** GORM's built-in soft delete (`gorm.DeletedAt`) applies only to queries GORM *builds*. Large parts of this codebase use `db.Raw(...)` with hand-written SQL — `nutrition/repository.go` around lines 148, 167 and 215, and `nutrition/alias.go` around line 91. **Adding `gorm.DeletedAt` to the model would silently protect the GORM queries and leave every raw query returning retired rows**, which is worse than not doing it at all, because it would look done. Filter explicitly at every site instead, and do not add `gorm.DeletedAt` to `FoodItem`.

Sites to change, all verified present:

| File | What it does | Consequence if missed |
|---|---|---|
| `nutrition/repository.go` GetByID | fetch by id | a retired food still resolves |
| `nutrition/repository.go` Count | index size | reports retired rows |
| `nutrition/repository.go` Search | mobile picker | user can log a retired food |
| `nutrition/repository.go` Resolve (raw, ~3 sites) | AI resolution | retired food returned as a candidate |
| `nutrition/alias.go` (raw) | personal alias lookup | a taught alias resurrects a retired food |
| `admin/repository.go` ListFoods | admin browse | retired rows in the admin table |
| `metrics/foodindex.go` | the gauges | `kora_food_index_items` counts invisible records |

Leave `Insert`'s dedup checks (around lines 77 and 87) counting ALL rows including soft-deleted, and say so in a comment: re-inserting a name that was deliberately retired should still be a no-op, not a resurrection by the back door. That is a deliberate asymmetry — write it down or someone will "fix" it.

- [ ] **Step 1: Write the failing tests first**

For each site, one test that seeds a live row and a soft-deleted row inside a rolled-back transaction and asserts the retired one is absent while the live one is present. **Both halves are required** — an assertion that only checks the retired row is absent would pass against a query that returns nothing at all.

For the gauge, the test must assert the total EXCLUDES the soft-deleted row while still counting the live one. Reuse the transaction-seeding pattern already in `metrics/foodindex_test.go`, which seeds controlled rows precisely because the shared table cannot be trusted.

- [ ] **Step 2: Run them, confirm they FAIL**

Every one should fail by returning the retired row. If any test passes before you change the code, that site already filters or your fixture is not discriminating — investigate rather than moving on.

- [ ] **Step 3: Add the filter at every site**

GORM builder queries: `.Where("deleted_at IS NULL")`. Raw SQL: add `AND fi.deleted_at IS NULL` to the existing WHERE, matching each query's alias. The gauge query becomes:

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
FROM food_items
WHERE deleted_at IS NULL
```

- [ ] **Step 4: Run the FULL suite and confirm green**

- [ ] **Step 5: Mutation-verify, one site at a time**

Remove the filter at each site individually and confirm exactly the test for that site fails. If removing one site's filter fails a different site's test, the tests are coupled and at least one is not proving what it names.

- [ ] **Step 6: Commit**

```bash
git add api/internal/nutrition/ api/internal/admin/repository.go api/internal/metrics/
git commit -m "feat(api): exclude soft-deleted foods from every read path"
```

---

## Task 3: cache generation counter

**Files:**
- Modify: `api/internal/ai/cache.go`
- Test: `api/internal/ai/cache_test.go`

**Interfaces:**
- Produces: a generation-aware `CacheKey`, and a way for the admin package to bump the generation. Keep the existing `Cache` interface's `Get`/`Set`/`Delete` shape; add the generation as its own small surface so `NoCache` and the Redis cache can both satisfy it.

**The property to build.** Every cache key embeds the current generation. Bumping the generation makes every prior key unreachable in one operation, with no scan and no reverse index. Entries age out on their existing 24h TTL.

**Failure mode to design against explicitly:** if reading the generation fails (Redis down, which is the CURRENT state in production), the resolver must keep working. Decide what a generation read failure means — a fixed fallback generation, or treating the cache as absent — and make that choice a tested property, not an accident. Note that `buildResolveHandler` already falls back to `ai.NoCache{}` when Redis is unreachable at startup, so the interesting case is Redis dying *after* startup.

**Do not break `CacheKey`'s existing pinned properties.** `cache_test.go` already pins that keys are normalised (lowercased, trimmed) and scoped by user — the latter is a regression test for a real cross-user data leak. Both must still hold with the generation added.

- [ ] **Step 1: Write the failing tests**

Cover: two keys built under different generations differ; a key is stable within one generation; bumping the generation makes a previously-`Set` value unreadable via a fresh key; normalisation and per-user scoping still hold; and a generation-read failure degrades in whatever way you chose rather than panicking or silently colliding.

- [ ] **Step 2: Run, confirm failure. Step 3: implement. Step 4: run, confirm pass.**

- [ ] **Step 5: Mutation-verify** — make the generation constant and confirm the invalidation test fails; break normalisation and confirm the pre-existing test fails.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(api): generation-scoped resolve cache keys"
```

---

## Task 4: mutations with transactional audit

**Files:**
- Create: `api/internal/admin/events.go`, `api/internal/admin/mutations.go`
- Test: `api/internal/admin/events_test.go`, `api/internal/admin/mutations_test.go`

**Interfaces:**
- Consumes: `nutrition.FoodItem`; the cache generation from Task 3.
- Produces: `admin.AdminEvent`, and repository methods for create, update and soft-delete, each taking the actor identity and returning the resulting food.

**Four invariants, each of which needs its own test:**

1. **The audit row and the mutation share one transaction.** Test by forcing the audit insert to fail and asserting the food change is ALSO absent. A test that only checks "both rows exist after success" does not prove atomicity.
2. **A rename clears the embedding.** Changing `name` (and therefore `normalized_name`) must set `embedding = NULL` in the same statement. The stale-vector case is worse than the un-embedded case because `kora_food_index_embedded` still counts the row. Test that a rename NULLs it and that a macros-only edit does NOT.
3. **A macros edit bumps the cache generation.** Test that it bumps, and — the twin — that a no-op update does not.
4. **Soft delete sets `deleted_at`, never issues a DELETE.** Test that the row still exists in the table afterwards and that the three CASCADE-referencing tables are untouched. Seed an alias, a pin and a saved-meal item pointing at the food, soft-delete it, and assert all three survive. This is the test that would have caught a hard delete, and it is the reason the column exists.

`before`/`after` snapshots: capture the food row before and after, serialise to jsonb. Do not put the actor in the snapshots — it has its own columns.

- [ ] **Step 1-6:** tests first, confirm failure, implement, confirm pass, mutation-verify each of the four invariants individually, commit.

```bash
git commit -m "feat(api): audited food create, update and soft delete"
```

---

## Task 5: mutation endpoints

**Files:**
- Modify: `api/internal/admin/handler.go`, `api/internal/server/router.go`
- Test: `api/internal/admin/handler_test.go`, `api/internal/server/router_test.go`

**Routes:** `POST /v1/admin/foods`, `PATCH /v1/admin/foods/:id`, `DELETE /v1/admin/foods/:id`.

**Validation, at minimum:** name non-empty; macros numeric, non-negative, and per-100g-shaped; `serving_grams` positive. Reject with the existing `httpx` 400 envelope. Every rejected request must never reach the repository — assert that, or "validation" that runs after the write passes its tests.

**The actor comes from the context, never the body.** Add a test that a request body containing an `actor_id` field cannot influence the recorded actor. That is the kind of thing nobody writes until it is exploited.

**PATH ENCODING — this is where slice 1's latent trap becomes live.** `:id` is the first path parameter on the admin surface. The TypeScript client signs the raw path string while `fetch` percent-encodes on the wire, and Go's `URL.Path` percent-*decodes*. A UUID is ASCII-safe so the normal case is fine, but the client's JSDoc already names the traps. Add a test that a signed request carrying a well-formed UUID verifies, and note in your report whether a malformed id can produce a 400 before gin rather than a clean 404.

- [ ] Tests first; confirm failure; implement; confirm pass; mutation-verify that each route is actually behind `bffauth` (an unsigned DELETE must 401, not 404 and not 200); commit.

```bash
git commit -m "feat(api): admin food mutation endpoints"
```

---

## Task 6: wire the generation bump and open the PR

**Files:** `api/cmd/api/main.go`, `api/internal/server/router.go`

Thread the cache into the admin mutation path the same way `buildResolveHandler` already threads it into `foodlog.Service` — it must be the SAME instance the resolver reads from, or an eviction is invisible to the next resolve. `main.go` already passes one variable to both `NewResolver` and `Deps.ResolveCache`; follow that exactly and assert it in a test if you can.

Run the full suite, `go vet`, push, open a PR. Do not merge.

---

## Task 7: close the gateway exposure (tesserix-k8s)

**Files:** one AuthorizationPolicy in `charts/thirdparty/istio-config/templates/authorization-policies.yaml`.

Mirror `deny-ops-endpoints-main`: a DENY action, selecting the **istio-ingressgateway**, with `to.operation.paths: ["/v1/admin/*"]`.

**Why bound to the gateway and not the namespace:** ns `kora` is ambient and its namespace-scoped policies are enforced by ztunnel, which cannot evaluate L7 attributes — it strips them, leaving an ALLOW with no valid rule, i.e. deny-all. That mistake previously made kora-api unreachable with 503s. A policy selecting the ingressgateway is a sidecar/gateway-enforced policy and CAN match paths. Verify which enforcement point picks it up before believing it works.

**Verify by traffic, not by status.** After it applies: a request to `https://kora-api.tesserix.app/v1/admin/foods` from outside must be refused at the edge, while the in-cluster call from the `company` pod must still succeed. ArgoCD reporting Synced proves nothing here — that has been true three times in this project while the resource did nothing.

Note this repo's CI is billing-blocked (private repo); its checks will not run and that does not gate ArgoCD.

---

## Task 8: portal — mutation client and UI

**Files:** `apps/web/lib/api/kora-admin.ts` (+ test), a food detail/edit surface, a create form, a delete confirmation.

Add `createKoraFood`, `updateKoraFood`, `deleteKoraFood` alongside `listKoraFoods`, following its shape exactly — including the shape check that turns an unexpected 200 body into an error rather than a silent `undefined`.

**The delete confirmation must show how many logs reference the food** before you delete it, per the design. That number needs an endpoint or a field; decide which and say so in your report rather than inventing a count in the client.

Every mutation surfaces Kora's error `code` and `message` on failure, the way the existing error state does. A mutation that fails silently is worse than one that errors loudly.

---

## Task 9: portal — audit page

**Files:** `apps/web/app/admin/apps/kora/audit/page.tsx`, a nav entry, tests.

Server component listing `kora_admin_events` newest-first: when, who, what action, which food, and a readable before/after diff. Needs `GET /v1/admin/events` — add it in Task 5 rather than here, and note the dependency.

**Add the nav entry to `koraNav`.** `/admin/apps/kora` is already in `EXACT_MATCH_ROOTS`, so the Overview active-state bug will not recur — but confirm rather than assume.

---

## Final verification, after all three PRs merge

Slice 1's deploy taught the sequence, and it is three steps, not one:

- [ ] Merge in order: **kora → tesserix-k8s → tesserix-home.**
- [ ] **Bump the live `kora-api` Application's `image.tag` to the merge commit.** Merging cannot advance it — `ignoreDifferences` on `/spec/source/helm/parameters` means a git merge neither resets nor advances the pin. This is the single most forgettable step and it lives outside all three repos.
- [ ] Verify the running digest against what CI pushed, filtering pods by `ownerReferences[].kind == ReplicaSet` — the `app.kubernetes.io/name=kora-api` label also matches Job pods, and a running seed Job will match a digest grep and produce a false green. This happened during slice 1's deploy.
- [ ] Confirm the migration reached v23 in prod before the new image serves traffic. A new pod against v22 will 500 on any mutation.
- [ ] Soft-delete one food through the portal, then confirm via a signed read that it is gone from the index, that `kora_food_index_items` dropped by exactly one, and that a `food_aliases` row pointing at it still exists.
- [ ] Confirm the audit row exists for that action with the right actor email.
