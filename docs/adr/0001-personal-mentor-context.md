# ADR 0001: Personal mentor context and commitments

## Status

Accepted for the first production slice.

## Context

Kora already grounds coaching in the authenticated user's food logs, usual foods,
targets, and weight trend. Apple Health steps, sleep, and workouts are read only on
the device, while reminders are device-local schedules that agents cannot inspect.
The result is a capable nutrition chat without a shared, user-controlled model of
preferences, Health patterns, or commitments.

The planning envelope is 100,000 daily users, ten health/commitment events per active
user per day, and a 10x diurnal peak: about 1 million rows/day, 12 average writes/s,
and 120 peak writes/s. Payloads remain below 16 KiB. Normal context reads target
99.9% monthly availability and p99 below 300 ms. Agent generation is a degradable
dependency with its existing independent timeout and direct-provider fallback.

The sensitive assets are dietary history, Health aggregates, routines, commitments,
and conversations. Trust crosses from HealthKit to the mobile app, from the app to
the authenticated API, and from the API to a registry-selected agent. Another user,
an unauthenticated caller, a compromised dependency, or an insider must not gain
access to another person's context.

## Decision

Keep the feature in the existing Go modular monolith and Postgres database.

- `mentor_profiles` stores user-confirmed preferences, coaching style, quiet hours,
  and independent consent switches. One row belongs to one authenticated user.
- `health_daily_summaries` stores consented local-day aggregates only. Raw HealthKit
  samples never leave the device. `(user_id, local_date)` is the idempotent identity.
- `mentor_commitments` stores user-approved recurring actions. Server state is
  canonical; the mobile app projects active schedules into local notifications.
- `mentor_check_ins` stores retry-safe actions such as done, skipped, or snoozed.
- `mentor_commitment_proposals` stores one validated, Nutrition Coach-reviewed
  machine proposal beside the Coach turn that produced it. A proposal is inert
  until its owner explicitly accepts it.
- Every row cascades from `users`. Repository reads and writes include `user_id` in
  the query. A well-formed identifier owned by another user returns 404.
- PUT is used for replace/upsert mutations. Client-generated commitment IDs and the
  `(commitment_id, scheduled_for)` check-in identity make retries converge on the
  same logical outcome.
- Coach grounding receives a bounded summary: current preferences, the latest seven
  Health days, and active commitments. It never receives raw samples or unbounded
  histories. Planner output is untrusted. Only a bounded `KORA_COMMITMENT` block
  that survives Nutrition Coach review and server validation becomes a stored
  proposal; the block is removed from user-visible chat text.
- Accepting a proposal locks its owner-scoped row, creates one active commitment,
  records the accepted commitment ID, and returns that commitment on retries.
  Agent output never activates a notification.
- HealthKit remains optional. Denial, revocation, unsupported platforms, or sync
  failure removes Health facts from coaching without disabling food coaching.
- Notification scheduling remains on-device. Open-ended schedules use recurring
  daily or weekly calendar triggers; future or finite schedules use bounded date
  projections refreshed on launch and foreground.
- Notification actions first enter a bounded per-account device outbox and then
  call the idempotent check-in API. It stores only commitment ID, occurrence
  time/date, action, and optional snooze time—not private profile or Health content.

The initial API is additive under `/v1/mentor`:

- `GET|PUT /profile`
- `PUT|DELETE /health/days` and `GET /health/days?from=YYYY-MM-DD`
- `GET /commitments`
- `PUT /commitments/:id`
- `PUT /commitments/:id/check-ins`
- `PUT /proposals/:id/accept`

## Consistency and failure behaviour

Profile and commitment writes are strongly consistent. Health reads may be seconds
stale after an offline sync. Local notification projection is eventually consistent
with the server and is rebuilt on successful fetch, launch, foreground, and account
switch.

- Postgres unavailable: writes fail without changing the local projection; the last
  scheduled reminders remain armed.
- HealthKit unavailable or denied: no fabricated zero values are uploaded.
- Agent registry/gateway unavailable: existing fallback answers from the same bounded
  context; commitments remain usable without AI.
- Notification permission denied: commitments remain visible and checkable in Kora;
  the UI reports that OS reminders are off.
- A request times out or is delivered twice: PUT plus unique identities converges on
  the same row.
- A notification action happens offline: its owner-scoped outbox retries on
  reconnect, launch, and foreground. Permanent 4xx rejections are removed rather
  than retried forever.
- The app crashes after a server write but before scheduling: foreground
  reconciliation repairs the projection.
- An agent emits malformed, unknown, restrictive, or out-of-range proposal data:
  Kora strips the machine block and returns no actionable proposal.

## Rollout and rollback

Migrations 000040 and 000041 are expand-only: new tables, foreign keys, checks, and
indexes. Old clients ignore the new routes and continue working. Deploy migrations,
API, then mobile client. API rollback leaves unused tables. The down paths drop only
the new tables and are destructive, so they are for non-production rollback before
real mentor data exists.

## Consequences

Postgres grows by roughly 365 million event rows over 36 months at the full planning
envelope; check-ins and Health days need retention and partitioning only when measured
volume approaches that envelope. The first release needs no cache, queue, Temporal,
or service split. If Kora later sends server-timed adaptive pushes while the app is
terminated, that wall-clock workflow requires a durable scheduler and transactional
outbox rather than extending the local projection ad hoc.

Rejected alternatives:

- Raw HealthKit upload: unnecessary privacy and retention risk.
- Device-only commitments: agents cannot reliably understand or review them.
- A new mentor microservice: no separate data owner or scaling profile justifies the
  operational cost.
- Agents writing reminders directly: removes meaningful user consent and makes agent
  retries externally destructive.
- A background notification service: recurring OS calendar triggers and a small
  retry outbox meet the current reliability target without another service,
  datastore, or native dependency.
