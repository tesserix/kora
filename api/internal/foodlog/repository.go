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

// LoggedDaysDesc returns distinct calendar days (YYYY-MM-DD in loc) that have at
// least one log at or before `notAfter`'s day, most-recent first, capped at limit.
func (r Repository) LoggedDaysDesc(ctx context.Context, userID uuid.UUID, notAfter time.Time, loc *time.Location, limit int) ([]string, error) {
	if limit <= 0 || limit > 4000 {
		limit = 4000
	}
	end := time.Date(notAfter.Year(), notAfter.Month(), notAfter.Day(), 0, 0, 0, 0, loc).Add(24 * time.Hour)
	tz := loc.String()
	var days []string
	err := r.db.WithContext(ctx).
		Raw("SELECT DISTINCT to_char(logged_at AT TIME ZONE ?, 'YYYY-MM-DD') AS day FROM food_logs WHERE user_id = ? AND logged_at < ? ORDER BY day DESC LIMIT ?",
			tz, userID, end, limit).
		Scan(&days).Error
	if err != nil {
		return nil, fmt.Errorf("foodlog: logged days: %w", err)
	}
	return days, nil
}
