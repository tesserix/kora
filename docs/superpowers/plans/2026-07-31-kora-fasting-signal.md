# Fasting-Signal Rethink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the coach's eating-disorder risk flag from firing on absent data, so it stops flagging every brand-new user and stops changing by time of day.

**Architecture:** `fastingStreak` is the only signal that conflates "no logging data" with "did not eat". Two rules fix it: exclude today (an incomplete day), and only count days at or after the user's first logged day in the window. Everything downstream (`SignalsFrom`, `guardrails.AtRisk`, the thresholds) is untouched.

**Tech Stack:** Go 1.26, testify/require. Tests run against Postgres via `TEST_DATABASE_URL`.

## Why this matters

`guardrails.AtRisk` fires when `FastingStreakDays >= 3`. `fastingStreak` currently counts consecutive `Kcal == 0` days walking back from today.

Two defects follow:

1. **A brand-new user has 7 unlogged days**, which reads as a 7-day fast → `AtRisk` is true → an eating-disorder support card is shown to **100% of first-time coach users**. That both alarms someone who just installed a nutrition app and desensitises them to a card that should mean something.
2. **Today is always incomplete.** At 08:00 today has zero kcal, so it counts toward the streak; after the first meal it stops. The flag flips by time of day, which also makes the weight-trend nudge appear and disappear.

The same policy already handles this correctly one signal over — `AtRisk` guards `AvgIntakeKcal` with an explicit comment that a zero means "no data", not "zero calories consumed", and must not trigger risk on its own. `fastingStreak` simply lacks the equivalent guard. This plan restores that symmetry.

**This change reduces sensitivity.** It is deliberate and was an explicit product decision: a signal that fires for everyone carries no information. Genuine fasting after real logging still fires.

## Global Constraints

- Do **not** change `guardrails.AtRisk`, its four thresholds, `Signals`, or `SignalsFrom`. The fix belongs in `fastingStreak` alone.
- Do **not** weaken any other risk signal.
- `DailyTotal` has `LogCount int` — that is how you distinguish "no logs that day" from "logged, zero kcal". A day where the user logged something that happens to total zero kcal (e.g. water only) is still a genuine zero-intake day and must keep counting.
- `RecentDaily` is always exactly `recentWindowDays` (7) entries, oldest→newest, zero-valued for days with no logs. The last entry is today.
- Run Go tests in the **foreground**, never backgrounded.
- `TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'` (container `kora-pg-test`, migrated). Do not recreate, restart, or remove the container, and do not drop the `kora` database.
- Do NOT run `go run ./cmd/seed`.
- Single-line conventional-commit messages, no body, no `Co-Authored-By`, no signature.
- Work on branch `kora-fasting-signal` off `main`.

---

### Task 1: Rewrite `fastingStreak`

**Files:**
- Modify: `api/internal/coach/grounding.go`
- Test: `api/internal/coach/grounding_test.go`

**Interfaces:**
- Consumes: `DailyTotal{Day, Kcal, ProteinG, FiberG, LogCount}`.
- Produces: `fastingStreak(daily []DailyTotal) int` — same signature, new semantics.

**Existing test that must change:** `TestBuildContextFastingStreakCountsConsecutiveZeroKcalDaysFromToday` (`grounding_test.go:113`) asserts `3` for "today + 2 preceding zero-kcal days". That test **encodes the defect** — it counts today and assumes no prior logging is needed. Update it to the new contract; do not bend the implementation to keep it passing. Rename it to match the new behaviour.

- [ ] **Step 1: Write the failing tests**

Add to `api/internal/coach/grounding_test.go`. These are pure-function tests over `fastingStreak`, no DB needed:

```go
// day builds one window entry. kcal > 0 implies the user logged food;
// logCount is stated explicitly so "no logs" and "logged zero kcal" stay
// distinguishable.
func day(kcal float64, logCount int) DailyTotal {
	return DailyTotal{Kcal: kcal, LogCount: logCount}
}

func TestFastingStreak_ZeroForUserWhoNeverLogged(t *testing.T) {
	// A brand-new user: seven empty days. This is absent data, not a fast.
	daily := []DailyTotal{
		day(0, 0), day(0, 0), day(0, 0), day(0, 0), day(0, 0), day(0, 0), day(0, 0),
	}

	require.Equal(t, 0, fastingStreak(daily),
		"a user with no logging history has no data, and no-data must never read as fasting")
}

func TestFastingStreak_ExcludesTodayBecauseItIsIncomplete(t *testing.T) {
	// Logged through day 5, then silent. Today (last entry) is incomplete and
	// must not count, so only day 6 counts.
	daily := []DailyTotal{
		day(2000, 3), day(2000, 3), day(2000, 3), day(2000, 3), day(2000, 3),
		day(0, 0), // yesterday: a real zero-intake day
		day(0, 0), // today: incomplete, must not count
	}

	require.Equal(t, 1, fastingStreak(daily),
		"today is incomplete — counting it makes the signal time-of-day dependent")
}

func TestFastingStreak_CountsGenuineGapAfterLogging(t *testing.T) {
	// Logged for four days, then three full silent days, then today.
	daily := []DailyTotal{
		day(2000, 3), day(2000, 3), day(2000, 3),
		day(0, 0), day(0, 0), day(0, 0), // three complete zero days
		day(0, 0),                       // today, excluded
	}

	require.Equal(t, 3, fastingStreak(daily),
		"a real gap after established logging is exactly what this signal is for")
}

func TestFastingStreak_StopsAtMostRecentDayWithIntake(t *testing.T) {
	daily := []DailyTotal{
		day(2000, 3), day(0, 0), day(0, 0),
		day(1800, 2), // ate here — the streak must not reach past this
		day(0, 0), day(0, 0),
		day(0, 0), // today, excluded
	}

	require.Equal(t, 2, fastingStreak(daily))
}

func TestFastingStreak_LoggedButZeroKcalStillCounts(t *testing.T) {
	// The user logged something that totalled zero kcal (e.g. water). That is
	// a real zero-intake day, not absent data, so it must still count.
	daily := []DailyTotal{
		day(2000, 3), day(2000, 3), day(2000, 3), day(2000, 3),
		day(0, 1), day(0, 1), // logged, zero kcal
		day(0, 0),            // today, excluded
	}

	require.Equal(t, 2, fastingStreak(daily))
}

func TestFastingStreak_ZeroWhenLoggingStartedToday(t *testing.T) {
	// First ever log is today. The six empty days before it are absent data.
	daily := []DailyTotal{
		day(0, 0), day(0, 0), day(0, 0), day(0, 0), day(0, 0), day(0, 0),
		day(1500, 2), // today, first ever log
	}

	require.Equal(t, 0, fastingStreak(daily))
}

func TestFastingStreak_HandlesShortAndEmptyWindows(t *testing.T) {
	require.Equal(t, 0, fastingStreak(nil))
	require.Equal(t, 0, fastingStreak([]DailyTotal{}))
	require.Equal(t, 0, fastingStreak([]DailyTotal{day(0, 0)}), "a single entry is today, which is excluded")
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd api && go test ./internal/coach/ -run TestFastingStreak -v`

Expected: FAIL. The current implementation counts today and ignores logging history, so at minimum `ZeroForUserWhoNeverLogged` (gets 7) and `ExcludesTodayBecauseItIsIncomplete` (gets 2) fail.

- [ ] **Step 3: Rewrite the function**

In `api/internal/coach/grounding.go`, replace `fastingStreak`:

```go
// fastingStreak counts consecutive zero-intake days ending YESTERDAY, and
// only within the span in which the user was actually logging.
//
// Two rules, both deliberate:
//
//   - Today is excluded. It is always incomplete — before the day's first
//     meal it looks identical to a fast — so counting it would make this
//     signal, and every risk decision derived from it, depend on the time
//     of day the request happened to arrive.
//   - Days before the user's first log in the window do not count. A day
//     with no logs is absent data, not evidence of not eating. Without this,
//     a brand-new user's seven empty days read as a seven-day fast and trip
//     the ED-risk threshold on first use. guardrails.AtRisk already applies
//     exactly this reasoning to AvgIntakeKcal ("zero means no data"); this
//     restores the symmetry.
//
// A day the user logged on that still totals zero kcal DOES count — that is
// a real zero-intake day, not missing data.
//
// The effect is a strictly less sensitive signal. That is the point: a flag
// that fires for every user carries no information. A genuine gap after
// established logging still fires.
func fastingStreak(daily []DailyTotal) int {
	// Exclude today (the last entry): it is incomplete.
	if len(daily) < 2 {
		return 0
	}
	complete := daily[:len(daily)-1]

	// Find the first day the user logged anything. Everything before it is
	// absent data rather than observed behaviour.
	firstLogged := -1
	for i, d := range complete {
		if d.LogCount > 0 {
			firstLogged = i
			break
		}
	}
	if firstLogged < 0 {
		return 0
	}

	streak := 0
	for i := len(complete) - 1; i >= firstLogged; i-- {
		if complete[i].Kcal > 0 {
			break
		}
		streak++
	}
	return streak
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd api && go test ./internal/coach/ -run TestFastingStreak -v`

Expected: PASS (7 tests).

- [ ] **Step 5: Update the test that encoded the old behaviour**

`TestBuildContextFastingStreakCountsConsecutiveZeroKcalDaysFromToday` (`grounding_test.go:113`) asserts `3` for "today + 2 preceding zero-kcal days". Under the new contract today does not count and prior logging is required.

Rename it to `TestBuildContextFastingStreakExcludesTodayAndRequiresPriorLogging` and rework its fixture so it seeds some logged days before the gap, then asserts the streak counts only the complete, post-logging zero days. Keep it a `BuildContext`-level test (it currently seeds real logs via the DB) so the end-to-end path stays covered — do not downgrade it to a pure-function test, since the pure-function cases are already covered by Step 1.

- [ ] **Step 6: Find and update every other affected test**

Run: `cd api && grep -rn "FastingStreak\|fastingStreak" internal/ --include="*_test.go"`

Check each. In particular `internal/coach/service_test.go` has a helper documented as producing `FastingStreakDays == 0` and comments about a fresh user tripping the threshold — those comments and fixtures may now be wrong or newly redundant. A fixture that previously relied on "fresh user is at risk" to test the at-risk path must be made explicit (e.g. seed a real gap, or set `FastingStreakDays` directly where the test constructs `Signals`), NOT left implicitly passing.

**Watch specifically for tests whose meaning silently inverts.** PR 2 added `TestServiceThread_ShowSupportReflectsLiveSignalsNotStoredState`, which flips a signal between two calls by relying on a fresh user being at risk. If that premise no longer holds, the test may still pass while proving nothing. Re-read it and make its risk state explicit.

- [ ] **Step 7: Run the full coach and guardrails suites**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -count=1 ./internal/coach/ ./internal/guardrails/ -v 2>&1 | tail -40`

Expected: PASS. Any failure here is a test that encoded the old behaviour — fix the test's fixture, not the implementation, and say which in your report.

- [ ] **Step 8: Commit**

```bash
git add api/internal/coach/grounding.go api/internal/coach/grounding_test.go
git commit -m "fix(coach): stop absent logging data reading as a fast in the ED-risk signal"
```

(Include any other test files you had to update in the same commit.)

---

### Task 1b: Apply the same no-data rule to `recentDeficitPct`

**Discovered during Task 1.** Fixing `fastingStreak` alone does NOT stop a brand-new user being flagged — `recentDeficitPct` has the identical defect. For a user with a 2000 kcal target and seven unlogged days, every day scores a full 1.0 deficit, averaging to 1.0 against a `riskDeficitPct` threshold of 0.30. So `AtRisk` stays true and the ED support card still shows to every first-time user.

This is the same category error: **a day with no logs is absent data, not a 100% deficit.**

**Files:**
- Modify: `api/internal/coach/signals.go`
- Test: `api/internal/coach/signals_test.go`

**Interfaces:**
- Consumes: `Context.RecentDaily` (`DailyTotal` has `LogCount int`).
- Produces: `recentDeficitPct(c Context) float64` — same signature, new semantics.

- [ ] **Step 1: Write the failing tests**

```go
func TestRecentDeficitPct_ZeroWhenNothingLogged(t *testing.T) {
	c := Context{
		Today: dashboard.Summary{Targets: dashboard.Totals{Kcal: 2000}},
		RecentDaily: []DailyTotal{
			{Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0},
			{Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0},
			{Kcal: 0, LogCount: 0},
		},
	}

	require.Equal(t, 0.0, recentDeficitPct(c),
		"no logs is absent data, not a 100% deficit")
}

func TestRecentDeficitPct_AveragesOnlyLoggedDays(t *testing.T) {
	// Two logged days at half target; the rest unlogged and ignored.
	c := Context{
		Today: dashboard.Summary{Targets: dashboard.Totals{Kcal: 2000}},
		RecentDaily: []DailyTotal{
			{Kcal: 1000, LogCount: 2}, {Kcal: 1000, LogCount: 2},
			{Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0},
			{Kcal: 0, LogCount: 0}, {Kcal: 0, LogCount: 0},
		},
	}

	require.InDelta(t, 0.5, recentDeficitPct(c), 0.001,
		"only days with evidence should contribute")
}

func TestRecentDeficitPct_LoggedZeroKcalDayStillCounts(t *testing.T) {
	// Logged, and it totalled zero — real evidence of not eating.
	c := Context{
		Today: dashboard.Summary{Targets: dashboard.Totals{Kcal: 2000}},
		RecentDaily: []DailyTotal{
			{Kcal: 2000, LogCount: 3}, {Kcal: 0, LogCount: 1},
		},
	}

	require.InDelta(t, 0.5, recentDeficitPct(c), 0.001)
}

func TestRecentDeficitPct_StillFiresForRealUnderEating(t *testing.T) {
	// Consistent logging well under target must still trip the threshold.
	daily := make([]DailyTotal, 7)
	for i := range daily {
		daily[i] = DailyTotal{Kcal: 800, LogCount: 3}
	}
	c := Context{
		Today:       dashboard.Summary{Targets: dashboard.Totals{Kcal: 2000}},
		RecentDaily: daily,
	}

	require.Greater(t, recentDeficitPct(c), 0.30,
		"genuine sustained under-eating must still fire")
}
```

Create `signals_test.go` if it does not exist; otherwise append, matching the file's idiom.

- [ ] **Step 2: Run to verify they fail**

Run: `cd api && go test ./internal/coach/ -run TestRecentDeficitPct -v`

Expected: FAIL — `ZeroWhenNothingLogged` returns 1.0, `AveragesOnlyLoggedDays` returns ~0.857.

- [ ] **Step 3: Implement**

Average over logged days only:

```go
// recentDeficitPct is the mean clamped shortfall vs today's kcal target
// across the days in c.RecentDaily the user ACTUALLY LOGGED.
//
// Unlogged days are excluded rather than scored as a full deficit. A day
// with no logs is absent data, not evidence of not eating — scoring it as a
// 100% shortfall meant a brand-new user with seven empty days averaged a
// 1.0 deficit and tripped the ED-risk threshold on first use. guardrails.AtRisk
// applies the same reasoning to AvgIntakeKcal ("zero means no data").
//
// A day the user logged on that still totals zero kcal DOES count — that is
// observed intake, not missing data.
//
// If the target is not positive (not onboarded) or nothing was logged in the
// window, there is nothing to measure a shortfall against, so this reports 0
// rather than a misleading spike.
func recentDeficitPct(c Context) float64 {
	target := c.Today.Targets.Kcal
	if target <= 0 || len(c.RecentDaily) == 0 {
		return 0
	}
	var sum float64
	var logged int
	for _, d := range c.RecentDaily {
		if d.LogCount == 0 {
			continue
		}
		deficit := 1 - d.Kcal/target
		switch {
		case deficit < 0:
			deficit = 0
		case deficit > 1:
			deficit = 1
		}
		sum += deficit
		logged++
	}
	if logged == 0 {
		return 0
	}
	return sum / float64(logged)
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd api && go test ./internal/coach/ -run TestRecentDeficitPct -v`

Expected: PASS (4 tests).

- [ ] **Step 5: Find every test that relied on the old behaviour**

Run: `cd api && grep -rn "RecentDeficitPct\|recentDeficitPct\|Deficit" internal/ --include="*_test.go"`

Several existing tests establish an at-risk state implicitly via "user has a target and no logs". Those now score 0 and are no longer at risk. Each must be made explicit — seed logged days with a real shortfall — not left silently passing. Report each one you touched and why.

- [ ] **Step 6: Run the coach and guardrails suites**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -count=1 ./internal/coach/ ./internal/guardrails/ 2>&1 | tail -20`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/internal/coach/signals.go api/internal/coach/signals_test.go
git commit -m "fix(coach): exclude unlogged days from the ED-risk deficit signal"
```

---

### Task 2: Prove the end-to-end effect and run the full suite

**Files:**
- Test: `api/internal/coach/service_test.go`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the end-to-end tests**

These assert the actual user-visible outcome, not the intermediate number. Build the service the way neighbouring tests in this file do.

```go
func TestServiceNudges_FreshUserIsNotFlaggedAtRisk(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	// No logs at all — a brand-new user.

	// ... build grounder/service as the neighbouring tests do ...

	result, err := svc.Nudges(context.Background(), userID, time.Now().UTC(), time.UTC)
	require.NoError(t, err)
	require.False(t, result.ShowSupport,
		"a brand-new user has no data, and must not be shown an ED support resource on first use")
}
```

Add a companion proving the signal still fires for a genuine gap: seed logs for several days, leave the most recent complete days empty, and assert `ShowSupport` is true. Reuse whatever log-seeding helper this package already has (see `seedSteadyWeek` and the other fixtures in `service_test.go`) rather than writing new seeding code.

If you cannot seed a genuine multi-day gap deterministically with the existing helpers, say so in your report rather than writing a test that asserts nothing.

- [ ] **Step 2: Run them**

Run: `cd api && TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test ./internal/coach/ -run TestServiceNudges_ -v`

Expected: PASS.

- [ ] **Step 3: Run vet and the full suite exactly as CI does**

```bash
cd api
go vet ./...
TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable' go test -race -p 1 -count=1 ./...
```

Expected: `go vet` clean; every package `ok`, zero `FAIL`. Foreground; let the `-race` run finish.

- [ ] **Step 4: Commit**

```bash
git add api/internal/coach/service_test.go
git commit -m "test(coach): prove a fresh user is not flagged at risk while real gaps still fire"
```

---

## Done criteria

- `go vet ./...` clean; `go test -race -p 1 -count=1 ./...` fully green.
- A brand-new user with no logs is **not** flagged at ED-risk.
- Today never contributes to the streak, so the flag no longer changes by time of day.
- A genuine multi-day gap after established logging **still** fires.
- A logged-but-zero-kcal day still counts.
- `guardrails.AtRisk`, its thresholds, `Signals`, and `SignalsFrom` are untouched.
- Every test that encoded the old behaviour was updated deliberately, and none was left passing-but-meaningless.
