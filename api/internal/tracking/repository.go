package tracking

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

func (r Repository) AddWater(ctx context.Context, userID uuid.UUID, volumeML int, at time.Time) (WaterEntry, error) {
	if volumeML <= 0 {
		return WaterEntry{}, fmt.Errorf("tracking: volume_ml must be positive")
	}
	if at.IsZero() {
		at = time.Now()
	}
	e := WaterEntry{UserID: userID, VolumeML: volumeML, LoggedAt: at}
	if err := r.db.WithContext(ctx).Create(&e).Error; err != nil {
		return WaterEntry{}, fmt.Errorf("tracking: add water: %w", err)
	}
	return e, nil
}

func (r Repository) WaterTotalForDay(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) (int, error) {
	start := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, loc)
	end := start.Add(24 * time.Hour)
	var total *int
	err := r.db.WithContext(ctx).Model(&WaterEntry{}).
		Where("user_id = ? AND logged_at >= ? AND logged_at < ?", userID, start, end).
		Select("COALESCE(SUM(volume_ml), 0)").Scan(&total).Error
	if err != nil {
		return 0, fmt.Errorf("tracking: water total: %w", err)
	}
	if total == nil {
		return 0, nil
	}
	return *total, nil
}
