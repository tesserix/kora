# Design — Kora user visibility

Date: 2026-08-05. Touches `kora` (one admin endpoint) and `tesserix-home` (one
page). Follows `2026-08-05-kora-admin-surface-design.md` and depends on slice 1
of `2026-08-05-kora-food-data-admin-design.md`.

**Status: scoped, NOT designed with the user.** Unlike the food-data and
AI-key designs, no decision here was made in conversation. The numbers below
were measured against prod on 2026-08-05; everything else is a proposal, and
the open questions at the end are genuinely open.

**This is user *visibility*, not user *management*.** No suspend, no delete, no
edit. That distinction is the whole scoping decision and is defended below.

## Purpose

Make the activation funnel visible. One measurement is the entire motivation:

> **6 users. 6 onboarded. 6 with targets. Only 2 have EVER logged a meal.**
> Newest signup 2026-08-01.

Onboarding completes. Activation does not. A third of the people who finished
setup have used the product for its one purpose, and that number is invisible
today — it took a hand-written SQL query against prod to learn it.

That is the number this page exists to show, and it is directly the R1 bar:
**"someone who isn't you can onboard and log unaided."** Six people cleared the
first half of that sentence and four did not clear the second. Whether they hit
the photo-capture failures (#82 → #79 → #87, all of which presented as an
identical detail-free 500), lost interest, or never opened the app again is not
answerable from this page alone — but *that the drop-off exists* has to be
visible before anyone will go looking.

**Six users is a small number and that is the point.** This surface is not
built for scale; it is built because at this scale every single user is a
signal, and losing four of six is the most important fact about the product
right now.

## What it shows

One row per user, most recent signup first:

| Column | Source | Why |
|---|---|---|
| Signed up | `users.created_at` | Cohort |
| Onboarded | `users.onboarded_at` | **NULL means they dropped out mid-onboarding** |
| Ever logged | derived: any `food_logs` row | The activation bit |
| First log | `min(food_logs.logged_at)` | Time-to-first-value |
| Last activity | derived, see below | Retention |
| Logs | `count(food_logs)` | Depth |
| AI calls | `count(ai_usage_events)` | Did they *try*? |
| Timezone | `users.timezone` | Everything day-bounded depends on it |

Plus a summary strip above the table, which is the actual deliverable:

```
Users 6 · Onboarded 6 (100%) · Ever logged 2 (33%) · Active 7d …
```

### `onboarded_at IS NULL` is the drop-out signal

`users.onboarded_at` is **nullable**, so "did they finish onboarding?" is
directly answerable with no inference. NULL means they created an account and
never completed setup.

Today that count is **zero** — all six users are onboarded. The column earns
its place on the page anyway, because it is the one funnel stage that *is*
cleanly answerable from stored data, and because a stale-profile-cache bug has
previously trapped fresh accounts back on step 1 after they finished. If that
recurs, this column is where it shows up.

### "Ever logged" and "tried but never logged" are different rows

The most valuable distinction on the page is between:

- **Never tried** — no `food_logs`, no `ai_usage_events`. They stopped after
  onboarding.
- **Tried and failed** — `ai_usage_events` rows, no `food_logs`. They attempted
  a capture and got nothing out of it.

The second cohort is the one worth chasing, and it is the cohort that three
stacked capture bugs would have produced. `ai_usage_events.user_id` is **NOT
NULL**, so this is a plain join and needs no new instrumentation.

Cross-reference: pair a user in that cohort with the failed-capture explorer
and you have their actual failures, by call type and latency. That pairing is
the reason both surfaces are worth building and neither is worth building
alone.

### "Last activity" needs a definition, and it is a weak one

Proposed: `max(food_logs.logged_at, ai_usage_events.created_at)` per user.

Be honest about what that misses. It does not see a user who opened the app,
looked at their diary, and closed it — Kora records no session or
app-open event, so "last activity" here means "last thing that wrote a row",
not "last time they used the product". A user who checks their progress daily
and logs nothing reads as inactive. With `food_logs` at **3 rows total** this
column is currently near-useless; it becomes meaningful only once logging does.

Do not invent a proxy. Label the column for what it measures.

## PII: what is shown, and what deliberately is not

`users` carries more than identity. The full column set is:

```
id, firebase_uid, email, display_name, created_at, updated_at,
sex, birth_year, height_cm, weight_kg, activity_level, goal,
target_kcal, target_protein_g, target_carbs_g, target_fat_g,
onboarded_at, timezone, friend_code, share_progress
```

**Proposed treatment, by category:**

- **Not shown at all: `sex`, `birth_year`, `height_cm`, `weight_kg`, `goal`,
  and the four `target_*` columns.** This is health data about a named person.
  It is not needed to answer "did activation happen", which is the entire
  purpose of the page, and a page that shows it turns an operational surface
  into a health-records browser. The one legitimate operational question about
  these columns — *"do they have targets at all?"* — is answerable as a boolean
  (`target_kcal IS NOT NULL`) without displaying the value. Show the boolean.
- **Not shown: `firebase_uid`.** An auth-provider identifier with no
  operational use on this page.
- **Shown: `email`.** This is the one deliberate PII exposure, and it is
  proposed rather than decided. The argument for it: with six beta users, the
  operator *is* the person who would email them, and "which of these six is
  stuck" is unanswerable if every row is a UUID. The argument against: nothing
  on this page strictly requires it, and `display_name` plus a short id prefix
  would identify a row for support purposes without putting an address list
  behind a portal login. See open questions.
- **Shown: `timezone`.** Not personal in any meaningful sense, and load-bearing
  — every day-boundary calculation in Kora depends on it, so a user whose
  timezone is wrong will see a wrong diary, and that is a support answer.
- **Shown: `display_name`, `created_at`, `onboarded_at`.**

**No export.** No CSV, no copy-all. The page is for looking at, and an export
button is how a beta user list becomes a file on someone's laptop.

**Reads are not audited** in this proposal, because the food-data design audits
*mutations* (`kora_admin_events`, written in the same transaction as the write)
and this surface has none. If read auditing is wanted for the PII, it is a
different mechanism and should be decided explicitly rather than assumed.

## Explicitly not user management

The Phase 1 design scoped Phase 3 as "list/inspect/**suspend** accounts". This
design deliberately takes the first two and leaves the third.

The reason is not squeamishness, it is that **writes are a materially larger
piece of work with a real correctness hazard**, and none of the value above
needs them:

- Kora keeps a **Redis resolve cache keyed by user** (`CacheKey("voice",
  userID, …)`), and `foodlog` carries idempotency invariants the offline queue
  (#22) depends on. A user-scoped write that does not go through Kora's own
  eviction path leaves per-user cache entries stale with nothing to clear them.
- "Delete a user" in a product with `food_logs.food_item_id` foreign keys,
  friend codes, and an offline write queue holding client-minted ids is a
  cascade design, not a `DELETE`.
- Nobody has needed it. Six users, zero support requests of that kind.

Reads over the signed BFF are a `GET` and a query. Writes are a project. Ship
the reads.

If a write is ever needed, the food-data design already establishes the path:
it goes through kora-api's BFF, with a `kora_admin_events` audit row written in
the same transaction. There is no second access path to build.

## Data source and access path

`users`, `food_logs` and `ai_usage_events`, read through **kora-api's signed
BFF** — slice 1 of the food-data admin design. **Hard dependency:** the portal
holds `MARK8LY_DB_*` and `HOMECHEF_DB_*` credentials and has **no Kora database
access at all**, and the food-data design deliberately keeps that true.

**Not a Prometheus surface, ever.** The Kora exporter carries **no `user_id`
label by design** — cardinality on a Managed Prometheus bill scales with the
user base. Per-user questions are not degraded there, they are not derivable.
Separately, Managed Prometheus is **not enabled on the cluster**
(`managedPrometheusConfig: {}`), so nothing `kora_*` is being scraped at all
today. `ai_usage_events` is and stays authoritative for anything per-user.

### The query

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

Two rules inherited from `docs/ai-usage-queries.md` apply to the `ai_calls`
column specifically:

- It is a **product** question ("did this user get value?"), so it should
  filter `outcome = 'ok'` — *except* that the "tried and failed" cohort above is
  precisely the case where you want the unfiltered count. **Show both**, or
  show the unfiltered count and label it "AI calls attempted". Do not show one
  number and leave which it is to the reader.
- **One user action can be several rows** when a fallback leg is abandoned, so
  this column is a count of *calls*, not of *captures*. Label it as calls.

## Dependencies

- **Slice 1 of the food-data admin design.** Hard.
- **Phase 1 nav plumbing** — `ProductConfig`, the `kora` route group, and the
  hand-written `koraNav` in `components/admin/sidebar.tsx`. Adding a product is
  not config-only, whatever `lib/products/types.ts:2-3` says.
- Nothing from Prometheus, by design.

## Out of scope

- **Every write.** Suspend, delete, edit, reset, impersonate. See above.
- **Body metrics and targets as values.** Booleans only.
- **Cohort retention curves.** Six users; a curve would be a drawing, not a
  measurement. Revisit at a population where a percentage means something.
- **Analytics events.** There is no session or screen-view instrumentation in
  Kora, and adding one is a different project with its own privacy questions.
- **Editing a user's `food_logs`.** A user's own history is not an admin
  surface — the food-data design already excludes this.
- **Friends, groups, competitions.** Social data is a separate surface if it is
  ever needed.

## Open questions

1. **Is `email` shown?** Proposed yes, argued both ways above. This is the one
   decision on the page that is genuinely a values call rather than a technical
   one, and it should be made explicitly. Whatever is decided applies to the
   failed-capture explorer's user column too — decide once.
2. **Are reads audited?** No mechanism exists for read auditing today
   (`kora_admin_events` covers mutations). Building one for a six-user beta may
   be premature; assuming it away silently is worse.
3. **What does "active" mean in the summary strip?** "Logged in the last 7
   days" is the only honest definition available, and with 3 total logs it will
   read 0 or 1 for a while. An alternative is to omit the strip's activity
   figure until logging volume makes it meaningful.
4. **Should a user detail view exist at all?** A per-user page (their logs,
   their AI calls, their failures) is the natural next click and would make the
   "tried and failed" cohort actionable — but it necessarily shows one person's
   meal history to an operator, which is a bigger privacy step than a list.
   Not proposed here.
5. **When does this stop being useful in this form?** A flat list is right for
   six users and wrong for six thousand. No pagination or search is proposed;
   both become necessary at some unknown point.
6. **Does the drop-off have a cause we could show?** If a "tried and failed"
   user's failures were joinable to their captures, the page could say *why*
   they never logged. That needs the failed-capture explorer and, to be
   genuinely useful, the error column that design proposes.
