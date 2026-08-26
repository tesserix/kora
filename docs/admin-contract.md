# Kora's platform admin contract surface

Kora implements the read half of the **Product Admin Integration Contract**
(`tesserix-home/docs/superpowers/specs/2026-08-14-product-admin-integration-contract.md`,
v2) so the Tesserix platform console can manage it.

Issues: #430 (foundation) · #431 audit-logs · #432 inbox · #433 entities ·
#434 health · #435 kpis · #447 (writes decision).

## Kora has TWO admin callers, not one

This is the single most important thing on this page, and #430 got it wrong.

| | tesserix-home **admin portal** | platform **console** |
|---|---|---|
| Code | `apps/web/app/admin/apps/kora/*` | `platform-api` → `internal/platform/federation` |
| Kora package | `internal/bffauth` | `internal/platformauth` |
| Headers | `X-User-Id`, `X-User-Email`, `X-User-Role`, `X-Auth-Pool`, `X-Auth-Ts`, `X-Internal-Auth` | `X-Platform-Operator`, `X-Platform-Capability`, `X-Platform-Timestamp`, `X-Platform-Nonce`, `X-Platform-Signature` |
| Canonical string | `method\npath\nbodyhash\nts\nuserID\nemail\nrole\npool` | `METHOD\npath\ncanonicalQuery\nbodyhash\nts\nnonce\noperator\ncapability` |
| Query signed? | no | **yes**, canonicalised |
| Replay defence | 60s window only | 5min window **plus** a single-use nonce |
| Secret | `KORA_BFF_HMAC_KEY` (base64) | `KORA_PLATFORM_ADMIN_SECRET` (raw string) |
| Routes | `foods`, `foods/:id`, `events`, `feedback`, `users` (+ writes) | `audit-logs`, `inbox`, `entities/:type`, `health`, `kpis` |

**The two canonical strings are byte-incompatible.** #430 said "transport and
identity are solved" because `/v1/admin/*` was already HMAC-protected. It was
— by the *other* scheme. A correctly-signed portal request is not a credential
on a console route, and vice versa; both sides answer one opaque 401, so the
only symptom of getting this wrong is a console page that never loads and a
Kora log line that says `signature mismatch`.

Both groups are mounted on `/v1/admin` with different middleware. Gin's radix
tree keeps them apart. `internal/server/platform_admin_routes_test.go` asserts
each rejects the other's caller — do not move a route between the groups
without moving its caller.

## Registration (#430)

Kora is **not yet registered**. The console side needs:

```
FEDERATION_PRODUCTS=mark8ly,kora
FEDERATION_KORA_BASE_URL=https://<kora-api>/v1
FEDERATION_KORA_SECRET=<same value as KORA_PLATFORM_ADMIN_SECRET>
```

### The base URL must end in `/v1`

The federation client calls `{BaseURL}/admin/audit-logs` and signs the decoded
`URL.Path` — including whatever prefix `BaseURL` carries. Kora mounts
everything under `/v1`, so the signed path is `/v1/admin/audit-logs` and the
registered base URL must end in `/v1`.

An unversioned alias (`/admin/*`) was considered and rejected: it would mean
two paths for one endpoint, only one of which the signature covers, and a
caller landing on the wrong one gets an opaque 401 with nothing in Kora's logs
to explain it.

Note mark8ly's registry comment about Istio: its base URL must avoid
`/api/v1/admin/*` because an `AuthorizationPolicy` denies un-JWT'd requests
there. Kora has no equivalent policy on `/v1/admin` today — the portal already
reaches it — but check before assuming.

### Conformance is still blocked

`@tesserix/admin-conformance` does not exist in `tesserix-home/packages/`
(verified 2026-08-26). Until it does, drift is caught by this repo's own tests
and by nothing else. Wiring it into CI is the remaining half of #430.

## What is implemented

| Endpoint | Status |
|---|---|
| `GET /v1/admin/audit-logs` | real, over `kora_admin_events` |
| `GET /v1/admin/inbox` | real, feedback queue only |
| `GET /v1/admin/entities/{type}` | real, `users` and `foods` |
| `GET /v1/admin/health` | real probes for Postgres and Redis |
| `GET /v1/admin/kpis` | deliberate `501 not_implemented` |
| `GET /admin/billing/*` | not implemented — Kora has no billing concept |
| `POST /admin/inbox/{id}/actions/{id}` | not implemented — no actions declared |
| any write | not implemented — see #447 below |

### audit-logs (#431)

Every row is Kora's **by construction**: `kora_admin_events` is Kora's own
table in Kora's own database, and this process can reach no other product's.
That is the finding behind #431 — the console's shared route validated a
`:product` parameter and then queried mark8ly's table regardless, so Kora's
overview displayed mark8ly's rows.

`before`/`after` snapshots are not on the wire: they can carry a food's whole
nutrition record, and the estate timeline renders a line per event, not a
diff. `metadata` is omitted for the reason mark8ly's is — the contract's
example shows a string while the column is `jsonb`.

`/v1/admin/events` (the portal's route) is unchanged and **not** renamed. #431
suggested renaming; it has a live consumer in `apps/web`, so it stays.

### inbox (#432)

One queue: feedback awaiting triage (`status IN (open, in_progress)`), oldest
first.

**The second queue #432 named does not exist.** Nothing in Kora persists a
food-resolution outcome — no table, no column, no write path — so
`kind: "unresolved_food"` has no data source. It is omitted rather than
invented. The same gap makes `unresolved_food_backlog` uninstrumented in
`/admin/health` and is one reason `/admin/kpis` is a 501.

`due_at` is `null` because Kora has no SLA on this queue. `actions` is empty
because §8.2's execution endpoint is not implemented and §3.2 says to declare
only actions the product can perform. `href` is empty because `console-core`
still marks every Kora route `pending`, and an href to a 404 is worse than
none.

### entities (#433)

`users` and `foods`. The endpoint **browses and searches**: an absent `q`
lists the type ordered `created_at DESC`; a present `q` filters by it. Same
envelope either way (kora#473).

`q` used to be **required**, at 2 characters minimum, as an enumeration guard —
"a search endpoint over user records must not answer everything when asked for
nothing". Browse retires that reasoning rather than weakening it. The console's
Food index and Users pages are *indexes* an operator pages through, so
"everything, paged" is the intended answer; against a search-only endpoint the
first thing an operator saw on opening either page was a `400`. With browse
available the old floor guarded nothing — `q=a` returns a strict SUBSET of what
an absent `q` returns — while breaking a legitimate narrowing search, so it is
gone rather than kept as an incoherent hole.

What bounds the response is pagination, unchanged: `limit` is capped and
`total` is exact and unpaged.

**Estate note.** mark8ly's `/admin/entities/tenants` already browsed, so the two
implementers disagreed. This closes that divergence in the direction mark8ly had
already taken; browse-and-search is the contract's shape, not Kora's local
choice.

**A product can pass conformance with an endpoint the console cannot use.** The
suite scored the old `400` against §4.4 (a well-formed error with a stable code)
rather than against the success shape, so search-only passed cleanly while being
unusable as an index. Worth remembering when reading a green conformance run.

The user row carries `id`, `label`, `sublabel`, `created_at` and nothing else.
`sublabel` is the handle when the user has one and the email otherwise;
`social.FriendView`'s no-email precedent is followed as far as it can be, but a
directory that cannot tell two people called "Alex" apart does not do the job
#433 exists to do.

Retired (soft-deleted) foods are excluded from both the page and the total.

**Known cost:** the search is `LIKE '%q%'`, which no existing index serves —
`idx_food_items_name` is a tsvector GIN (word matching, not substring) and
`idx_food_items_name_trgm` is a plain btree on `lower(name)` despite the name.
Both the page and the count scan; the count is the expensive half. Substring
matching is what a ⌘K directory is for, so if this becomes slow on the food
index the fix is `pg_trgm` plus a GIN trgm index on `lower(name)` — indexed
without changing what an operator can find — not a narrower search.

### health (#434)

Genuinely probed: Postgres (`SELECT 1`, a real round trip — a pool with idle
connections to a stopped database looks healthy from the inside) and Redis
(`PING`, through a **dedicated client**, because `buildResolveHandler` closes
its own after one failed boot ping and therefore holds nothing to probe in
exactly the state #105 describes).

Not instrumented, and reported as such rather than as `ok`:

- `ai_provider` — prod is gateway→Vertex and the only genuine probe is a model
  call, which costs money and quota on every console page render. A set API key
  says a deploy was configured, not that it works.
- `unresolved_food_backlog` — nothing persists a resolution outcome.

The endpoint is always `200`: it *reports* health, it does not *have* health.
A 503 would make "Kora says Redis is down" and "Kora's health endpoint is
down" the same event.

### kpis (#435)

`501 not_implemented`, deliberately. §3.1 forbids `{}` or zeroes, which render
as em-dashes that read as "zero activity" rather than "nothing measured".
Kora is pre-launch; #43 decides which numbers are headline, and two candidates
are not computable yet. When #43 lands, copy mark8ly's `KPIRegistry` shape —
a declared key list driving both the 200 and the 501 — rather than adding a
bare value.

## #447 — the console is read-only for Kora

**Decision, 2026-08-26.** Foods and users are edited through Kora's own admin
portal; the console observes. `console-core` should read "Food index" as a
table, not an editor.

The existing `POST`/`PATCH`/`DELETE /v1/admin/foods` and
`DELETE /v1/admin/users/:id` are unchanged and stay behind `bffauth` — they
have a portal caller. Nothing platform-scoped writes.

Reopening this means first answering §8.3: which capability value each route
requires (the vocabulary is not settled — mark8ly's
`RequiredWriteCapabilities` values are all empty for the same reason), reason
codes on reversible-but-consequential actions, and confirmation semantics on
the irreversible ones. A user delete is an account deletion with a compliance
dimension; it is the one worth revisiting first.

## Operating notes

- An empty `KORA_PLATFORM_ADMIN_SECRET` leaves the surface **unmounted**, so an
  unconfigured environment answers 404 rather than 401. That difference is what
  tells an operator whether the deploy is missing a secret or the secret is
  wrong.
- `platform_request_nonces` (migration 000057) grows one row per federated
  request and nothing sweeps it on a schedule — Kora has no cron process.
  `platformauth.SweepExpiredNonces` exists and is tested; wire it to something
  before the table matters. Never replace it with "delete anything older than a
  day": `expires_at` is `signedTS + window`, exactly the instant a request stops
  being signature-valid.
- Rejections log a `reason` (`signature_mismatch`, `timestamp outside window`,
  `nonce replayed or unverifiable`, …) and nothing else about the request. The
  wire answer is always one opaque 401.
- The signing vectors in `api/internal/platformauth/testdata/vectors.json` are
  byte-identical to mark8ly's and to the federation client's. If you change
  anything in `signature.go`, those tests are the only thing standing between
  you and a silent production 401.
