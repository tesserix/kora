package foodlog

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
	updated, err := svc.EditLog(context.Background(), userID, created.ID, EditRequest{QuantityGrams: &newGrams})
	require.NoError(t, err)
	require.Equal(t, newGrams, updated.QuantityGrams)
	require.InDelta(t, item.KcalPer100g*newGrams/100, updated.Kcal, 0.001)
	require.InDelta(t, item.ProteinPer100g*newGrams/100, updated.ProteinG, 0.001)
	require.Equal(t, wantDescription, updated.Description)
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

	svc := NewService(NewRepository(db), nutriRepo)
	created, err := svc.LogFood(context.Background(), userID, LogRequest{
		FoodItemID: &oldItem.ID, MealSlot: "lunch", Source: "manual", QuantityGrams: 100, LoggedAt: time.Now(),
	})
	require.NoError(t, err)

	updated, err := svc.EditLog(context.Background(), userID, created.ID, EditRequest{
		FoodItemID: &newItem.ID, CorrectionPhrase: phrase,
	})
	require.NoError(t, err)
	require.Equal(t, 200.0, updated.Kcal) // recomputed from new item at same 100g
	require.Equal(t, newItem.Name, updated.Description)

	cands, err := nutriRepo.Resolve(context.Background(), phrase, nil, 5)
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
