package database

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

// onboardingWeighInBackfillSQL loads the ACTUAL shipped up.sql via the same
// embed.FS the real migrator uses, rather than a copy pasted into the test --
// a copy could drift from the file without either failing.
func onboardingWeighInBackfillSQL(t *testing.T) string {
	t.Helper()
	b, err := migrationsFS.ReadFile("migrations/000048_onboarding_first_weighin.up.sql")
	require.NoError(t, err)
	return string(b)
}

// TestOnboardingWeighInBackfillOnlyTargetsEntrylessProfiles is 000048's core
// guarantee: it inserts exactly one weigh-in per profile with a positive
// weight and NO existing weight_entries row, and skips everyone else --
// a zero weight, and a profile that already has a weigh-in.
func TestOnboardingWeighInBackfillOnlyTargetsEntrylessProfiles(t *testing.T) {
	db := testDB(t)
	runBackfill := onboardingWeighInBackfillSQL(t)

	withWeightNoEntry := uuid.New()
	withZeroWeight := uuid.New()
	alreadyHasEntry := uuid.New()

	createdAt := time.Date(2026, 1, 15, 3, 30, 0, 0, time.UTC)

	for _, u := range []struct {
		id       uuid.UUID
		weightKg float64
	}{
		{withWeightNoEntry, 72.5},
		{withZeroWeight, 0},
		{alreadyHasEntry, 68.0},
	} {
		require.NoError(t, db.Exec(
			`INSERT INTO users (id, firebase_uid, email, weight_kg, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			u.id, "backfill-"+u.id.String(), u.id.String()+"@test.dev", u.weightKg, createdAt, createdAt,
		).Error)
	}
	t.Cleanup(func() {
		for _, id := range []uuid.UUID{withWeightNoEntry, withZeroWeight, alreadyHasEntry} {
			db.Exec("DELETE FROM users WHERE id = ?", id)
		}
	})

	// alreadyHasEntry gets a pre-existing weigh-in with a DIFFERENT value, so
	// a run that wrongly re-backfilled it would be caught by the value check
	// below, not just a row-count check.
	require.NoError(t, db.Exec(
		`INSERT INTO weight_entries (user_id, logged_at, weight_kg, local_date, source)
		 VALUES (?, ?, ?, ?, 'manual')`,
		alreadyHasEntry, createdAt, 99.0, createdAt.Format("2006-01-02"),
	).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM weight_entries WHERE user_id IN (?, ?, ?)", withWeightNoEntry, withZeroWeight, alreadyHasEntry)
	})

	require.NoError(t, db.Exec(runBackfill).Error)

	assertEntries := func(id uuid.UUID) []struct {
		WeightKg float64
		Source   string
	} {
		var rows []struct {
			WeightKg float64
			Source   string
		}
		require.NoError(t, db.Raw(
			"SELECT weight_kg, source FROM weight_entries WHERE user_id = ?", id,
		).Scan(&rows).Error)
		return rows
	}

	got := assertEntries(withWeightNoEntry)
	require.Len(t, got, 1, "a positive-weight, entry-less profile must get exactly one backfilled row")
	require.Equal(t, 72.5, got[0].WeightKg)
	require.Equal(t, "manual", got[0].Source)

	require.Empty(t, assertEntries(withZeroWeight), "a zero profile weight must not produce a weigh-in")

	stillOne := assertEntries(alreadyHasEntry)
	require.Len(t, stillOne, 1, "a profile with an existing weigh-in must not gain a second one")
	require.Equal(t, 99.0, stillOne[0].WeightKg, "the pre-existing row must be untouched")

	// Re-running is a no-op: withWeightNoEntry now has an entry, so the
	// NOT EXISTS guard excludes it on this second pass.
	require.NoError(t, db.Exec(runBackfill).Error)
	require.Len(t, assertEntries(withWeightNoEntry), 1, "re-running the backfill must not duplicate the row")
}

// TestOnboardingWeighInBackfillDatesAtProfileCreation confirms the backfilled
// row is dated at the PROFILE's created_at, not now() -- backfilling with
// now() would place a months-old weight on today's chart.
func TestOnboardingWeighInBackfillDatesAtProfileCreation(t *testing.T) {
	db := testDB(t)
	runBackfill := onboardingWeighInBackfillSQL(t)

	id := uuid.New()
	// Deliberately in the past and far from "now" so a now()-dated bug would
	// be obviously wrong rather than accidentally close.
	createdAt := time.Date(2024, 6, 1, 10, 0, 0, 0, time.UTC)

	require.NoError(t, db.Exec(
		`INSERT INTO users (id, firebase_uid, email, weight_kg, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		id, "backfill-date-"+id.String(), id.String()+"@test.dev", 60.0, createdAt, createdAt,
	).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM weight_entries WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})

	require.NoError(t, db.Exec(runBackfill).Error)

	var loggedAt time.Time
	require.NoError(t, db.Raw("SELECT logged_at FROM weight_entries WHERE user_id = ?", id).Scan(&loggedAt).Error)
	require.True(t, loggedAt.Equal(createdAt), "logged_at must equal the profile's created_at, not now()")
}

// TestOnboardingWeighInBackfillLeavesCompositionColumnsNull confirms the
// backfilled row makes no composition claim -- an onboarding weight is a
// weight, not a body-composition reading. See migration 000039.
func TestOnboardingWeighInBackfillLeavesCompositionColumnsNull(t *testing.T) {
	db := testDB(t)
	runBackfill := onboardingWeighInBackfillSQL(t)

	id := uuid.New()
	createdAt := time.Date(2025, 3, 10, 8, 0, 0, 0, time.UTC)
	require.NoError(t, db.Exec(
		`INSERT INTO users (id, firebase_uid, email, weight_kg, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		id, "backfill-comp-"+id.String(), id.String()+"@test.dev", 65.0, createdAt, createdAt,
	).Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM weight_entries WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})

	require.NoError(t, db.Exec(runBackfill).Error)

	var row struct {
		BodyFatPct         *float64
		SubcutaneousFatPct *float64
		VisceralFatRating  *float64
		SkeletalMusclePct  *float64
		MuscleMassKg       *float64
		BodyWaterPct       *float64
		ProteinPct         *float64
		BoneMassKg         *float64
		ScaleBmrKcal       *float64
	}
	require.NoError(t, db.Raw(`
		SELECT body_fat_pct, subcutaneous_fat_pct, visceral_fat_rating, skeletal_muscle_pct,
		       muscle_mass_kg, body_water_pct, protein_pct, bone_mass_kg, scale_bmr_kcal
		FROM weight_entries WHERE user_id = ?`, id).Scan(&row).Error)

	require.Nil(t, row.BodyFatPct)
	require.Nil(t, row.SubcutaneousFatPct)
	require.Nil(t, row.VisceralFatRating)
	require.Nil(t, row.SkeletalMusclePct)
	require.Nil(t, row.MuscleMassKg)
	require.Nil(t, row.BodyWaterPct)
	require.Nil(t, row.ProteinPct)
	require.Nil(t, row.BoneMassKg)
	require.Nil(t, row.ScaleBmrKcal)
}

// onboardingWeighInBackfillDownSQL loads the actual shipped down.sql the same
// way onboardingWeighInBackfillSQL loads up.sql.
func onboardingWeighInBackfillDownSQL(t *testing.T) string {
	t.Helper()
	b, err := migrationsFS.ReadFile("migrations/000048_onboarding_first_weighin.down.sql")
	require.NoError(t, err)
	return string(b)
}

// TestOnboardingWeighInBackfillDownDeletesOnlyMatchingSignature is the down
// migration's documented, narrow guarantee: it deletes a 'manual' row whose
// logged_at and weight_kg exactly match the owning profile's created_at and
// weight_kg (the signature only the up migration produces), and leaves a
// genuine weigh-in -- logged at a different instant -- untouched. See the
// down migration's own comment for what this does and does not undo.
func TestOnboardingWeighInBackfillDownDeletesOnlyMatchingSignature(t *testing.T) {
	db := testDB(t)
	up := onboardingWeighInBackfillSQL(t)
	down := onboardingWeighInBackfillDownSQL(t)

	backfilledUser := uuid.New()
	realWeighInUser := uuid.New()
	createdAt := time.Date(2025, 1, 1, 5, 0, 0, 0, time.UTC)

	for _, u := range []struct {
		id       uuid.UUID
		weightKg float64
	}{
		{backfilledUser, 70.0},
		{realWeighInUser, 55.0},
	} {
		require.NoError(t, db.Exec(
			`INSERT INTO users (id, firebase_uid, email, weight_kg, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			u.id, "down-"+u.id.String(), u.id.String()+"@test.dev", u.weightKg, createdAt, createdAt,
		).Error)
	}
	t.Cleanup(func() {
		db.Exec("DELETE FROM weight_entries WHERE user_id IN (?, ?)", backfilledUser, realWeighInUser)
		db.Exec("DELETE FROM users WHERE id IN (?, ?)", backfilledUser, realWeighInUser)
	})

	// backfilledUser gets the up migration's actual output.
	require.NoError(t, db.Exec(up).Error)

	// realWeighInUser gets a GENUINE manual weigh-in logged a month later --
	// same source, different instant, so it must survive the down migration.
	loggedLater := createdAt.AddDate(0, 1, 0)
	require.NoError(t, db.Exec(
		`INSERT INTO weight_entries (user_id, logged_at, weight_kg, local_date, source, created_at)
		 VALUES (?, ?, 55.0, ?, 'manual', ?)`,
		realWeighInUser, loggedLater, loggedLater.Format("2006-01-02"), loggedLater,
	).Error)

	require.NoError(t, db.Exec(down).Error)

	var backfilledCount, realCount int64
	require.NoError(t, db.Raw("SELECT count(*) FROM weight_entries WHERE user_id = ?", backfilledUser).Scan(&backfilledCount).Error)
	require.NoError(t, db.Raw("SELECT count(*) FROM weight_entries WHERE user_id = ?", realWeighInUser).Scan(&realCount).Error)

	require.Zero(t, backfilledCount, "the down migration must delete the row it backfilled")
	require.EqualValues(t, 1, realCount, "a genuine later weigh-in must survive the down migration")
}
