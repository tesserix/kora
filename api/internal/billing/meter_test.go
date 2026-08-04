package billing

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/metrics"
)

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

func TestWithinBudgetCallCountCap(t *testing.T) {
	db := testDB(t) // existing helper in this test file; it skips if no TEST_DATABASE_URL
	m := NewMeter(db)
	ctx := context.Background()
	uid := seedUser(t, db) // existing helper; creates a users row and returns its id

	// Insert exactly the cap number of zero-cost calls this month.
	for i := 0; i < perUserMonthlyCallCap; i++ {
		if err := m.Record(ctx, uid, ai.Usage{Provider: "gemini", Model: "gemini-3.5-flash-lite", CallType: "identify_text"}, 0); err != nil {
			t.Fatal(err)
		}
	}
	ok, err := m.WithinBudget(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatalf("WithinBudget = true at %d calls, want false (call-count cap)", perUserMonthlyCallCap)
	}
}

func TestEventJSONOmitsUserID(t *testing.T) {
	b, err := json.Marshal(Event{UserID: uuid.New(), Provider: "gemini"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "user_id") {
		t.Fatalf("Event JSON leaked user_id: %s", b)
	}
}

// WithinBudget deliberately does NOT filter on outcome. Both caps protect a
// real resource that a FAILED call still consumes:
//
//   - the cost cap, because providers return token usage alongside an error
//     (see openai.go: a response that arrived but failed to parse carries real
//     billed tokens), so excluding failures under-counts actual spend;
//   - the call cap, whose own comment says it exists to protect free-tier
//     provider quota — and quota is spent by any request that reaches the
//     provider, answered or not.
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
	for i := 0; i < perUserMonthlyCallCap; i++ {
		require.NoError(t, meter.Record(context.Background(), userID, timedOut, 0))
	}

	ok, err := meter.WithinBudget(context.Background(), userID)
	require.NoError(t, err)
	require.False(t, ok, "failed calls consume free-tier provider quota, which is exactly what the call cap guards")
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
