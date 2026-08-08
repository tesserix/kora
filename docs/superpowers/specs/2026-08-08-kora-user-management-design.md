# Design — Kora admin user management (Phase 3)

Date: 2026-08-08. Touches `kora` (three admin endpoints, one `/v1/me` endpoint,
one shared deletion service) and `tesserix-home` (one list page, one detail
panel, one destructive flow).

**Status: designed with the user on 2026-08-08. Decisions recorded below.**

Supersedes the scoping in `2026-08-05-kora-user-visibility-design.md`, which was
explicitly "scoped, NOT designed with the user" and deliberately excluded every
write. That exclusion is **reversed here by decision**: management, not just
visibility. The visibility spec's *read* design — its columns, its query, its
PII treatment — is adopted almost intact and credited throughout.

Depends on `2026-08-07-account-deletion-design.md` (#106), whose deletion
sequence this design implements rather than duplicates.

## Purpose

Two jobs, one surface.

**See the activation funnel.** Measured against prod on 2026-08-08:

> **6 users. 6 onboarded. 6 with targets. 2 have ever logged a meal.**
> **3 users made 124 AI calls and produced 3 food logs between them.**

Onboarding completes; activation does not. One user tried the core feature and
got nothing out of it; three never tried at all. That is directly the R1 bar —
"someone who isn't you can onboard and log unaided" — and today it takes a
hand-written SQL query against prod to learn it.

**Delete a user, correctly and irreversibly.** Kora has no deletion path at all
today. `DELETE /v1/me` is not registered and `api/internal/user/` has no delete
service — #106 slice 1 (Apple `authorizationCode` capture) shipped, slice 2 did
not.

## Decisions

| Question | Decision | Where argued |
|---|---|---|
| Scope | List + counts-only detail + delete | below |
| Suspend | **Out of scope** | "Why not suspend" |
| Delete engine | **One shared service, two callers** | "The deletion engine" |
| Access path | Everything over the signed BFF | "Access path" |
| `email` shown | **Yes** | "PII" |
| Read auditing | **No** — recorded as a decision, not an omission | "PII" |
| Detail depth | Counts only; never a user's actual meals | "Detail panel" |
| Firebase failure, admin caller | **Surfaced**, not swallowed | "Divergence 1" |
| Redis eviction | **Added** to the deletion sequence | "Divergence 2" |

## Access path

Everything goes over kora-api's **signed BFF** (`KORA_BFF_HMAC_KEY`, HMAC-SHA256
binding method, path, body hash, timestamp and caller identity). No direct
database access.

This is not a fresh choice; it is the visibility spec's own rule resolving. That
spec said: if Phase 3 ships read-only, take the mark8ly direct-DB route and skip
the BFF; **the moment it needs one write, build the BFF and put everything
through it**, because maintaining two access paths is not worth it. Delete is a
write, so the rule resolves to "everything through the BFF".

Two facts make this cheap rather than the "long pole" the Phase 1 spec
predicted:

- **The BFF already exists and is in production.** `foods`, `events` and
  `feedback` all route through it; `main.go` gates the whole admin surface on
  `KORA_BFF_HMAC_KEY`. The infrastructure Phase 1 costed as the long pole is
  built.
- **The portal holds no Kora database credentials at all** (only `MARK8LY_DB_*`
  and `HOMECHEF_DB_*`), and the food-data design deliberately keeps that true.
  Direct-DB reads would mean provisioning Kora DB access that does not exist.

The correctness argument stands independently for writes: Kora keeps a **Redis
resolve cache keyed by user** (`CacheKey(kind, userID, value)` for `phrase`,
`photo` and `voice`), and `foodlog` carries idempotency invariants the offline
queue (#22) depends on. A direct SQL write leaves per-user cache entries stale
with nothing to evict them — the portal would look like it worked while Kora
went on serving stale resolutions.

## Endpoints

New on the existing HMAC-gated `adminGroup` in `api/internal/server/router.go`:

| Endpoint | Purpose |
|---|---|
| `GET /admin/users` | Activation-funnel list + summary counts |
| `GET /admin/users/:id` | Counts-only detail, incl. deletion preview |
| `DELETE /admin/users/:id` | Irreversible deletion via the shared service |

New outside the admin group, because the shared service needs its second caller:

| Endpoint | Purpose |
|---|---|
| `DELETE /v1/me` | Self-deletion. Row resolved from `IDFromContext`, exactly as `PATCH /v1/me` does — no user id in the request, nothing to forge. |

`DELETE /v1/me` **is #106 slice 2's entire server half.** After this ships, #106
slice 2 is the mobile Settings UI and confirmation screen only.

Note the asymmetry deliberately: the admin endpoint takes a user id in the path
and *is* forgeable, which is exactly what the BFF signature and the audit row
exist for.

## The list

One row per user, most recent signup first. Columns and their sources are
inherited from the visibility spec:

| Column | Source |
|---|---|
| Signed up | `users.created_at` |
| Onboarded | `users.onboarded_at` — NULL means dropped out mid-onboarding |
| Ever logged | derived: any `food_logs` row |
| First log | `min(food_logs.logged_at)` |
| Last write | `max(food_logs.logged_at, ai_usage_events.created_at)` |
| Logs | `count(food_logs)` |
| AI calls attempted | `count(ai_usage_events)` |
| Has targets | `target_kcal IS NOT NULL` — boolean, never the value |
| Timezone | `users.timezone` |

### The query

Lives in kora-api's repository layer, not the portal.

```sql
SELECT u.id, u.email, u.display_name, u.created_at, u.onboarded_at,
       u.timezone,
       (u.target_kcal IS NOT NULL) AS has_targets,
       l.log_count, l.first_log, l.last_log,
       a.ai_calls, a.last_ai_call
FROM users u
LEFT JOIN (
  SELECT user_id, count(*) AS log_count,
         min(logged_at) AS first_log, max(logged_at) AS last_log
  FROM food_logs GROUP BY user_id
) l ON l.user_id = u.id
LEFT JOIN (
  SELECT user_id, count(*) AS ai_calls, max(created_at) AS last_ai_call
  FROM ai_usage_events GROUP BY user_id
) a ON a.user_id = u.id
ORDER BY u.created_at DESC;
```

Two rules inherited from `docs/ai-usage-queries.md`:

- **`outcome = 'ok'` is deliberately NOT applied.** Filtering it would erase the
  "tried and failed" cohort, which is currently 1 of 6 users and the single most
  actionable row on the page.
- **One user action can be several rows** when a fallback leg is abandoned. This
  is a count of *calls*, not captures, and the column says so.

### Summary strip

The actual deliverable. Today: `6 users · 6 onboarded (100%) · 2 ever logged
(33%) · 1 tried but never logged`.

**No "Active 7d" figure.** With 3 food logs in the entire database it reads 0 or
1 and invites a conclusion the data cannot support. "Tried but never logged" —
`ai_usage_events` rows but no `food_logs` — replaces it, and is the cohort that
pairs with the failed-capture explorer if that is ever built.

### "Last write" is named for what it measures

Kora records no session or app-open event. A user who opens the app, reads their
diary and closes it writes no row and reads as inactive.

The visibility spec's instruction was "do not invent a proxy; label the column
for what it measures". So the column is **Last write**, not "Last seen" or "Last
active". With `food_logs` at 3 rows it is near-useless today and becomes
meaningful only once logging does.

### No pagination, no search

Correct for 6 users, wrong for 6,000. The threshold is genuinely unknown and is
not invented here. Revisit when the list stops fitting on a screen.

## Detail panel

Counts only. Never a user's actual meals.

Shows: per-table row counts, and the two consequences of deletion that a count
alone does not reveal —

- **which groups transfer ownership, and to whom**, and
- **whether an Apple refresh token will be revoked**.

A full detail view showing the user's logged meals and AI failures would be more
diagnostic for "why did this person never activate", and is the natural next
click. It is **out of scope**: it shows one named person's meal history to an
operator, which is a materially bigger privacy step than a list of counts, and
it is not needed for either job this surface exists to do.

## PII

Adopted from the visibility spec, with its one open question now decided.

**Not shown at all:** `sex`, `birth_year`, `height_cm`, `weight_kg`, `goal`, and
the four `target_*` values. This is health data about a named person. It is not
needed to answer "did activation happen", and a page that shows it turns an
operational surface into a health-records browser. The one legitimate
operational question — *do they have targets at all?* — is a boolean.

**Not shown:** `firebase_uid` (an auth-provider identifier with no operational
use), `apple_refresh_token` (a credential).

**Shown: `email`. Decided yes.** Two arguments carried it. With six beta users
the operator *is* the person who would email them, and "which of these six is
stuck" is unanswerable if every row is a UUID. Decisively: **delete is
irreversible**, and confirming an irreversible destruction against a UUID prefix
invites destroying the wrong person. `display_name` is user-supplied,
non-unique, and was empty for Google users until #121 seeded it — it cannot
carry a confirmation.

Per the visibility spec's instruction, this decision **applies to the
failed-capture explorer's user column too**. Decided once, here.

**Also shown:** `display_name`, `created_at`, `onboarded_at`, `timezone`.
Timezone is not personal in any meaningful sense and is load-bearing — every
day-boundary calculation in Kora depends on it, so a wrong timezone is a support
answer.

**No export.** No CSV, no copy-all. The page is for looking at; an export button
is how a beta user list becomes a file on someone's laptop.

**Reads are not audited — recorded as a decision, not an omission.**
`kora_admin_events` covers mutations, written in the same transaction as the
write. No read-auditing mechanism exists, and building one for a six-user beta
is premature. Because `email` is now shown, this is a real and deliberate
exposure. The **delete is a mutation and is audited.**

**Never Prometheus.** The Kora exporter carries no `user_id` label by design —
cardinality on a Managed Prometheus bill scales with the user base. Per-user
questions are not degraded there, they are **underivable**. `ai_usage_events` is
and remains authoritative for anything per-user. (Doubly moot: the entire
`monitoring` namespace is scaled to zero replicas as of 2026-08-08.)

## The deletion engine

**One service, two callers.**

```go
// api/internal/user/
func (s Service) Delete(ctx context.Context, userID uuid.UUID, actor Actor) (DeleteResult, error)
```

`DELETE /admin/users/:id` calls it with the admin identity from the BFF.
`DELETE /v1/me` calls it with `actor = self`. There is exactly one cascade and
one set of cascade tests. Building an admin-only deletion beside #106's
self-deletion would mean two implementations of an 18-table cascade, which is
the failure this structure exists to prevent.

### Sequence

Implements #106's designed order, whose rationale is adopted unchanged:

1. **Transfer group and challenge ownership.** Must be first — once the cascade
   fires the groups are already gone. Ownership passes to the member with the
   earliest `group_members.joined_at`; a group where they are the only member
   cascades away. Same rule for challenges.
2. **Revoke the Apple refresh token.** Before the DB delete, because the token
   lives on the `users` row. **Non-fatal** — if Apple is unreachable, log and
   continue. Blocking deletion on a third-party outage would break the one thing
   Apple actually requires: that deletion completes in-app.
3. **`DELETE FROM users WHERE id = ?`** — one statement, 18 cascades. On
   failure, abort and touch nothing else. Fully retryable.

   **The 18, verified against the live schema on 2026-08-08** — every FK
   referencing `users(id)`, all currently `ON DELETE CASCADE`:

   `ai_usage_events`, `challenge_participants`, `challenges` (creator_id),
   `coach_turns`, `device_tokens`, `feedback`, `food_aliases`, `food_logs`,
   `friendships` (**two** — requester_id and addressee_id), `group_members`,
   `groups` (owner_id), `notifications` (**two** — user_id and actor_id),
   `pins`, `saved_meals`, `water_entries`, `weight_entries`.

   Transitive children cascade behind these: `coach_turn_citations` off
   `coach_turns`, `saved_meal_items` off `saved_meals`.

   Two of these deserve attention rather than a glance. `friendships` and
   `notifications` each reference `users` **twice**, so a deleted user is
   reachable as the *other* party — a test that only seeds the survivor as
   `requester_id` will miss rows where they are the `addressee_id`.
4. **Evict the user's Redis cache entries.** See Divergence 2. Non-fatal.
5. **Delete the Firebase identity** via the Admin SDK.

### Why the DB delete precedes the Firebase delete

#106's load-bearing decision, restated because it must not be "tidied" later.

If Firebase deletion fails *after* the DB delete, the personal data is already
gone. The identity lingers, so the user can sign in and `EnsureUser` provisions
a fresh, empty row. Momentarily confusing, harmless, and **self-healing**.

Reverse the order and the failure is far worse: delete the Firebase identity
first, fail the DB delete, and the user can never sign in again — so nobody can
retry, and their personal data sits in the database forever with no owner and no
trigger to remove it. Orphaned personal data with no recovery path is precisely
what deletion exists to prevent.

### Audit

`kora_admin_events` gets a row for **admin** deletions, written in the same
transaction as the delete, matching the food-data design.

**Verified against the live schema on 2026-08-08:** `kora_admin_events` has
**no foreign keys at all** — `target_id` is a plain nullable `uuid`. So #106's
requirement that deletion must not cascade the audit away holds by construction,
not by luck. The row survives the user it describes, and carries no PII beyond
`target_id` plus the acting admin's own identity.

**Self-deletion writes no `kora_admin_events` row.** It is not an admin action,
and that table is scoped to admin actions. It is logged.

### Divergence 1 — a Firebase failure must not be silent for an admin

#106 returns **204** when Firebase deletion fails, and for self-deletion that is
right: from the user's perspective their data genuinely is gone, and the path
self-heals when they delete again.

**That story does not exist for an admin caller.** The admin cannot retry
through the user. The identity lingers, the user signs in, `EnsureUser`
provisions a fresh row, and the person the admin deleted **reappears** — while
the admin was told it succeeded.

So the two callers report differently:

- `DELETE /v1/me` → **204**, unchanged from #106.
- `DELETE /admin/users/:id` → **200** with
  `{"firebase_identity_removed": false}` when the identity survived. The
  deletion still succeeded; the admin is simply not lied to. The portal renders
  a warning naming the cleanup.

### Divergence 2 — evict the Redis cache

#106's spec does not mention Redis, cache or eviction anywhere. Meanwhile
`ai.CacheKey(kind, userID, value)` produces per-user entries under three
prefixes — `phrase:`, `photo:`, `voice:` — and the cached **values** are that
user's own food resolutions and nutrition numbers.

Left alone, those entries outlive "deletion" until their TTL expires. For a
feature whose entire purpose is removing a person's data, that is a correctness
gap rather than a cosmetic one.

**Added to the sequence:** `SCAN` + `DEL` over `phrase:<uuid>:*`,
`photo:<uuid>:*` and `voice:<uuid>:*` after the DB delete. **Non-fatal** — a
Redis outage must never block a deletion Apple mandates completes in-app. The
cache already treats a `Delete` failure as never fatal, so this matches existing
behaviour.

Practically this is a no-op today: Redis is unreachable in prod (#105 — the pod
dials `127.0.0.1:6379` for a sidecar that is not in the Deployment). That is a
reason to write it now, not to omit it.

## Why not suspend

Phase 1 scoped Phase 3 as "list/inspect/**suspend** accounts". Suspend is
dropped by decision.

- Nobody has needed it. Six users, zero support requests of that kind.
- Delete covers the actual ask.
- It is not one column. It needs `users.status`, enforcement in
  `ResolveMiddleware` (the one chokepoint every authenticated request passes),
  Redis eviction, an un-suspend path, and **a mobile screen that does not
  exist** — the app has no state for "authenticated but rejected", so a
  suspended user would see generic errors.
- The alternative mechanism, disabling the Firebase identity via the Admin SDK,
  blocks token minting at the source with no Kora schema change — but the state
  then lives outside Kora's database, invisible to any SQL and requiring the
  portal to read Firebase to display it.

If suspend is ever needed, the Firebase-identity route is the cheaper of the two
and should be re-evaluated on its own.

## Error handling

- **BFF unreachable / misconfigured** — the page renders the same explicit
  `not_configured` / status-code error the food index uses. Never an empty table
  that reads as "no users".
- **`GET /admin/users/:id` on an unknown id** — 404, rendered as "user not
  found", not an empty panel.
- **Delete on an already-deleted user** — 404. The list refreshes.
- **Apple revoke fails** — deletion proceeds; logged.
- **Redis eviction fails** — deletion proceeds; logged.
- **Firebase deletion fails** — deletion proceeds; `200` with
  `firebase_identity_removed: false`; portal shows a warning.
- **The DB delete itself fails** — 500, nothing else touched, safe to retry.

## Testing

**The cascade is verified by query, never by a 204.** A `204` proves the handler
returned, not that rows are gone.

Non-negotiable assertions:

- **Seed a SECOND user and assert their rows survive.** This is the specific
  mutation that matters: `DELETE FROM users` missing its `WHERE` clause passes
  every other assertion in the suite. Without a second user the test is green
  against a catastrophic bug.
- Every one of the 18 cascading tables asserted empty for the deleted user. The
  survivor is seeded in a **named subset** of those tables — at minimum
  `food_logs`, `ai_usage_events`, `group_members` and `weight_entries` — and
  each of those asserted **still populated** afterwards, so a cascade regression
  fails positively rather than by absence. Seeding all 18 is not required;
  seeding none is what makes the suite green against a missing `WHERE`.
- `ai_usage_events` rows **retained** with `user_id` set to NULL, per #106.
- Ownership transfer asserted by query in both directions: a group with another
  member transfers to the earliest `joined_at`; a solo group cascades away.
- The `kora_admin_events` row asserted **present after** the delete.
- Redis eviction asserted against a seeded key under each of the three prefixes.
- `DELETE /v1/me` and `DELETE /admin/users/:id` asserted to reach the **same**
  service — a test that pins one and not the other permits the two-cascade
  future this design exists to avoid.

### The environment trap this suite will hit

**Go repository tests SKIP silently without `TEST_DATABASE_URL`.** They do not
fail; `go test` still prints `ok`. A bare `go test ./...` looks green while
never touching a single DB path. This produced a false "the mutation passed"
result on 2026-08-07.

Every task in the implementation plan must export it and **confirm the test
count rose**, not merely that the suite was green:

```
export TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'
```

CI is unaffected — `.github/workflows/ci.yml` runs a postgres service and sets
it.

## Out of scope

- **Suspend, edit, reset, impersonate.** See above.
- **A user's actual food logs in the detail view.** Counts only.
- **Body metrics and target values.** Booleans only.
- **Export in any form.**
- **Read auditing.** Decided against; revisit deliberately.
- **Pagination, search, cohort retention curves.** Six users.
- **Friends, groups and competitions as a browsable surface.** Ownership
  transfer touches groups only as a deletion consequence.
- **Analytics/session instrumentation.** Kora has none; adding it is a different
  project with its own privacy questions.

## Dependencies

- **The signed BFF** — already in production. No new secret, no new middleware.
- **Phase 1 nav plumbing** — `ProductConfig`, the `kora` route group, and the
  hand-written `koraNav` in `components/admin/sidebar.tsx`. Adding a product
  page is **not** config-only, whatever `lib/products/types.ts:2-3` says.
- **#106 slice 1** — shipped. `users.apple_refresh_token` exists and is
  populated for Apple users created after it landed.
- **Migration** — `ai_usage_events.user_id` must drop `NOT NULL` and its FK
  become `ON DELETE SET NULL`, per #106. This is the one schema change and it
  belongs to the deletion engine.

  **Confirmed necessary, not assumed:** the live constraint today is
  `ai_usage_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON
  DELETE CASCADE`, and `user_id` is `NOT NULL`. Without this migration, #106's
  decision to *retain* `ai_usage_events` is silently violated — the rows are
  deleted with the user and the "tried and failed" signal is destroyed along
  with them.

## Relationship to #106

This design **delivers #106 slice 2's server half in full**: the deletion
service, the cascade, ownership transfer, Apple revocation, Firebase identity
removal, and `DELETE /v1/me`.

After this ships, **#106 slice 2 is the mobile Settings UI and confirmation
screen only.** Its issue should be updated to say so, or the two will be
estimated as though the server work were still ahead.
