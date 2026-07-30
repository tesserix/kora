package coach

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/memory"
	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/tracking"
)

// fakeProvider is a minimal ai.Provider test double for the coach package:
// only GenerateText is exercised by Service, so every other method is a
// no-op stub that exists solely to satisfy the interface.
type fakeProvider struct {
	text      string
	textUsage ai.Usage
	textErr   error

	calls int
}

func (f *fakeProvider) IdentifyText(ctx context.Context, phrase string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (f *fakeProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (f *fakeProvider) Decompose(ctx context.Context, dish string) ([]ai.IngredientGuess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (f *fakeProvider) Embed(ctx context.Context, text string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (f *fakeProvider) Transcribe(ctx context.Context, audio []byte, mime string) (string, ai.Usage, error) {
	return "", ai.Usage{}, nil
}

func (f *fakeProvider) GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, ai.Usage, error) {
	f.calls++
	return f.text, f.textUsage, f.textErr
}

func (f *fakeProvider) Name() string { return "fake" }

var _ ai.Provider = (*fakeProvider)(nil)

// stubMeter is a configurable ai.Meter test double, mirroring the shape of
// ai/resolver_test.go's stubMeter (kept local here since that one is
// unexported in package ai).
type stubMeter struct {
	withinBudget    bool
	withinBudgetErr error

	recordErr error
	records   []ai.Usage
}

func (m *stubMeter) Record(ctx context.Context, userID uuid.UUID, u ai.Usage, costUSD float64) error {
	m.records = append(m.records, u)
	return m.recordErr
}

func (m *stubMeter) WithinBudget(ctx context.Context, userID uuid.UUID) (bool, error) {
	return m.withinBudget, m.withinBudgetErr
}

var _ ai.Meter = (*stubMeter)(nil)

func TestAsk_GroundedAnswerReturnsCitations(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc)

	provider := &fakeProvider{
		text:      "You have 55g protein to go.",
		textUsage: ai.Usage{Provider: "stub", Model: "test-model", CallType: "generate_text"},
	}
	meter := &stubMeter{withinBudget: true}
	svc := NewService(&g, provider, meter)

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	a, err := svc.Ask(context.Background(), userID, now, time.UTC, "how's my protein?")

	require.NoError(t, err)
	require.NotEmpty(t, a.Text)
	require.NotEmpty(t, a.Citations)
	require.Equal(t, 1, provider.calls, "provider must be called when within budget")
	require.Len(t, meter.records, 1, "usage must be recorded")
}

func TestAsk_OverBudgetDegradesGracefully(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc)

	provider := &fakeProvider{text: "should not be reached"}
	meter := &stubMeter{withinBudget: false}
	svc := NewService(&g, provider, meter)

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	a, err := svc.Ask(context.Background(), userID, now, time.UTC, "how's my protein?")

	require.NoError(t, err)
	require.Equal(t, 0, provider.calls, "provider must never be called once over budget")
	require.Empty(t, meter.records, "no usage should be recorded when the provider was never called")
	require.Contains(t, a.Text, "usage limit")
}

func TestAsk_EmptyQuestion(t *testing.T) {
	svc := NewService(nil, &fakeProvider{}, &stubMeter{withinBudget: true})

	_, err := svc.Ask(context.Background(), uuid.New(), time.Now(), time.UTC, "  ")

	require.Error(t, err)
	msg, ok := httpx.IsValidation(err)
	require.True(t, ok, "empty question must produce an httpx.ValidationError")
	require.NotEmpty(t, msg)
}

func TestLooksRestrictive(t *testing.T) {
	tests := []struct {
		name string
		text string
		want bool
	}{
		{"eat less", "You should try to eat less today.", true},
		{"eaten enough", "You've eaten enough for today.", true},
		{"had enough", "You've had enough already.", true},
		{"stop eating", "Maybe stop eating for now.", true},
		{"skip a meal", "You could skip a meal.", true},
		{"skip meals", "You could try to skip meals sometimes.", true},
		{"cut back", "Time to cut back on snacks.", true},
		{"restrict", "Consider restricting your intake.", true},
		{"too many calories", "That's too many calories today.", true},
		{"go to bed hungry", "It's fine to go to bed hungry tonight.", true},
		{"case-insensitive", "YOU SHOULD EAT LESS.", true},
		{"supportive answer", "You have 55g protein to go — a yoghurt would help.", false},
		{"empty", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.want, looksRestrictive(tt.text))
		})
	}
}

// seedSteadyWeek seeds one log per day for the trailing recentWindowDays
// window (today included), each hitting targetKcal exactly, so the derived
// guardrails.Signals carry no risk: RecentDeficitPct == 0, AvgIntakeKcal ==
// targetKcal (comfortably above the low-intake risk threshold), and
// FastingStreakDays == 0 (today has a log). Used by tests that need to
// exercise the "no ED-risk signal" branch of the Protective policy
// deterministically.
func seedSteadyWeek(t *testing.T, db *gorm.DB, logRepo foodlog.Repository, userID uuid.UUID, now time.Time, targetKcal float64) {
	t.Helper()
	item := nutrition.FoodItem{
		Name: "Coach Steady Week Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 200, ProteinPer100g: 20,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	for i := 0; i < recentWindowDays; i++ {
		seedLog(t, db, logRepo, foodlog.FoodLog{
			UserID: userID, FoodItemID: &item.ID, LoggedAt: now.AddDate(0, 0, -i).Add(-time.Hour),
			MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
			QuantityGrams: targetKcal / 200 * 100, Kcal: targetKcal, ProteinG: targetKcal / 10,
		})
	}
}

func TestAsk_RestrictiveAnswerSuppressedUnderRisk(t *testing.T) {
	db := testDB(t)
	// No logs seeded: a fresh user is fasting for the whole window, which
	// trips the FastingStreakDays risk threshold on its own.
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc)

	const restrictiveRaw = "You've eaten enough today — try to cut back tomorrow."
	provider := &fakeProvider{text: restrictiveRaw}
	meter := &stubMeter{withinBudget: true}
	svc := NewService(&g, provider, meter)

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	a, err := svc.Ask(context.Background(), userID, now, time.UTC, "how am I doing?")

	require.NoError(t, err)
	require.Equal(t, suppressedAnswerMessage, a.Text, "Suppress must fall back to the safe supportive message, not empty text")
	require.True(t, a.ShowSupport)
	require.NotContains(t, a.Text, "cut back")
	require.NotContains(t, a.Text, "eaten enough")
}

func TestAsk_RestrictiveAnswerSoftenedWhenNoRisk(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc)

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	seedSteadyWeek(t, db, logRepo, userID, now, 2000)

	const restrictiveRaw = "You've eaten enough today — try to cut back tomorrow."
	provider := &fakeProvider{text: restrictiveRaw}
	meter := &stubMeter{withinBudget: true}
	svc := NewService(&g, provider, meter)

	a, err := svc.Ask(context.Background(), userID, now, time.UTC, "how am I doing?")

	require.NoError(t, err)
	require.NotEmpty(t, a.Text)
	require.NotEqual(t, restrictiveRaw, a.Text, "a restrictive answer must be reframed, not passed through")
	require.NotContains(t, strings.ToLower(a.Text), "cut back")
	require.NotContains(t, strings.ToLower(a.Text), "eaten enough")
}

func TestAsk_NonRestrictiveAnswerAllowedUnchanged(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc)

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	seedSteadyWeek(t, db, logRepo, userID, now, 2000)

	const supportiveRaw = "You have 55g protein to go — a yoghurt would help."
	provider := &fakeProvider{text: supportiveRaw}
	meter := &stubMeter{withinBudget: true}
	svc := NewService(&g, provider, meter)

	a, err := svc.Ask(context.Background(), userID, now, time.UTC, "how's my protein?")

	require.NoError(t, err)
	require.Equal(t, supportiveRaw, a.Text, "Allow must pass the raw answer through unchanged")
}

func TestNudges_WrapsBuildContextAndBuildNudges(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true})

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	r, err := svc.Nudges(context.Background(), userID, now, time.UTC)

	require.NoError(t, err)
	require.NotEmpty(t, r.Nudges, "a fresh user with no logs should still get a protein-gap nudge")
}
