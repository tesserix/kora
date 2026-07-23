package foodlog

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

func (r Repository) Create(ctx context.Context, log FoodLog) (FoodLog, error) {
	created := log
	if err := r.db.WithContext(ctx).Create(&created).Error; err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: create: %w", err)
	}
	return created, nil
}

// ListByUserAndDay returns logs whose logged_at falls on `day` in location `loc`.
func (r Repository) ListByUserAndDay(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) ([]FoodLog, error) {
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, loc)
	end := start.Add(24 * time.Hour)
	var logs []FoodLog
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND logged_at >= ? AND logged_at < ?", userID, start, end).
		Order("logged_at ASC").
		Find(&logs).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: list by day: %w", err)
	}
	return logs, nil
}

func (r Repository) GetByID(ctx context.Context, userID, logID uuid.UUID) (FoodLog, error) {
	var log FoodLog
	if err := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", logID, userID).
		First(&log).Error; err != nil {
		return FoodLog{}, fmt.Errorf("foodlog: get by id: %w", err)
	}
	return log, nil
}

func (r Repository) Delete(ctx context.Context, userID, logID uuid.UUID) error {
	res := r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", logID, userID).
		Delete(&FoodLog{})
	if res.Error != nil {
		return fmt.Errorf("foodlog: delete: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("foodlog: delete: not found")
	}
	return nil
}
