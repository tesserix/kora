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

// seedUnderEatingWeek seeds one log per day for the trailing recentWindowDays
// window (today included), each at 40% of targetKcal — a genuine, explicitly
// logged shortfall (deficit 0.6, well past riskDeficitPct) rather than the
// mere absence of logs. Days with no logs at all no longer register as a
// deficit (see recentDeficitPct's doc comment: absent data isn't evidence of
// not eating), so tests that need a deterministic at-risk fixture via
// RecentDeficitPct must seed real under-eating like this, not just omit
// logs.
func seedUnderEatingWeek(t *testing.T, db *gorm.DB, logRepo foodlog.Repository, userID uuid.UUID, now time.Time, targetKcal float64) {
	t.Helper()
	item := nutrition.FoodItem{
		Name: "Coach Under-Eating Week Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 200, ProteinPer100g: 20,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	underEatKcal := 0.4 * targetKcal
	for i := 0; i < recentWindowDays; i++ {
		seedLog(t, db, logRepo, foodlog.FoodLog{
			UserID: userID, FoodItemID: &item.ID, LoggedAt: now.AddDate(0, 0, -i).Add(-time.Hour),
			MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
			QuantityGrams: underEatKcal / 200 * 100, Kcal: underEatKcal, ProteinG: underEatKcal / 10,
		})
	}
}

func TestAsk_RestrictiveAnswerSuppressedUnderRisk(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	// Genuine, explicitly logged under-eating every day of the window trips
	// AtRisk via RecentDeficitPct. Unlogged days no longer score as a
	// deficit (see recentDeficitPct's doc comment) — a fresh user with no
	// logs at all is no longer at risk by default, so this fixture must
	// seed real evidence of under-eating, not merely omit logs.
	seedUnderEatingWeek(t, db, logRepo, userID, now, 2000)

	const restrictiveRaw = "You've eaten enough today — try to cut back tomorrow."
	provider := &fakeProvider{text: restrictiveRaw}
	meter := &stubMeter{withinBudget: true}
	svc := NewService(&g, provider, meter, nil)

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

// TestServiceNudges_FreshUserIsNotFlaggedAtRisk is the acceptance test for
// this branch: a brand-new user with no logs at all must not be shown the
// ED support card on first use. Uses a realistic positive target_kcal (not
// 0) specifically so this exercises the recentDeficitPct path for real — a
// 0 target makes recentDeficitPct short-circuit to 0 regardless of the fix,
// which would make this assertion pass even against the old buggy code.
func TestServiceNudges_FreshUserIsNotFlaggedAtRisk(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)
	// No logs at all — a brand-new user.

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)

	result, err := svc.Nudges(context.Background(), userID, time.Now().UTC(), time.UTC)

	require.NoError(t, err)
	require.False(t, result.ShowSupport,
		"a brand-new user has no data, and must not be shown an ED support resource on first use")
}

// TestServiceNudges_FreshUserWhoLoggedOneMealTodayIsNotFlagged proves the
// today-exclusion fix end-to-end, against a realistically seeded user, not a
// narrowed Context/Signals construction: a brand-new user whose only log is
// a single partial meal logged earlier today must not be shown the ED
// support card. TestServiceNudges_FreshUserIsNotFlaggedAtRisk (zero logs)
// cannot see this bug — with zero logs, both RecentDeficitPct and
// AvgIntakeKcal already short-circuit to 0 ("nothing logged") regardless of
// today-exclusion. This test seeds exactly one partial log, today, so
// RecentDaily's last entry (today) is the ONLY logged day in the window.
// Before the today-exclusion fix, that made today's own partial reading the
// entire RecentDeficitPct signal (1 - 450/2000 = 0.775, well past the 0.30
// threshold). Fixing RecentDeficitPct alone was not sufficient, though:
// AvgIntakeKcal (computed in grounding.go's summarizeRecent) also derives
// from RecentDaily, and averaged the same lone 450 kcal log over a
// hard-coded 7-day denominator (450/7 ≈ 64.3 kcal) — positive and far below
// riskAvgIntakeKcal (1200), independently tripping guardrails.AtRisk. Both
// signals must exclude today and average only over logged days for this
// scenario to correctly read as "no data yet", not "at risk".
func TestServiceNudges_FreshUserWhoLoggedOneMealTodayIsNotFlagged(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	item := nutrition.FoodItem{
		Name: "Coach Fresh User Breakfast " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 225, ProteinPer100g: 15,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	// Fixed, mid-afternoon "now" (not time.Now()): LoggedAt is 2 hours
	// earlier and must land in the same UTC calendar day as now for this
	// test to actually exercise today-exclusion. time.Now() would make that
	// day-boundary alignment flaky depending on wall-clock time at test run.
	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	// One partial meal, a couple hours before now — a brand-new user's first
	// log of the day, not a full day's intake.
	seedLog(t, db, logRepo, foodlog.FoodLog{
		UserID: userID, FoodItemID: &item.ID, LoggedAt: now.Add(-2 * time.Hour),
		MealSlot: "breakfast", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
		QuantityGrams: 200, Kcal: 450, ProteinG: 30,
	})

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)

	result, err := svc.Nudges(context.Background(), userID, now, time.UTC)

	require.NoError(t, err)
	require.False(t, result.ShowSupport,
		"a single partial meal logged today must not be treated as the whole window's deficit or intake signal")
}

// TestServiceNudges_GenuineDeficitStillFlagsAtRisk proves the fresh-user fix
// reduced sensitivity deliberately, not accidentally to zero: a user with a
// real, explicitly logged week-long shortfall (seedUnderEatingWeek logs at
// 40% of target every day) must still trip ShowSupport via RecentDeficitPct.
func TestServiceNudges_GenuineDeficitStillFlagsAtRisk(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	seedUnderEatingWeek(t, db, logRepo, userID, now, 2000)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)

	result, err := svc.Nudges(context.Background(), userID, now, time.UTC)

	require.NoError(t, err)
	require.True(t, result.ShowSupport,
		"a genuine week of logged under-eating must still trip ED-risk via RecentDeficitPct")
}

// TestServiceNudges_GenuineFastingGapStillFlagsAtRisk proves the
// fastingStreak fix also still fires for a real gap: target_kcal is 0 so
// RecentDeficitPct stays inert (isolating FastingStreakDays as the only
// signal in play, mirroring
// TestServiceThread_ShowSupportReflectsLiveSignalsNotStoredState), logging
// history is established on the 3 oldest days of the window and today, but
// the 3 days in between are left genuinely silent — a real
// riskFastingStreakDays-length gap, not merely the absence of a full week
// of logs.
func TestServiceNudges_GenuineFastingGapStillFlagsAtRisk(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 0, 120)

	logRepo := foodlog.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, tracking.NewRepository(db), db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, fakeWeightSource{})

	item := nutrition.FoodItem{
		Name: "Coach Nudges Gap Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 300, ProteinPer100g: 30,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)

	logDaysAgo := func(daysAgo int) {
		seedLog(t, db, logRepo, foodlog.FoodLog{
			UserID: userID, FoodItemID: &item.ID, LoggedAt: now.AddDate(0, 0, -daysAgo).Add(-time.Hour),
			MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
			QuantityGrams: 1000, Kcal: 3000, ProteinG: 100,
		})
	}
	// Established logging on days 6, 5, 4 and today (0), with a genuine
	// 3-day silent gap on days 3, 2, 1 in between.
	for _, daysAgo := range []int{6, 5, 4, 0} {
		logDaysAgo(daysAgo)
	}

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)

	result, err := svc.Nudges(context.Background(), userID, now, time.UTC)

	require.NoError(t, err)
	require.True(t, result.ShowSupport,
		"a genuine 3-day silent gap earlier in the week must still trip ED-risk via FastingStreakDays, even though today itself is logged")
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

// TestServiceThread_NilThreadRepositoryReturnsEmptyTurns proves nil-tolerance
// on the replay path, mirroring the nil-provider tolerance already covered
// on the ask path (TestAsk_NilProviderDegradesGracefully). A Service built
// without a thread repository must still answer Thread() with no error, a
// non-nil empty Turns slice (so callers/serialisers never have to special-
// case nil), and ShowSupport still computed from the user's live signals.
func TestServiceThread_NilThreadRepositoryReturnsEmptyTurns(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, nil)

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	// Genuine, explicitly logged under-eating trips AtRisk via
	// RecentDeficitPct (see TestAsk_RestrictiveAnswerSuppressedUnderRisk) —
	// an unlogged window no longer counts as a deficit, so this fixture must
	// seed real evidence, not just omit logs.
	seedUnderEatingWeek(t, db, logRepo, userID, now, 2000)

	result, err := svc.Thread(context.Background(), userID, now, time.UTC)

	require.NoError(t, err, "a nil thread repository must degrade gracefully, not error or panic")
	require.NotNil(t, result.Turns, "Turns must be a non-nil empty slice on the nil-thread-repository path")
	require.Empty(t, result.Turns)
	require.True(t, result.ShowSupport, "a user with a genuine logged deficit is at risk via RecentDeficitPct, an ED-risk signal")
}

// TestServiceThread_ShowSupportReflectsLiveSignalsNotStoredState proves
// GET /v1/coach/thread's show_support tracks the user's CURRENT risk
// signals, never whatever was true at write time.
//
// This deliberately isolates FastingStreakDays as the ONLY risk signal in
// play, and specifically as one that only the FIXED semantics detect,
// rather than the more obvious "fresh user with no logs at all" setup: for
// a user with a target_kcal set, an all-empty window already trips AtRisk
// via RecentDeficitPct (every day's deficit is 1.0) independent of
// FastingStreakDays — so that setup would keep passing even if
// fastingStreak regressed to its pre-fix behaviour, proving nothing.
// Instead: target_kcal is 0 (recentDeficitPct is inert — see its own "no
// data" doc comment), the user logs today AND 3 days before the gap, but
// goes silent for exactly riskFastingStreakDays days in between. This
// scenario is chosen so old and new fastingStreak semantics disagree at the
// AtRisk boundary: the pre-fix version starts scanning at today, sees it
// logged, and immediately reports streak 0 (missing the real gap entirely);
// the fixed version excludes today by construction and still finds the
// 3-day gap in the logging history, reporting streak 3. So if fastingStreak
// ever regresses to counting from today instead of excluding it, "before"
// flips from at-risk to not-at-risk and this test fails — it does not just
// pass along either way.
func TestServiceThread_ShowSupportReflectsLiveSignalsNotStoredState(t *testing.T) {
	db := testDB(t)
	// target_kcal: 0 -> no target set, keeps RecentDeficitPct out of play
	// entirely so FastingStreakDays is the only signal that can trip risk.
	userID := seedUser(t, db, 0, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	item := nutrition.FoodItem{
		Name: "Coach ShowSupport Gap Food " + uuid.NewString(), Provenance: nutrition.ProvenanceAFCD,
		KcalPer100g: 300, ProteinPer100g: 30,
	}
	require.NoError(t, db.Create(&item).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", item.ID) })

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)

	logDaysAgo := func(daysAgo int) {
		seedLog(t, db, logRepo, foodlog.FoodLog{
			UserID: userID, FoodItemID: &item.ID, LoggedAt: now.AddDate(0, 0, -daysAgo).Add(-time.Hour),
			MealSlot: "lunch", Source: "manual", Provenance: nutrition.ProvenanceAFCD,
			QuantityGrams: 1000, Kcal: 3000, ProteinG: 100,
		})
	}

	// Establish logging history on the 3 oldest days of the window (6, 5,
	// 4 days ago) and log today (0 days ago), but leave the 3 days between
	// (3, 2, 1 days ago) silent — a genuine riskFastingStreakDays-length
	// gap that today's own logging must not paper over. Average intake
	// over the window is 12000/7 ≈ 1714 kcal (above the low-intake
	// threshold) and logs/day is 4/7 (far below the obsessive-logging
	// threshold), so neither of those signals fires either.
	for _, daysAgo := range []int{6, 5, 4, 0} {
		logDaysAgo(daysAgo)
	}

	// Store an exchange while the user is still at-risk.
	require.NoError(t, threadRepo.AppendExchange(context.Background(), userID,
		"how am I doing?", "an answer", nil))

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)

	before, err := svc.Thread(context.Background(), userID, now, time.UTC)
	require.NoError(t, err)
	require.True(t, before.ShowSupport,
		"a genuine 3-day silent gap earlier in the week must still read as at-risk via FastingStreakDays, even though today itself is logged")

	// Flip the live signal: close the gap itself.
	for _, daysAgo := range []int{3, 2, 1} {
		logDaysAgo(daysAgo)
	}

	after, err := svc.Thread(context.Background(), userID, now, time.UTC)
	require.NoError(t, err)
	require.False(t, after.ShowSupport,
		"show_support must track CURRENT signals, not whatever was true when the turn was stored")
	require.Len(t, after.Turns, 2, "the stored exchange itself must still replay unchanged")
}

// TestServiceThread_ReplayedRestrictiveTurnSuppressedForAtRiskUser proves the
// read-time re-gate: a stored Otto turn whose text is restrictive must not
// replay verbatim for a user who is currently at-risk, even though nothing
// re-generated it — Thread must re-run the same Protective policy Ask
// applied at write time, against the CURRENT signals.
func TestServiceThread_ReplayedRestrictiveTurnSuppressedForAtRiskUser(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	const restrictiveRaw = "You've eaten enough today — try to cut back tomorrow."
	require.NoError(t, threadRepo.AppendExchange(context.Background(), userID,
		"how am I doing?", restrictiveRaw, nil))

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)
	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	// Genuine, explicitly logged under-eating trips AtRisk via
	// RecentDeficitPct — an unlogged window no longer counts as a deficit,
	// so this fixture must seed real evidence, not just omit logs.
	seedUnderEatingWeek(t, db, logRepo, userID, now, 2000)

	result, err := svc.Thread(context.Background(), userID, now, time.UTC)
	require.NoError(t, err)
	require.True(t, result.ShowSupport, "user with a genuine logged deficit should be at risk (RecentDeficitPct)")

	require.Len(t, result.Turns, 2)
	require.Equal(t, TurnRoleOtto, result.Turns[1].Role)
	require.Equal(t, suppressedAnswerMessage, result.Turns[1].Text,
		"a replayed restrictive Otto turn must be suppressed for an at-risk user, not shown raw")
	require.NotEqual(t, restrictiveRaw, result.Turns[1].Text)
}

// TestServiceThread_ReplayedBenignTurnUnchanged proves the re-gate is not
// overzealous: a stored Otto turn with ordinary supportive text — no
// restrictive phrase — must replay exactly as stored, regardless of the
// user's current risk state (Allow and Soften both preserve non-restrictive
// text unchanged per guardrails.Evaluate).
func TestServiceThread_ReplayedBenignTurnUnchanged(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	const supportiveRaw = "You have 55g protein to go — a yoghurt would help."
	require.NoError(t, threadRepo.AppendExchange(context.Background(), userID,
		"how's my protein?", supportiveRaw, nil))

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)
	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)

	result, err := svc.Thread(context.Background(), userID, now, time.UTC)
	require.NoError(t, err)

	require.Len(t, result.Turns, 2)
	require.Equal(t, TurnRoleOtto, result.Turns[1].Role)
	require.Equal(t, supportiveRaw, result.Turns[1].Text,
		"a benign stored turn must replay exactly as stored")
}

// TestServiceThread_UserTurnsNeverRewritten proves the re-gate only ever
// touches TurnRoleOtto turns, even while it is actively suppressing the
// Otto turn from the very same exchange: a user's own words — even ones
// that happen to contain a restrictivePhrases substring — must replay
// byte-identical to what was stored, regardless of the risk state. Seeds a
// genuinely at-risk user (seedUnderEatingWeek — real logged under-eating,
// the same fixture TestServiceNudges_GenuineDeficitStillFlagsAtRisk uses)
// and stores a restrictive Otto answer alongside the user's question, so
// the user-turn assertion below is made under ACTIVE suppression, not
// merely alongside a user who happens to carry no risk signal at all (which
// would prove nothing about replay under suppression — the risk state IS
// the point of this test, not incidental to it). Re-gating a user's own
// question would be both wrong (the guardrail governs what Otto says, not
// what the user asks) and unsafe (it would silently alter a user's own
// words).
func TestServiceThread_UserTurnsNeverRewritten(t *testing.T) {
	db := testDB(t)
	userID := seedUser(t, db, 2000, 120)

	logRepo := foodlog.NewRepository(db)
	trackRepo := tracking.NewRepository(db)
	dashSvc := dashboard.NewService(logRepo, trackRepo, db)
	memSvc := memory.NewService(logRepo)
	g := NewGrounder(dashSvc, logRepo, memSvc, trackRepo)
	threadRepo := NewThreadRepository(db)

	now := time.Date(2026, 3, 10, 18, 0, 0, 0, time.UTC)
	seedUnderEatingWeek(t, db, logRepo, userID, now, 2000)

	const userQuestion = "should I eat less?"
	const restrictiveRaw = "You've eaten enough today — try to cut back tomorrow."
	require.NoError(t, threadRepo.AppendExchange(context.Background(), userID,
		userQuestion, restrictiveRaw, nil))

	svc := NewService(&g, &fakeProvider{}, &stubMeter{withinBudget: true}, &threadRepo)

	result, err := svc.Thread(context.Background(), userID, now, time.UTC)
	require.NoError(t, err)
	require.True(t, result.ShowSupport, "test setup must actually be at-risk, or suppression below proves nothing")

	require.Len(t, result.Turns, 2)
	require.Equal(t, TurnRoleUser, result.Turns[0].Role)
	require.Equal(t, userQuestion, result.Turns[0].Text,
		"re-gating must only ever touch TurnRoleOtto turns, never TurnRoleUser turns — even while the Otto turn in the same exchange is suppressed")

	require.Equal(t, TurnRoleOtto, result.Turns[1].Role)
	require.Equal(t, suppressedAnswerMessage, result.Turns[1].Text,
		"the Otto turn must actually be suppressed here — this is what makes the user-turn assertion above a test of replay under ACTIVE suppression")
	require.NotEqual(t, restrictiveRaw, result.Turns[1].Text)
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
