package recipes

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Create inserts the recipe and its ingredients (with position) in one
// transaction.
func (r Repository) Create(ctx context.Context, rec Recipe, items []Ingredient) (Recipe, error) {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&rec).Error; err != nil {
			return err
		}
		return insertIngredients(tx, rec.ID, items)
	})
	if err != nil {
		return Recipe{}, fmt.Errorf("recipes: create: %w", err)
	}
	return rec, nil
}

// insertIngredients rewrites Position from slice order, so callers never have
// to keep the two in sync.
func insertIngredients(tx *gorm.DB, recipeID uuid.UUID, items []Ingredient) error {
	if len(items) == 0 {
		return nil
	}
	rows := make([]Ingredient, len(items))
	for i, it := range items {
		rows[i] = Ingredient{
			RecipeID: recipeID, Position: i,
			FoodItemID: it.FoodItemID, RawText: it.RawText, Grams: it.Grams,
			EnteredAmount: it.EnteredAmount, EnteredUnit: it.EnteredUnit,
			PortionAssumed: it.PortionAssumed,
			MatchScore:     it.MatchScore, MatchTier: it.MatchTier,
		}
	}
	return tx.Create(&rows).Error
}

func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID) ([]Recipe, error) {
	out := []Recipe{}
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at DESC").
		Find(&out).Error; err != nil {
		return nil, fmt.Errorf("recipes: list: %w", err)
	}
	return out, nil
}

// GetForUser returns gorm.ErrRecordNotFound when the recipe is absent OR
// owned by someone else — the handler maps both to 404 so ids stay
// non-enumerable.
func (r Repository) GetForUser(ctx context.Context, userID, recipeID uuid.UUID) (Recipe, error) {
	var rec Recipe
	if err := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", recipeID, userID).
		First(&rec).Error; err != nil {
		return Recipe{}, err
	}
	return rec, nil
}

// IngredientsForRecipes returns ingredients joined to food_items for name and
// per-100g macros, ordered by (recipe, position).
//
// LEFT JOIN, deliberately — food_item_id is nullable, and an INNER JOIN would
// silently drop every unresolved ingredient from the result, shrinking the
// recipe with no error and no indication to the user. That is precisely the
// silent shrinkage the nullable column exists to prevent.
//
// Like savedmeals.ItemsForMeals, this does NOT filter fi.deleted_at: a user
// must still see the recipe they saved, name and macros intact, after the
// underlying food is retired from the index. The batch log path rejects a
// retired item separately (foodlog.Service.CreateBatch).
func (r Repository) IngredientsForRecipes(ctx context.Context, recipeIDs []uuid.UUID) ([]IngredientRow, error) {
	out := []IngredientRow{}
	if len(recipeIDs) == 0 {
		return out, nil
	}
	err := r.db.WithContext(ctx).
		Table("recipe_ingredients AS ri").
		Select("ri.recipe_id, ri.food_item_id, ri.position, ri.raw_text, ri.grams, "+
			"ri.entered_amount, ri.entered_unit, ri.portion_assumed, ri.match_score, ri.match_tier, "+
			"COALESCE(fi.name, '') AS name, "+
			"COALESCE(fi.kcal_per_100g, 0) AS kcal_per100g, "+
			"COALESCE(fi.protein_per_100g, 0) AS protein_per100g, "+
			"COALESCE(fi.carbs_per_100g, 0) AS carbs_per100g, "+
			"COALESCE(fi.fat_per_100g, 0) AS fat_per100g, "+
			"COALESCE(fi.fiber_per_100g, 0) AS fiber_per100g").
		Joins("LEFT JOIN food_items fi ON fi.id = ri.food_item_id").
		Where("ri.recipe_id IN ?", recipeIDs).
		Order("ri.recipe_id, ri.position").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("recipes: ingredients: %w", err)
	}
	return out, nil
}

// Replace updates a user-owned recipe's name/servings and swaps its
// ingredients atomically. The updated_at timestamp is maintained by GORM's
// autoUpdateTime tag on the Recipe.UpdatedAt field, guarded by
// TestReplaceAdvancesUpdatedAt.
func (r Repository) Replace(ctx context.Context, userID, recipeID uuid.UUID, name string, servings int, items []Ingredient) error {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing Recipe
		if err := tx.Where("id = ? AND user_id = ?", recipeID, userID).First(&existing).Error; err != nil {
			return err // gorm.ErrRecordNotFound if absent/not owned
		}
		if err := tx.Model(&Recipe{}).Where("id = ?", recipeID).
			Updates(map[string]any{"name": name, "servings": servings}).Error; err != nil {
			return err
		}
		if err := tx.Where("recipe_id = ?", recipeID).Delete(&Ingredient{}).Error; err != nil {
			return err
		}
		return insertIngredients(tx, recipeID, items)
	})
	if err != nil {
		return fmt.Errorf("recipes: replace: %w", err)
	}
	return nil
}

func (r Repository) DeleteForUser(ctx context.Context, userID, recipeID uuid.UUID) error {
	res := r.db.WithContext(ctx).Where("id = ? AND user_id = ?", recipeID, userID).Delete(&Recipe{})
	if res.Error != nil {
		return fmt.Errorf("recipes: delete: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("recipes: delete: %w", gorm.ErrRecordNotFound)
	}
	return nil
}

func (r Repository) CountForUser(ctx context.Context, userID uuid.UUID) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&Recipe{}).Where("user_id = ?", userID).Count(&n).Error; err != nil {
		return 0, fmt.Errorf("recipes: count: %w", err)
	}
	return n, nil
}
