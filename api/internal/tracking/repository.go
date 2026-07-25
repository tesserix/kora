package tracking

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/httpx"
)

type Repository struct {
	db *gorm.DB
}

func NewRepository(db *gorm.DB) Repository {
	return Repository{db: db}
}

func (r Repository) AddWater(ctx context.Context, userID uuid.UUID, volumeML int, at time.Time) (WaterEntry, error) {
	if volumeML <= 0 {
		return WaterEntry{}, httpx.ValidationError{Message: "volume_ml must be positive"}
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

func (r Repository) AddWeight(ctx context.Context, userID uuid.UUID, weightKg float64, at time.Time) (WeightEntry, error) {
	if weightKg <= 0 {
		return WeightEntry{}, httpx.ValidationError{Message: "weight_kg must be positive"}
	}
	if at.IsZero() {
		at = time.Now()
	}
	e := WeightEntry{UserID: userID, WeightKg: weightKg, LoggedAt: at}
	if err := r.db.WithContext(ctx).Create(&e).Error; err != nil {
		return WeightEntry{}, fmt.Errorf("tracking: add weight: %w", err)
	}
	return e, nil
}

func (r Repository) WeightSeries(ctx context.Context, userID uuid.UUID, from, to time.Time) ([]WeightEntry, error) {
	entries := []WeightEntry{}
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND logged_at >= ? AND logged_at < ?", userID, from, to).
		Order("logged_at ASC").
		Find(&entries).Error
	if err != nil {
		return nil, fmt.Errorf("tracking: weight series: %w", err)
	}
	return entries, nil
}
