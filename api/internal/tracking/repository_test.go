package tracking

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
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

// seedUser inserts a bare user row and returns its id.
func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "tr-"+id.String(), "tr@test.dev").Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM water_entries WHERE user_id = ?", id)
		// Scoped to this test's own user, never a truncate — these tests own
		// their fixtures and must not disturb anyone else's rows (kora#151).
		db.Exec("DELETE FROM weight_entries WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func TestAddWaterHappyPath(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	entry, err := repo.AddWater(context.Background(), userID, 500, time.Now(), dayOf(time.Now()))
	require.NoError(t, err)
	require.Equal(t, 500, entry.VolumeML)
	require.NotEqual(t, uuid.Nil, entry.ID)
}

func TestWeightReplayNeverReturnsAnotherUsersEntry(t *testing.T) {
	db := testDB(t)
	owner, other := seedUser(t, db), seedUser(t, db)
	repo := NewRepository(db)
	in := WeightInput{ID: uuid.New(), WeightKg: 71, LoggedAt: time.Now(), LocalDate: time.Now()}
	first, err := repo.AddWeightEntry(t.Context(), owner, in)
	require.NoError(t, err)
	replay, err := repo.AddWeightEntry(t.Context(), owner, in)
	require.NoError(t, err)
	require.Equal(t, first.ID, replay.ID)
	leaked, err := repo.AddWeightEntry(t.Context(), other, in)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound)
	require.Equal(t, uuid.Nil, leaked.ID)
}

func TestAddWaterRejectsNonPositiveVolume(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	_, err := repo.AddWater(context.Background(), userID, 0, time.Time{}, dayOf(time.Time{}))
	require.Error(t, err)

	_, err = repo.AddWater(context.Background(), userID, -100, time.Now(), dayOf(time.Now()))
	require.Error(t, err)
}

func TestAddWaterDefaultsLoggedAtWhenZero(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	entry, err := repo.AddWater(context.Background(), userID, 250, time.Time{}, dayOf(time.Time{}))
	require.NoError(t, err)
	require.False(t, entry.LoggedAt.IsZero())
}

func TestWaterTotalForDaySumsSameDayAndExcludesOtherDays(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	dayD := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	dayD2 := time.Date(2026, 3, 3, 9, 0, 0, 0, time.UTC)
	dayNone := time.Date(2026, 3, 5, 0, 0, 0, 0, time.UTC)

	_, err := repo.AddWater(context.Background(), userID, 250, dayD, dayOf(dayD))
	require.NoError(t, err)
	_, err = repo.AddWater(context.Background(), userID, 500, dayD.Add(2*time.Hour), dayOf(dayD.Add(2*time.Hour)))
	require.NoError(t, err)
	_, err = repo.AddWater(context.Background(), userID, 1000, dayD2, dayOf(dayD2))
	require.NoError(t, err)

	total, err := repo.WaterTotalForDay(context.Background(), userID, dayD)
	require.NoError(t, err)
	require.Equal(t, 750, total)

	total, err = repo.WaterTotalForDay(context.Background(), userID, dayD2)
	require.NoError(t, err)
	require.Equal(t, 1000, total)

	total, err = repo.WaterTotalForDay(context.Background(), userID, dayNone)
	require.NoError(t, err)
	require.Equal(t, 0, total)
}

func TestAddWeightHappyPathAndRejectsNonPositive(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	e, err := repo.AddWeight(context.Background(), userID, 72.4, time.Now(), dayOf(time.Now()))
	require.NoError(t, err)
	require.Equal(t, 72.4, e.WeightKg)
	require.NotEqual(t, uuid.Nil, e.ID)

	_, err = repo.AddWeight(context.Background(), userID, 0, time.Now(), dayOf(time.Now()))
	require.Error(t, err)
	_, err = repo.AddWeight(context.Background(), userID, -5, time.Now(), dayOf(time.Now()))
	require.Error(t, err)
}

func TestWeightSeriesInRangeAscendingAndUserScoped(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	other := seedUser(t, db)
	repo := NewRepository(db)

	d1 := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	d2 := time.Date(2026, 3, 3, 8, 0, 0, 0, time.UTC)
	outOfRange := time.Date(2026, 2, 1, 8, 0, 0, 0, time.UTC)
	_, _ = repo.AddWeight(context.Background(), userID, 73.0, d2, dayOf(d2)) // insert out of order
	_, _ = repo.AddWeight(context.Background(), userID, 74.0, d1, dayOf(d1))
	_, _ = repo.AddWeight(context.Background(), userID, 99.0, outOfRange, dayOf(outOfRange))
	_, _ = repo.AddWeight(context.Background(), other, 60.0, d1, dayOf(d1)) // other user, must be excluded

	got, err := repo.WeightSeries(context.Background(), userID,
		time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC),
		time.Date(2026, 3, 4, 0, 0, 0, 0, time.UTC))
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Equal(t, 74.0, got[0].WeightKg) // ascending by logged_at
	require.Equal(t, 73.0, got[1].WeightKg)
}

// dayOf gives a test the local day matching the instant it is seeding.
//
// It mirrors the repository's own zero-time defaulting: AddWater/AddWeight
// substitute time.Now() for a zero logged_at, so a test passing time.Time{}
// must get today's date here too. Returning the zero date instead would write
// 0001-01-01 and trip the local_date_plausible CHECK — which is exactly the
// silent-corruption case that constraint exists to catch (kora#84).
func dayOf(t time.Time) time.Time {
	if t.IsZero() {
		t = time.Now()
	}
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// ptr is the shorthand these tests need constantly: every body-composition
// metric is a pointer so that absent stays distinguishable from a measured 0.
func ptr(v float64) *float64 { return &v }

func TestAddWeightEntryRoundTripsComposition(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	// The values are a real Renpho reading, so the ranges are the ones the
	// validation actually has to admit rather than invented ones.
	at := time.Now()
	in := WeightInput{
		WeightKg:  70.2,
		LoggedAt:  at,
		LocalDate: dayOf(at),
		Composition: BodyComposition{
			BodyFatPct:         ptr(32.6),
			SubcutaneousFatPct: ptr(28.4),
			VisceralFatRating:  ptr(7.5),
			SkeletalMusclePct:  ptr(48.9),
			MuscleMassKg:       ptr(44.8),
			BodyWaterPct:       ptr(47.3),
			ProteinPct:         ptr(16.1),
			BoneMassKg:         ptr(2.6),
			ScaleBMRKcal:       ptr(1627),
			// Synthetic tape figures, not anyone's measurements — they exist
			// to prove six distinct columns round-trip to six distinct
			// fields, so no two of them share a value.
			NeckCm:  ptr(31),
			ChestCm: ptr(91),
			WaistCm: ptr(71),
			HipCm:   ptr(101),
			ArmCm:   ptr(26),
			ThighCm: ptr(51),
			Source:  SourceScaleScreenshot,
		},
	}

	created, err := repo.AddWeightEntry(context.Background(), userID, in)
	require.NoError(t, err)

	got, err := repo.WeightSeries(context.Background(), userID, at.Add(-time.Hour), at.Add(time.Hour))
	require.NoError(t, err)
	require.Len(t, got, 1)
	stored := got[0]

	require.Equal(t, created.ID, stored.ID)
	require.Equal(t, 70.2, stored.WeightKg)
	require.Equal(t, SourceScaleScreenshot, stored.Source)
	require.Equal(t, 32.6, *stored.BodyFatPct)
	require.Equal(t, 28.4, *stored.SubcutaneousFatPct)
	// A rating, not a percentage — and a fractional one, which is why the
	// column is DOUBLE rather than INT.
	require.Equal(t, 7.5, *stored.VisceralFatRating)
	require.Equal(t, 48.9, *stored.SkeletalMusclePct)
	require.Equal(t, 44.8, *stored.MuscleMassKg)
	require.Equal(t, 47.3, *stored.BodyWaterPct)
	require.Equal(t, 16.1, *stored.ProteinPct)
	require.Equal(t, 2.6, *stored.BoneMassKg)
	require.Equal(t, 1627.0, *stored.ScaleBMRKcal)
	// Distinct values per column: a transposed pair would survive assertions
	// written against a shared number.
	require.Equal(t, 31.0, *stored.NeckCm)
	require.Equal(t, 91.0, *stored.ChestCm)
	require.Equal(t, 71.0, *stored.WaistCm)
	require.Equal(t, 101.0, *stored.HipCm)
	require.Equal(t, 26.0, *stored.ArmCm)
	require.Equal(t, 51.0, *stored.ThighCm)
}

// The whole reason the metrics are pointers: a user who steps on a basic scale
// has no body fat reading, and 0.0% is a very different claim from "unknown".
// A chart plotting the second as the first draws a cliff that never happened.
func TestAbsentMetricRoundTripsAsAbsentNotZero(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	at := time.Now()
	_, err := repo.AddWeightEntry(context.Background(), userID, WeightInput{
		WeightKg:    70.2,
		LoggedAt:    at,
		LocalDate:   dayOf(at),
		Composition: BodyComposition{BodyFatPct: ptr(0)},
	})
	require.NoError(t, err)

	later := at.Add(time.Minute)
	_, err = repo.AddWeightEntry(context.Background(), userID, WeightInput{
		WeightKg:  70.2,
		LoggedAt:  later,
		LocalDate: dayOf(later),
	})
	require.NoError(t, err)

	got, err := repo.WeightSeries(context.Background(), userID, at.Add(-time.Hour), at.Add(time.Hour))
	require.NoError(t, err)
	require.Len(t, got, 2)

	require.NotNil(t, got[0].BodyFatPct, "a measured 0.0%% must survive as a measurement")
	require.Equal(t, 0.0, *got[0].BodyFatPct)
	require.Nil(t, got[1].BodyFatPct, "an unmeasured metric must stay absent, never become 0")
	require.Nil(t, got[1].MuscleMassKg)
	require.Nil(t, got[1].ScaleBMRKcal)
	require.Nil(t, got[1].WaistCm, "an untaken tape measurement must stay absent")
	require.Nil(t, got[1].NeckCm)
}

// An entry with no stated instrument is a typed one, and the column is NOT
// NULL, so the default has to be applied before the insert rather than left to
// the database to guess.
func TestAddWeightDefaultsSourceToManual(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	at := time.Now()
	e, err := repo.AddWeight(context.Background(), userID, 72.4, at, dayOf(at))
	require.NoError(t, err)
	require.Equal(t, SourceManual, e.Source)

	got, err := repo.WeightSeries(context.Background(), userID, at.Add(-time.Hour), at.Add(time.Hour))
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, SourceManual, got[0].Source)
}

// Out-of-range values are rejected rather than stored: an impossible number
// looks like data forever and deforms every chart drawn from it, whereas a
// rejected write is visible at the moment the mistake is made.
func TestAddWeightEntryRejectsImpossibleComposition(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	at := time.Now()
	cases := map[string]BodyComposition{
		"body fat above 100":         {BodyFatPct: ptr(100.1)},
		"negative body fat":          {BodyFatPct: ptr(-0.1)},
		"subcutaneous fat above 100": {SubcutaneousFatPct: ptr(140)},
		"skeletal muscle above 100":  {SkeletalMusclePct: ptr(101)},
		"body water above 100":       {BodyWaterPct: ptr(100.5)},
		"protein above 100":          {ProteinPct: ptr(1000)},
		"zero muscle mass":           {MuscleMassKg: ptr(0)},
		"negative bone mass":         {BoneMassKg: ptr(-2.6)},
		"non-positive scale bmr":     {ScaleBMRKcal: ptr(0)},
		// A percentage mistakenly written into the rating field: 32.6 would
		// pass a 0-100 bound, so the rating is bounded by the widest vendor
		// scale in use (Tanita's 1-59) instead.
		"visceral rating above vendor scale": {VisceralFatRating: ptr(60)},
		"non-positive visceral rating":       {VisceralFatRating: ptr(0)},
		"unknown instrument":                 {Source: Source("renpho")},
		// A tape measurement of 0 is an empty field that arrived as a number,
		// and a negative one cannot be measured at all. Above the bound is
		// millimetres typed into a centimetre field.
		"zero neck":          {NeckCm: ptr(0)},
		"negative chest":     {ChestCm: ptr(-91)},
		"waist beyond bound": {WaistCm: ptr(maxMeasurementCm + 0.1)},
		"hip in millimetres": {HipCm: ptr(1010)},
		"zero arm":           {ArmCm: ptr(0)},
		"thigh beyond bound": {ThighCm: ptr(510)},
	}
	for name, comp := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := repo.AddWeightEntry(context.Background(), userID, WeightInput{
				WeightKg:    70.2,
				LoggedAt:    at,
				LocalDate:   dayOf(at),
				Composition: comp,
			})
			require.Error(t, err)
			require.IsType(t, httpx.ValidationError{}, err, "must be a 400, not a constraint violation")
		})
	}
}

// A rejection has to say WHICH measurement was wrong. Six length fields share
// one bound, so an error reading only "must be between 0 and 300" leaves the
// caller guessing which of six inputs to fix.
func TestTapeMeasurementRejectionNamesTheField(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	at := time.Now()
	_, err := repo.AddWeightEntry(context.Background(), userID, WeightInput{
		WeightKg:    70.2,
		LoggedAt:    at,
		LocalDate:   dayOf(at),
		Composition: BodyComposition{ThighCm: ptr(510)},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "thigh_cm")
	// Named for the column and the wire, so the message is greppable from
	// either end.
	require.NotContains(t, err.Error(), "ThighCm")
}

// The bounds admit real readings, not just reject bad ones — a validation that
// only ever says no is indistinguishable from a broken write path.
func TestAddWeightEntryAcceptsEdgeOfRangeValues(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	at := time.Now()
	_, err := repo.AddWeightEntry(context.Background(), userID, WeightInput{
		WeightKg:  70.2,
		LoggedAt:  at,
		LocalDate: dayOf(at),
		Composition: BodyComposition{
			BodyFatPct:        ptr(100),
			ProteinPct:        ptr(0),
			VisceralFatRating: ptr(maxVisceralFatRating),
			// The tape bound is inclusive at the top and exclusive at the
			// bottom, so the largest admissible measurement must be accepted.
			WaistCm: ptr(maxMeasurementCm),
			NeckCm:  ptr(0.1),
			Source:  SourceDEXA,
		},
	})
	require.NoError(t, err)
}

// Every constant in Sources must satisfy weight_entries_source_check, or the Go
// layer accepts a write the database then refuses with a 500.
func TestEverySourceConstantSatisfiesTheCheckConstraint(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	repo := NewRepository(db)

	for i, src := range Sources {
		at := time.Now().Add(time.Duration(i) * time.Minute)
		_, err := repo.AddWeightEntry(context.Background(), userID, WeightInput{
			WeightKg:    70.2,
			LoggedAt:    at,
			LocalDate:   dayOf(at),
			Composition: BodyComposition{Source: src},
		})
		require.NoError(t, err, "source %q is in Sources but rejected on write", src)
	}
}
