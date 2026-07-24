package billing

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
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
