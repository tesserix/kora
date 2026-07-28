package savedmeals

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
	require.NoError(t, db.Exec("INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "sm-"+id.String(), "sm@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

func seedFood(t *testing.T, db *gorm.DB, kcal float64) nutrition.FoodItem {
	t.Helper()
	item := nutrition.FoodItem{Name: "SM Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD, KcalPer100g: kcal, ProteinPer100g: 10}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item
}

func TestCreateListReplaceDeleteScoped(t *testing.T) {
	db := testDB(t)
	userA := seedUser(t, db)
	userB := seedUser(t, db)
	f1 := seedFood(t, db, 100)
	f2 := seedFood(t, db, 200)
	repo := NewRepository(db)
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM saved_meals WHERE user_id IN (?, ?)", userA, userB) })

	created, err := repo.Create(ctx, SavedMeal{UserID: userA, Name: "Bfast", MealSlot: "breakfast"},
		[]SavedMealItem{{FoodItemID: f1.ID, Grams: 100}, {FoodItemID: f2.ID, Grams: 50}})
	require.NoError(t, err)

	list, err := repo.ListForUser(ctx, userA)
	require.NoError(t, err)
	require.Len(t, list, 1)

	rows, err := repo.ItemsForMeals(ctx, []uuid.UUID{created.ID})
	require.NoError(t, err)
	require.Len(t, rows, 2)
	require.Equal(t, 0, rows[0].Position) // ordered by position
	require.Equal(t, 1, rows[1].Position)

	// Replace: rename + drop to a single item.
	require.NoError(t, repo.Replace(ctx, userA, created.ID, "My Bfast", "lunch",
		[]SavedMealItem{{FoodItemID: f1.ID, Grams: 120}}))
	rows, err = repo.ItemsForMeals(ctx, []uuid.UUID{created.ID})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, 120.0, rows[0].Grams)
	list, _ = repo.ListForUser(ctx, userA)
	require.Equal(t, "My Bfast", list[0].Name)
	require.Equal(t, "lunch", list[0].MealSlot)

	// Isolation: user B can't see, replace, or delete user A's meal.
	bList, _ := repo.ListForUser(ctx, userB)
	require.Empty(t, bList)
	require.Error(t, repo.Replace(ctx, userB, created.ID, "hax", "dinner", []SavedMealItem{{FoodItemID: f1.ID, Grams: 10}}))
	require.Error(t, repo.DeleteForUser(ctx, userB, created.ID))
	list, _ = repo.ListForUser(ctx, userA)
	require.Len(t, list, 1)

	// Delete cascades items.
	require.NoError(t, repo.DeleteForUser(ctx, userA, created.ID))
	rows, err = repo.ItemsForMeals(ctx, []uuid.UUID{created.ID})
	require.NoError(t, err)
	require.Empty(t, rows)
}

func TestCountForUser(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	f1 := seedFood(t, db, 100)
	repo := NewRepository(db)
	ctx := context.Background()
	t.Cleanup(func() { db.Exec("DELETE FROM saved_meals WHERE user_id = ?", userID) })

	n, err := repo.CountForUser(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, int64(0), n)
	_, err = repo.Create(ctx, SavedMeal{UserID: userID, Name: "x", MealSlot: "snack"}, []SavedMealItem{{FoodItemID: f1.ID, Grams: 50}})
	require.NoError(t, err)
	n, err = repo.CountForUser(ctx, userID)
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
}
