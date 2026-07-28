package pins

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

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

func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "pin-"+id.String(), "pin@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

func seedFood(t *testing.T, db *gorm.DB) nutrition.FoodItem {
	t.Helper()
	item := nutrition.FoodItem{Name: "Pin Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 100, ProteinPer100g: 10, CarbsPer100g: 20, FatPer100g: 5, FiberPer100g: 2}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item
}

func TestUpsertCreatesThenUpdatesIdempotently(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	food := seedFood(t, db)
	repo := NewRepository(db)
	ctx := context.Background()

	_, err := repo.Upsert(ctx, Pin{UserID: userID, FoodItemID: food.ID, Grams: 100, MealSlot: "breakfast"})
	require.NoError(t, err)
	// Re-pin the same food with a different portion/slot — must UPDATE, not duplicate.
	_, err = repo.Upsert(ctx, Pin{UserID: userID, FoodItemID: food.ID, Grams: 150, MealSlot: "snack"})
	require.NoError(t, err)

	list, err := repo.ListForUser(ctx, userID)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, 150.0, list[0].Grams)
	require.Equal(t, "snack", list[0].MealSlot)
	t.Cleanup(func() { db.Exec("DELETE FROM pins WHERE user_id = ?", userID) })
}

func TestListAndDeleteAreUserScoped(t *testing.T) {
	db := testDB(t)
	userA := seedUser(t, db)
	userB := seedUser(t, db)
	food := seedFood(t, db)
	repo := NewRepository(db)
	ctx := context.Background()

	_, err := repo.Upsert(ctx, Pin{UserID: userA, FoodItemID: food.ID, Grams: 100, MealSlot: "lunch"})
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM pins WHERE user_id IN (?, ?)", userA, userB) })

	// User B sees nothing.
	bList, err := repo.ListForUser(ctx, userB)
	require.NoError(t, err)
	require.Empty(t, bList)

	// User B deleting user A's food is a no-op (idempotent, scoped).
	require.NoError(t, repo.DeleteForUser(ctx, userB, food.ID))
	aList, err := repo.ListForUser(ctx, userA)
	require.NoError(t, err)
	require.Len(t, aList, 1)

	// User A deletes their own pin.
	require.NoError(t, repo.DeleteForUser(ctx, userA, food.ID))
	aList, err = repo.ListForUser(ctx, userA)
	require.NoError(t, err)
	require.Empty(t, aList)
}

func TestCountForUser(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	food := seedFood(t, db)
	repo := NewRepository(db)
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM pins WHERE user_id = ?", userID) })

	n, err := repo.CountForUser(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, int64(0), n)

	_, err = repo.Upsert(ctx, Pin{UserID: userID, FoodItemID: food.ID, Grams: 100, MealSlot: "lunch"})
	require.NoError(t, err)
	n, err = repo.CountForUser(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
}
