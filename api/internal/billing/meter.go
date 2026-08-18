package billing

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/metrics"
)

const (
	// perUserMonthlyCostCapUSD is the maximum estimated AI spend a single
	// user may accrue within a calendar month.
	perUserMonthlyCostCapUSD = 5.0
	// globalMonthlyCostCapUSD is the maximum estimated AI spend across all
	// users within a calendar month.
	globalMonthlyCostCapUSD = 500.0

	perUserDailyRequestCap   = 20
	perUserWeeklyRequestCap  = 100
	perUserMonthlyRequestCap = 300

	quotaDay   = "day"
	quotaWeek  = "week"
	quotaMonth = "month"
)

var errQuotaExceeded = errors.New("ai quota exceeded")

type quotaWindow struct {
	kind  string
	start time.Time
	limit int
}

// Meter records provider usage and reserves user quota before provider work.
type Meter struct {
	db  *gorm.DB
	now func() time.Time
}

// NewMeter builds a Meter backed by db.
func NewMeter(db *gorm.DB) Meter {
	return Meter{db: db, now: time.Now}
}

// Record persists one metered AI provider call made on behalf of userID.
func (m Meter) Record(ctx context.Context, userID uuid.UUID, u ai.Usage, costUSD float64) error {
	return m.record(ctx, &userID, u, costUSD)
}

// RecordSystem persists one metered AI provider call that NO USER made, so it
// lands with a NULL user_id.
//
// It exists for the food-index backfill (cmd/embed), which embeds thousands of
// rows on the platform's behalf. Those calls were previously discarded
// entirely, which made "total COGS = resolution + derived" false at the org
// level: the single largest embedding consumer in the system appeared in
// neither ai_usage_events nor the kora_ai_calls_total counters (kora#97).
//
// Deliberately NOT routed through Record with some placeholder user: there is
// no user to attribute it to, and inventing one would corrupt every per-user
// query, including the WithinBudget caps below, which would then throttle a
// fictional account while the real spend stayed unattributed. NULL is the
// value the schema already uses for "usage with no owning person" — the same
// state a deleted user's retained rows end up in (migration 000025).
//
// It does NOT consult WithinBudget. Those caps are per-user throttles, and the
// backfill is an operator-initiated batch job whose ceiling is its own row
// count, not a user's monthly allowance.
func (m Meter) RecordSystem(ctx context.Context, u ai.Usage, costUSD float64) error {
	return m.record(ctx, nil, u, costUSD)
}

// record is the shared body of Record and RecordSystem. userID is nil for a
// call with no owning user.
func (m Meter) record(ctx context.Context, userID *uuid.UUID, u ai.Usage, costUSD float64) error {
	// Instrumented BEFORE the insert and independently of its result: the
	// provider call already happened and was already billed upstream, whether
	// or not this row lands. See #43.
	metrics.RecordAICall(u.CallType, u.Model, u.Outcome, costUSD, time.Duration(u.LatencyMs)*time.Millisecond)

	event := Event{
		UserID:     userID,
		Provider:   u.Provider,
		Model:      u.Model,
		CallType:   u.CallType,
		TokensIn:   u.TokensIn,
		TokensOut:  u.TokensOut,
		LatencyMs:  u.LatencyMs,
		CostUSDEst: costUSD,
		Outcome:    u.Outcome,
	}
	if err := m.db.WithContext(ctx).Create(&event).Error; err != nil {
		return fmt.Errorf("billing: record: %w", err)
	}
	return nil
}

// WithinBudget atomically reserves one provider-backed AI request from the
// user's daily, weekly, and monthly free-tier windows. It also checks the
// user's and platform's calendar-month cost caps. False means no provider
// work may begin; an error also fails closed.
// NOTE ON `outcome` (added in #81): this function deliberately does NOT filter
// it. Both caps guard a resource that a FAILED call still consumes — providers
// return token usage alongside an error, and provider quota is spent by any
// request that reaches them. Filtering to outcome = 'ok' here would silently
// under-protect both. See the two TestWithinBudgetCountsFailedCalls… tests,
// which fail if someone adds that filter.
//
// The distinction that matters when writing any query over ai_usage_events:
//
//	RESOURCE questions ("what did we spend?", "how much quota is left?")
//	  -> count every row, no outcome filter.
//	PRODUCT questions ("AI calls per active user", "photo share", "median
//	  calls per log")
//	  -> filter outcome = 'ok', or failures and retries inflate the number.
//
// Before #81 the table held only successes, so every query was implicitly a
// product query. That is no longer true, and an unfiltered product metric now
// over-counts where it used to under-count.
func (m Meter) WithinBudget(ctx context.Context, userID uuid.UUID) (bool, error) {
	windows := quotaWindowsAt(m.now())
	monthStart := windows[2].start
	err := m.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(
			"SELECT pg_advisory_xact_lock(hashtextextended(CAST(? AS text), 0))",
			userID.String(),
		).Error; err != nil {
			return fmt.Errorf("acquire user quota lock: %w", err)
		}

		var userTotal float64
		if err := tx.Model(&Event{}).
			Where("user_id = ? AND created_at >= ?", userID, monthStart).
			Select("COALESCE(SUM(cost_usd_est), 0)").
			Scan(&userTotal).Error; err != nil {
			return fmt.Errorf("sum user cost: %w", err)
		}
		if userTotal >= perUserMonthlyCostCapUSD {
			return errQuotaExceeded
		}

		var globalTotal float64
		if err := tx.Model(&Event{}).
			Where("created_at >= ?", monthStart).
			Select("COALESCE(SUM(cost_usd_est), 0)").
			Scan(&globalTotal).Error; err != nil {
			return fmt.Errorf("sum global cost: %w", err)
		}
		if globalTotal >= globalMonthlyCostCapUSD {
			return errQuotaExceeded
		}

		type countRow struct {
			Kind  string `gorm:"column:window_kind"`
			Count int    `gorm:"column:request_count"`
		}
		var rows []countRow
		if err := tx.Raw(`
			SELECT window_kind, request_count
			FROM ai_quota_windows
			WHERE user_id = ?
			  AND (window_kind, window_start) IN ((?, ?), (?, ?), (?, ?))`,
			userID,
			windows[0].kind, windows[0].start,
			windows[1].kind, windows[1].start,
			windows[2].kind, windows[2].start,
		).Scan(&rows).Error; err != nil {
			return fmt.Errorf("load quota windows: %w", err)
		}
		counts := make(map[string]int, len(rows))
		for _, row := range rows {
			counts[row.Kind] = row.Count
		}
		for _, window := range windows {
			if counts[window.kind] >= window.limit {
				return errQuotaExceeded
			}
		}

		updatedAt := m.now().UTC()
		if err := tx.Exec(`
			INSERT INTO ai_quota_windows (user_id, window_kind, window_start, request_count, updated_at)
			VALUES (?, ?, ?, 1, ?), (?, ?, ?, 1, ?), (?, ?, ?, 1, ?)
			ON CONFLICT (user_id, window_kind, window_start)
			DO UPDATE SET
				request_count = ai_quota_windows.request_count + 1,
				updated_at = EXCLUDED.updated_at`,
			userID, windows[0].kind, windows[0].start, updatedAt,
			userID, windows[1].kind, windows[1].start, updatedAt,
			userID, windows[2].kind, windows[2].start, updatedAt,
		).Error; err != nil {
			return fmt.Errorf("reserve quota windows: %w", err)
		}
		return nil
	})
	if errors.Is(err, errQuotaExceeded) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("billing: within budget: %w", err)
	}
	return true, nil
}

func quotaWindowsAt(t time.Time) [3]quotaWindow {
	u := t.UTC()
	dayStart := time.Date(u.Year(), u.Month(), u.Day(), 0, 0, 0, 0, time.UTC)
	daysSinceMonday := (int(u.Weekday()) + 6) % 7
	return [3]quotaWindow{
		{kind: quotaDay, start: dayStart, limit: perUserDailyRequestCap},
		{kind: quotaWeek, start: dayStart.AddDate(0, 0, -daysSinceMonday), limit: perUserWeeklyRequestCap},
		{kind: quotaMonth, start: startOfMonthUTC(u), limit: perUserMonthlyRequestCap},
	}
}

// startOfMonthUTC returns midnight UTC on the first day of t's month.
func startOfMonthUTC(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), 1, 0, 0, 0, 0, time.UTC)
}
