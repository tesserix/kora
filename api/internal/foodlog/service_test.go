package foodlog

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/nutrition"
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
	})
	require.NoError(t, err)
	require.Equal(t, 200.0, log.Kcal)    // 100/100g * 200g
	require.Equal(t, 20.0, log.ProteinG) // 10/100g * 200g
	require.Equal(t, nutrition.ProvenanceAFCD, log.Provenance)
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
	_, err := svc.LogFood(context.Background(), userID, LogRequest{FoodItemID: &item.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: day1})
	require.NoError(t, err)

	n, err := svc.CopyDay(context.Background(), userID, day1, day2, time.UTC)
	require.NoError(t, err)
	require.Equal(t, 1, n)

	logs, err := NewRepository(db).ListByUserAndDay(context.Background(), userID, day2, time.UTC)
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
	})
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
	})
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
	})
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
	})
	require.NoError(t, err)
	require.Len(t, logs, 1)
	require.Equal(t, item.KcalPer100g*2.0, logs[0].Kcal, "kcal must be server-computed from item per-100g * grams")
	require.Equal(t, item.ProteinPer100g*2.0, logs[0].ProteinG)
	require.Equal(t, item.CarbsPer100g*2.0, logs[0].CarbsG)
	require.Equal(t, item.FatPer100g*2.0, logs[0].FatG)
	require.Equal(t, item.FiberPer100g*2.0, logs[0].FiberG)
}

func TestCreateBatchRejectsEmptyItems(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	_, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast", Items: nil,
	})
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
	})
	require.Error(t, err)

	logs, err := NewRepository(db).ListForUserSince(context.Background(), userID, since)
	require.NoError(t, err)
	require.Empty(t, logs, "the resolvable item must NOT have been committed — batch must be atomic")
}

func TestCreateBatchUnknownFoodItemIDReturnsValidationError(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	svc := NewService(NewRepository(db), nutrition.NewRepository(db))

	bogusFoodID := uuid.New()
	_, err := svc.CreateBatch(context.Background(), userID, CreateBatchRequest{
		LoggedAt: time.Now(), MealSlot: "breakfast",
		Items: []BatchItem{{FoodItemID: bogusFoodID, QuantityGrams: 100}},
	})
	require.Error(t, err)
	msg, ok := httpx.IsValidation(err)
	require.True(t, ok, "unknown food_item_id must be a client ValidationError (400), got: %v", err)
	require.Equal(t, "unknown food_item_id", msg)
	require.False(t, errors.Is(err, gorm.ErrRecordNotFound), "not-found must be converted, not leaked as gorm.ErrRecordNotFound")
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
	})
	require.Error(t, err)
	require.False(t, errors.Is(err, gorm.ErrRecordNotFound), "driver fault must not masquerade as record-not-found")
	_, ok := httpx.IsValidation(err)
	require.False(t, ok, "infra fault must NOT be a ValidationError, got a 400-class error: %v", err)
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
	})
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
	})
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
	})
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
	})
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
	})
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
	})
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
