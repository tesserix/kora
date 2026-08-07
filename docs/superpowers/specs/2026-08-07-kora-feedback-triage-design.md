# Design — Kora feedback triage in the admin portal

Date: 2026-08-07. Touches `kora` (two admin endpoints, no migration) and
`tesserix-home` (one page, one client function, one rail entry).

Follows `2026-08-05-kora-admin-surface-design.md`. Unlike Phases 2–4 of that
document, this is **not** one of its scoped phases — it is a new surface, added
because R1 is a friends-and-family beta whose entire point is collecting
feedback, and today nothing can read it.

## The problem

`apps/mobile/app/feedback.tsx` posts to `POST /v1/feedback`. The handler stores
the row. **That is the end of the story** — `api/internal/feedback` has only
`Create`, there is no list endpoint, and nothing has ever read the `feedback`
table.

So a beta tester's bug report goes into Postgres and is seen by nobody. For a
release whose success criterion is "a friend can onboard unaided", that is the
one feedback loop that cannot be missing.

## What already exists — build on it, do not redesign it

The 2026-08-05 work anticipated this feature precisely. Nothing here needs a
migration or a schema change.

**`feedback` table** (migration `000019_feedback`): `id`, `user_id`, `kind`,
`subject`, `description`, `status`, `app_version`, `platform`, `os_version`,
`device_model`, `created_at`. It carries `ix_feedback_status_created` — an
index on `(status, created_at)` that **has never been used by any query**,
because nothing filters by status yet. This design is what makes it earn its
keep.

**`Kind`** (`model.go`): `bug` | `feature`, with `Kind.Valid()`.

**`Status`** (`model.go`): `open` | `in_progress` | `resolved` | `closed`, with
`Status.Valid()`. The lifecycle mirrors mark8ly's marketplace-api ticket
contract deliberately, and the model's own comment states the intent:

> Kora only ever WRITES StatusOpen — the other values exist so the column can
> express the full lifecycle once an admin integration can triage feedback.

**This design MUST reuse `Status.Valid()` and the existing four values.** Do
not invent a new status set. An earlier draft of this design proposed
`open/acknowledged/closed`; that was wrong, and would have split Kora's
lifecycle away from the mark8ly contract the column was named after.

**The admin transport** is settled: `tesserix-home` calls kora-api over
`bffauth` — an HMAC-signed `X-Internal-Auth` header computed in
`apps/web/lib/api/kora-admin.ts`, mirroring `api/internal/bffauth/bffauth.go`.
Admin reads live under `r.Group("/v1/admin", bffauth.Middleware(...))`
(`api/internal/server/router.go:147`), alongside `/v1/admin/foods` and
`/v1/admin/events`.

## Scope

**Read and triage. Not replies.**

Replies were considered and rejected. They would require a thread table, a
delivery channel to reach the user (push or email), and a notion of who is
answering — turning a capture table into a support console. The migration
comment is explicit that this table is capture-only, "no reply thread". If
Kora ever needs a support console, it should adopt mark8ly's ticket service
rather than grow one inside the feedback table.

## API — two endpoints

Both in `api/internal/feedback`, both registered on the existing
`/v1/admin` bffauth group.

### `GET /v1/admin/feedback`

Query parameters, all optional:

| Param | Values | Default |
|---|---|---|
| `status` | one of the four `Status` values | unset — all statuses |
| `kind` | `bug` \| `feature` | unset — both |
| `limit` | 1–100 | 50 |
| `offset` | ≥ 0 | 0 |

An invalid `status` or `kind` is a **400**, not a silently-ignored filter. A
filter that quietly does nothing is worse than an error: the operator believes
they are looking at a filtered list and are not.

Ordered `created_at DESC`. This, with a `status` filter, is what finally uses
`ix_feedback_status_created`.

Response: the feedback rows plus a `total` for pagination, and — per row — the
submitter's `email` and `display_name`.

**The join is the point.** The table deliberately stores no submitter identity
beyond `user_id`, so a row on its own is unactionable: you cannot tell whether
"it crashed" came from a tester you can ask or from someone you cannot reach.
`users` is joined read-only for `email` and `display_name`. Note
`display_name` may be empty for users created before the name-seeding fix, so
the page must tolerate a blank name and fall back to email.

### `PATCH /v1/admin/feedback/:id`

Body: `{"status": "<one of the four>"}`. Nothing else is mutable — subject,
description, kind and device context are the user's words and must never be
edited by an operator.

Validation uses `Status.Valid()`. An unrecognised value is a 400; a valid value
for a missing id is a 404.

Returns the updated row so the page can re-render from the response rather
than refetching the list.

## Admin page

`tesserix-home`: `apps/web/app/admin/apps/kora/feedback/page.tsx`, plus
client functions in the existing `apps/web/lib/api/kora-admin.ts` (reusing its
HMAC signer — no new transport code), plus one `koraNav` entry.

Nav order: Overview, Food index, Audit trail, **Feedback**. It goes last
because it is the newest surface, and because the rail is scanned top-down by
frequency of use.

The page shows a filterable list: status and kind filters, newest first, each
row showing subject, kind, submitter, age, and a status control. The
description expands in place — bug reports run long and truncating them at the
row loses the actual report. Device context (`app_version`, `platform`,
`os_version`, `device_model`) is shown with the expanded description, since
that is what turns "it crashed" into something reproducible.

Default filter on load: **`status=open`**. The operator's question on opening
this page is "what needs my attention", not "what has ever been submitted".

### Rail-containment rule

`tesserix-home#75` removed a `koraNav` entry that pointed at a platform page,
and added a test asserting every Kora rail entry matches
`^/admin/apps/kora(/|$)`. The new Feedback entry must satisfy it. That test is
the guard, not a convention to remember.

## Testing

Per the project's binding rule — *an assertion whose expected value equals the
initial state cannot distinguish "it worked" from "nothing ran"* — every
absence assertion reaches a state where a wrong implementation produces a
presence.

**API:**
- List returns rows newest-first. Seed two rows with distinct `created_at`,
  assert the order — a single-row fixture proves nothing about ordering.
- `status` filter genuinely filters: seed one `open` and one `resolved`, assert
  the filtered call returns exactly one, and that the unfiltered call returns
  both. The unfiltered assertion is the counterweight; without it a repository
  that returns nothing at all would pass.
- Same shape for `kind`.
- Invalid `status` and invalid `kind` each return 400, not 200-with-all-rows.
- Pagination: `limit`/`offset` slice correctly, and `total` reflects the
  **unpaginated** count — a `total` that equals `len(rows)` is the classic
  pagination bug and must be asserted against.
- PATCH sets status and returns the updated row; an unrecognised status is 400;
  an unknown id is 404.
- PATCH does **not** alter subject/description/kind — assert they survive
  unchanged, having first asserted the status *did* change in the same test,
  so this is immutability rather than a no-op handler.
- The join surfaces email, and tolerates an empty `display_name`.

**Mutation steps.** Replace `Status.Valid()` with an always-true check: exactly
the invalid-status test must fail. Drop the `status` filter from the query:
exactly the status-filter test must fail while the unfiltered test stays green.
If either mutation reddens more than its named test, it proved nothing.

**Admin page:** the existing `configs.test.ts` rail-containment test covers the
nav entry. Page tests follow whatever `foods`/`audit` already do — read them
first rather than inventing a pattern.

## Out of scope

- Replies, notifications, ticket numbers, assignees, attachments.
- Editing user-authored fields.
- Deleting feedback. `ON DELETE CASCADE` from `users` already removes it with
  the account, which is the only deletion path #106 needs.
- Any change to `apps/mobile`. The capture side works; this is the read side.
- Bulk status changes. Worth revisiting only if the beta produces enough volume
  to make one-at-a-time painful, which is not knowable yet.
