package recipes

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
		id, "rc-"+id.String(), "rc@test.dev").Error)
	t.Cleanup(func() { db.Exec("DELETE FROM users WHERE id = ?", id) })
	return id
}

func seedFood(t *testing.T, db *gorm.DB, kcal float64) nutrition.FoodItem {
	t.Helper()
	item := nutrition.FoodItem{
		Name: "RC Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: kcal, ProteinPer100g: 10,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })
	return item
}

func TestCreateGetScopedToOwner(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	other := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Dal", Servings: 4, Source: SourcePaste},
		[]Ingredient{{FoodItemID: &f.ID, RawText: "1 cup lentils", Grams: 200}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })
	require.False(t, r.CreatedAt.IsZero(), "autoCreateTime must populate created_at")

	got, err := repo.GetForUser(ctx, owner, r.ID)
	require.NoError(t, err)
	require.Equal(t, "Dal", got.Name)

	_, err = repo.GetForUser(ctx, other, r.ID)
	require.ErrorIs(t, err, gorm.ErrRecordNotFound, "another user's recipe must be invisible")
}

// TestIngredientsForRecipesKeepsUnresolved is the whole point of the nullable
// food_item_id: a LEFT JOIN so an unresolved ingredient survives the read.
// An INNER JOIN here would silently shrink the recipe.
func TestIngredientsForRecipesKeepsUnresolved(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Curry", Servings: 2, Source: SourcePaste},
		[]Ingredient{
			{FoodItemID: &f.ID, RawText: "200g lentils", Grams: 200},
			{FoodItemID: nil, RawText: "a pinch of asafoetida", Grams: 0},
		},
	)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })

	rows, err := repo.IngredientsForRecipes(ctx, []uuid.UUID{r.ID})
	require.NoError(t, err)
	require.Len(t, rows, 2, "the unresolved ingredient must survive the join")
	require.Equal(t, 0, rows[0].Position)
	require.Equal(t, "200g lentils", rows[0].RawText)
	require.Nil(t, rows[1].FoodItemID)
	require.Equal(t, "a pinch of asafoetida", rows[1].RawText)
	require.Zero(t, rows[1].KcalPer100g, "unresolved rows carry no macros")
}

func TestReplaceSwapsIngredientsAtomically(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	other := seedUser(t, db)
	f1 := seedFood(t, db, 100)
	f2 := seedFood(t, db, 200)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Old", Servings: 2, Source: SourceManual},
		[]Ingredient{{FoodItemID: &f1.ID, RawText: "a", Grams: 100}},
	)
	require.NoError(t, err)
	t.Cleanup(func() { db.Exec("DELETE FROM recipes WHERE id = ?", r.ID) })

	require.NoError(t, repo.Replace(ctx, owner, r.ID, "New", 6,
		[]Ingredient{{FoodItemID: &f2.ID, RawText: "b", Grams: 50}}))

	got, err := repo.GetForUser(ctx, owner, r.ID)
	require.NoError(t, err)
	require.Equal(t, "New", got.Name)
	require.Equal(t, 6, got.Servings)

	rows, err := repo.IngredientsForRecipes(ctx, []uuid.UUID{r.ID})
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "b", rows[0].RawText)

	require.ErrorIs(t, repo.Replace(ctx, other, r.ID, "Hijack", 1, nil), gorm.ErrRecordNotFound)
}

func TestDeleteScopedAndCascades(t *testing.T) {
	db := testDB(t)
	repo := NewRepository(db)
	owner := seedUser(t, db)
	other := seedUser(t, db)
	f := seedFood(t, db, 100)
	ctx := context.Background()

	r, err := repo.Create(ctx,
		Recipe{UserID: owner, Name: "Gone", Servings: 1, Source: SourceManual},
		[]Ingredient{{FoodItemID: &f.ID, RawText: "a", Grams: 10}},
	)
	require.NoError(t, err)

	require.ErrorIs(t, repo.DeleteForUser(ctx, other, r.ID), gorm.ErrRecordNotFound)
	require.NoError(t, repo.DeleteForUser(ctx, owner, r.ID))

	var n int64
	require.NoError(t, db.Table("recipe_ingredients").Where("recipe_id = ?", r.ID).Count(&n).Error)
	require.Zero(t, n, "ingredients must cascade with the recipe")
}
