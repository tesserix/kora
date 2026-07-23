// Package dashboard aggregates a user's daily intake against their targets.
package dashboard

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/tracking"
)

type Totals struct {
	Kcal     float64 `json:"kcal"`
	ProteinG float64 `json:"protein_g"`
	CarbsG   float64 `json:"carbs_g"`
	FatG     float64 `json:"fat_g"`
	FiberG   float64 `json:"fiber_g"`
}

type Summary struct {
	Date         string         `json:"date"`
	Consumed     Totals         `json:"consumed"`
	Targets      Totals         `json:"targets"`
	WaterML      int            `json:"water_ml"`
	StreakDays   int            `json:"streak_days"`
	SourceCounts map[string]int `json:"source_counts"`
}

type Service struct {
	logs  foodlog.Repository
	water tracking.Repository
	db    *gorm.DB
}

func NewService(logs foodlog.Repository, water tracking.Repository, db *gorm.DB) Service {
	return Service{logs: logs, water: water, db: db}
}

func (s Service) ForDay(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) (Summary, error) {
	logs, err := s.logs.ListByUserAndDay(ctx, userID, day, loc)
	if err != nil {
		return Summary{}, err
	}
	consumed := Totals{}
	sources := map[string]int{}
	for _, l := range logs {
		consumed.Kcal += l.Kcal
		consumed.ProteinG += l.ProteinG
		consumed.CarbsG += l.CarbsG
		consumed.FatG += l.FatG
		consumed.FiberG += l.FiberG
		sources[l.Source]++
	}

	var u struct {
		TargetKcal     float64
		TargetProteinG float64
		TargetCarbsG   float64
		TargetFatG     float64
	}
	if err := s.db.WithContext(ctx).Table("users").
		Select("target_kcal, target_protein_g, target_carbs_g, target_fat_g").
		Where("id = ?", userID).Scan(&u).Error; err != nil {
		return Summary{}, fmt.Errorf("dashboard: load targets: %w", err)
	}

	waterML, err := s.water.WaterTotalForDay(ctx, userID, day, loc)
	if err != nil {
		return Summary{}, err
	}

	streak, err := s.streakDays(ctx, userID, day, loc)
	if err != nil {
		return Summary{}, err
	}

	return Summary{
		Date:         day.In(loc).Format("2006-01-02"),
		Consumed:     consumed,
		Targets:      Totals{Kcal: u.TargetKcal, ProteinG: u.TargetProteinG, CarbsG: u.TargetCarbsG, FatG: u.TargetFatG},
		WaterML:      waterML,
		StreakDays:   streak,
		SourceCounts: sources,
	}, nil
}

// streakDays counts consecutive days ending at `day` that have ≥1 food log.
func (s Service) streakDays(ctx context.Context, userID uuid.UUID, day time.Time, loc *time.Location) (int, error) {
	days, err := s.logs.LoggedDaysDesc(ctx, userID, day, loc, 4000)
	if err != nil {
		return 0, err
	}
	have := make(map[string]bool, len(days))
	for _, d := range days {
		have[d] = true
	}
	streak := 0
	cursor := day
	for {
		key := cursor.In(loc).Format("2006-01-02")
		if !have[key] {
			break
		}
		streak++
		cursor = cursor.Add(-24 * time.Hour)
	}
	return streak, nil
}
