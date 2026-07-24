package billing

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
)

const (
	// perUserMonthlyCostCapUSD is the maximum estimated AI spend a single
	// user may accrue within a calendar month.
	perUserMonthlyCostCapUSD = 5.0
	// globalMonthlyCostCapUSD is the maximum estimated AI spend across all
	// users within a calendar month.
	globalMonthlyCostCapUSD = 500.0
	// perUserMonthlyCallCap bounds how many AI calls a single user may make in
	// a calendar month, protecting free-tier provider quota even when the
	// list-price cost estimate stays under the dollar cap.
	perUserMonthlyCallCap = 300
)

// Meter records AI provider usage and enforces monthly cost budgets.
type Meter struct {
	db *gorm.DB
}

// NewMeter builds a Meter backed by db.
func NewMeter(db *gorm.DB) Meter {
	return Meter{db: db}
}

// Record persists one metered AI provider call.
func (m Meter) Record(ctx context.Context, userID uuid.UUID, u ai.Usage, costUSD float64) error {
	event := Event{
		UserID:     userID,
		Provider:   u.Provider,
		Model:      u.Model,
		CallType:   u.CallType,
		TokensIn:   u.TokensIn,
		TokensOut:  u.TokensOut,
		LatencyMs:  u.LatencyMs,
		CostUSDEst: costUSD,
	}
	if err := m.db.WithContext(ctx).Create(&event).Error; err != nil {
		return fmt.Errorf("billing: record: %w", err)
	}
	return nil
}

// WithinBudget reports whether userID has remaining monthly AI budget, and
// whether the platform as a whole is still within its global monthly cap.
// It returns false if either the user's or the global calendar-month spend
// is at or above its respective cap.
func (m Meter) WithinBudget(ctx context.Context, userID uuid.UUID) (bool, error) {
	monthStart := startOfMonthUTC(time.Now())

	var userTotal float64
	if err := m.db.WithContext(ctx).
		Model(&Event{}).
		Where("user_id = ? AND created_at >= ?", userID, monthStart).
		Select("COALESCE(SUM(cost_usd_est), 0)").
		Scan(&userTotal).Error; err != nil {
		return false, fmt.Errorf("billing: within budget: sum user cost: %w", err)
	}
	if userTotal >= perUserMonthlyCostCapUSD {
		return false, nil
	}

	var userCalls int64
	if err := m.db.WithContext(ctx).
		Model(&Event{}).
		Where("user_id = ? AND created_at >= ?", userID, monthStart).
		Count(&userCalls).Error; err != nil {
		return false, fmt.Errorf("billing: within budget: count user calls: %w", err)
	}
	if userCalls >= perUserMonthlyCallCap {
		return false, nil
	}

	var globalTotal float64
	if err := m.db.WithContext(ctx).
		Model(&Event{}).
		Where("created_at >= ?", monthStart).
		Select("COALESCE(SUM(cost_usd_est), 0)").
		Scan(&globalTotal).Error; err != nil {
		return false, fmt.Errorf("billing: within budget: sum global cost: %w", err)
	}
	if globalTotal >= globalMonthlyCostCapUSD {
		return false, nil
	}

	return true, nil
}

// startOfMonthUTC returns midnight UTC on the first day of t's month.
func startOfMonthUTC(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), 1, 0, 0, 0, 0, time.UTC)
}
