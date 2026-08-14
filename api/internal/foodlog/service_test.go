package foodlog

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/metrics"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"

	"github.com/stretchr/testify/assert"
)

// fakeResolutionCache is a ResolutionCache test double that records every
// key it was asked to Delete, so tests can assert exactly when (and with
// what key) EditLog invalidates the AI resolve cache.
type fakeResolutionCache struct {
	deleted []string
}

func (f *fakeResolutionCache) Delete(ctx context.Context, key string) error {
	f.deleted = append(f.deleted, key)
	return nil
}

var _ ResolutionCache = (*fakeResolutionCache)(nil)

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
		id, "fl-"+id.String(), "fl@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

func TestLogFoodComputesMacrosFromGrams(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	// Insert a known food: 100 kcal/100g, 10g protein/100g.
	item := nutrition.FoodItem{Name: "Test Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10, CarbsPer100g: 20, FatPer100g: 5, FiberPer100g: 2}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 200, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)
	require.Equal(t, 200.0, log.Kcal)    // 100/100g * 200g
	require.Equal(t, 20.0, log.ProteinG) // 10/100g * 200g
	require.Equal(t, nutrition.ProvenanceAFCD, log.Provenance)
}

// TestLogFoodRetiredFoodReturnsValidationError proves that logging a food
// whose GetByID now filters retired rows is a 400, not the 500 a bare
// fmt.Errorf("resolve food: %w", err) wrap would produce. This case was
// effectively unreachable before soft delete (a hard delete CASCADEd, so the
// client's food_item_id vanished with the row) — filtering GetByID is what
// turns it into a normal occurrence: a client's food picker cache can
// predate a retire, or an offline-queued log can be replayed after one. A
// 500 here costs five wasted replays across drain triggers before the item
// moves to failed, whereas a 400 fails on the first refusal with a legible
// message the user can act on.
func TestLogFoodRetiredFoodReturnsValidationError(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Retired LogFood Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	require.NoError(t, db.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", item.ID).Error)

	svc := NewService(NewRepository(db), nutriRepo)
	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now(),
	}, nil)
	require.Error(t, err)
	msg, ok := httpx.IsValidation(err)
	require.True(t, ok, "a retired food_item_id must be a client ValidationError (400), not a 500 that costs five wasted replays; got: %v", err)
	require.Equal(t, "food_item_id not found", msg)
	require.False(t, errors.Is(err, gorm.ErrRecordNotFound), "error must not still satisfy gorm.ErrRecordNotFound (would map to a misleading 404 upstream)")
}

// The live twin of TestLogFoodRetiredFoodReturnsValidationError: a
// non-retired food must still log successfully through the same GetByID call
// path.
func TestLogFoodLiveFoodStillLogsSuccessfully(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Live LogFood Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)
	require.Equal(t, item.Name, log.Description)
}

// TestLogFoodPersistsPortionAssumedTrue proves a log created with
// portion_assumed: true carries that flag through create and read back —
// see #138: the hedge shown at capture must survive into the diary.
func TestLogFoodPersistsPortionAssumedTrue(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Assumed Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 100, LoggedAt: time.Now(), PortionAssumed: true,
	}, nil)
	require.NoError(t, err)
	require.True(t, created.PortionAssumed)

	fetched, err := NewRepository(db).GetByID(context.Background(), userID, created.ID)
	require.NoError(t, err)
	require.True(t, fetched.PortionAssumed, "portion_assumed must survive a read back, not just the create response")
}

// TestLogFoodDefaultsPortionAssumedFalse proves a log created WITHOUT the
// field reads back as false — the Go zero value, matching the column
// default — never null, never absent.
func TestLogFoodDefaultsPortionAssumedFalse(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Not Assumed Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 100, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)
	require.False(t, created.PortionAssumed)

	fetched, err := NewRepository(db).GetByID(context.Background(), userID, created.ID)
	require.NoError(t, err)
	require.False(t, fetched.PortionAssumed)
}

// TestPortionAssumedDoesNotAffectDayTotals pins "the flag is a LABEL, never
// an input to arithmetic" (#138): two logs with identical nutrition, one
// assumed and one not, must sum to exactly twice one row's kcal.
func TestPortionAssumedDoesNotAffectDayTotals(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Totals Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	day := time.Date(2026, 5, 1, 9, 0, 0, 0, time.UTC)

	assumed, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "breakfast", Source: "manual",
		QuantityGrams: 150, LoggedAt: day, PortionAssumed: true,
	}, nil)
	require.NoError(t, err)
	measured, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "breakfast", Source: "manual",
		QuantityGrams: 150, LoggedAt: day.Add(time.Hour),
	}, nil)
	require.NoError(t, err)

	require.Equal(t, assumed.Kcal, measured.Kcal, "identical grams of the same item must produce identical kcal regardless of the flag")

	// Go through the real aggregate rather than hand-summing rows, so a
	// future change that filtered totals on the flag would actually fail
	// this test.
	m, err := NewRepository(db).DailyKcal(context.Background(), userID, day, day.Add(24*time.Hour), time.UTC)
	require.NoError(t, err)
	require.Equal(t, 2*measured.Kcal, m[day.Format("2006-01-02")], "portion_assumed must never be an input to the day's kcal total")
}

func TestCopyDayClonesLogsToNewDate(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Copy Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	day1 := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 1, 11, 8, 0, 0, 0, time.UTC)
	_, err := svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: day1}, nil)
	require.NoError(t, err)

	n, err := svc.CopyDay(context.Background(), userID, day1, day2)
	require.NoError(t, err)
	require.Equal(t, 1, n)

	logs, err := NewRepository(db).ListByUserAndDay(context.Background(), userID, day2)
	require.NoError(t, err)
	require.Len(t, logs, 1)
}

func TestEditLogGramsChangeRecomputesFromSameFoodRow(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Edit Grams Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 150, ProteinPer100g: 12, CarbsPer100g: 20, FatPer100g: 5, FiberPer100g: 2}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)
	wantDescription := created.Description

	newGrams := 250.0
	res, err := svc.EditLog(context.Background(), userID, created.ID, EditRequest{QuantityGrams: &newGrams})
	require.NoError(t, err)
	require.Equal(t, newGrams, res.Log.QuantityGrams)
	require.InDelta(t, item.KcalPer100g*newGrams/100, res.Log.Kcal, 0.001)
	require.InDelta(t, item.ProteinPer100g*newGrams/100, res.Log.ProteinG, 0.001)
	require.Equal(t, wantDescription, res.Log.Description)
}

// TestEditLogOverwritingGramsClearsPortionAssumed proves the server clears a
// stale hedge rather than trusting clients to send portion_assumed: false —
// see #138. A stored true no longer describes a portion the user just
// overwrote by hand.
func TestEditLogOverwritingGramsClearsPortionAssumed(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Clear Assumed Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 100, LoggedAt: time.Now(), PortionAssumed: true,
	}, nil)
	require.NoError(t, err)
	require.True(t, created.PortionAssumed)

	newGrams := 180.0
	res, err := svc.EditLog(context.Background(), userID, created.ID, EditRequest{QuantityGrams: &newGrams})
	require.NoError(t, err)
	require.False(t, res.Log.PortionAssumed, "editing the portion by hand must clear the stale hedge")

	fetched, err := NewRepository(db).GetByID(context.Background(), userID, created.ID)
	require.NoError(t, err)
	require.False(t, fetched.PortionAssumed)
}

// TestEditLogEnteredPairClearsPortionAssumed is the sibling of
// TestEditLogOverwritingGramsClearsPortionAssumed for the OTHER path that
// overwrites the portion: re-resolving from a new entered pair (e.g. "1
// cup") instead of a bare grams figure. A unit-aware client is if anything
// MORE likely to take this path, so it must clear the same stale hedge — see
// #138.
func TestEditLogEnteredPairClearsPortionAssumed(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)

	item := nutrition.FoodItem{
		Name: "Clear Assumed Sachet Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`),
		KcalPer100g:  545.45,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "snack", Source: "manual",
		QuantityGrams: 100, LoggedAt: time.Now(), PortionAssumed: true,
	}, nil)
	require.NoError(t, err)
	require.True(t, created.PortionAssumed)

	amount := 3.0
	unit := "sachet"
	res, err := svc.EditLog(context.Background(), userID, created.ID, EditRequest{
		EnteredAmount: &amount, EnteredUnit: &unit,
	})
	require.NoError(t, err)
	require.False(t, res.Log.PortionAssumed, "re-resolving from a real entered unit must clear the stale hedge")

	fetched, err := NewRepository(db).GetByID(context.Background(), userID, created.ID)
	require.NoError(t, err)
	require.False(t, fetched.PortionAssumed)
}

// TestEditLogMealSlotOnlyLeavesPortionAssumedUntouched proves the clear is
// scoped to edits that actually change the portion: an edit that changes
// only meal_slot (or, symmetrically, only logged_at) falls through both
// grams-resolution branches and must NOT clear the flag, because nothing
// about the amount changed.
func TestEditLogMealSlotOnlyLeavesPortionAssumedUntouched(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Untouched Assumed Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 100, LoggedAt: time.Now(), PortionAssumed: true,
	}, nil)
	require.NoError(t, err)
	require.True(t, created.PortionAssumed)

	res, err := svc.EditLog(context.Background(), userID, created.ID, EditRequest{MealSlot: "dinner"})
	require.NoError(t, err)
	require.True(t, res.Log.PortionAssumed, "a meal_slot-only edit does not change the portion and must not clear the hedge")

	fetched, err := NewRepository(db).GetByID(context.Background(), userID, created.ID)
	require.NoError(t, err)
	require.True(t, fetched.PortionAssumed)
}

func TestEditLogFoodChangeWithCorrectionPhraseRecordsAlias(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	oldItem := nutrition.FoodItem{Name: "Old Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&oldItem).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", oldItem.ID) })
	newItem := nutrition.FoodItem{Name: "New Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 200, ProteinPer100g: 15}
	require.NoError(t, db.Create(&newItem).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", newItem.ID) })

	phrase := "my brekkie " + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM food_aliases WHERE lower(alias) = ?", phrase) })

	// The phrase is now server-derived from the log's own input_phrase (set
	// only for ai_text/ai_voice sources), not client-supplied — seed the log
	// with it rather than passing a correction_phrase on the request.
	created := seedPhraseLog(t, db, userID, oldItem, phrase)

	svc := NewService(NewRepository(db), nutriRepo)
	res, err := svc.EditLog(context.Background(), userID, created.ID, EditRequest{
		FoodItemID: &newItem.ID,
	})
	require.NoError(t, err)
	require.True(t, res.AliasRecorded)
	require.Equal(t, 200.0, res.Log.Kcal) // recomputed from new item at same 100g
	require.Equal(t, newItem.Name, res.Log.Description)

	cands, err := nutriRepo.Resolve(context.Background(), userID, phrase, nil, 5)
	require.NoError(t, err)
	require.NotEmpty(t, cands)
	require.Equal(t, newItem.ID, cands[0].Item.ID)
	require.Equal(t, nutrition.MatchAlias, cands[0].MatchTier)
}

func TestEditLogFoodChangeWithoutCorrectionPhraseRecordsNoAlias(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	oldItem := nutrition.FoodItem{Name: "Old Food2 " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&oldItem).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", oldItem.ID) })
	newItem := nutrition.FoodItem{Name: "New Food2 " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 200}
	require.NoError(t, db.Create(&newItem).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", newItem.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &oldItem.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)

	_, err = svc.EditLog(context.Background(), userID, created.ID, EditRequest{FoodItemID: &newItem.ID})
	require.NoError(t, err)

	var n int64
	db.Raw("SELECT count(*) FROM food_aliases WHERE food_item_id = ?", newItem.ID).Scan(&n)
	require.Equal(t, int64(0), n)
}

func TestEditLogNonexistentFoodItemIDReturnsValidationError(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Bad FoodID Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)

	bogusFoodID := uuid.New()
	_, err = svc.EditLog(context.Background(), userID, created.ID, EditRequest{FoodItemID: &bogusFoodID})
	require.Error(t, err)
	msg, ok := httpx.IsValidation(err)
	require.True(t, ok, "expected httpx.ValidationError, got: %v", err)
	require.Equal(t, "food_item_id not found", msg)
	require.False(t, errors.Is(err, gorm.ErrRecordNotFound), "error must not still satisfy gorm.ErrRecordNotFound (would map to misleading 404)")
}

func TestCreateBatchComputesMacrosServerSide(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Batch Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10, CarbsPer100g: 20, FatPer100g: 5, FiberPer100g: 2}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	logs, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{{FoodItemID: item.ID, QuantityGrams: 200}},
	}, nil)
	require.NoError(t, err)
	require.Len(t, logs, 1)
	require.Equal(t, item.KcalPer100g*2.0, logs[0].Kcal, "kcal must be server-computed from item per-100g * grams")
	require.Equal(t, item.ProteinPer100g*2.0, logs[0].ProteinG)
	require.Equal(t, item.CarbsPer100g*2.0, logs[0].CarbsG)
	require.Equal(t, item.FatPer100g*2.0, logs[0].FatG)
	require.Equal(t, item.FiberPer100g*2.0, logs[0].FiberG)
}

// TestCreateBatchPersistsPortionAssumedPerItem proves the batch path — how
// capture logs several candidates from one photo — carries portion_assumed
// per item, not just the single-log path. Missing this would leave every
// multi-item capture unmarked, which is the common case for a photo of a
// plate. See #138.
func TestCreateBatchPersistsPortionAssumedPerItem(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Batch Assumed Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	logs, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{
			{FoodItemID: item.ID, QuantityGrams: 100, PortionAssumed: true},
			{FoodItemID: item.ID, QuantityGrams: 100},
		},
	}, nil)
	require.NoError(t, err)
	require.Len(t, logs, 2)
	require.True(t, logs[0].PortionAssumed, "the first item requested portion_assumed: true")
	require.False(t, logs[1].PortionAssumed, "the second item omitted it and must default false")
}

// TestCreateBatchRejectsAForeignSource: `source` is bound straight from the
// request body, so without an allowlist a client could POST {"source":"ai_text"}
// and write correction-eligible rows carrying no input_phrase — the invariant
// 000020_log_corrections documents — or pass "manual" and make a fan-out
// indistinguishable from hand entry in dashboard.SourceCounts.
func TestCreateBatchRejectsAForeignSource(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	item := nutrition.FoodItem{Name: "Batch Src " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE user_id = ?", userID) })

	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	req := func(source string) CreateBatchRequest {
		return CreateBatchRequest{
			LoggedAt: time.Now(), MealSlot: "breakfast", Source: source,
			Items: []BatchItem{{FoodItemID: item.ID, QuantityGrams: 100}},
		}
	}

	for _, source := range []string{"ai_text", "ai_voice", "ai_photo", "manual", "nonsense", strings.Repeat("x", 500)} {
		_, err := svc.CreateBatch(context.Background(), userID, req(source), nil)
		require.Error(t, err, "source %q must be rejected", source)
		_, ok := httpx.IsValidation(err)
		require.True(t, ok, "want ValidationError for source %q, got: %v", source, err)
	}

	for _, source := range []string{"", "memory", "meal", "recipe"} {
		logs, err := svc.CreateBatch(context.Background(), userID, req(source), nil)
		require.NoError(t, err, "source %q is a legitimate batch source", source)
		require.Len(t, logs, 1)
		if source == "" {
			require.Equal(t, "memory", logs[0].Source, "empty still means memory")
		} else {
			require.Equal(t, source, logs[0].Source)
		}
	}
}

func TestCreateBatchRejectsEmptyItems(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	_, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast", Items: nil,
	}, nil)
	require.Error(t, err)
	_, ok := httpx.IsValidation(err)
	require.True(t, ok, "want ValidationError on empty items, got: %v", err)
}

func TestCreateBatchRollsBackWholeBatchOnUnresolvableItem(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Batch Rollback Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	bogusID := uuid.New()
	since := time.Now().Add(-time.Hour)

	_, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{
			{FoodItemID: item.ID, QuantityGrams: 100},
			{FoodItemID: bogusID, QuantityGrams: 100},
		},
	}, nil)
	require.Error(t, err)

	logs, err := NewRepository(db).ListForUserSince(context.Background(), userID, since)
	require.NoError(t, err)
	require.Empty(t, logs, "the resolvable item must NOT have been committed — batch must be atomic")
}

// A rolled-back batch must not move kora_food_logs_total. Counting rows that
// were never actually persisted would let a client inflate the total-logs
// denominator (and so deflate photo share) just by looping a batch with a
// bogus food_item_id in it.
func TestCreateBatchRollbackDoesNotCountFoodLogMetric(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Batch Metric Rollback Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	bogusID := uuid.New()

	before := testutil.ToFloat64(metrics.Default().FoodLogsCounter("memory"))

	_, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{
			{FoodItemID: item.ID, QuantityGrams: 100},
			{FoodItemID: bogusID, QuantityGrams: 100},
		},
	}, nil)
	require.Error(t, err)

	after := testutil.ToFloat64(metrics.Default().FoodLogsCounter("memory"))
	require.Equal(t, before, after, "a rolled-back batch must not increment kora_food_logs_total for the item that inserted before the rollback")
}

// The mirror of the rollback test above, and it is not redundant with it: the
// rollback test only proves the counter does NOT move, so deleting the entire
// post-commit recording loop in Repository.Transaction leaves it green. That
// failure would deflate the total-logs denominator and INFLATE photo share —
// the exact mirror of the over-count the deferred recording was added to fix,
// and equally corrupting to the number #41 gates on.
func TestCreateBatchSuccessCountsEachCommittedLog(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Batch Metric Commit Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	before := testutil.ToFloat64(metrics.Default().FoodLogsCounter("memory"))

	created, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{
			{FoodItemID: item.ID, QuantityGrams: 100},
			{FoodItemID: item.ID, QuantityGrams: 150},
		},
	}, nil)
	require.NoError(t, err)
	require.Len(t, created, 2)

	after := testutil.ToFloat64(metrics.Default().FoodLogsCounter("memory"))
	require.Equal(t, before+2, after, "a committed batch must count every row it inserted")
}

func TestCreateBatchUnknownFoodItemIDReturnsValidationError(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	bogusFoodID := uuid.New()
	_, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{{FoodItemID: bogusFoodID, QuantityGrams: 100}},
	}, nil)
	require.Error(t, err)
	msg, ok := httpx.IsValidation(err)
	require.True(t, ok, "unknown food_item_id must be a client ValidationError (400), got: %v", err)
	require.Equal(t, "unknown food_item_id", msg)
	require.False(t, errors.Is(err, gorm.ErrRecordNotFound), "not-found must be converted, not leaked as gorm.ErrRecordNotFound")
}

// TestCreateBatchRetiredFoodItemNamesTheUnavailableFood covers the saved-meal
// case: savedmeals.Repository.ItemsForMeals deliberately keeps an unfiltered
// JOIN, so a user can still see a saved meal containing a retired item, tap
// "log", and hit this batch path. The user never chose the food_item_id
// (it came from the meal, not their own typing), so the error must name the
// FOOD that's unavailable, not a bare id they wouldn't recognize.
func TestCreateBatchRetiredFoodItemNamesTheUnavailableFood(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Retired Batch Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	require.NoError(t, db.Exec("UPDATE food_items SET deleted_at = now() WHERE id = ?", item.ID).Error)

	svc := NewService(NewRepository(db), nutriRepo)
	_, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{{FoodItemID: item.ID, QuantityGrams: 100}},
	}, nil)
	require.Error(t, err)
	msg, ok := httpx.IsValidation(err)
	require.True(t, ok, "a retired food_item_id must still be a client ValidationError (400), got: %v", err)
	require.Contains(t, msg, item.Name, "the error must name the unavailable FOOD, not a bare id the user never chose")
	require.NotEqual(t, "unknown food_item_id", msg, "a retired item is a known food with a name — must not fall back to the truly-unknown-id message")
}

func TestCreateBatchInfraFaultIsNotMisclassifiedAsValidation(t *testing.T) {
	// Log repo is healthy (transaction begins, cleanups run); the FOODS repo is
	// broken so GetByID fails with a driver error (not gorm.ErrRecordNotFound).
	// That infra fault must surface as a 500-class error, never a client 400.
	db := testDB(t)
	userID := seedUser(t, db)

	brokenDB := testDB(t)
	brokenPool, err := brokenDB.DB()
	require.NoError(t, err)
	require.NoError(t, brokenPool.Close())

	svc := NewService(NewRepository(db), nutrition.NewRepository(brokenDB))
	_, err = svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{{FoodItemID: uuid.New(), QuantityGrams: 100}},
	}, nil)
	require.Error(t, err)
	require.False(t, errors.Is(err, gorm.ErrRecordNotFound), "driver fault must not masquerade as record-not-found")
	_, ok := httpx.IsValidation(err)
	require.False(t, ok, "infra fault must NOT be a ValidationError, got a 400-class error: %v", err)
}

// TestCreateBatchResolvesEnteredUnits proves a saved meal logs each item in
// the unit it was saved in: the SERVER resolves the entered (amount, unit)
// pair into quantity_grams here, exactly once, and stores the entered pair
// beside the resolved figure. The client sends quantity_grams: 0 as a
// placeholder for the entered-pair item, so the positive-quantity guard must
// run against the RESOLVED grams, not that placeholder.
func TestCreateBatchResolvesEnteredUnits(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)

	// One sachet is 16.5g, base unit grams.
	sachet := nutrition.FoodItem{
		Name: "Batch Sachet Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`),
		KcalPer100g:  100,
	}
	require.NoError(t, db.Create(&sachet).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", sachet.ID) })

	milk := nutrition.FoodItem{
		Name: "Batch Milk Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit: "ml", ServingUnits: json.RawMessage(`[]`), KcalPer100g: 60,
	}
	require.NoError(t, db.Create(&milk).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", milk.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	amount := 2.0
	unit := "sachet"

	got, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "snack",
		Items: []BatchItem{
			{FoodItemID: sachet.ID, EnteredAmount: &amount, EnteredUnit: &unit},
			{FoodItemID: milk.ID, QuantityGrams: 200},
		},
	}, nil)
	require.NoError(t, err)
	require.Len(t, got, 2)

	// 2 sachets x 16.5g = 33g, resolved server-side, entered pair stored beside it.
	assert.InDelta(t, 33.0, got[0].QuantityGrams, 1e-9)
	require.NotNil(t, got[0].EnteredUnit)
	assert.Equal(t, "sachet", *got[0].EnteredUnit)
	require.NotNil(t, got[0].EnteredAmount)
	assert.InDelta(t, 2.0, *got[0].EnteredAmount, 1e-9)
	assert.InDelta(t, sachet.KcalPer100g*0.33, got[0].Kcal, 1e-9, "nutrition must be computed from the RESOLVED grams")

	// The gram-entered item is untouched and keeps a null pair.
	assert.InDelta(t, 200.0, got[1].QuantityGrams, 1e-9)
	assert.Nil(t, got[1].EnteredUnit)
	assert.Nil(t, got[1].EnteredAmount)
}

// TestCreateBatchRejectsUnknownUnitAndLogsNothing proves an unresolvable
// entered unit joins CreateBatch's existing all-or-nothing failure path: it
// names the ingredient (mirroring the unresolvable-food_item_id case) and
// rolls back every item in the batch, including ones that resolved fine.
func TestCreateBatchRejectsUnknownUnitAndLogsNothing(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)

	milk := nutrition.FoodItem{
		Name: "Batch Unknown Unit Milk " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit: "ml", ServingUnits: json.RawMessage(`[]`), KcalPer100g: 60,
	}
	require.NoError(t, db.Create(&milk).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", milk.ID) })

	sachet := nutrition.FoodItem{
		Name: "Batch Unknown Unit Sachet " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`),
		KcalPer100g:  100,
	}
	require.NoError(t, db.Create(&sachet).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", sachet.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	since := time.Now().Add(-time.Hour)
	amount := 1.0
	unit := "bucket"

	_, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "snack",
		Items: []BatchItem{
			{FoodItemID: milk.ID, QuantityGrams: 200},
			{FoodItemID: sachet.ID, EnteredAmount: &amount, EnteredUnit: &unit},
		},
	}, nil)
	require.Error(t, err)
	msg, ok := httpx.IsValidation(err)
	require.True(t, ok, "unresolvable entered unit must be a client ValidationError (400), got: %v", err)
	// The message must name the ingredient, the way the unresolvable-id path
	// already does — an opaque "unrecognised unit" tells the user nothing
	// about WHICH item of their saved meal is the problem.
	assert.Contains(t, msg, units.UnrecognisedUnitMessage)
	assert.Contains(t, msg, sachet.Name)

	logs, listErr := NewRepository(db).ListForUserSince(context.Background(), userID, since)
	require.NoError(t, listErr)
	assert.Empty(t, logs, "all-or-nothing: the VALID first item must not have been logged either")
}

func TestEditLogInvalidMealSlotReturnsValidationError(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Slot Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)

	_, err = svc.EditLog(context.Background(), userID, created.ID, EditRequest{MealSlot: "brunch"})
	require.Error(t, err)
	_, ok := httpx.IsValidation(err)
	require.True(t, ok)
}

func TestLogFoodPersistsInputPhraseForTextSource(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Phrase Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	phrase := "brekkie eggs"
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "breakfast", Source: "ai_text",
		QuantityGrams: 100, InputPhrase: &phrase,
	}, nil)
	require.NoError(t, err)
	require.NotNil(t, log.InputPhrase)
	require.Equal(t, "brekkie eggs", *log.InputPhrase)
	require.Equal(t, item.Name, log.Description, "description stays the RESOLVED name")
}

func TestLogFoodIgnoresInputPhraseForNonResolveSource(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Phrase Food M " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	phrase := "not from a resolve"
	// A manual log has no AI guess to correct, so there is nothing to teach
	// the index with — the phrase must be dropped rather than stored.
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 100, InputPhrase: &phrase,
	}, nil)
	require.NoError(t, err)
	require.Nil(t, log.InputPhrase)
}

func TestLogFoodPersistsInputPhraseForVoiceSource(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Phrase Food V " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	phrase := "two boiled eggs"
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "breakfast", Source: "ai_voice",
		QuantityGrams: 100, InputPhrase: &phrase,
	}, nil)
	require.NoError(t, err)
	require.NotNil(t, log.InputPhrase)
	require.Equal(t, "two boiled eggs", *log.InputPhrase)
}

// seedPhraseLog creates an ai_text log for `from` carrying `phrase`.
func seedPhraseLog(t *testing.T, db *gorm.DB, userID uuid.UUID, from nutrition.FoodItem, phrase string) FoodLog {
	t.Helper()
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &from.ID, MealSlot: "lunch", Source: "ai_text",
		QuantityGrams: 100, InputPhrase: &phrase,
	}, nil)
	require.NoError(t, err)
	return log
}

func TestEditLogWritesPersonalAliasWhenFoodChanges(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice C " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa C " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "the grain thing " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)

	svc := NewService(NewRepository(db), nutriRepo)
	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)
	require.True(t, res.AliasRecorded)
	require.Equal(t, quinoa.ID, *res.Log.FoodItemID)

	// The alias must be keyed on the phrase the LOG carries, personal to this user.
	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, strings.ToLower(phrase), quinoa.ID).Scan(&n).Error)
	require.EqualValues(t, 1, n)
}

func TestEditLogWritesNoAliasWhenLogHasNoPhrase(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice N " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa N " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	// A manual log carries no phrase, so there is nothing to teach.
	log, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &rice.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100,
	}, nil)
	require.NoError(t, err)

	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)
	require.False(t, res.AliasRecorded)

	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ?", userID).Scan(&n).Error)
	require.EqualValues(t, 0, n)
}

func TestEditLogWritesNoAliasWhenOnlyPortionChanges(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice P " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	require.NoError(t, db.Create(&rice).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", rice.ID) })

	phrase := "portion only " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)

	svc := NewService(NewRepository(db), nutriRepo)
	grams := 200.0
	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{QuantityGrams: &grams})
	require.NoError(t, err)
	require.False(t, res.AliasRecorded, "a portion change teaches the index nothing")
	require.Equal(t, 200.0, res.Log.QuantityGrams)
}

func TestEditLogRetractsTheAliasTheCorrectionCreated(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice R " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa R " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "undo me " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)
	svc := NewService(NewRepository(db), nutriRepo)

	// Correct rice -> quinoa, which teaches (phrase -> quinoa).
	_, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)

	// Undo: revert to rice AND un-teach what the correction taught.
	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{
		FoodItemID: &rice.ID, RetractCorrection: true,
	})
	require.NoError(t, err)
	require.Equal(t, rice.ID, *res.Log.FoodItemID)

	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, strings.ToLower(phrase), quinoa.ID).Scan(&n).Error)
	require.EqualValues(t, 0, n, "the alias the correction created must be gone")
}

func TestEditLogRetractDoesNotAliasTheRevertTarget(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice RT " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa RT " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "no rebound " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)
	svc := NewService(NewRepository(db), nutriRepo)

	_, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)
	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{
		FoodItemID: &rice.ID, RetractCorrection: true,
	})
	require.NoError(t, err)
	require.False(t, res.AliasRecorded, "an undo must not itself teach the index")

	// An undo that taught (phrase -> rice) would make the wrong food sticky
	// in the opposite direction — the exact trap this flag exists to avoid.
	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ?",
		userID, strings.ToLower(phrase)).Scan(&n).Error)
	require.EqualValues(t, 0, n)
}

// TestEditLogRejectedRetractDoesNotDestroyAlias is the finding-1 regression
// test: an undo request that fails validation (here, an invalid meal_slot)
// must leave the taught alias and the log's food untouched. Before the fix,
// retraction ran before validation, so this exact request deleted the alias
// and then returned an error — the log stayed pointed at the wrong food AND
// the correction that fixed it was erased.
func TestEditLogRejectedRetractDoesNotDestroyAlias(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice RJ " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa RJ " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "rejected undo " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)
	svc := NewService(NewRepository(db), nutriRepo)

	// Correct rice -> quinoa, which teaches (phrase -> quinoa).
	_, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)

	// Attempt an undo carrying an invalid meal_slot — must fail validation.
	_, err = svc.EditLog(context.Background(), userID, log.ID, EditRequest{
		FoodItemID: &rice.ID, MealSlot: "brunchtime", RetractCorrection: true,
	})
	require.Error(t, err)
	var verr httpx.ValidationError
	require.True(t, errors.As(err, &verr), "expected a validation error, got %T: %v", err, err)

	// The taught alias must survive the rejected undo.
	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, strings.ToLower(phrase), quinoa.ID).Scan(&n).Error)
	require.EqualValues(t, 1, n, "a rejected edit must not destroy the alias it did not successfully retract")

	// The log's food must be unchanged — the rejected edit never applied.
	reloaded, err := NewRepository(db).GetByID(context.Background(), userID, log.ID)
	require.NoError(t, err)
	require.Equal(t, quinoa.ID, *reloaded.FoodItemID, "the log's food must be unchanged by a rejected edit")
}

// TestEditLogBareRetractWithNoFoodChangeLeavesAliasIntact is the finding-3
// regression test: a request that sets retract_correction but does not
// change the food (e.g. a portion-only edit, or a request with nothing else
// in it) must not delete any alias. Before the fix, the retraction guard was
// not gated on foodChanged, so a bare {retract_correction: true} silently
// deleted the user's personal alias for (log.input_phrase, the log's CURRENT
// food) even though no correction happened in this call.
func TestEditLogBareRetractWithNoFoodChangeLeavesAliasIntact(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice BR " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa BR " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "bare retract " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)
	svc := NewService(NewRepository(db), nutriRepo)

	// Correct rice -> quinoa, which teaches (phrase -> quinoa).
	_, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)

	// A bare retract_correction with no food change at all.
	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{RetractCorrection: true})
	require.NoError(t, err)
	require.Equal(t, quinoa.ID, *res.Log.FoodItemID, "the log's food must be unaffected")

	var n int64
	require.NoError(t, db.Raw(
		"SELECT count(*) FROM food_aliases WHERE user_id = ? AND lower(alias) = ? AND food_item_id = ?",
		userID, strings.ToLower(phrase), quinoa.ID).Scan(&n).Error)
	require.EqualValues(t, 1, n, "a bare retract with no food change must not destroy the existing alias")
}

// TestEditLogFoodChangeInvalidatesResolutionCache is the regression test for
// the stale-cache bug: EditLog taught the alias but never evicted the AI
// resolve cache, so a corrected phrase could keep resolving to the old,
// wrong food out of cache for up to the cache's TTL. This proves a
// food-changing correction deletes exactly the cache entry the resolver
// would have used for this user+phrase (ai.CacheKey("phrase", ...)).
func TestEditLogFoodChangeInvalidatesResolutionCache(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice IC " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa IC " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "brekkie bowl " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)

	cache := &fakeResolutionCache{}
	svc := NewService(NewRepository(db), nutriRepo).WithResolutionCache(cache)

	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)
	require.True(t, res.AliasRecorded)

	require.Equal(t, []string{ai.CacheKey("phrase", userID, phrase)}, cache.deleted,
		"a food-changing correction must evict exactly the cached entry for this user's phrase")
}

// TestEditLogRetractInvalidatesResolutionCache proves the undo half of a
// correction also evicts the cache — otherwise a retracted alias could keep
// serving the (now wrong) corrected resolution out of cache after the
// correction was undone.
func TestEditLogRetractInvalidatesResolutionCache(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice ICR " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa ICR " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "undo cache " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)

	cache := &fakeResolutionCache{}
	svc := NewService(NewRepository(db), nutriRepo).WithResolutionCache(cache)

	_, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
	require.NoError(t, err)
	cache.deleted = nil // reset: only interested in what the retract itself triggers

	_, err = svc.EditLog(context.Background(), userID, log.ID, EditRequest{
		FoodItemID: &rice.ID, RetractCorrection: true,
	})
	require.NoError(t, err)

	require.Equal(t, []string{ai.CacheKey("phrase", userID, phrase)}, cache.deleted,
		"retracting a correction must evict the cached entry for this user's phrase")
}

// TestEditLogPortionOnlyChangeDoesNotInvalidateResolutionCache proves the
// invalidator is NOT called when nothing was taught — a portion-only edit
// changes no food, so there is no stale cache entry to evict, and calling
// Delete anyway would just be wasted work on every ordinary edit.
func TestEditLogPortionOnlyChangeDoesNotInvalidateResolutionCache(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice ICP " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	require.NoError(t, db.Create(&rice).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", rice.ID) })

	phrase := "portion only cache " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)

	cache := &fakeResolutionCache{}
	svc := NewService(NewRepository(db), nutriRepo).WithResolutionCache(cache)

	grams := 200.0
	res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{QuantityGrams: &grams})
	require.NoError(t, err)
	require.False(t, res.AliasRecorded)

	require.Empty(t, cache.deleted, "a portion-only edit teaches nothing, so nothing should be invalidated")
}

// TestEditLogWithNilResolutionCacheIsSilentNoOp proves a Service built
// without WithResolutionCache (i.e. every existing NewService call site) is
// unaffected by this change — a food-changing correction must still succeed
// and record the alias exactly as before, with no cache configured at all.
func TestEditLogWithNilResolutionCacheIsSilentNoOp(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	rice := nutrition.FoodItem{Name: "Rice ICN " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130}
	quinoa := nutrition.FoodItem{Name: "Quinoa ICN " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120}
	require.NoError(t, db.Create(&rice).Error)
	require.NoError(t, db.Create(&quinoa).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id IN (?, ?)", rice.ID, quinoa.ID) })

	phrase := "no cache configured " + uuid.NewString()
	log := seedPhraseLog(t, db, userID, rice, phrase)

	svc := NewService(NewRepository(db), nutriRepo) // no WithResolutionCache call

	require.NotPanics(t, func() {
		res, err := svc.EditLog(context.Background(), userID, log.ID, EditRequest{FoodItemID: &quinoa.ID})
		require.NoError(t, err)
		require.True(t, res.AliasRecorded)
	})
}

// The client-supplied id reaches the row through exactly ONE line in LogFood:
// `if req.ID != nil { log.ID = *req.ID }`. Both idempotency tests in
// repository_test.go call repo.CreateIdempotent directly with an id already
// set, so deleting that line leaves the whole suite green while every replay
// inserts a duplicate meal — the single outcome the offline queue exists to
// prevent. This test is the only thing connecting the wire format to the row.
func TestLogFoodUsesClientSuppliedIDSoAReplayStaysOneRow(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Replay Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	t.Cleanup(func() { db.Exec("DELETE FROM food_logs WHERE user_id = ?", userID) })

	svc := NewService(NewRepository(db), nutriRepo)
	id := uuid.New()
	req := LogRequest{
		ID: &id, FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 150, LoggedAt: time.Now(),
	}

	first, err := svc.LogFood(context.Background(), userID, req, nil)
	require.NoError(t, err)
	require.Equal(t, id, first.ID, "LogFood must persist the client's id, not let the column default mint one")

	// Exactly what a queue drain replays after a response was lost.
	second, err := svc.LogFood(context.Background(), userID, req, nil)
	require.NoError(t, err)
	require.Equal(t, id, second.ID)

	// Counted across the whole (freshly seeded) user rather than by id: if the
	// id never reached the row, both writes land under generated ids and a
	// count filtered by `id` would report 0 and look like a pass.
	var count int64
	require.NoError(t, db.Model(&FoodLog{}).Where("user_id = ?", userID).Count(&count).Error)
	require.Equal(t, int64(1), count, "a replay through LogFood must not create a second meal")
}

// TestLogFoodResolvesEnteredUnitToGrams proves the server, not the client,
// resolves an entered unit into grams — and that the resolution happens
// exactly once, at write time: quantity_grams is what every nutrition figure
// on this row is (and will remain) derived from, while entered_amount/
// entered_unit are stored verbatim beside it purely so the diary can read
// back what the user actually typed ("2 sachet").
func TestLogFoodResolvesEnteredUnitToGrams(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)

	// One sachet is 16.5g, base unit grams.
	item := nutrition.FoodItem{
		Name: "Sachet Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`),
		KcalPer100g:  545.45,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	amount := 2.0
	unit := "sachet"
	got, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "snack", Source: "manual",
		EnteredAmount: &amount, EnteredUnit: &unit, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)

	// Two sachets = 33g, resolved server-side.
	assert.InDelta(t, 33.0, got.QuantityGrams, 1e-9)
	require.NotNil(t, got.EnteredAmount)
	assert.InDelta(t, 2.0, *got.EnteredAmount, 1e-9)
	require.NotNil(t, got.EnteredUnit)
	assert.Equal(t, "sachet", *got.EnteredUnit)
	// Nutrition must be computed from the resolved grams, not the entered pair.
	assert.InDelta(t, item.KcalPer100g*33.0/100.0, got.Kcal, 1e-6)
}

// TestLogFoodRejectsUnknownUnit proves units.ErrNoConversion surfaces as a
// client validation error rather than silently falling back to a default —
// a fabricated conversion would silently corrupt every total derived from it.
func TestLogFoodRejectsUnknownUnit(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)

	item := nutrition.FoodItem{
		Name: "No Servings Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit: "g", ServingUnits: json.RawMessage(`[]`), KcalPer100g: 100,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	amount := 1.0
	unit := "cup"
	_, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "snack", Source: "manual",
		EnteredAmount: &amount, EnteredUnit: &unit, LoggedAt: time.Now(),
	}, nil)
	var verr httpx.ValidationError
	require.ErrorAs(t, err, &verr)
	assert.Contains(t, verr.Message, "unit")
}

// TestLogFoodWithoutEnteredUnitIsUnchanged is the legacy-path regression: a
// gram-entered log (no entered_amount/entered_unit) must keep working exactly
// as before, with both fields left NULL.
func TestLogFoodWithoutEnteredUnitIsUnchanged(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)

	item := nutrition.FoodItem{
		Name: "Legacy Grams Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		ServingUnits: json.RawMessage(`[]`), KcalPer100g: 100,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	got, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual",
		QuantityGrams: 140, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)
	assert.InDelta(t, 140.0, got.QuantityGrams, 1e-9)
	assert.Nil(t, got.EnteredAmount)
	assert.Nil(t, got.EnteredUnit)
}

// TestEditLogReResolvesGramsFromEnteredUnit proves an edit that supplies a
// new entered pair re-resolves quantity_grams from it — the entered unit is
// still resolved server-side, not trusted from the client, on the update path
// too.
func TestEditLogReResolvesGramsFromEnteredUnit(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)

	item := nutrition.FoodItem{
		Name: "Edit Sachet Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`),
		KcalPer100g:  545.45,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "snack", Source: "manual",
		QuantityGrams: 100, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)

	amount := 3.0
	unit := "sachet"
	res, err := svc.EditLog(context.Background(), userID, created.ID, EditRequest{
		EnteredAmount: &amount, EnteredUnit: &unit,
	})
	require.NoError(t, err)
	assert.InDelta(t, 49.5, res.Log.QuantityGrams, 1e-9)
	require.NotNil(t, res.Log.EnteredAmount)
	assert.InDelta(t, 3.0, *res.Log.EnteredAmount, 1e-9)
	require.NotNil(t, res.Log.EnteredUnit)
	assert.Equal(t, "sachet", *res.Log.EnteredUnit)
	assert.InDelta(t, item.KcalPer100g*49.5/100.0, res.Log.Kcal, 1e-6)
}

// TestEditLogGramsOnlyClearsEnteredPair proves that when an edit supplies
// ONLY quantity_grams (not a new entered pair), the previously-stored entered
// pair is nulled out rather than left stale — the stored pair no longer
// describes the amount once grams have been overwritten directly.
func TestEditLogGramsOnlyClearsEnteredPair(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)

	item := nutrition.FoodItem{
		Name: "Clear Entered Pair Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit:     "g",
		ServingUnits: json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`),
		KcalPer100g:  545.45,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	amount := 2.0
	unit := "sachet"
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "snack", Source: "manual",
		EnteredAmount: &amount, EnteredUnit: &unit, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)
	require.NotNil(t, created.EnteredAmount)
	require.NotNil(t, created.EnteredUnit)

	newGrams := 200.0
	res, err := svc.EditLog(context.Background(), userID, created.ID, EditRequest{
		QuantityGrams: &newGrams,
	})
	require.NoError(t, err)
	assert.InDelta(t, 200.0, res.Log.QuantityGrams, 1e-9)
	assert.Nil(t, res.Log.EnteredAmount, "stale entered pair must be nulled once grams no longer describe it")
	assert.Nil(t, res.Log.EnteredUnit, "stale entered pair must be nulled once grams no longer describe it")
}

// TestEditLogUnknownEnteredUnitReturnsValidationError proves the update path
// also surfaces units.ErrNoConversion as a validation error rather than
// substituting a default.
func TestEditLogUnknownEnteredUnitReturnsValidationError(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)

	item := nutrition.FoodItem{
		Name: "Edit No Servings Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		BaseUnit: "g", ServingUnits: json.RawMessage(`[]`), KcalPer100g: 100,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &item.ID, MealSlot: "snack", Source: "manual",
		QuantityGrams: 100, LoggedAt: time.Now(),
	}, nil)
	require.NoError(t, err)

	amount := 1.0
	unit := "cup"
	_, err = svc.EditLog(context.Background(), userID, created.ID, EditRequest{
		EnteredAmount: &amount, EnteredUnit: &unit,
	})
	var verr httpx.ValidationError
	require.ErrorAs(t, err, &verr)
	assert.Contains(t, verr.Message, "unit")
}

// TestCreateBatchSourceDefaultsToMemory keeps every pre-recipes caller's
// behaviour byte-identical while letting recipes tag their own logs.
func TestCreateBatchSourceDefaultsToMemory(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	nutriRepo := nutrition.NewRepository(db)
	item := nutrition.FoodItem{Name: "Batch Source Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	svc := NewService(NewRepository(db), nutriRepo)
	ctx := context.Background()

	logs, err := svc.CreateBatch(ctx, userID, CreateBatchRequest{
		MealSlot: "lunch",
		Items:    []BatchItem{{FoodItemID: item.ID, QuantityGrams: 100}},
	}, nil)
	require.NoError(t, err)
	require.Equal(t, "memory", logs[0].Source)

	tagged, err := svc.CreateBatch(ctx, userID, CreateBatchRequest{
		MealSlot: "lunch", Source: "recipe",
		Items: []BatchItem{{FoodItemID: item.ID, QuantityGrams: 100}},
	}, nil)
	require.NoError(t, err)
	require.Equal(t, "recipe", tagged[0].Source)
}
