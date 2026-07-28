package savedmeals

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

// Create inserts the meal and its items (with position) in one transaction.
func (r Repository) Create(ctx context.Context, m SavedMeal, items []SavedMealItem) (SavedMeal, error) {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&m).Error; err != nil {
			return err
		}
		return insertItems(tx, m.ID, items)
	})
	if err != nil {
		return SavedMeal{}, fmt.Errorf("savedmeals: create: %w", err)
	}
	return m, nil
}

func insertItems(tx *gorm.DB, mealID uuid.UUID, items []SavedMealItem) error {
	if len(items) == 0 {
		return nil
	}
	rows := make([]SavedMealItem, len(items))
	for i, it := range items {
		rows[i] = SavedMealItem{SavedMealID: mealID, FoodItemID: it.FoodItemID, Grams: it.Grams, Position: i}
	}
	return tx.Create(&rows).Error
}

func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID) ([]SavedMeal, error) {
	out := []SavedMeal{}
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at DESC").
		Find(&out).Error; err != nil {
		return nil, fmt.Errorf("savedmeals: list: %w", err)
	}
	return out, nil
}

// ItemsForMeals returns items for the given meals, joined to food_items for
// name + per-100g macros, ordered by (meal, position).
func (r Repository) ItemsForMeals(ctx context.Context, mealIDs []uuid.UUID) ([]ItemRow, error) {
	out := []ItemRow{}
	if len(mealIDs) == 0 {
		return out, nil
	}
	err := r.db.WithContext(ctx).
		Table("saved_meal_items AS smi").
		Select("smi.saved_meal_id, smi.food_item_id, smi.grams, smi.position, fi.name, fi.kcal_per_100g AS kcal_per100g, fi.protein_per_100g AS protein_per100g, fi.carbs_per_100g AS carbs_per100g, fi.fat_per_100g AS fat_per100g, fi.fiber_per_100g AS fiber_per100g").
		Joins("JOIN food_items fi ON fi.id = smi.food_item_id").
		Where("smi.saved_meal_id IN ?", mealIDs).
		Order("smi.saved_meal_id, smi.position").
		Scan(&out).Error
	if err != nil {
		return nil, fmt.Errorf("savedmeals: items: %w", err)
	}
	return out, nil
}

// Replace updates a user-owned meal's name/slot and swaps its items atomically.
func (r Repository) Replace(ctx context.Context, userID, mealID uuid.UUID, name, slot string, items []SavedMealItem) error {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing SavedMeal
		if err := tx.Where("id = ? AND user_id = ?", mealID, userID).First(&existing).Error; err != nil {
			return err // gorm.ErrRecordNotFound if absent/not owned
		}
		if err := tx.Model(&SavedMeal{}).Where("id = ?", mealID).Updates(map[string]any{"name": name, "meal_slot": slot}).Error; err != nil {
			return err
		}
		if err := tx.Where("saved_meal_id = ?", mealID).Delete(&SavedMealItem{}).Error; err != nil {
			return err
		}
		return insertItems(tx, mealID, items)
	})
	if err != nil {
		return fmt.Errorf("savedmeals: replace: %w", err)
	}
	return nil
}

func (r Repository) DeleteForUser(ctx context.Context, userID, mealID uuid.UUID) error {
	res := r.db.WithContext(ctx).Where("id = ? AND user_id = ?", mealID, userID).Delete(&SavedMeal{})
	if res.Error != nil {
		return fmt.Errorf("savedmeals: delete: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("savedmeals: delete: %w", gorm.ErrRecordNotFound)
	}
	return nil
}

func (r Repository) CountForUser(ctx context.Context, userID uuid.UUID) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&SavedMeal{}).Where("user_id = ?", userID).Count(&n).Error; err != nil {
		return 0, fmt.Errorf("savedmeals: count: %w", err)
	}
	return n, nil
}
