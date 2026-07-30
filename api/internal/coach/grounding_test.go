package coach

import (
	"context"
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
	g := NewGrounder(dashSvc, logRepo, memSvc)

	ctx, err := g.BuildContext(context.Background(), userID, now, loc)
	require.NoError(t, err)

	require.Len(t, ctx.RecentDaily, recentWindowDays, "RecentDaily must cover the full window, zero-filling days with no logs")
	require.Equal(t, 2, ctx.DaysLogged, "only 2 of the 7 days have logs")

	require.InDelta(t, 600.0, ctx.Today.Consumed.Kcal, 0.001)
	require.InDelta(t, 2000.0, ctx.Today.Targets.Kcal, 0.001)

	wantAvgKcal := (400.0 + 600.0) / float64(recentWindowDays)
	require.InDelta(t, wantAvgKcal, ctx.AvgIntakeKcal, 0.001, "AvgIntakeKcal must match the seeded totals over the full window")

	wantLogsPerDay := 3.0 / float64(recentWindowDays)
	require.InDelta(t, wantLogsPerDay, ctx.LogsPerDay, 0.001)

	rendered := ctx.Render()
	require.Contains(t, rendered, "2000", "Render must cite today's kcal target")
	require.Contains(t, rendered, "600", "Render must cite today's consumed kcal")
}

func TestBuildContextFastingStreakCountsConsecutiveZeroKcalDaysFromToday(t *testing.T) {
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

	// Only a log 3 days ago; today and the two days before it have nothing.
	seedLog(t, db, logRepo, foodlog.FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.AddDate(0, 0, -3),
		MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
		QuantityGrams: 100, Kcal: 100, ProteinG: 10,
	})

	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc)

	ctx, err := g.BuildContext(context.Background(), userID, now, loc)
	require.NoError(t, err)

	require.Equal(t, 3, ctx.FastingStreakDays, "today + 2 preceding zero-kcal days")
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
	g := NewGrounder(dashSvc, logRepo, memSvc)

	ctx, err := g.BuildContext(context.Background(), userID, now, loc)
	require.NoError(t, err)

	require.Equal(t, 1, ctx.DaysLogged,
		"the oldest window day's log must not be dropped by a since/bucket boundary mismatch")
	require.InDelta(t, targetKcal, ctx.RecentDaily[0].Kcal, 0.001,
		"the seeded log must land in the oldest (index 0) day bucket")
	require.InDelta(t, targetKcal/float64(recentWindowDays), ctx.AvgIntakeKcal, 0.001)

	s := SignalsFrom(ctx)
	require.Less(t, s.RecentDeficitPct, 0.99,
		"a logged oldest day must pull RecentDeficitPct below the spurious all-days-deficit ceiling of 1.0")
}
