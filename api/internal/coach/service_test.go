package coach

import (
	"context"
	"errors"
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

// errorProvider is an ai.Provider test double whose GenerateText always
// fails, used to exercise Ask's provider-error path.
type errorProvider struct{}

func (e *errorProvider) IdentifyText(ctx context.Context, phrase string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (e *errorProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (e *errorProvider) Decompose(ctx context.Context, dish string) ([]ai.IngredientGuess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (e *errorProvider) Embed(ctx context.Context, text string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (e *errorProvider) Transcribe(ctx context.Context, audio []byte, mime string) (string, ai.Usage, error) {
	return "", ai.Usage{}, nil
}

func (e *errorProvider) GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, ai.Usage, error) {
	return "", ai.Usage{}, errors.New("provider boom")
}

func (e *errorProvider) Name() string { return "error" }

var _ ai.Provider = (*errorProvider)(nil)

// recordingProvider is an ai.Provider test double that records the exact
// systemPrompt/userPrompt it was called with, used to assert on precisely
// what the model sees — e.g. that stored thread turns never leak into it.
type recordingProvider struct {
	systemPrompt string
	userPrompt   string
	answer       string
}

func (r *recordingProvider) IdentifyText(ctx context.Context, phrase string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (r *recordingProvider) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]ai.Guess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (r *recordingProvider) Decompose(ctx context.Context, dish string) ([]ai.IngredientGuess, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (r *recordingProvider) Embed(ctx context.Context, text string) ([]float32, ai.Usage, error) {
	return nil, ai.Usage{}, nil
}

func (r *recordingProvider) Transcribe(ctx context.Context, audio []byte, mime string) (string, ai.Usage, error) {
	return "", ai.Usage{}, nil
}

func (r *recordingProvider) GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, ai.Usage, error) {
	r.systemPrompt = systemPrompt
	r.userPrompt = userPrompt
	answer := r.answer
	if answer == "" {
		answer = "a canned recorded answer"
	}
	return answer, ai.Usage{}, nil
}

func (r *recordingProvider) Name() string { return "recording" }

var _ ai.Provider = (*recordingProvider)(nil)

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
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	provider := &fakeProvider{
		text:      "You have 55g protein to go.",
		textUsage: ai.Usage{Provider: "stub", Model: "test-model", CallType: "generate_text"},
	}
	meter := &stubMeter{withinBudget: true}
	svc := NewService(&g, provider, meter, nil)

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
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	provider := &fakeProvider{text: "should not be reached"}
	meter := &stubMeter{withinBudget: false}
	svc := NewService(&g, provider, meter, nil)

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	a, err := svc.Ask(context.Background(), userID, now, time.UTC, "how's my protein?")

	require.NoError(t, err)
	require.Equal(t, 0, provider.calls, "provider must never be called once over budget")
	require.Empty(t, meter.records, "no usage should be recorded when the provider was never called")
	require.Contains(t, a.Text, "usage limit")
}

func TestAsk_NilProviderDegradesGracefully(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	meter := &stubMeter{withinBudget: true}
	svc := NewService(&g, nil, meter, nil)

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	a, err := svc.Ask(context.Background(), userID, now, time.UTC, "how's my protein?")

	require.NoError(t, err, "a nil provider must degrade gracefully, not error or panic")
	require.Equal(t, providerUnavailableText, a.Text)
	require.Empty(t, meter.records, "Record must never be called on the nil-provider path")
}

func TestAsk_EmptyQuestion(t *testing.T) {
	svc := NewService(nil, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)

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
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	const restrictiveRaw = "You've eaten enough today — try to cut back tomorrow."
	provider := &fakeProvider{text: restrictiveRaw}
	meter := &stubMeter{withinBudget: true}
	svc := NewService(&g, provider, meter, nil)

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
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	seedSteadyWeek(t, db, logRepo, userID, now, 2000)

	const restrictiveRaw = "You've eaten enough today — try to cut back tomorrow."
	provider := &fakeProvider{text: restrictiveRaw}
	meter := &stubMeter{withinBudget: true}
	svc := NewService(&g, provider, meter, nil)

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
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	seedSteadyWeek(t, db, logRepo, userID, now, 2000)

	const supportiveRaw = "You have 55g protein to go — a yoghurt would help."
	provider := &fakeProvider{text: supportiveRaw}
	meter := &stubMeter{withinBudget: true}
	svc := NewService(&g, provider, meter, nil)

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
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	r, err := svc.Nudges(context.Background(), userID, now, time.UTC)

	require.NoError(t, err)
	require.NotEmpty(t, r.Nudges, "a fresh user with no logs should still get a protein-gap nudge")
}

func TestServiceAsk_PersistsExchange(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)

	_, err := svc.Ask(context.Background(), userID, time.Now().UTC(), time.UTC, "what should I eat?")
	require.NoError(t, err)

	turns, err := threadRepo.ListRecent(context.Background(), userID, maxThreadTurns)
	require.NoError(t, err)
	require.Len(t, turns, 2)
	require.Equal(t, TurnRoleUser, turns[0].Role)
	require.Equal(t, "what should I eat?", turns[0].Text)
	require.Equal(t, TurnRoleOtto, turns[1].Role)
	require.NotEmpty(t, turns[1].Citations, "the answer's grounding facts should be stored")
}

func TestServiceAsk_DoesNotPersistWhenBudgetExhausted(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: false}, &threadRepo)

	ans, err := svc.Ask(context.Background(), userID, time.Now().UTC(), time.UTC, "hello")
	require.NoError(t, err)
	require.Equal(t, budgetDegradedText, ans.Text)

	turns, err := threadRepo.ListRecent(context.Background(), userID, maxThreadTurns)
	require.NoError(t, err)
	require.Empty(t, turns, "a budget-degraded reply is a UI state, not a stored turn")
}

func TestServiceAsk_DoesNotPersistWhenNoProvider(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	svc := NewService(&g, nil, &stubMeter{withinBudget: true}, &threadRepo)

	_, err := svc.Ask(context.Background(), userID, time.Now().UTC(), time.UTC, "hello")
	require.NoError(t, err)

	turns, err := threadRepo.ListRecent(context.Background(), userID, maxThreadTurns)
	require.NoError(t, err)
	require.Empty(t, turns)
}

// TestServiceAsk_PriorTurnsNeverEnterThePrompt is the single most important
// guard in this PR: persisting the thread for replay must never change what
// the model sees. A prior exchange with a distinctive marker is stored, then
// Ask is called for a new question — the marker must never appear in the
// prompt passed to the provider. This must pass on first run: Task 3 wired
// storage and replay only, it never touched prompt construction. If this
// test ever fails, prompt construction was changed and must be reverted —
// this test is the guard, never a target to satisfy by editing the assertion.
func TestServiceAsk_PriorTurnsNeverEnterThePrompt(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	// A prior exchange with a distinctive marker already in the thread.
	require.NoError(t, threadRepo.AppendExchange(context.Background(), userID,
		"UNIQUEPRIORQUESTION", "UNIQUEPRIORANSWER", nil))

	rec := &recordingProvider{}
	svc := NewService(&g, rec, &stubMeter{withinBudget: true}, &threadRepo)

	_, err := svc.Ask(context.Background(), userID, time.Now().UTC(), time.UTC, "today's question")
	require.NoError(t, err)

	require.NotContains(t, rec.userPrompt, "UNIQUEPRIORQUESTION",
		"store+replay only: a prior turn must never reach the prompt")
	require.NotContains(t, rec.userPrompt, "UNIQUEPRIORANSWER",
		"store+replay only: a prior answer must never reach the prompt")
	require.Contains(t, rec.userPrompt, "today's question")
}

func TestServiceAsk_PersistsNothingOnProviderError(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	svc := NewService(&g, &errorProvider{}, &stubMeter{withinBudget: true}, &threadRepo)

	_, err := svc.Ask(context.Background(), userID, time.Now().UTC(), time.UTC, "hello")
	require.Error(t, err)

	turns, err := threadRepo.ListRecent(context.Background(), userID, maxThreadTurns)
	require.NoError(t, err)
	require.Empty(t, turns, "a failed generation must not leave an orphaned question")
}
