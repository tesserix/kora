package fasting

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// fakeFirstLogs is a FirstLogSource double. It applies the same "strictly
// after" rule the real query does, so a test cannot accidentally pass by
// handing back a log that predates the fast.
type fakeFirstLogs struct {
	at  *time.Time
	err error
}

func (f fakeFirstLogs) FirstLogAfter(_ context.Context, _ uuid.UUID, after time.Time) (*time.Time, error) {
	if f.err != nil {
		return nil, f.err
	}
	if f.at == nil || !f.at.After(after) {
		return nil, nil
	}
	return f.at, nil
}

// seedMeal logs one real food log at `at`, through the same service the app
// uses, and returns nothing but the side effect. Used where the point is that
// the WIRING to foodlog works, not just the arithmetic.
func seedMeal(t *testing.T, db *gorm.DB, userID uuid.UUID, at time.Time) {
	t.Helper()
	item := nutrition.FoodItem{
		Name: "Fasting Test Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 100, ProteinPer100g: 10, CarbsPer100g: 20, FatPer100g: 5, FiberPer100g: 2,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := foodlog.NewService(foodlog.NewRepository(db), nutrition.NewRepository(db))
	_, err := svc.LogFood(context.Background(), userID, foodlog.LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 100, LoggedAt: at,
	}, time.UTC)
	require.NoError(t, err)
}

// TestStartingAgainAfterAMealEndedTheLastFastDeclaresANewInterval is the
// reviewer's reproduction of kora#407's critical finding, end to end against
// a real database and a real food log.
//
//	Mon 20:00  the user starts a fast; the row opens
//	Tue 12:00  the user eats and logs it -- the fast is effectively over at
//	           16h, and the row correctly stays open (nothing implicit ever
//	           writes ended_at)
//	Tue 20:00  the user starts a NEW fast
//
// Before the fix, Open was the bare column read `ended_at IS NULL`, so that
// third step returned MONDAY's row and the new fast was never recorded. The
// user then genuinely fasted 36h while the guardrail computed 16.00 from the
// stale interval and left AtRisk false where the 24h threshold should have
// fired -- under-firing an eating-disorder guardrail on the ordinary path,
// the path of anyone who ends a fast by eating rather than by tapping.
func TestStartingAgainAfterAMealEndedTheLastFastDeclaresANewInterval(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db, foodlog.NewRepository(db))
	ctx := context.Background()

	base := time.Now().Truncate(time.Second)
	mon20 := base.Add(-48 * time.Hour)
	tue12 := base.Add(-32 * time.Hour) // 16h into the fast
	tue20 := base.Add(-24 * time.Hour)

	first, err := repo.Start(ctx, userID, mon20, mon20)
	require.NoError(t, err)

	seedMeal(t, db, userID, tue12)

	// Eating ended it, so nothing is open by Tuesday evening...
	_, open, err := repo.Open(ctx, userID, tue20)
	require.NoError(t, err)
	require.False(t, open, "a meal ends a fast, whatever ended_at says")

	// ...and the new fast is a new interval, not Monday's handed back.
	second, err := repo.Start(ctx, userID, tue20, tue20)
	require.NoError(t, err)
	require.NotEqual(t, first.ID, second.ID,
		"the second start must declare a NEW fast, not return the one a meal already ended")

	// Monday's row is not resurrected and not rewritten: ended_at stays NULL
	// because no explicit end was ever tapped (decision 2).
	var stored Interval
	require.NoError(t, db.Where("id = ?", first.ID).First(&stored).Error)
	require.Nil(t, stored.EndedAt, "an implicit ending must never be written")
	require.Nil(t, stored.EndedBy)

	// The running fast is now the new one, for its full duration.
	current, open, err := repo.Open(ctx, userID, base)
	require.NoError(t, err)
	require.True(t, open)
	require.Equal(t, second.ID, current.ID)
	require.InDelta(t, 24, Hours(current, nil, base), 0.01)
}

// TestOpenReportsNothingOnceAMealEndedTheFast is the /v1/fasting/current half
// of the same bug: a fast the user ate through must not be reported as still
// running.
func TestOpenReportsNothingOnceAMealEndedTheFast(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	ctx := context.Background()
	base := time.Now().Truncate(time.Second)
	started := base.Add(-20 * time.Hour)
	ate := base.Add(-4 * time.Hour)

	repo := NewRepository(db, fakeFirstLogs{at: &ate})
	_, err := repo.Start(ctx, userID, started, started)
	require.NoError(t, err)

	_, open, err := repo.Open(ctx, userID, base)
	require.NoError(t, err)
	require.False(t, open)
}

// TestOpenStillReportsAGenuinelyOpenFast is the guard against fixing the bug
// by declaring everything closed. Nothing has ended this fast: no explicit
// end, no meal since it began, and the cap is hours away.
func TestOpenStillReportsAGenuinelyOpenFast(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	ctx := context.Background()
	base := time.Now().Truncate(time.Second)
	started := base.Add(-18 * time.Hour)
	// A meal from BEFORE the fast began cannot have ended it.
	before := started.Add(-2 * time.Hour)

	repo := NewRepository(db, fakeFirstLogs{at: &before})
	in, err := repo.Start(ctx, userID, started, started)
	require.NoError(t, err)

	got, open, err := repo.Open(ctx, userID, base)
	require.NoError(t, err)
	require.True(t, open, "an 18-hour fast with no meal since is still running")
	require.Equal(t, in.ID, got.ID)
}

// TestOpenReportsNothingPastTheCap: an abandoned fast is over, whatever the
// column says. Without this, one forgotten "start fast" tap would block every
// future fast the user declares.
func TestOpenReportsNothingPastTheCap(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	ctx := context.Background()
	base := time.Now().Truncate(time.Second)
	started := base.Add(-(CapHours + 1) * time.Hour)

	repo := NewRepository(db, nil)
	_, err := repo.Start(ctx, userID, started, started)
	require.NoError(t, err)

	_, open, err := repo.Open(ctx, userID, base)
	require.NoError(t, err)
	require.False(t, open)
}

// TestEndDoesNotEndAFastAMealAlreadyEnded: End must not stamp ended_at on an
// interval that was over hours ago, which would both lie about when it ended
// and (via the stored value) change what the guardrail reads.
func TestEndDoesNotEndAFastAMealAlreadyEnded(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	ctx := context.Background()
	base := time.Now().Truncate(time.Second)
	started := base.Add(-20 * time.Hour)
	ate := base.Add(-6 * time.Hour)

	repo := NewRepository(db, fakeFirstLogs{at: &ate})
	in, err := repo.Start(ctx, userID, started, started)
	require.NoError(t, err)

	_, ended, err := repo.End(ctx, userID, base)
	require.NoError(t, err, "a stale screen is not an error")
	require.False(t, ended)

	var stored Interval
	require.NoError(t, db.Where("id = ?", in.ID).First(&stored).Error)
	require.Nil(t, stored.EndedAt)
}

// TestOpenPropagatesAFirstLogReadFailure: the food-log read is now part of
// the answer to "is a fast open?", so a failure there is an UNKNOWN, not a
// "no meal". Swallowing it would report a fast as running on unknown state --
// the same fail-open the design's decision 5 refuses for the fasting read.
func TestOpenPropagatesAFirstLogReadFailure(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	ctx := context.Background()
	now := time.Now()

	repo := NewRepository(db, nil)
	_, err := repo.Start(ctx, userID, now.Add(-time.Hour), now)
	require.NoError(t, err)

	failing := NewRepository(db, fakeFirstLogs{err: errors.New("food log store unavailable")})
	_, open, err := failing.Open(ctx, userID, now)
	require.Error(t, err)
	require.False(t, open)
}
