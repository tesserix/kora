package billing

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
)

// seedPaidOrder inserts a settled order so an entitlement has something to
// hang off, and returns its id.
func seedPaidOrder(t *testing.T, db *gorm.DB, userID uuid.UUID, pack Pack) uuid.UUID {
	t.Helper()
	price := Price(pack)
	id := uuid.New()
	require.NoError(t, db.Exec(`
		INSERT INTO ai_payment_orders
			(id, user_id, pack_code, base_paise, platform_fee_paise, gst_paise, total_paise,
			 status, paid_at, invoice_number)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', now(), ?)`,
		id, userID, pack.Code, price.BasePaise, price.PlatformFeePaise, price.GSTPaise,
		price.TotalPaise, "KORA-TEST-"+id.String()[:8]).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM ai_payment_orders WHERE id = ?", id) })
	return id
}

// grantPack is the production grant path, used by tests so they cannot drift
// from what a real webhook writes.
func grantPack(t *testing.T, db *gorm.DB, userID uuid.UUID, pack Pack, now time.Time) uuid.UUID {
	t.Helper()
	orderID := seedPaidOrder(t, db, userID, pack)
	require.NoError(t, grantEntitlement(db, userID, orderID, pack, now))
	return orderID
}

func exhaustFreeWindows(t *testing.T, db *gorm.DB, userID uuid.UUID, now time.Time) {
	t.Helper()
	windows := quotaWindowsAt(now)
	for _, w := range windows {
		setQuotaCount(t, db, userID, w.kind, w.start, w.limit)
	}
}

func TestWithinBudgetRefusesAnExhaustedUserWithNoPack(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	meter := Meter{db: db, now: func() time.Time { return now }}

	exhaustFreeWindows(t, db, userID, now)

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.False(t, ok, "the free tier is unchanged for a user who bought nothing")
}

func TestWithinBudgetSpendsAPackOnceTheFreeWindowsAreGone(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	meter := Meter{db: db, now: func() time.Time { return now }}
	pack, err := PackByCode("spark")
	require.NoError(t, err)
	grantPack(t, db, userID, pack, now)

	exhaustFreeWindows(t, db, userID, now)

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.True(t, ok, "a paid pack admits the request")

	var consumed int
	require.NoError(t, db.Raw(
		"SELECT consumed FROM ai_entitlements WHERE user_id = ?", userID).Scan(&consumed).Error)
	require.Equal(t, 1, consumed, "exactly one request is charged to the pack")
}

// A pack must not be touched while anything free remains, or a user would pay
// for requests their free allowance already covers.
func TestWithinBudgetLeavesAPackUntouchedWhileTheFreeTierRemains(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	meter := Meter{db: db, now: func() time.Time { return now }}
	pack, err := PackByCode("spark")
	require.NoError(t, err)
	grantPack(t, db, userID, pack, now)

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.True(t, ok)

	var consumed int
	require.NoError(t, db.Raw(
		"SELECT consumed FROM ai_entitlements WHERE user_id = ?", userID).Scan(&consumed).Error)
	require.Zero(t, consumed, "the free window paid for this request")
}

func TestWithinBudgetEnforcesThePackDailyCap(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	meter := Meter{db: db, now: func() time.Time { return now }}
	pack, err := PackByCode("spark")
	require.NoError(t, err)
	grantPack(t, db, userID, pack, now)
	exhaustFreeWindows(t, db, userID, now)

	for i := 0; i < pack.DailyCap; i++ {
		ok, err := meter.WithinBudget(context.Background(), userID)
		require.NoError(t, err)
		require.Truef(t, ok, "request %d is within the daily cap", i+1)
	}

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.False(t, ok, "the pack's daily cap holds")

	// Tomorrow the same pack is spendable again, and the grant it has left is
	// what limits it — the daily cap is a rate, not a reduction of the grant.
	tomorrow := now.AddDate(0, 0, 1)
	meter = Meter{db: db, now: func() time.Time { return tomorrow }}
	exhaustFreeWindows(t, db, userID, tomorrow)
	ok, err = meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.True(t, ok, "the daily cap resets with the day")
}

func TestWithinBudgetRefusesOnceThePackGrantIsSpent(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	pack, err := PackByCode("spark")
	require.NoError(t, err)
	grantPack(t, db, userID, pack, now)
	require.NoError(t, db.Exec(
		"UPDATE ai_entitlements SET consumed = grant_total WHERE user_id = ?", userID).Error)

	meter := Meter{db: db, now: func() time.Time { return now }}
	exhaustFreeWindows(t, db, userID, now)

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.False(t, ok, "a spent pack grants nothing")
}

func TestWithinBudgetRefusesAnExpiredPack(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	bought := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)
	pack, err := PackByCode("spark")
	require.NoError(t, err)
	grantPack(t, db, userID, pack, bought)

	now := bought.Add(packValidity + time.Hour)
	meter := Meter{db: db, now: func() time.Time { return now }}
	exhaustFreeWindows(t, db, userID, now)

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.False(t, ok, "a pack stops working when it expires")
}

// The ₹1050 pack is the only one that keeps admitting requests past any daily
// number, and it must still leave an audit trail of what it covered.
func TestWithinBudgetAdmitsUnlimitedPackBeyondEveryDailyNumber(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	meter := Meter{db: db, now: func() time.Time { return now }}
	pack, err := PackByCode("boundless")
	require.NoError(t, err)
	require.True(t, pack.Unlimited)
	grantPack(t, db, userID, pack, now)
	exhaustFreeWindows(t, db, userID, now)

	for i := 0; i < 60; i++ {
		ok, err := meter.WithinBudget(context.Background(), userID)
		require.NoError(t, err)
		require.Truef(t, ok, "unlimited admits request %d", i+1)
	}

	var counted int
	require.NoError(t, db.Raw(`
		SELECT request_count FROM ai_entitlement_days d
		JOIN ai_entitlements e ON e.id = d.entitlement_id
		WHERE e.user_id = ?`, userID).Scan(&counted).Error)
	require.Equal(t, 60, counted, "unlimited usage is still recorded")
}

// The per-user monthly COST cap is purchasable — it is a free-tier throttle,
// and a user who bought a pack has already paid past it.
func TestWithinBudgetLetsAPackCoverTheUserCostCap(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	require.NoError(t, db.Exec(`
		INSERT INTO ai_usage_events (user_id, provider, model, call_type, tokens_in, tokens_out, latency_ms, cost_usd_est, outcome, created_at)
		VALUES (?, 'test', 'test-model', 'resolve', 0, 0, 1, ?, 'ok', ?)`,
		userID, perUserMonthlyCostCapUSD+1, now).Error)

	meter := Meter{db: db, now: func() time.Time { return now }}
	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.False(t, ok, "the cost cap stops a user with no pack")

	pack, err := PackByCode("spark")
	require.NoError(t, err)
	grantPack(t, db, userID, pack, now)

	ok, err = meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.True(t, ok, "the pack covers the request the cost cap refused")
}

// The GLOBAL cap protects the shared provider account, so no purchase may
// cross it: Kora cannot deliver what it has itself run out of.
func TestWithinBudgetKeepsTheGlobalCapUnpurchasable(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	other := seedUser(t, db)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	require.NoError(t, db.Exec(`
		INSERT INTO ai_usage_events (user_id, provider, model, call_type, tokens_in, tokens_out, latency_ms, cost_usd_est, outcome, created_at)
		VALUES (?, 'test', 'test-model', 'resolve', 0, 0, 1, ?, 'ok', ?)`,
		other, globalMonthlyCostCapUSD+1, now).Error)

	pack, err := PackByCode("boundless")
	require.NoError(t, err)
	grantPack(t, db, userID, pack, now)

	meter := Meter{db: db, now: func() time.Time { return now }}
	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.False(t, ok, "not even an unlimited pack crosses the platform cap")
}

// A replayed webhook must not grant a second entitlement for one payment.
func TestGrantEntitlementIsIdempotentPerOrder(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	pack, err := PackByCode("steady")
	require.NoError(t, err)
	orderID := seedPaidOrder(t, db, userID, pack)

	require.NoError(t, grantEntitlement(db, userID, orderID, pack, now))
	require.NoError(t, grantEntitlement(db, userID, orderID, pack, now))

	var count int64
	require.NoError(t, db.Model(&Entitlement{}).Where("order_id = ?", orderID).Count(&count).Error)
	require.EqualValues(t, 1, count, "one payment grants one entitlement")
}

func TestRemainingIsZeroForAnUnlimitedEntitlement(t *testing.T) {
	grant := 10
	require.Equal(t, 7, Entitlement{GrantTotal: &grant, Consumed: 3}.Remaining())
	require.Equal(t, 0, Entitlement{GrantTotal: &grant, Consumed: 99}.Remaining(), "remaining never goes negative")
	require.Equal(t, 0, Entitlement{Unlimited: true}.Remaining())
}
