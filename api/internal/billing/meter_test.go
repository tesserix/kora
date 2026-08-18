package billing

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
	dto "github.com/prometheus/client_model/go"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/metrics"
)

// bucketCount reads histogram h's cumulative count for the bucket whose
// upper bound is le. Mirrors internal/metrics/metrics_test.go's helper of
// the same name — duplicated here (rather than exported from package
// metrics as production API) because it exists purely to let a test read a
// single bucket value off the wire representation.
func bucketCount(t *testing.T, h prometheus.Histogram, le float64) uint64 {
	t.Helper()
	var m dto.Metric
	require.NoError(t, h.Write(&m))
	for _, b := range m.GetHistogram().GetBucket() {
		if b.GetUpperBound() == le {
			return b.GetCumulativeCount()
		}
	}
	t.Fatalf("no bucket with le=%v", le)
	return 0
}

func testDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgres://kora:kora_dev@localhost:5432/kora?sslmode=disable"
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	if err != nil {
		t.Skipf("postgres unavailable: %v", err)
	}
	return db
}

// seedUser inserts a bare user row and returns its id.
func seedUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "billing-"+id.String(), "billing-"+id.String()+"@test.dev").Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM ai_usage_events WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

func setQuotaCount(t *testing.T, db *gorm.DB, userID uuid.UUID, kind string, start time.Time, count int) {
	t.Helper()
	require.NoError(t, db.Exec(`
		INSERT INTO ai_quota_windows (user_id, window_kind, window_start, request_count)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id, window_kind, window_start)
		DO UPDATE SET request_count = EXCLUDED.request_count, updated_at = now()`,
		userID, kind, start, count).Error)
}

func quotaCount(t *testing.T, db *gorm.DB, userID uuid.UUID, kind string, start time.Time) int {
	t.Helper()
	var count int
	require.NoError(t, db.Raw(`
		SELECT request_count FROM ai_quota_windows
		WHERE user_id = ? AND window_kind = ? AND window_start = ?`,
		userID, kind, start).Scan(&count).Error)
	return count
}

func TestQuotaWindowStartsUseFixedUTCBoundaries(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, time.January, 1, 0, 30, 0, 0, time.FixedZone("AEDT", 11*60*60))
	windows := quotaWindowsAt(now)

	require.Equal(t, time.Date(2025, time.December, 31, 0, 0, 0, 0, time.UTC), windows[0].start)
	require.Equal(t, time.Date(2025, time.December, 29, 0, 0, 0, 0, time.UTC), windows[1].start)
	require.Equal(t, time.Date(2025, time.December, 1, 0, 0, 0, 0, time.UTC), windows[2].start)
}

func TestWithinBudgetRollsBackEveryWindowWhenDailyQuotaIsExhausted(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, time.August, 19, 12, 0, 0, 0, time.UTC)
	meter := NewMeter(db)
	meter.now = func() time.Time { return now }
	windows := quotaWindowsAt(now)
	setQuotaCount(t, db, userID, quotaDay, windows[0].start, perUserDailyRequestCap)
	setQuotaCount(t, db, userID, quotaWeek, windows[1].start, 7)
	setQuotaCount(t, db, userID, quotaMonth, windows[2].start, 8)

	ok, err := meter.WithinBudget(context.Background(), userID)

	require.NoError(t, err)
	require.False(t, ok)
	require.Equal(t, perUserDailyRequestCap, quotaCount(t, db, userID, quotaDay, windows[0].start))
	require.Equal(t, 7, quotaCount(t, db, userID, quotaWeek, windows[1].start))
	require.Equal(t, 8, quotaCount(t, db, userID, quotaMonth, windows[2].start))
}

func TestWithinBudgetEnforcesWeeklyAndMonthlyQuota(t *testing.T) {
	tests := []struct {
		name  string
		kind  string
		index int
		limit int
	}{
		{name: "weekly", kind: quotaWeek, index: 1, limit: perUserWeeklyRequestCap},
		{name: "monthly", kind: quotaMonth, index: 2, limit: perUserMonthlyRequestCap},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			db := testDB(t)
			userID := seedUser(t, db)
			now := time.Date(2026, time.August, 19, 12, 0, 0, 0, time.UTC)
			meter := NewMeter(db)
			meter.now = func() time.Time { return now }
			windows := quotaWindowsAt(now)
			setQuotaCount(t, db, userID, tt.kind, windows[tt.index].start, tt.limit)

			ok, err := meter.WithinBudget(context.Background(), userID)

			require.NoError(t, err)
			require.False(t, ok)
		})
	}
}

func TestWithinBudgetResetsAtNewUTCWindows(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	previous := time.Date(2026, time.August, 31, 23, 59, 59, 0, time.UTC)
	now := previous.Add(time.Second)
	previousWindows := quotaWindowsAt(previous)
	for _, window := range previousWindows {
		setQuotaCount(t, db, userID, window.kind, window.start, window.limit)
	}
	meter := NewMeter(db)
	meter.now = func() time.Time { return now }

	ok, err := meter.WithinBudget(context.Background(), userID)

	require.NoError(t, err)
	require.True(t, ok)
	for _, window := range quotaWindowsAt(now) {
		require.Equal(t, 1, quotaCount(t, db, userID, window.kind, window.start))
	}
}

func TestWithinBudgetSerializesConcurrentReservations(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	meter := NewMeter(db)
	meter.now = func() time.Time {
		return time.Date(2026, time.August, 19, 12, 0, 0, 0, time.UTC)
	}

	var allowed atomic.Int32
	var denied atomic.Int32
	errs := make(chan error, perUserDailyRequestCap+10)
	var wg sync.WaitGroup
	for range perUserDailyRequestCap + 10 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := meter.WithinBudget(context.Background(), userID)
			if err != nil {
				errs <- err
				return
			}
			if ok {
				allowed.Add(1)
			} else {
				denied.Add(1)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	require.Equal(t, int32(perUserDailyRequestCap), allowed.Load())
	require.Equal(t, int32(10), denied.Load())
	day := quotaWindowsAt(meter.now())[0]
	require.Equal(t, perUserDailyRequestCap, quotaCount(t, db, userID, quotaDay, day.start))
}

func TestWithinBudgetFailsClosedWhenDatabaseIsUnavailable(t *testing.T) {
	db := testDB(t)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	require.NoError(t, sqlDB.Close())

	ok, err := NewMeter(db).WithinBudget(context.Background(), uuid.New())

	require.Error(t, err)
	require.False(t, ok)
}

func TestRecordInsertsUsageEvent(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	meter := NewMeter(db)

	usage := ai.Usage{
		Provider:  "openai",
		Model:     "gpt-4o",
		CallType:  "identify_text",
		TokensIn:  120,
		TokensOut: 45,
		LatencyMs: 850,
	}
	require.NoError(t, meter.Record(context.Background(), userID, usage, 0.0123))

	var got Event
	require.NoError(t, db.Where("user_id = ?", userID).First(&got).Error)
	require.Equal(t, usage.Provider, got.Provider)
	require.Equal(t, usage.Model, got.Model)
	require.Equal(t, usage.CallType, got.CallType)
	require.Equal(t, usage.TokensIn, got.TokensIn)
	require.Equal(t, usage.TokensOut, got.TokensOut)
	require.Equal(t, usage.LatencyMs, got.LatencyMs)
	require.InDelta(t, 0.0123, got.CostUSDEst, 1e-9)
}

func TestWithinBudgetTrueWithNoEvents(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	meter := NewMeter(db)

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.True(t, ok)
}

func TestWithinBudgetFalseAfterCrossingPerUserCap(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	meter := NewMeter(db)

	// Two events summing to exactly the per-user monthly cap.
	usage := ai.Usage{Provider: "openai", Model: "gpt-4o", CallType: "identify_text", TokensIn: 10, TokensOut: 10, LatencyMs: 100}
	require.NoError(t, meter.Record(context.Background(), userID, usage, perUserMonthlyCostCapUSD/2))
	require.NoError(t, meter.Record(context.Background(), userID, usage, perUserMonthlyCostCapUSD/2))

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.False(t, ok)
}

func TestWithinBudgetMonthlyRequestCap(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	now := time.Date(2026, time.August, 19, 12, 0, 0, 0, time.UTC)
	meter := NewMeter(db)
	meter.now = func() time.Time { return now }
	month := quotaWindowsAt(now)[2]
	setQuotaCount(t, db, userID, quotaMonth, month.start, perUserMonthlyRequestCap)

	ok, err := meter.WithinBudget(context.Background(), userID)

	require.NoError(t, err)
	require.False(t, ok)
}

// TestRecordSystemInsertsWithNullUserID pins the food-index backfill's
// metering path (kora#97). The row MUST land with user_id NULL: the zero UUID
// a non-pointer field would have written is rejected by
// ai_usage_events_user_id_fkey, so the insert would fail and the spend would
// stay invisible — the exact bug this path exists to close.
func TestRecordSystemInsertsWithNullUserID(t *testing.T) {
	db := testDB(t)
	meter := NewMeter(db)

	// A model string unique to this run, so the row is findable and removable
	// without a user_id to scope by.
	model := "test-embed-" + uuid.NewString()
	t.Cleanup(func() { db.Exec("DELETE FROM ai_usage_events WHERE model = ?", model) })

	usage := ai.Usage{
		Provider: "gemini", Model: model, CallType: "embed",
		LatencyMs: 120, Outcome: ai.OutcomeOK,
	}
	require.NoError(t, meter.RecordSystem(context.Background(), usage, 0))

	var got Event
	require.NoError(t, db.Where("model = ?", model).First(&got).Error)
	require.Nil(t, got.UserID, "a system call has no owning user and must store NULL, not the zero UUID")
	require.Equal(t, "embed", got.CallType)

	var nullCount int64
	require.NoError(t, db.Model(&Event{}).
		Where("model = ? AND user_id IS NULL", model).Count(&nullCount).Error)
	require.Equal(t, int64(1), nullCount, "the column itself must be NULL in the database")
}

func TestEventJSONOmitsUserID(t *testing.T) {
	id := uuid.New()
	b, err := json.Marshal(Event{UserID: &id, Provider: "gemini"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "user_id") {
		t.Fatalf("Event JSON leaked user_id: %s", b)
	}
}

// The cost ledger deliberately does NOT filter on outcome. Both caps protect
// a real resource that a FAILED call still consumes:
//
//   - the cost cap, because providers return token usage alongside an error
//     (see openai.go: a response that arrived but failed to parse carries real
//     billed tokens), so excluding failures under-counts actual spend;
//   - the request cap, because a reservation is not released after a provider
//     failure or timeout.
//
// These two tests exist because the `outcome` column added in #81 invites the
// opposite conclusion. Anyone "fixing" WithinBudget to filter outcome = 'ok'
// will fail here and read why. Product metrics are the ones that must filter;
// resource protection is not.
func TestWithinBudgetCountsFailedCallsTowardTheCostCap(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	meter := NewMeter(db)

	// A call that reached the model, burned tokens, then failed. Real money.
	failed := ai.Usage{
		Provider: "openai", Model: "gpt-4o", CallType: "identify_text",
		TokensIn: 10, TokensOut: 10, LatencyMs: 100, Outcome: ai.OutcomeError,
	}
	require.NoError(t, meter.Record(context.Background(), userID, failed, perUserMonthlyCostCapUSD))

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.False(t, ok, "a failed call that consumed tokens still spent money and must count")
}

func TestWithinBudgetCountsFailedCallsTowardTheCallCap(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	meter := NewMeter(db)

	// Zero-cost failures — e.g. timeouts — so ONLY the call cap can trip.
	// Each still consumed provider quota, which is what that cap guards.
	timedOut := ai.Usage{
		Provider: "openai", Model: "gpt-4o", CallType: "identify_photo",
		LatencyMs: 30000, Outcome: ai.OutcomeTimeout,
	}
	for range perUserDailyRequestCap {
		ok, err := meter.WithinBudget(context.Background(), userID)
		require.NoError(t, err)
		require.True(t, ok)
		require.NoError(t, meter.Record(context.Background(), userID, timedOut, 0))
	}

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.False(t, ok, "a failed provider call must not refund its quota reservation")
}

// The provider call happened — and was billed by the provider — whether or not
// our ai_usage_events row lands. So the counter must move even when the insert
// fails. Metering the ROW and metering the CALL are different questions, and
// conflating them would silently under-report COGS in exactly the situation
// where something is already going wrong.
func TestRecordIncrementsTheCounterEvenWhenTheInsertFails(t *testing.T) {
	db := testDB(t)
	sqlDB, err := db.DB()
	require.NoError(t, err)
	require.NoError(t, sqlDB.Close()) // every subsequent query now errors

	m := NewMeter(db)
	collectors := metrics.Default()
	before := testutil.ToFloat64(collectors.AICallsCounter("resolution", "identify_text", "test-model", "ok"))

	err = m.Record(context.Background(), uuid.New(),
		ai.Usage{Provider: "test", Model: "test-model", CallType: "identify_text", LatencyMs: 884, Outcome: "ok"}, 0.0004)

	require.Error(t, err, "insert against a closed DB must still return an error")
	after := testutil.ToFloat64(collectors.AICallsCounter("resolution", "identify_text", "test-model", "ok"))
	require.Equal(t, before+1, after, "counter must increment even though the insert failed")
}

// THE ms→Duration SEAM. Record converts u.LatencyMs (an int, milliseconds)
// to a time.Duration via `time.Duration(u.LatencyMs) * time.Millisecond`
// (meter.go:43). Drop that `* time.Millisecond` and 20000 becomes 20000
// NANOSECONDS instead of 20 seconds — every observation then lands in the
// smallest latency bucket regardless of how slow the call actually was, and
// "how often does the fast path miss its budget?" silently answers "never"
// forever. This is the exact bug #43's histogram buckets exist to catch, so
// the conversion itself needs its own test independent of the metrics
// package (which only tests Observe with an already-correct time.Duration
// and can't see this seam at all).
//
// Uses before/after deltas rather than absolute bucket counts:
// metrics.Default() is process-global and shared across every test in this
// package, so an earlier test's observation may have already pushed the
// le=20 bucket's cumulative count above zero.
func TestRecordConvertsLatencyMsToSecondsNotNanoseconds(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db)
	meter := NewMeter(db)

	hist := metrics.Default().AILatencyHistogram("identify_text", "ok")
	beforeSmallest := bucketCount(t, hist, 0.25)

	usage := ai.Usage{
		Provider: "openai", Model: "test-model", CallType: "identify_text",
		LatencyMs: 20000, Outcome: ai.OutcomeOK, // 20s if converted correctly
	}
	require.NoError(t, meter.Record(context.Background(), userID, usage, 0.001))

	afterSmallest := bucketCount(t, hist, 0.25)
	require.Equal(t, beforeSmallest, afterSmallest,
		"a 20000ms LatencyMs must NOT land in the le=0.25s bucket — it only can if the ms→Duration conversion dropped * time.Millisecond and turned 20000ms into 20000ns")
}
