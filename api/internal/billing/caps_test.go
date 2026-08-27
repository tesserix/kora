package billing

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// seedSpend writes one usage event with a given cost at a given instant.
func seedSpend(t *testing.T, db *gorm.DB, userID uuid.UUID, costUSD float64, at time.Time) {
	t.Helper()
	require.NoError(t, db.Exec(
		`INSERT INTO ai_usage_events
		   (user_id, provider, model, call_type, tokens_in, tokens_out, latency_ms, cost_usd_est, outcome, created_at)
		 VALUES (?, 'gemini', 'test', 'resolve', 1, 1, 1, ?, 'success', ?)`,
		userID, costUSD, at).Error)
}

// TestCapsInEffectReportsTheConstantsEnforcementUses guards the drift this
// whole surface exists to prevent: a reported ceiling that is not the enforced
// one is worse than no ceiling at all, because it reads reassuring at exactly
// the moment the kill switch fires.
func TestCapsInEffectReportsTheConstantsEnforcementUses(t *testing.T) {
	caps := CapsInEffect()
	assert.Equal(t, perUserMonthlyCostCapUSD, caps.PerUserMonthlyCostUSD)
	assert.Equal(t, globalMonthlyCostCapUSD, caps.GlobalMonthlyCostUSD)
	assert.Equal(t, perUserDailyRequestCap, caps.PerUserDailyRequests)
	assert.Equal(t, perUserWeeklyRequestCap, caps.PerUserWeeklyRequests)
	assert.Equal(t, perUserMonthlyRequestCap, caps.PerUserMonthlyRequests)
}

// TestGlobalMonthSpendCountsThisMonthOnly pins the window. The reported spend
// must be measured over the SAME month WithinBudget compares against, so a
// prior month's spend cannot inflate today's headroom reading.
func TestGlobalMonthSpendCountsThisMonthOnly(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, time.August, 19, 12, 0, 0, 0, time.UTC)
	meter := NewMeter(db)
	meter.now = func() time.Time { return now }

	// Measured as a DELTA, never as an absolute. This is an estate-wide
	// aggregate over a table the shared dev database already holds real rows
	// in, so asserting a total would be asserting the fixture is alone in the
	// world — the same trap the nutrition ranking tests fell into.
	before, err := meter.GlobalMonthSpendUSD(context.Background())
	require.NoError(t, err)

	// Inside the enforced month.
	seedSpend(t, db, userID, 1.25, time.Date(2026, time.August, 2, 9, 0, 0, 0, time.UTC))
	seedSpend(t, db, userID, 0.75, time.Date(2026, time.August, 18, 9, 0, 0, 0, time.UTC))
	// The previous month: must NOT count, or headroom reads low forever.
	seedSpend(t, db, userID, 400, time.Date(2026, time.July, 31, 23, 59, 0, 0, time.UTC))

	after, err := meter.GlobalMonthSpendUSD(context.Background())

	require.NoError(t, err)
	assert.InDelta(t, 2.0, after-before, 1e-9,
		"only the two in-month events may move the figure; the July event must not")
}

// TestGlobalMonthSpendIsEstateWideNotPerUser — the global cap is the estate's,
// so a second user's spend must raise it. Scoping this per-user would report
// headroom that does not exist.
func TestGlobalMonthSpendIsEstateWideNotPerUser(t *testing.T) {
	db := testDB(t)
	first := seedUser(t, db)
	second := seedUser(t, db)
	now := time.Date(2026, time.August, 19, 12, 0, 0, 0, time.UTC)
	meter := NewMeter(db)
	meter.now = func() time.Time { return now }

	before, err := meter.GlobalMonthSpendUSD(context.Background())
	require.NoError(t, err)

	seedSpend(t, db, first, 1.5, time.Date(2026, time.August, 3, 9, 0, 0, 0, time.UTC))
	seedSpend(t, db, second, 2.5, time.Date(2026, time.August, 4, 9, 0, 0, 0, time.UTC))

	after, err := meter.GlobalMonthSpendUSD(context.Background())

	require.NoError(t, err)
	assert.InDelta(t, 4.0, after-before, 1e-9,
		"both users' spend must raise the estate figure")
}

// TestBudgetMetricsReportsHeadroomAgainstTheCap — the operator's question is
// "how close are we?", so headroom is computed here rather than left as a
// subtraction for the reader.
func TestBudgetMetricsReportsHeadroomAgainstTheCap(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, time.August, 19, 12, 0, 0, 0, time.UTC)
	meter := NewMeter(db)
	meter.now = func() time.Time { return now }
	seedSpend(t, db, userID, 12.34, time.Date(2026, time.August, 5, 9, 0, 0, 0, time.UTC))

	got, err := meter.BudgetMetrics(context.Background())

	require.NoError(t, err)
	assert.Equal(t, usdCents(globalMonthlyCostCapUSD), got["global_month_cap_usd_cents"])
	assert.Equal(t, int64(perUserDailyRequestCap), got["per_user_daily_requests_cap"])
	// Self-consistency rather than an absolute spend, for the shared-database
	// reason above: whatever the estate total is, headroom must be the cap
	// minus exactly that, in the same unit.
	assert.Equal(t,
		got["global_month_cap_usd_cents"]-got["global_month_spend_usd_cents"],
		got["global_month_headroom_usd_cents"],
		"headroom must be the cap minus the reported spend, in the same unit")
	assert.GreaterOrEqual(t, got["global_month_spend_usd_cents"], int64(1234),
		"the seeded spend must be included in the estate figure")
}

// TestBudgetMetricsClampsHeadroomAtZeroOnceTheCapIsCrossed — past the cap the
// honest reading is "none left", never a negative number an operator has to
// interpret.
func TestBudgetMetricsClampsHeadroomAtZeroOnceTheCapIsCrossed(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, time.August, 19, 12, 0, 0, 0, time.UTC)
	meter := NewMeter(db)
	meter.now = func() time.Time { return now }
	seedSpend(t, db, userID, globalMonthlyCostCapUSD+10, time.Date(2026, time.August, 5, 9, 0, 0, 0, time.UTC))

	got, err := meter.BudgetMetrics(context.Background())

	require.NoError(t, err)
	assert.Zero(t, got["global_month_headroom_usd_cents"])
}

// TestUsdCentsRoundsRatherThanTruncates — truncation would report a $4.999
// spend as $4.99 forever, and more importantly would report sub-cent spend as
// zero, which is what "$0.00 against a $500 cap" looked like before.
func TestUsdCentsRoundsRatherThanTruncates(t *testing.T) {
	assert.Equal(t, int64(1235), usdCents(12.345))
	assert.Equal(t, int64(50000), usdCents(500))
	assert.Equal(t, int64(1), usdCents(0.006))
}

// TestGlobalMonthSpendIncludesSystemEvents — RecordSystem writes usage with a
// NULL user_id, and WithinBudget's global sum has no user filter, so that
// spend genuinely counts against the estate cap. A reader that quietly scoped
// itself to per-user rows would under-report the estate figure and show
// headroom that does not exist.
//
// Added because a mutation adding `user_id IS NOT NULL` to the query SURVIVED
// the rest of this file.
func TestGlobalMonthSpendIncludesSystemEvents(t *testing.T) {
	db := testDB(t)
	now := time.Date(2026, time.August, 19, 12, 0, 0, 0, time.UTC)
	meter := NewMeter(db)
	meter.now = func() time.Time { return now }

	before, err := meter.GlobalMonthSpendUSD(context.Background())
	require.NoError(t, err)

	at := time.Date(2026, time.August, 6, 9, 0, 0, 0, time.UTC)
	require.NoError(t, db.Exec(
		`INSERT INTO ai_usage_events
		   (user_id, provider, model, call_type, tokens_in, tokens_out, latency_ms, cost_usd_est, outcome, created_at)
		 VALUES (NULL, 'gemini', 'test', 'system', 1, 1, 1, ?, 'success', ?)`,
		3.5, at).Error)

	after, err := meter.GlobalMonthSpendUSD(context.Background())

	require.NoError(t, err)
	assert.InDelta(t, 3.5, after-before, 1e-9,
		"system spend counts against the estate cap, so it must count in the estate reading")
}
