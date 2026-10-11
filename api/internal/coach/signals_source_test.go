package coach

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/guardrails"
	"github.com/tesserix/kora/api/internal/memory"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/tracking"
)

// The adapter must return exactly what SignalsFrom computes for the built
// context — no second definition of risk may appear here.
//
// A user with no logs at all makes every guardrails.Signals field its own
// zero value (see recentDeficitPct's minDeficitLoggedDays gate), which
// would let a mutant that returns guardrails.Signals{} unconditionally pass
// this test undetected. So this seeds real, under-target logs on two
// complete days to force a non-zero RecentDeficitPct/AvgIntakeKcal/
// LogsPerDay, making the comparison actually exercise SignalsFrom's output.
func TestSignalsSourceReturnsSignalsFromBuiltContext(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	item := nutrition.FoodItem{
		Name: "Signals Source Test Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 200, ProteinPer100g: 20, FiberPer100g: 5,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	now := time.Now().UTC()
	seedLog(t, db, logRepo, foodlog.FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.AddDate(0, 0, -1), LocalDate: localDayOf(now.AddDate(0, 0, -1)),
		MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
		QuantityGrams: 200, Kcal: 400, ProteinG: 40, FiberG: 10,
	})
	seedLog(t, db, logRepo, foodlog.FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.AddDate(0, 0, -2), LocalDate: localDayOf(now.AddDate(0, 0, -2)),
		MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
		QuantityGrams: 200, Kcal: 400, ProteinG: 40, FiberG: 10,
	})

	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)

	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})
	src := NewSignalsSource(g)

	got, err := src.SignalsFor(context.Background(), userID, time.UTC)
	require.NoError(t, err)

	built, err := g.BuildContext(context.Background(), userID, now, time.UTC)
	require.NoError(t, err)
	want := SignalsFrom(built)
	require.NotEqual(t, guardrails.Signals{}, want, "test fixture must produce non-zero signals or a zero-value mutant would pass undetected")
	require.Equal(t, want, got)
}

// failingLogSource fails BuildContext via the LogSource seam.
// BuildContext deliberately swallows WeightSource errors (see
// TestBuildContextSwallowsWeightSourceError), so the failure must come from
// a dependency BuildContext does NOT degrade on: LogSource.
type failingLogSource struct {
	err error
}

func (f failingLogSource) ListForUserSince(_ context.Context, _ uuid.UUID, _ time.Time) ([]foodlog.FoodLog, error) {
	return nil, f.err
}

func (f failingLogSource) DaysLoggedBetween(_ context.Context, _ uuid.UUID, _, _ time.Time) (int, error) {
	return 0, f.err
}

func TestSignalsSourcePropagatesBuildFailure(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	dashSvc := dashboard.NewService(foodlog.NewRepository(db), tracking.NewRepository(db), db)
	logs := failingLogSource{err: errors.New("log source unavailable")}
	memSvc := memory.NewService(foodlog.NewRepository(db))

	g := NewGrounder(dashSvc, logs, memSvc, fakeWeightSource{})
	src := NewSignalsSource(g)

	_, err := src.SignalsFor(context.Background(), userID, time.UTC)
	require.Error(t, err, "an unknown risk state must reach the caller, never read as no-risk")
}
