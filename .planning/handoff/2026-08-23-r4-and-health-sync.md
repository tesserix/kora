# Handoff — Kora, end of R4 body composition, start of health sync

You are picking up work on **Kora** (`/Users/Mahesh.Sangawar/personal/tesserix-new/kora`),
a nutrition-tracking iOS app: Go API + Expo/React Native, pre-launch, one tester.

`main` is at `8ae5fc0b`. A TestFlight build was cut from that exact commit
(`gh run view 32615185964`) — the first build containing any of R4.

**The repo is PUBLIC as of 2026-08-22.** Issues, PRs and history are all
visible. Never put a real body-composition or weight value in a commit,
comment, test fixture, issue or PR. Describe results as field counts.

## The single most important thing

**Nothing in the HealthKit or sleep work has been verified on a device.**
HealthKit reads never succeed on a simulator (#187), so two merged features —
sleep interval-union (#368) and HealthKit weight sync (#369) — rest entirely on
unit tests of their pure functions. Every report says so; keep it that way.

The device check worth doing once, in one pass: with a weight in Apple Health
written by a third-party scale app, confirm it appears in Kora with
`source: 'healthkit'`, that a relaunch does not duplicate it, and that it does
not join a manual reading in the trend. That exercises the anchor, the dedup
and the provenance rule together. For sleep, compare Kora's figure against the
Health app's own "Time Asleep" for the same night, ideally with more than one
source writing — that is the case that produced the 12.8h bug.

## What shipped

R4 slice 3 is complete and closed (#314). The screenshot reader works: measured
on two real devices, Renpho 10/10 legible fields and Omron 6/6, on 5 of 5 runs.

Merged: #346 (reader), #349 (mobile flow), #353 (the fix that made it work),
#355 (Google light button), #356 (instrument detection), #357 (one Log weight
sheet), #360 + #363 (Trends card honesty), #361 (onboarding writes a real
weigh-in), #368 (sleep), #369 (HealthKit weight sync), #374 (pinned Save).
Closed: #314, #327, #354.

## Decisions already made — do not relitigate

- **Required + Nullable is how the vision schema expresses optional.** Omitting
  the `Required` list entirely is what made the reader return weight and
  nothing else. It was a deliberate choice defended in a long comment, and the
  reasoning overlooked nullability. Never revert it. See #314's closing comment.
- **Reconcile on the device; store the answer, never the raw claims.** HealthKit
  returns every source's samples with no dedup and only the device can apply
  Apple's source-priority rules. #140 and #327 were both this bug.
- **Both weights are kept, separated by `source`.** A HealthKit weight and a
  manual weight on the same day are two readings from two instruments.
- **The vision model transcribes the reading date VERBATIM; Go resolves the
  year.** Scale screens print `22/08` with no year, so asking the model for
  `YYYY-MM-DD` forced it to invent one.
- **`POST /v1/health/sync` returns 200 whenever the body parses**, even with
  every record rejected. A non-2xx makes the device re-send bad samples forever.
- **Foreground-only sync, iOS only.** Health Connect is a separate issue; Google
  Fit is a retired API.
- **The dock scrim was removed, not colour-matched** (#354). A scrim that must
  mirror `AppBackground`'s radial pools re-breaks whenever those change.
- **The Google button's border comes from Kora's theme**, deliberately deviating
  from Google's spec; fill, label and mark stay theirs.
- **Progress photos are dropped from #45**, not deferred. **InBody/DEXA left R4**
  → #367.

## What is open, roughly in priority order

- **#375** — the HealthKit permission prompt now fires on app launch, before the
  user asks for anything health-related. Consequence of mounting `useHealthSync`
  at the root. A denial is sticky, so a badly-timed prompt can lose the feature
  permanently. Small fix, user-visible, ships in the next build otherwise.
- **#366** — the dev Gemini key is free tier: **20 requests/day for the whole
  project**, while `perUserDailyRequestCap` is 20 *per user*. If prod runs on a
  key like that, one user exhausts everyone's budget. R6 plans 10–15 testers.
  Deployment config is not in this repo, so it could not be checked from here.
- **#45** — waist/tape measurements and estimate-framed trend prediction are both
  genuinely unbuilt. Verified: no `waist` column anywhere, no projection code.
- **#372 / #373** — plans 2 and 3 of #30. #373 (workouts) carries a
  recommendation to close as won't-do: nothing reads workout data.
- **#371** — nothing asserts every `/v1` route requires auth.
- **#365** — the screenshot downscaler point-samples text. Not implicated in the
  under-reading bug; explicitly filed so the two are not conflated.
- **#309** — draft, offline barcode, still waits on a device test with a real
  barcode. Not in any build.

## Repo traps — the ones that cost real time today

Everything in the previous handoff still applies. New this session:

- **GitHub Actions rejects the first run after a push** with a billing
  annotation, then a plain `gh run rerun` succeeds. Read the annotation before
  believing a 2-second red is your diff. This burned an hour.
- **Vertex is the way to run AI smoke tests**, not the Gemini key:
  `VERTEX_PROJECT=tesseracthub-480811`, ADC already present. Vertex is enabled
  there and NOT on `kora-app-e6d38`, which holds identities only.
- **`ON CONFLICT` against a PARTIAL unique index needs `clause.TargetWhere`**
  with the predicate matching verbatim, or Postgres errors `42P10`.
- **A partial unique index cannot be validated by Postgres tests.** It treats
  NULLs as distinct, so a wrongly non-partial index passes everything. Mutation-
  check it in both directions.
- **gopls "file is within module ... not included in your workspace"** noise
  appears constantly while agents work in worktrees. It is not a real error;
  `go build` in the worktree is the truth.
- **`idb` coordinates go stale between steps.** Re-read the a11y tree after every
  navigation — a permission dialog or a layout change shifts everything, and a
  stale tap lands somewhere unrelated (once, in the camera flow).
- **Jest performs no layout, so a "visible" button can be 743pt below the fold.**
  Measure with `idb ui describe-all` frames against the 956pt screen height.
  That gap is what caused the reported "screenshot didn't log" bug.
- **The local dev DB drifts behind migrations.** `internal/coach`,
  `internal/nutrition/refresh` and `cmd/backfillunits` fail locally on missing
  `starts_on`, `food_refresh_runs`, `diet_tags`. Always confirm a failure
  reproduces on untouched `main` before blaming a diff.
- **Agents will poll CI in a loop forever.** Two did today. Tell them explicitly
  not to wait on CI, and kill them if they do.
- **Agents leave debris**: a `.bak` file from a mutation check, 260 lines of
  incidental `go.sum` churn. Check `git status` before opening a PR.

## Working practices the user expects

Unchanged from the previous handoff, plus:

- **Mutation-check every new test** and report it concretely — broke it, went
  red, restored, went green. This caught a stale-closure bug and an untested
  write-failure path today.
- **Subagent-driven execution for plans**, with a ledger; never ask inline vs
  subagent. Record every ruling with what it costs if wrong, and surface them
  all at the end.
- **Verify visual claims on the simulator.** Jest cannot see layout, and two of
  today's user-reported bugs were invisible to a green suite.
- File issues for what you find rather than fixing silently out of scope, and
  put the measurement in them.

## Suggested first move

Ask whether the TestFlight build installed cleanly and whether the screenshot
import now logs — that was a real user-facing bug (#374) and its fix is
verified on the simulator but not by the person who hit it.

Then **#375**, which is small, user-visible, and otherwise ships in every build
from here.

Two questions from this session are still unanswered and worth asking rather
than assuming: what the user saw when the import failed (values, an error and
its wording, or nothing), and what the deployed API actually uses for AI
(`AI_GATEWAY_ENABLED` / `VERTEX_PROJECT` / `GEMINI_API_KEY`), which decides
whether #366 is a dev annoyance or a closed-beta blocker.
