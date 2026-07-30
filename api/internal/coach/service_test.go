package coach

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/dashboard"
	"github.com/tesserix/kora/api/internal/foodlog"
	"github.com/tesserix/kora/api/internal/httpx"
	"github.com/tesserix/kora/api/internal/memory"
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
