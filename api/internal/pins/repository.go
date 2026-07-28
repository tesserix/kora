package pins

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository { return Repository{db: db} }

// Upsert creates a pin, or updates its grams/meal_slot if the (user, food)
// pair is already pinned — one pin per food.
func (r Repository) Upsert(ctx context.Context, p Pin) (Pin, error) {
	err := r.db.WithContext(ctx).
		Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "user_id"}, {Name: "food_item_id"}},
			DoUpdates: clause.AssignmentColumns([]string{"grams", "meal_slot"}),
		}).
		Create(&p).Error
	if err != nil {
		return Pin{}, fmt.Errorf("pins: upsert: %w", err)
	}
	return p, nil
}

// ListForUser returns the user's pins, newest first.
func (r Repository) ListForUser(ctx context.Context, userID uuid.UUID) ([]Pin, error) {
	out := []Pin{}
	if err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("created_at DESC").
		Find(&out).Error; err != nil {
		return nil, fmt.Errorf("pins: list for user: %w", err)
	}
	return out, nil
}

// DeleteForUser unpins a food, scoped by user. Idempotent — absent pin is not an error.
func (r Repository) DeleteForUser(ctx context.Context, userID, foodItemID uuid.UUID) error {
	if err := r.db.WithContext(ctx).
		Where("user_id = ? AND food_item_id = ?", userID, foodItemID).
		Delete(&Pin{}).Error; err != nil {
		return fmt.Errorf("pins: delete: %w", err)
	}
	return nil
}

func (r Repository) CountForUser(ctx context.Context, userID uuid.UUID) (int64, error) {
	var n int64
	if err := r.db.WithContext(ctx).Model(&Pin{}).Where("user_id = ?", userID).Count(&n).Error; err != nil {
		return 0, fmt.Errorf("pins: count: %w", err)
	}
	return n, nil
}
