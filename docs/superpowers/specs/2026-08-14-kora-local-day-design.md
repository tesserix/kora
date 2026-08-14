# Local day per log — design

**Issue:** kora#84 — client asks for a device-local day while the server buckets by profile timezone.

**Status:** design, awaiting review.

## The problem is bigger than the issue states

kora#84 frames this as travellers and stale profile zones. The real scope is wider.

- `api/internal/onboarding/calc.go:13` — the onboarding API **accepts** a `timezone`.
- `apps/mobile/src/api/types.ts` — `OnboardingInput` **has no `timezone` field**, and no code in `apps/mobile/src` sends one.
- `api/internal/user/repository.go:26` and `api/internal/onboarding/handler.go:41` — so every account falls back to `DefaultTimezone = "Australia/Sydney"`.

Verified in production on 2026-08-14: `select timezone, count(*) from users group by timezone` returns `Australia/Sydney | 8` — every row.

So no Kora user has ever had a correct timezone unless they live in Sydney. A London user's day boundary is wrong from signup, every single day, without going anywhere. Nobody is harmed today only because the current userbase is the developer.

## Why the cheap fix is not enough

Adding `timezone` to the onboarding payload fixes provisioning, but the day boundary would still be computed from a *mutable profile field* at query time. `food_logs` stores only `logged_at timestamptz`, and `ListByUserAndDay` derives boundaries in the **current** profile zone — so changing that zone silently re-buckets all history. Fly Sydney → London, and yesterday's dinner moves to a different day retroactively.

A log's day is a fact about when it was eaten. It should be decided once, at capture, and never move.

## Design

Store the local calendar date on each row at write time, and query by it directly.

### Schema

Migration `000032_local_day`, adding to **three** tables — `food_logs`, `water_entries`, `weight_entries`:

```sql
ALTER TABLE food_logs ADD COLUMN local_date DATE;
-- backfill, then:
ALTER TABLE food_logs ALTER COLUMN local_date SET NOT NULL;
CREATE INDEX idx_food_logs_user_local_date ON food_logs (user_id, local_date);
```

All three tables, not just `food_logs`: the dashboard summary combines food and water, so fixing one leaves that screen mixing a correct figure with a drifting one.

### Backfill

```sql
UPDATE food_logs fl SET local_date = (fl.logged_at AT TIME ZONE u.timezone)::date
FROM users u WHERE u.id = fl.user_id;
```

Every existing user is `Australia/Sydney` and every existing row was already bucketed that way, so this reproduces current behaviour exactly — **zero visible change to existing data**. That is what makes `NOT NULL` from day one safe, and it avoids carrying a nullable fallback path forever.

The backfill runs inside the migration. Row counts are small (prod `food_logs` is trivial today); this is not a batched-backfill situation, and pretending otherwise would add machinery for a problem that does not exist.

### Write path — the local date is client-supplied

`local_date` is sent by the client with each write, **not** computed server-side from a request timezone.

This is forced by the offline queue, not chosen. `apps/mobile/src/offline/queue.ts` persists a captured log and replays it on reconnect, possibly hours later and possibly in a different zone. A meal captured in London and replayed after landing in Sydney must keep **London's** date. A server computing the date on receipt would stamp the replay, silently filing the meal on the wrong day — the exact bug this work exists to remove, reintroduced through the back door.

Client sources it as `new Date().toLocaleDateString("en-CA")` at capture time, matching what `apps/mobile/app/(tabs)/diary.tsx:43` and `apps/mobile/src/offline/useQueuedLogs.ts` already do, so queued and server rows agree by construction rather than by coincidence.

### Validating client input

A client-supplied date is untrusted input. The server validates it against `logged_at`:

- must parse as `YYYY-MM-DD`
- must be within **±1 day** of `logged_at` evaluated in UTC

±1 day rather than an exact match because no single UTC date is "correct" — the whole point is that the local date legitimately differs from the UTC date by up to a day in either direction. Anything outside that window is not a timezone, it is a bad or hostile client, and is rejected with `invalid_input`.

**Absent** `local_date` is distinct from **invalid**: an older client that omits the field falls back to computing it from the profile zone, exactly as today. That keeps already-installed builds working rather than breaking every user who has not updated. The fallback is the compatibility path, not a second permanent code path — it can be removed once the floor build is enforced.

### Read path

Day-scoped queries filter on `local_date` and stop taking a `*time.Location`:

- `foodlog.Repository.ListByUserAndDay`
- `dashboard.Service.ForDay`
- `tracking.Repository.WaterTotalForDay`
- `foodlog.Service.CopyDay`

`user.LocFromContext` stays for the things that are genuinely "now" questions in the user's zone rather than "which day does this row belong to" questions — challenges start/end, coach, memory, streak and adherence windows in `compare` and `groups`. Those are a **separate concern** and deliberately out of scope here; conflating them is how this fix would sprawl.

### Onboarding timezone

Separately, and still worth doing: add `timezone` to `OnboardingInput` on the client and send `Intl.DateTimeFormat().resolvedOptions().timeZone`. The server already accepts it. This does not affect log bucketing once `local_date` lands, but the profile zone still drives the streak and challenge windows above, so leaving every user on Sydney would leave those wrong.

## What this does NOT fix

Streaks, adherence windows, challenge boundaries, coach and memory still resolve through the profile timezone and still drift for a user whose profile zone is wrong. The onboarding change above makes that right for new users; existing users need a way to update their zone, which is not in this scope.

Stating this explicitly so the issue is not closed as "timezone fixed" when a well-defined part of it remains.

## Testing

- **Migration:** backfill produces the same day buckets the current code produces, asserted against seeded rows in several zones — the property that makes `NOT NULL` safe.
- **Write path:** a create with a `local_date` that disagrees with the server's profile-zone computation persists the **client's** value. This is the test that fails if someone later "simplifies" it to server-side computation.
- **Offline replay:** a queued log carrying a London date, replayed while the device is in Sydney, lands on the London date. The regression this design exists to prevent.
- **Validation:** a date more than one day from `logged_at` is rejected; a date exactly one day off in either direction is accepted; an absent one falls back to the profile zone.
- **Read path:** logs are returned by `local_date`, and changing the user's profile timezone afterwards does **not** move them — the retroactive re-bucketing that motivated this design.

## Migration ordering note

Production `schema_migrations` is at **26** while the repo has up to `000031` — prod is five migrations behind. This work adds `000032`. The next deploy will therefore apply six migrations at once, which is also the first real exercise of kora#118's initContainer ordering against a migration-bearing deploy.

## Verified end to end, 2026-08-14

Against the running stack (dev API + iPhone 17 Pro simulator, migration `000032` applied):

**Backfill preserved existing buckets.** `local_date` equals `(logged_at AT TIME ZONE u.timezone)::date` for every pre-existing row — zero visible change, which is what made `NOT NULL` safe.

**A write round-trips the client's date.** Adding water from the app produced `POST /v1/water 201` and a row with `local_date = 2026-08-14`, the simulator's device date.

**The day does not move when the timezone changes.** The water row's stored day is the 14th, but under `Pacific/Kiritimati` (UTC+14) the old profile-zone logic computes the **15th** for the same `logged_at` — a genuine divergence, confirmed in SQL. With the profile switched to Kiritimati the diary still showed `0.3 L` and `190 kcal` on the 14th. Under the old code the water would have vanished from that day.

## Changes made during implementation that this design did not anticipate

- **A `CHECK (local_date > DATE '2000-01-01')` on all three tables.** `NOT NULL` alone does not protect the column: Go's zero `time.Time` marshals to `0001-01-01`, which Postgres accepts as a valid DATE. A writer that forgot the field would pass `NOT NULL` and store year 1, producing a row that matches no day query and is invisible forever. The CHECK makes that a failed write instead, and immediately caught direct-write paths in `admin`, `coach`, `memory`, `user`, `foodlog` and `tracking`.
- **`CopyDay` and `RepeatLog` needed the clone's day set explicitly.** Both clone a log and shift `LoggedAt`; without also setting `LocalDate` the clone inherits the SOURCE's day and lands invisible on the day the user asked for. Neither was in the original design.
- **`dashboard.ForDay` keeps its `*time.Location`.** Streaks remain profile-zone scoped per the "What this does NOT fix" section, so the parameter stays for that alone; only the log and water reads inside it dropped it.
- **A latent off-by-one in the summary's date label.** `ForDay` rendered `day.In(loc)`, but `day` is a calendar date at midnight UTC rather than an instant, so any negative-offset zone labelled the summary with the previous day. Now `day.Format(...)`.
