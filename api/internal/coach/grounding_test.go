package coach

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/memory"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/tracking"
)

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

// seedUser inserts a bare user row with the given kcal/protein targets and
// returns its id.
func seedUser(t *testing.T, db *gorm.DB, targetKcal, targetProteinG float64) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email, target_kcal, target_protein_g) VALUES (?, ?, ?, ?, ?)",
		id, "coach-"+id.String(), "coach-"+id.String()+"@test.dev", targetKcal, targetProteinG).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

func seedLog(t *testing.T, db *gorm.DB, repo foodlog.Repository, log foodlog.FoodLog) foodlog.FoodLog {
	t.Helper()
	created, err := repo.Create(context.Background(), log)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE id = ?", created.ID) })
	return created
}

func TestBuildContextAggregatesRecentDailyAndRenders(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	item := nutrition.FoodItem{
		Name: "Coach Grounding Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 200, ProteinPer100g: 20, FiberPer100g: 5,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	loc := time.UTC
	now := time.Date(2026, 3, 10, 18, 0, 0, 0, loc)

	// Yesterday: one log, 400 kcal.
	seedLog(t, db, logRepo, foodlog.FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.AddDate(0, 0, -1),
		MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
		QuantityGrams: 200, Kcal: 400, ProteinG: 40, FiberG: 10,
	})

	// Today: two logs totalling 600 kcal.
	seedLog(t, db, logRepo, foodlog.FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.Add(-2 * time.Hour),
		MealSlot: "breakfast", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
		QuantityGrams: 100, Kcal: 200, ProteinG: 20, FiberG: 5,
	})
	seedLog(t, db, logRepo, foodlog.FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.Add(-1 * time.Hour),
		MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
		QuantityGrams: 200, Kcal: 400, ProteinG: 40, FiberG: 10,
	})

	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	ctx, err := g.BuildContext(context.Background(), userID, now, loc)
	require.NoError(t, err)

	require.Len(t, ctx.RecentDaily, recentWindowDays, "RecentDaily must cover the full window, zero-filling days with no logs")
	require.Equal(t, 2, ctx.DaysLogged, "only 2 of the 7 days have logs")

	require.InDelta(t, 600.0, ctx.Today.Consumed.Kcal, 0.001)
	require.InDelta(t, 2000.0, ctx.Today.Targets.Kcal, 0.001)

	// AvgIntakeKcal excludes today and averages only over logged complete
	// days (see summarizeRecent's doc comment): today's 600 kcal is
	// excluded regardless of its value, leaving yesterday (400 kcal,
	// logged) as the only complete day with evidence, so the average is
	// yesterday's total, not a 7-day-diluted mean.
	wantAvgKcal := 400.0
	require.InDelta(t, wantAvgKcal, ctx.AvgIntakeKcal, 0.001, "AvgIntakeKcal must average only logged complete (non-today) days")

	wantLogsPerDay := 3.0 / float64(recentWindowDays)
	require.InDelta(t, wantLogsPerDay, ctx.LogsPerDay, 0.001)

	rendered := ctx.Render()
	require.Contains(t, rendered, "2000", "Render must cite today's kcal target")
	require.Contains(t, rendered, "600", "Render must cite today's consumed kcal")
}

// TestBuildContextFastingStreakExcludesTodayAndRequiresPriorLogging replaces
// TestBuildContextFastingStreakCountsConsecutiveZeroKcalDaysFromToday, which
// encoded the old defect: it asserted 3 for "today + 2 preceding zero-kcal
// days" — counting the always-incomplete today and requiring no prior
// logging history at all. Under the new contract, today never counts and a
// day only counts once the user has an established log somewhere earlier in
// the window. This seeds two logged days, then a genuine 2-day silent gap
// leading up to (but excluding) today, and asserts the streak counts only
// those complete, post-logging zero days.
func TestBuildContextFastingStreakExcludesTodayAndRequiresPriorLogging(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	item := nutrition.FoodItem{
		Name: "Coach Fasting Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 100, ProteinPer100g: 10,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	loc := time.UTC
	now := time.Date(2026, 3, 10, 12, 0, 0, 0, loc)

	// Logged 4 and 3 days ago (establishes logging history), then silent
	// for the 2 days before today, then today itself is also silent but
	// must be excluded from the count.
	seedLog(t, db, logRepo, foodlog.FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.AddDate(0, 0, -4),
		MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
		QuantityGrams: 100, Kcal: 100, ProteinG: 10,
	})
	seedLog(t, db, logRepo, foodlog.FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.AddDate(0, 0, -3),
		MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
		QuantityGrams: 100, Kcal: 100, ProteinG: 10,
	})

	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	ctx, err := g.BuildContext(context.Background(), userID, now, loc)
	require.NoError(t, err)

	require.Equal(t, 2, ctx.FastingStreakDays,
		"only the 2 complete zero-kcal days after logging began must count; today is excluded")
}

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
		day(0, 0), // today, excluded
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
		day(0, 0), // today, excluded
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

// TestBuildContextWindowStartMatchesAcrossFetchAndBucketing is a regression
// test for the day-window boundary drift: the DB fetch's `since` and
// aggregateDaily's bucketing must use the identical local-midnight boundary,
// or the oldest day of the window silently loses logs. This is worst when
// now (typically time.Now().UTC(), per the real call pattern) is in a
// different Location than loc (the user's zone) — the old
// `since := now.AddDate(0,0,-(recentWindowDays-1))` kept now's own
// clock-time and Location, drifting away from the local-midnight-aligned
// `startDay` aggregateDaily computed from now.In(loc).
//
// This test fails against the pre-fix code (the seeded log's day silently
// drops out, DaysLogged/AvgIntakeKcal undercount, and RecentDeficitPct is
// spuriously pinned at 1.0) and passes once both boundaries share one
// windowStart helper.
func TestBuildContextWindowStartMatchesAcrossFetchAndBucketing(t *testing.T) {
	db := testDB(t)
	targetKcal := 1000.0
	userID := seedUser(t, db, targetKcal, 80)

	logRepo := foodlog.NewRepository(db)
	item := nutrition.FoodItem{
		Name: "Coach Window Boundary Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 100, ProteinPer100g: 10,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	// now matches the standard call pattern (time.Now().UTC()); loc is a
	// fixed non-UTC zone distinct from now's Location, so any drift between
	// the fetch boundary and the bucketing boundary shows up deterministically.
	now := time.Now().UTC()
	loc := time.FixedZone("IST", 5*3600+1800)

	// Computed independently of the production windowStart helper (rather
	// than calling it) so this test exercises behavior, not the helper's
	// own implementation: the local-midnight start of the trailing window,
	// mirroring what aggregateDaily's bucketing must align with.
	nowLocal := now.In(loc)
	oldestDayStart := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, loc).
		AddDate(0, 0, -(recentWindowDays - 1))
	// Seeded just after local midnight on the oldest day of the window —
	// the log a since/bucket boundary mismatch would drop.
	seedLog(t, db, logRepo, foodlog.FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: oldestDayStart.Add(time.Minute),
		MealSlot: "breakfast", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
		QuantityGrams: 1000, Kcal: targetKcal, ProteinG: 100,
	})

	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	ctx, err := g.BuildContext(context.Background(), userID, now, loc)
	require.NoError(t, err)

	require.Equal(t, 1, ctx.DaysLogged,
		"the oldest window day's log must not be dropped by a since/bucket boundary mismatch")
	require.InDelta(t, targetKcal, ctx.RecentDaily[0].Kcal, 0.001,
		"the seeded log must land in the oldest (index 0) day bucket")
	// The single seeded log is the oldest window day, which is a complete
	// (non-today) day and the only one logged, so AvgIntakeKcal now equals
	// that day's total directly rather than being diluted by the fixed
	// 7-day denominator.
	require.InDelta(t, targetKcal, ctx.AvgIntakeKcal, 0.001)

	s := SignalsFrom(ctx)
	require.Less(t, s.RecentDeficitPct, 0.99,
		"a logged oldest day must pull RecentDeficitPct below the spurious all-days-deficit ceiling of 1.0")
}

type fakeWeightSource struct {
	entries []tracking.WeightEntry
	err     error

	// calls, when non-nil, records the arguments the most recent
	// WeightSeries call was invoked with, so tests can assert BuildContext
	// wires userID/from/to correctly.
	calls *weightSeriesCall
}

// weightSeriesCall captures one WeightSeries invocation's arguments.
type weightSeriesCall struct {
	userID uuid.UUID
	from   time.Time
	to     time.Time
}

func (f fakeWeightSource) WeightSeries(_ context.Context, userID uuid.UUID, from, to time.Time) ([]tracking.WeightEntry, error) {
	if f.calls != nil {
		f.calls.userID = userID
		f.calls.from = from
		f.calls.to = to
	}
	return f.entries, f.err
}

func TestWeightTrendFrom_DeltaOverWindow(t *testing.T) {
	base := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	entries := []tracking.WeightEntry{
		{WeightKg: 80.0, LoggedAt: base},
		{WeightKg: 79.1, LoggedAt: base.AddDate(0, 0, 10)},
		{WeightKg: 78.2, LoggedAt: base.AddDate(0, 0, 20)},
	}

	tr := weightTrendFrom(entries)

	require.True(t, tr.Valid)
	require.InDelta(t, -1.8, tr.DeltaKg, 0.001)
	require.Equal(t, 20, tr.Days)
}

func TestWeightTrendFrom_InvalidBelowTwoEntries(t *testing.T) {
	require.False(t, weightTrendFrom(nil).Valid)
	require.False(t, weightTrendFrom([]tracking.WeightEntry{{WeightKg: 80}}).Valid)
}

func TestWeightTrendFrom_GainIsPositiveDelta(t *testing.T) {
	base := time.Date(2026, 7, 1, 8, 0, 0, 0, time.UTC)
	entries := []tracking.WeightEntry{
		{WeightKg: 78.0, LoggedAt: base},
		{WeightKg: 79.0, LoggedAt: base.AddDate(0, 0, 7)},
	}

	tr := weightTrendFrom(entries)

	require.True(t, tr.Valid)
	require.InDelta(t, 1.0, tr.DeltaKg, 0.001)
}

// TestBuildContextWiresPopulatedWeightTrend closes the gap where every prior
// BuildContext test used a zero-value fakeWeightSource (nil entries), so
// Context.WeightTrend was always the zero WeightTrend{} and the assignment
// from WeightSeries's result into Context.WeightTrend was never actually
// exercised. A populated, ascending-by-logged_at series must flow through to
// a non-zero, Valid trend with the expected signed delta and day span.
func TestBuildContextWiresPopulatedWeightTrend(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)

	loc := time.UTC
	now := time.Date(2026, 3, 10, 18, 0, 0, 0, loc)

	weights := fakeWeightSource{entries: []tracking.WeightEntry{
		{WeightKg: 82.0, LoggedAt: now.AddDate(0, 0, -25)},
		{WeightKg: 79.0, LoggedAt: now.AddDate(0, 0, -1)},
	}}
	g := NewGrounder(dashSvc, logRepo, memSvc, weights)

	ctx, err := g.BuildContext(context.Background(), userID, now, loc)
	require.NoError(t, err)

	require.True(t, ctx.WeightTrend.Valid, "a populated ascending series must produce a valid trend")
	require.InDelta(t, -3.0, ctx.WeightTrend.DeltaKg, 0.001, "DeltaKg must be the signed last-minus-first change")
	require.Equal(t, 24, ctx.WeightTrend.Days)
}

// TestBuildContextCallsWeightSeriesWithCorrectArguments guards the wiring
// itself: with a zero-value fakeWeightSource, this test would pass unchanged
// even if userID/from/to were swapped or scrambled when calling
// WeightSeries, because no test previously inspected what arguments
// BuildContext actually passed. This records the call and checks each
// argument individually against what BuildContext was given.
func TestBuildContextCallsWeightSeriesWithCorrectArguments(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)

	loc := time.FixedZone("IST", 5*3600+1800)
	now := time.Date(2026, 3, 10, 3, 30, 0, 0, time.UTC) // crosses a day boundary in loc

	calls := &weightSeriesCall{}
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{calls: calls})

	_, err := g.BuildContext(context.Background(), userID, now, loc)
	require.NoError(t, err)

	require.Equal(t, userID, calls.userID, "WeightSeries must be called with the same userID passed to BuildContext")
	require.True(t, calls.to.Equal(now), "WeightSeries's `to` must be the `now` passed to BuildContext, got %v want %v", calls.to, now)

	// Computed independently of windowStartDays so this test exercises behavior,
	// not the helper's own implementation: the local-midnight start of the
	// trailing 30-day weight window.
	nowLocal := now.In(loc)
	wantFrom := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(), 0, 0, 0, 0, loc).
		AddDate(0, 0, -29) // weightWindowDays - 1
	require.True(t, calls.from.Equal(wantFrom),
		"WeightSeries's `from` must be 29 days before now's local midnight (30-day window), got %v want %v",
		calls.from, wantFrom)
}

// TestBuildContextSwallowsWeightSourceError proves the documented
// error-swallowing behavior: a WeightSeries failure must not fail
// BuildContext (nudges/Q&A keep working without a weight trend) and must
// leave WeightTrend at its zero value (Valid: false) rather than a
// misleading zero delta, so a failed read is never mistaken for "no change".
func TestBuildContextSwallowsWeightSourceError(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)

	loc := time.UTC
	now := time.Date(2026, 3, 10, 18, 0, 0, 0, loc)

	weights := fakeWeightSource{err: errors.New("weight source unavailable")}
	g := NewGrounder(dashSvc, logRepo, memSvc, weights)

	ctx, err := g.BuildContext(context.Background(), userID, now, loc)

	require.NoError(t, err, "a weight source error must not fail BuildContext")
	require.Equal(t, WeightTrend{}, ctx.WeightTrend, "a failed weight read must leave WeightTrend zero-valued, not a misleading zero-change trend")
	require.False(t, ctx.WeightTrend.Valid)
}
