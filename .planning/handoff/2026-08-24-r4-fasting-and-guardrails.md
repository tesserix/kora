# Handoff — Kora, R4 body composition: the guardrail sessions

You are picking up **Kora** (`/Users/Mahesh.Sangawar/personal/tesserix-new/kora`),
a nutrition-tracking iOS app: Go API + Expo/React Native, pre-launch, one tester.

`main` is at `fec1bab2`. **The API is deployed from that same commit** — check
before assuming, because an app that ships ahead of its API shows controls that
silently fail to persist, and that reads as a UI bug.

**The repo is PUBLIC.** Never put a real weight, measurement or intake value in
a commit, comment, test fixture, issue or PR. Describe results as field counts.

## The single most important thing

**Three fixes merged after the last TestFlight build, and none is device-verified.**

The installed build is `1b97c1d3`. Since then: #406 (the connect-prompt fix),
#405 (why-no-rate), #408 (the fasting-streak fix) and #407 (declared fasting)
have all merged. A build from `fec1bab2` would carry them.

The device checklist from the last session is still live and still accurate:
https://claude.ai/code/artifact/8a8eb38d-f6c5-4f57-ae56-bc1e6458dc1b

Checks 8–10 (HealthKit relaunch dedup, provenance separation, sleep vs the
Health app) work on the **currently installed** build and have never been done.

## What shipped in R4, and what it cost to learn

Ten PRs merged across two sessions. #45 is closed: ten measured metrics, six tape
measurements, an estimate-framed weekly rate, screenshot reading device-verified
end to end for the first time. #372 closed: active energy and resting heart rate.
#407 closed: declared fasting intervals.

**Five bugs were found by using the app, not by testing the code**, and four of
them are the same failure wearing different clothes — two distinct states
collapsed into one silent rendering:

- **#378** a correct save rendered as a failed one (future `logged_at` excluded
  by its own read window)
- **#406** absent measurement rendered as absent permission ("Connect Apple
  Health" shown to someone already connected — and the button was not inert)
- **#405** no-rate rendered identically whether gated or guardrail-suppressed
- **#408** not-logging read as not-eating (one food log, ever, produced a
  seven-day fasting streak and tripped the ED threshold)

If you find yourself looking at a blank space or an unexpected prompt, suspect
this class first.

## Decisions already made — do not relitigate

- **The guardrail's asymmetry is deliberate.** `insufficient_data` explains
  itself on screen; `suppressed` says nothing at all. Telling someone the app
  has classified them as at eating-disorder risk is the disclosure #23 exists
  to avoid. There is a test on it and a long comment saying so.
- **`DeclaredFastHours` and `FastingStreakDays` never feed each other.** One is
  told, one is guessed; they need different thresholds and separate tuning.
- **A declared fast cannot switch the guardrail off.** Someone restricting will
  not tap "start fasting", so the inferred signal must keep working on
  undeclared behaviour. Do not "simplify" risk to depend on declarations.
- **The measure is the LONGEST fast, never a sum.** Seven 16h overnight fasts
  total 112h and mean nothing; summing flags every 16:8 faster daily.
- **A fast's end is computed, never stored** — except an explicit end. The
  partial unique index that used to enforce one-open-fast was DROPPED
  (migration 000053) because Postgres cannot index a computed property;
  `pg_advisory_xact_lock` in `Start` holds that invariant now.
- **Weight and tape metrics fit ACROSS instrument changes; composition
  percentages do not.** Vendors disagree about body fat by 20+ points and about
  weight by a few hundred grams, and `source` describes the weigh-in, not the
  tape.
- **Progress photos are dropped from #45**, not deferred.

## What is open

- **#413** — `POST /v1/fasting/start` needs two DB connections (a tx handle plus
  a pool-bound food-log read) and `maxOpenConns = 5`. Five concurrent starts
  stall **every** endpoint, not just fasting. Unreachable with one tester;
  **a blocker for the closed beta (#328)**. The issue names the exact test shape
  needed — without both a small pool AND a non-nil log source, a regression test
  passes under the bug.
- **#30** — needs your device. Two properties still unproven, both only
  observable on a *second* run: a relaunch must not duplicate the 28 synced
  HealthKit rows, and a HealthKit weight must not merge with a manual one.
- **#153** — contacts discovery, still looks misfiled into this milestone.

## Repo traps

Everything in the previous handoff still applies. New:

- **Editor diagnostics lie constantly here.** Stale gopls snapshots reported
  compile errors on `router.go` and test files at least five times this session
  while `go build ./...` exited 0 every time. Verify before believing them.
- **Kora's test Postgres is on 5433.** 5432 in this workspace is an unrelated
  tesserix-marketplace database. Run DB suites with `-p 1` — they do not close
  their gorm pools and exhaust `max_connections` concurrently.
- **There is more than one user in the production database.** Aggregate queries
  without a `user_id` filter mix accounts. This produced a completely wrong
  diagnosis and a filed issue that had to be publicly retracted.
- **`apiFetch` does `envelope.data ?? envelope`** — a `data: null` response
  returns the whole envelope, which is truthy. Use `apiFetchEnvelope` when null
  is meaningful.
- **Whole-module `jest.mock("@/api/hooks")` / `@/health` factories** replace the
  module: every hook the screen imports must be listed or it arrives `undefined`
  and every test in the file fails at once. This cost time three times.
- **The TestFlight job is named "Local iOS release" but runs on GitHub.**
  `gh workflow run ios-release.yml --ref main`, ~25 min. Nothing builds locally.
- **Synthetic input on the simulator is unavailable** — `cliclick` reports
  accessibility privileges disabled, `idb` is not installed. Driving the app is
  not possible without the user granting Accessibility to the terminal.

## Working practices the user expects

Unchanged, plus:

- **Mutation-check every test and report it concretely.** This session produced
  **six defects in a single plan, all mine, none in the implementations** — and
  four were tests that were green while asserting nothing. A suite you have
  watched fail for the right reason is worth far more than a green one.
- **Verify an issue's premises before planning off it.** Four issues asserted
  things that were not true (#366, #372, #373, and #405's own evidence). The
  ones saying "nothing here needs re-deciding" are the highest risk.
- **Say what is not verified**, on every PR, in its own section.
