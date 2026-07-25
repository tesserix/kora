// Package progress computes habit metrics (log streak, calorie-target adherence)
// from a user's food logs. It is deliberately independent of the dashboard so it
// can be reused (e.g. by friend comparison) without coupling.
package progress

import (
	"context"
	"math"
	"time"

	"github.com/google/uuid"
)

const (
	adherenceWindow = 7
	adherenceBand   = 0.10
)

// Metrics is a user's habit summary. AdherenceDays counts, over the last
// AdherenceWindow local days, days whose kcal was within ±10% of target.
type Metrics struct {
	StreakDays      int `json:"streak_days"`
	AdherenceDays   int `json:"adherence_days"`
	AdherenceWindow int `json:"adherence_window"`
}

// LogSource is the slice of foodlog.Repository this package needs.
type LogSource interface {
	LoggedDaysDesc(ctx context.Context, userID uuid.UUID, notAfter time.Time, loc *time.Location, limit int) ([]string, error)
	DailyKcal(ctx context.Context, userID uuid.UUID, from, to time.Time, loc *time.Location) (map[string]float64, error)
}

func Compute(ctx context.Context, logs LogSource, userID uuid.UUID, targetKcal float64, day time.Time, loc *time.Location) (Metrics, error) {
	local := day.In(loc)
	endDay := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)

	loggedDays, err := logs.LoggedDaysDesc(ctx, userID, day, loc, 4000)
	if err != nil {
		return Metrics{}, err
	}
	have := make(map[string]bool, len(loggedDays))
	for _, d := range loggedDays {
		have[d] = true
	}
	streak := 0
	for c := endDay; have[c.Format("2006-01-02")]; c = c.AddDate(0, 0, -1) {
		streak++
	}

	from := endDay.AddDate(0, 0, -(adherenceWindow - 1))
	to := endDay.AddDate(0, 0, 1)
	kcalByDay, err := logs.DailyKcal(ctx, userID, from, to, loc)
	if err != nil {
		return Metrics{}, err
	}
	adherence := 0
	if targetKcal > 0 {
		for i := 0; i < adherenceWindow; i++ {
			key := endDay.AddDate(0, 0, -i).Format("2006-01-02")
			if math.Abs(kcalByDay[key]-targetKcal) <= adherenceBand*targetKcal {
				adherence++
			}
		}
	}
	return Metrics{StreakDays: streak, AdherenceDays: adherence, AdherenceWindow: adherenceWindow}, nil
}
