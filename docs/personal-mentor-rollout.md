# Personal Mentor rollout and team handoff

## What is ready

Kora now has one consent-controlled Personal Mentor context shared by Coach,
Nutrition Coach, and Meal Planner:

- confirmed motivation, dietary preferences, allergies, coaching style, quiet
  hours, and reminder intensity;
- optional seven-day Apple Health aggregates for steps, sleep, and workouts, with
  raw samples remaining on device;
- user-owned commitments and idempotent check-ins;
- recurring local reminders with Done, Snooze 15 min, and Change actions;
- durable per-account retry of offline notification actions;
- structured planner proposals reviewed by Nutrition Coach, persisted with the
  Coach thread, and activated only after the user reviews and confirms them.

Postgres remains canonical. Local notification state and the check-in outbox are
device projections, not alternative sources of truth. Android and devices without
HealthKit keep the food, coaching, commitment, and reminder experience; Health
aggregation reports unavailable without fabricating zeroes.

## Agent response contract

The Nutrition Coach may append one machine block only when the user explicitly
requested a recurring action and the exact schedule is known:

```text
[[KORA_COMMITMENT]]
{"title":"Drink water","kind":"hydration","cadence":"interval","weekdays_mask":127,"start_minute":480,"interval_minutes":120,"end_minute":1200}
[[/KORA_COMMITMENT]]
```

Kora removes this block from visible chat, rejects unknown fields and invalid
ranges, and persists a proposal only after review. Do not change the marker or
field names in an agent card without updating the parser contract tests. The
acceptance endpoint derives owner, source, and agent attribution server-side.

## Deployment order

1. Apply migrations `000040_personal_mentor` and
   `000041_mentor_commitment_proposals`.
2. Deploy the API and verify authenticated Mentor routes, Coach thread replay,
   proposal acceptance, and account deletion.
3. Build and distribute a native mobile binary. HealthKit and notification
   behaviour cannot be certified in Expo Go.
4. Run the device matrix below before widening distribution.
5. Monitor API 4xx/5xx rates for `/v1/mentor/*`, Coach proposal parse/accept
   behaviour, notification permission denial, and Health sync failures without
   logging payloads.

Rolling the mobile client back is safe because the API is additive. Rolling the
API back leaves the new tables unused. Do not run either down migration after real
Mentor data exists; restore the previous application version and retain the
additive tables instead.

## Device acceptance matrix

On a real iPhone using a development or preview build:

- confirm steps-only, sleep-only, workouts-only, all-metrics, denied, and revoked
  Health permissions;
- confirm raw Health samples never appear in requests or logs;
- create daily and selected-weekday fixed commitments;
- create an every-two-hours interval commitment and verify quiet-hour suppression;
- keep Kora closed beyond seven days and confirm open-ended reminders continue;
- use Done while online, Done while offline then reconnect, Snooze, and Change;
- switch accounts and confirm one account never displays or sends another
  account's reminders or queued check-ins;
- ask Coach for a precisely scheduled routine, verify Planner and Nutrition Coach
  attribution, edit the proposal, activate it once, and verify a retry returns the
  same commitment;
- deny notifications and confirm the commitment remains active while the UI states
  reminders are off;
- revoke Health consent during an in-flight read and confirm nothing stale uploads;
- delete the account and confirm Health summaries, profiles, proposals,
  commitments, check-ins, local reminders, and active projections are gone.

On Android:

- verify Personal Mentor setup, proposal review, commitments, recurring reminders,
  Done/Snooze/Change, offline retry, permission denial, account switching, and
  deletion;
- verify Apple Health is shown as unavailable and every non-Health feature remains
  usable.

Repeat core flows with reduced motion, large text, the smallest supported width,
background/foreground transitions, a cold start from a notification action, and a
timezone change.

## Release gates

Run the repository-required API and mobile commands in `AGENTS.md`. Also require:

- no new findings in a Gitleaks scan of the working diff;
- no reachable Go vulnerability from `govulncheck`;
- review of Trivy and npm audit findings, with dependency remediation isolated
  from this feature when it would rewrite the independently modified mobile
  lockfile;
- screenshots or recordings from the iOS and Android acceptance matrix attached
  to the release ticket.

Do not claim Health permissions or notification actions production-ready from unit
tests alone. Those APIs are OS-owned and require the real-device gate above.
