package ai

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// testDB opens a real Postgres connection for integration tests, skipping
// (never failing) the test if Postgres is unavailable — Resolver's core
// invariant guard can only be proven against real nutrition-index rows.
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

// seedTestUser inserts a bare user row (ai_usage_events.user_id has an FK to
// users) and schedules its cleanup.
func seedTestUser(t *testing.T, db *gorm.DB) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		"INSERT INTO users (id, firebase_uid, email) VALUES (?, ?, ?)",
		id, "resolver-"+id.String(), "resolver-"+id.String()+"@test.dev").Error)
	t.Cleanup(func() {
		db.Exec("DELETE FROM ai_usage_events WHERE user_id = ?", id)
		db.Exec("DELETE FROM users WHERE id = ?", id)
	})
	return id
}

// seedAlias inserts an exact-match alias for a food item directly (bypassing
// the ingestion/correction pipeline), giving tests a deterministic
// MatchScore of 1.0 instead of depending on full-text ranking internals.
func seedAlias(t *testing.T, db *gorm.DB, alias string, foodItemID uuid.UUID) {
	t.Helper()
	require.NoError(t, db.Exec(
		"INSERT INTO food_aliases (alias, food_item_id) VALUES (?, ?)", alias, foodItemID).Error)
}

// stubMeter is a configurable billing.Meter test double. It is defined
// locally (not billing.Meter) because package billing imports package ai for
// ai.Usage — Resolver depends on the local Meter interface instead, which
// billing.Meter satisfies structurally at the call site where Resolver is
// actually constructed in production wiring.
type stubMeter struct {
	withinBudget    bool
	withinBudgetErr error

	recordErr error
	records   []Usage
}

func (m *stubMeter) Record(ctx context.Context, userID uuid.UUID, u Usage, costUSD float64) error {
	m.records = append(m.records, u)
	return m.recordErr
}

func (m *stubMeter) WithinBudget(ctx context.Context, userID uuid.UUID) (bool, error) {
	return m.withinBudget, m.withinBudgetErr
}

var _ Meter = (*stubMeter)(nil)

// fakePortionSource is a configurable PortionSource test double, keyed by
// (userID, phrase) so tests can assert the alias short-circuit looks up
// portion history for the CALLER, not just any row matching the phrase.
type fakePortionSource struct {
	grams map[string]float64 // key: userID.String()+"|"+phrase
	err   error
}

func (f *fakePortionSource) LastPortionForPhrase(ctx context.Context, userID uuid.UUID, phrase string) (float64, bool, error) {
	if f.err != nil {
		return 0, false, f.err
	}
	g, ok := f.grams[userID.String()+"|"+phrase]
	return g, ok, nil
}

var _ PortionSource = (*fakePortionSource)(nil)

func seedFoodItem(t *testing.T, repo nutrition.Repository, item nutrition.FoodItem) nutrition.FoodItem {
	t.Helper()
	_, err := repo.Insert(context.Background(), []nutrition.FoodItem{item})
	require.NoError(t, err)

	var got nutrition.FoodItem
	items, err := repo.Search(context.Background(), item.Name, 5)
	require.NoError(t, err)
	for _, it := range items {
		if it.Brand == item.Brand && it.Name == item.Name {
			got = it
			break
		}
	}
	require.NotEqual(t, uuid.Nil, got.ID, "seeded food item must be findable by Search")
	return got
}

// TestResolveText_PersonalAliasShortCircuit_SkipsProviderAndMetering is the
// main fix under test: a personal alias for the RAW phrase must resolve
// without ever calling the provider or metering any AI usage, since no AI
// work happened. It also proves the returned candidate's kcal is computed
// only from the aliased row (never fabricated) and that the portion comes
// from the user's last log of this exact phrase.
func TestResolveText_PersonalAliasShortCircuit_SkipsProviderAndMetering(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test4a'") })
	repo := nutrition.NewRepository(db)
	userID := seedTestUser(t, db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Quinoa bowl", Brand: "test4a",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120, ServingGrams: 150,
	})
	phrase := "brekkie eggs " + uuid.NewString()
	require.NoError(t, repo.AddAlias(context.Background(), userID, phrase, item.ID))

	portions := &fakePortionSource{grams: map[string]float64{
		userID.String() + "|" + phrase: 220,
	}}
	provider := &stubProvider{
		guesses:    []Guess{{Food: "should never be reached", Confidence: 0.99}},
		guessUsage: Usage{Provider: "stub"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter).WithPortionSource(portions)

	res, err := resolver.ResolveText(context.Background(), userID, phrase)

	require.NoError(t, err)
	require.Equal(t, 0, provider.calls, "a personal alias hit must never invoke the provider")
	require.Empty(t, meter.records, "an alias short-circuit did no AI work and must not be metered")
	require.Equal(t, TierAuto, res.Tier)
	require.Len(t, res.Candidates, 1)
	// The candidate carries its OWN tier too: a personal correction is the
	// most confident signal there is, so the row is never a follow-up.
	require.Equal(t, TierAuto, res.Candidates[0].Tier)
	require.Equal(t, item.ID, res.Candidates[0].Item.ID)
	require.Equal(t, nutrition.MatchAlias, res.Candidates[0].MatchTier)
	require.Equal(t, 220.0, res.Candidates[0].PortionGrams, "portion must come from the user's last log of this phrase")
	// 120 kcal/100g * 220g / 100 = 264 — computed from the row, never fabricated.
	require.Equal(t, 264.0, res.Candidates[0].Kcal)
}

// TestResolveText_PersonalAliasShortCircuit_FallsBackToServingGrams proves
// the portion fallback chain's second rung: when there is no prior log of
// this phrase (found=false from the PortionSource), the food's own
// ServingGrams is used instead.
func TestResolveText_PersonalAliasShortCircuit_FallsBackToServingGrams(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test4b'") })
	repo := nutrition.NewRepository(db)
	userID := seedTestUser(t, db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Quinoa bowl no history", Brand: "test4b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120, ServingGrams: 180,
	})
	phrase := "brekkie eggs " + uuid.NewString()
	require.NoError(t, repo.AddAlias(context.Background(), userID, phrase, item.ID))

	portions := &fakePortionSource{grams: map[string]float64{}} // no prior log for anyone
	provider := &stubProvider{}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter).WithPortionSource(portions)

	res, err := resolver.ResolveText(context.Background(), userID, phrase)

	require.NoError(t, err)
	require.Len(t, res.Candidates, 1)
	require.Equal(t, 180.0, res.Candidates[0].PortionGrams)
	// 120 kcal/100g * 180g / 100 = 216.
	require.Equal(t, 216.0, res.Candidates[0].Kcal)
}

// TestResolveText_PersonalAliasShortCircuit_FallsBackTo100gWhenServingGramsZero
// proves the final rung of the fallback chain: no prior log AND no
// ServingGrams on the row falls back to the barcode path's 100g convention.
func TestResolveText_PersonalAliasShortCircuit_FallsBackTo100gWhenServingGramsZero(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test4c'") })
	repo := nutrition.NewRepository(db)
	userID := seedTestUser(t, db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Quinoa bowl zero serving", Brand: "test4c",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120, ServingGrams: 0,
	})
	phrase := "brekkie eggs " + uuid.NewString()
	require.NoError(t, repo.AddAlias(context.Background(), userID, phrase, item.ID))

	portions := &fakePortionSource{grams: map[string]float64{}}
	provider := &stubProvider{}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter).WithPortionSource(portions)

	res, err := resolver.ResolveText(context.Background(), userID, phrase)

	require.NoError(t, err)
	require.Len(t, res.Candidates, 1)
	require.Equal(t, 100.0, res.Candidates[0].PortionGrams)
	require.Equal(t, 120.0, res.Candidates[0].Kcal)
}

// TestResolveText_PersonalAliasShortCircuit_NilPortionSourceFallsBackSafely
// proves a Resolver built WITHOUT WithPortionSource (nil PortionSource, the
// default for every existing construction site) never panics on an alias
// hit and falls back through the same ServingGrams/100g chain.
func TestResolveText_PersonalAliasShortCircuit_NilPortionSourceFallsBackSafely(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test4d'") })
	repo := nutrition.NewRepository(db)
	userID := seedTestUser(t, db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Quinoa bowl nil source", Brand: "test4d",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120, ServingGrams: 175,
	})
	phrase := "brekkie eggs " + uuid.NewString()
	require.NoError(t, repo.AddAlias(context.Background(), userID, phrase, item.ID))

	provider := &stubProvider{}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter) // no WithPortionSource call

	require.NotPanics(t, func() {
		res, err := resolver.ResolveText(context.Background(), userID, phrase)
		require.NoError(t, err)
		require.Len(t, res.Candidates, 1)
		require.Equal(t, 175.0, res.Candidates[0].PortionGrams)
	})
}

// TestResolveText_NoAlias_LLMPathRunsUnchanged is THE regression guard: a
// phrase with no personal alias must go through the existing LLM path
// exactly as before. If this ever breaks, every user who has never made a
// correction loses food resolution entirely.
func TestResolveText_NoAlias_LLMPathRunsUnchanged(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test4e'") })
	repo := nutrition.NewRepository(db)
	userID := seedTestUser(t, db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Grilled salmon", Brand: "test4e",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 208,
	})
	seedAlias(t, db, "grilled salmon", item.ID) // global alias only — no personal correction

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "grilled salmon", PortionEstimate: "100 g", Confidence: 0.95},
		},
		guessUsage: Usage{Provider: "stub"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveText(context.Background(), userID, "grilled salmon")

	require.NoError(t, err)
	require.Greater(t, provider.calls, 0, "with no personal alias, the provider must still be called")
	require.NotEmpty(t, meter.records, "the LLM path must still meter usage")
	require.Equal(t, TierAuto, res.Tier)
	require.Equal(t, 208.0, res.Candidates[0].Kcal)
}

// TestResolveText_PersonalAliasShortCircuit_AnotherUsersAliasDoesNotApply
// proves the per-user scoping survives all the way through ResolveText: a
// stranger with no personal alias for this phrase must go through the LLM
// path, never short-circuiting off someone else's correction.
func TestResolveText_PersonalAliasShortCircuit_AnotherUsersAliasDoesNotApply(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test4f'") })
	repo := nutrition.NewRepository(db)
	owner := seedTestUser(t, db)
	stranger := seedTestUser(t, db)

	quinoa := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Owner's quinoa", Brand: "test4f",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120,
	})
	other := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Stranger's actual food", Brand: "test4f",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 90,
	})
	phrase := "brekkie eggs " + uuid.NewString()
	require.NoError(t, repo.AddAlias(context.Background(), owner, phrase, quinoa.ID))
	seedAlias(t, db, phrase, other.ID) // global alias so the stranger's LLM path still resolves deterministically

	provider := &stubProvider{
		guesses:    []Guess{{Food: phrase, PortionEstimate: "100 g", Confidence: 0.95}},
		guessUsage: Usage{Provider: "stub"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveText(context.Background(), stranger, phrase)

	require.NoError(t, err)
	require.Greater(t, provider.calls, 0, "another user's personal alias must not short-circuit this user")
	require.NotEmpty(t, res.Candidates)
	require.NotEqual(t, quinoa.ID, res.Candidates[0].Item.ID, "the owner's aliased food must never leak to a stranger")
}

// TestResolveText_InvariantGuard_KcalComesOnlyFromTheRow is THE hard
// invariant test. The stub provider's Guess carries only Food/PortionEstimate
// /Confidence/CookingMethod — there is no field on Guess through which a
// number could reach Resolution.Candidates[0].Kcal. The only source of a
// kcal number in the resolver is FoodItem.KcalPer100g × grams / 100. This
// test seeds a FoodItem with a known KcalPer100g, feeds a Guess for the same
// food, and asserts the resolved Kcal equals exactly what the row's
// KcalPer100g implies for the parsed portion — proving the number came from
// the nutrition index, not from the (kcal-less) LLM guess.
func TestResolveText_InvariantGuard_KcalComesOnlyFromTheRow(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Grilled chicken breast", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "grilled chicken breast", item.ID)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "grilled chicken breast", PortionEstimate: "100 g", Confidence: 0.95},
		},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)
	userID := uuid.New()

	res, err := resolver.ResolveText(context.Background(), userID, "grilled chicken breast")

	require.NoError(t, err)
	require.Equal(t, TierAuto, res.Tier)
	require.Len(t, res.Candidates, 1)
	require.Equal(t, 100.0, res.Candidates[0].PortionGrams)
	// 165 kcal/100g * 100g / 100 = 165 — computed from the row, never from
	// the (kcal-less) Guess.
	require.Equal(t, 165.0, res.Candidates[0].Kcal)
	require.Equal(t, item.KcalPer100g, res.Candidates[0].Item.KcalPer100g)
	require.NotEmpty(t, meter.records, "provider usage must be metered")
}

// TestResolveText_WeakConfidence_FollowUpWhenDecomposeYieldsNothing covers a
// resolvable-but-weak match: the alias gives a perfect MatchScore, but the
// guess's own identify confidence is low, so TierFor's min() rule pulls the
// overall tier down to follow_up. Decompose is configured to return nothing
// resolvable, so the resolver must fall back to the original follow-up
// Resolution (with its question) rather than fabricate an estimate.
func TestResolveText_WeakConfidence_FollowUpWhenDecomposeYieldsNothing(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Weak match snack", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 200,
	})
	seedAlias(t, db, "weak match snack", item.ID)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "weak match snack", PortionEstimate: "100 g", Confidence: 0.3},
		},
		guessUsage:  Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: nil, // Decompose yields nothing resolvable.
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "weak match snack")

	require.NoError(t, err)
	require.Equal(t, TierFollowUp, res.Tier)
	require.NotEmpty(t, res.FollowUpQuestion)
	require.False(t, res.IsEstimate)
}

// TestResolveText_UnknownDish_DecomposesToEstimate covers a dish that
// doesn't resolve at all on the first pass (a nonce phrase matching nothing
// in the index) but whose ingredients, once decomposed, DO resolve. The
// resulting Resolution must be a summed estimate with a low/high band,
// entirely from ingredient rows.
func TestResolveText_UnknownDish_DecomposesToEstimate(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)

	chicken := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Shredded chicken ingredient", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "shredded chicken 2b", chicken.ID)

	rice := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Steamed rice ingredient", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130,
	})
	seedAlias(t, db, "steamed rice 2b", rice.ID)

	provider := &stubProvider{
		guesses: []Guess{
			// Nonce token that no seeded or ambient row contains — guaranteed
			// zero matches across alias/full-text/embedding tiers.
			{Food: "qzzznonce unknown dish 2b", PortionEstimate: "1 serving", Confidence: 0.9},
		},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: []IngredientGuess{
			{Ingredient: "shredded chicken 2b", PortionEstimate: "150 g", Confidence: 0.8},
			{Ingredient: "steamed rice 2b", PortionEstimate: "200 g", Confidence: 0.8},
		},
		ingredientsUsage: Usage{Provider: "stub", CallType: "decompose"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "qzzznonce unknown dish 2b")

	require.NoError(t, err)
	require.True(t, res.IsEstimate)
	require.Less(t, res.KcalLow, res.KcalHigh)
	// 165*150/100 + 130*200/100 = 247.5 + 260 = 507.5
	wantSum := 507.5
	require.InDelta(t, wantSum*(1-estimateBand), res.KcalLow, 0.01)
	require.InDelta(t, wantSum*(1+estimateBand), res.KcalHigh, 0.01)
	require.Len(t, res.Candidates, 2)
}

// TestResolveText_EstimatePath_StampsConfirmTierOnEveryCandidate covers the
// decompose/estimate fallback, which builds candidates by a different path
// than resolveGuesses. Its items are inherently uncertain — the whole
// Resolution is TierConfirm and IsEstimate — so each candidate must say so
// rather than arriving with an empty tier the client has to guess about.
func TestResolveText_EstimatePath_StampsConfirmTierOnEveryCandidate(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2c'") })
	repo := nutrition.NewRepository(db)

	chicken := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Shredded chicken tier ingredient", Brand: "test2c",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "shredded chicken 2c", chicken.ID)

	rice := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Steamed rice tier ingredient", Brand: "test2c",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130,
	})
	seedAlias(t, db, "steamed rice 2c", rice.ID)

	provider := &stubProvider{
		// Nonce token that no seeded or ambient row contains, so the first
		// pass resolves nothing and the decompose fallback runs.
		guesses:    []Guess{{Food: "qzzznonce unknown dish 2c", PortionEstimate: "1 serving", Confidence: 0.9}},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: []IngredientGuess{
			{Ingredient: "shredded chicken 2c", PortionEstimate: "150 g", Confidence: 0.8},
			{Ingredient: "steamed rice 2c", PortionEstimate: "200 g", Confidence: 0.8},
		},
		ingredientsUsage: Usage{Provider: "stub", CallType: "decompose"},
	}
	resolver := NewResolver(provider, repo, NoCache{}, &stubMeter{withinBudget: true})

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "qzzznonce unknown dish 2c")

	require.NoError(t, err)
	require.True(t, res.IsEstimate)
	require.NotEmpty(t, res.Candidates)
	for i, c := range res.Candidates {
		require.Equal(t, TierConfirm, c.Tier, "candidate %d", i)
	}
}

// TestResolveText_BudgetExceeded_GracefulManualFallback verifies the budget
// gate returns a graceful, error-free manual-fallback Resolution and never
// even reaches the provider.
func TestResolveText_BudgetExceeded_GracefulManualFallback(t *testing.T) {
	db := testDB(t)
	repo := nutrition.NewRepository(db)

	provider := &stubProvider{
		guesses:    []Guess{{Food: "should not be reached", Confidence: 0.99}},
		guessUsage: Usage{Provider: "stub"},
	}
	meter := &stubMeter{withinBudget: false}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "anything")

	require.NoError(t, err)
	require.Equal(t, TierFollowUp, res.Tier)
	require.Equal(t, "budget", res.Provenance)
	require.NotEmpty(t, res.FollowUpQuestion)
	require.Equal(t, 0, provider.calls, "provider must never be called once over budget")
}

// TestResolveVoiceTranscribesThenResolves proves ResolveVoice transcribes
// audio then feeds the transcript through the same ResolveText pipeline: the
// resolved candidate's Kcal must still come only from the seeded row's
// KcalPer100g, never from the provider's guess or transcript.
func TestResolveVoiceTranscribesThenResolves(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test3a'") })
	repo := nutrition.NewRepository(db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Banana", Brand: "test3a",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 89,
	})
	seedAlias(t, db, "banana", item.ID)

	provider := &stubProvider{
		transcript:      "banana",
		transcriptUsage: Usage{Provider: "stub", CallType: "transcribe"},
		guesses: []Guess{
			{Food: "banana", PortionEstimate: "100 g", Confidence: 0.95},
		},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveVoice(context.Background(), uuid.New(), []byte("audio-bytes"), "audio/mp4")

	require.NoError(t, err)
	require.Equal(t, TierAuto, res.Tier)
	require.Len(t, res.Candidates, 1)
	// 89 kcal/100g * 100g / 100 = 89 — computed from the row, never from the
	// (kcal-less) transcript or guess.
	require.Equal(t, 89.0, res.Candidates[0].Kcal)
	// A successful voice resolve must carry the transcript back to the
	// caller — a mobile client has nothing else it can put in
	// FoodLog.InputPhrase for an ai_voice log.
	require.Equal(t, "banana", res.Transcript)

	// The whole point of transcription metering: at least one recorded Usage
	// row must be the transcribe call itself, alongside the identify/embed
	// rows from the reused text pipeline.
	require.GreaterOrEqual(t, len(meter.records), 2, "provider usage must be metered for both transcribe and the text pipeline")
	var sawTranscribe bool
	for _, u := range meter.records {
		if u.CallType == "transcribe" {
			sawTranscribe = true
			break
		}
	}
	assert.True(t, sawTranscribe, "a transcribe call_type row must be recorded")
}

// TestResolveVoiceBlankTranscriptFollowUp proves that when transcription
// yields no usable speech, ResolveVoice returns a graceful follow-up without
// ever reaching the foods repository.
func TestResolveVoiceBlankTranscriptFollowUp(t *testing.T) {
	db := testDB(t)
	repo := nutrition.NewRepository(db)

	provider := &stubProvider{transcript: "   "}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveVoice(context.Background(), uuid.New(), []byte("audio"), "audio/mp4")

	require.NoError(t, err)
	assert.Equal(t, TierFollowUp, res.Tier)
	assert.Empty(t, res.Candidates)
	// A blank/unusable transcript must return the existing follow-up
	// Resolution unchanged — no transcript for a client to log against.
	assert.Empty(t, res.Transcript)
}

// TestResolveText_CachesResolution_SkipsProviderOnSecondCall proves the
// happy-path result is cached and a repeat request from the SAME user for
// the same phrase never re-invokes the provider. Both calls deliberately use
// the same userID: the cache key is user-scoped (finding 1), so two
// different users would not be expected to share a cache entry — that
// cross-user behavior is covered separately by
// TestResolveText_CacheDoesNotLeakAcrossUsers.
func TestResolveText_CachesResolution_SkipsProviderOnSecondCall(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)
	userID := seedTestUser(t, db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Cached grilled chicken", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "cached grilled chicken", item.ID)

	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()
	cache := NewRedisCache(client, 0)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "cached grilled chicken", PortionEstimate: "100 g", Confidence: 0.95},
		},
		guessUsage: Usage{Provider: "stub"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, cache, meter)
	ctx := context.Background()

	first, err := resolver.ResolveText(ctx, userID, "cached grilled chicken")
	require.NoError(t, err)
	callsAfterFirst := provider.calls // IdentifyText + Embed(per guess)
	require.Greater(t, callsAfterFirst, 0)

	second, err := resolver.ResolveText(ctx, userID, "cached grilled chicken")
	require.NoError(t, err)
	require.Equal(t, callsAfterFirst, provider.calls, "second call must be served from cache")
	require.Equal(t, first.Tier, second.Tier)
	require.Equal(t, first.Candidates[0].Kcal, second.Candidates[0].Kcal)
}

// TestResolveText_CacheDoesNotLeakAcrossUsers is the finding-1 regression
// test at the full ResolveText/wiring level: it reproduces the exact leak
// scenario the finding describes. User A has a personal alias that the
// MODEL's guess resolves to (scored 1.0 by resolveGuesses's alias tier ->
// TierAuto -> cached) — deliberately keyed to a different string than the
// raw phrase A types, so this exercises the pre-existing cache layer rather
// than the newer personal-alias short-circuit in ResolveText (which only
// ever checks the raw phrase, see TestResolveText_PersonalAliasShortCircuit_*
// above for that path). User B then resolves the identical raw phrase and
// must NOT receive user A's cached Resolution — proven two ways: (1) the
// provider must be re-invoked for user B instead of the request being served
// from cache, and (2) user B's candidates (B has neither a personal nor a
// global alias for this nonce phrase) must never contain user A's aliased
// food item.
func TestResolveText_CacheDoesNotLeakAcrossUsers(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2c'") })
	repo := nutrition.NewRepository(db)
	userA := seedTestUser(t, db)
	userB := seedTestUser(t, db)

	quinoa := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Personally aliased quinoa", Brand: "test2c",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120,
	})
	phrase := "brekkie bowl " + uuid.NewString()
	// What the model calls it — deliberately NOT what the user typed, so the
	// raw-phrase personal-alias short-circuit (LookupPersonalAlias(userA,
	// phrase)) finds nothing and this request falls through to the LLM/cache
	// path under test, exactly as it did before that short-circuit existed.
	modelFood := "quinoa bowl (model) " + uuid.NewString()
	// A real correction: user A's personal alias on the MODEL's wording,
	// scored 1.0 by the alias tier (see nutrition.Repository.Resolve tier 1),
	// which is enough on its own to reach TierAuto and get cached.
	require.NoError(t, repo.AddAlias(context.Background(), userA, modelFood, quinoa.ID))

	mr, err := miniredis.Run()
	require.NoError(t, err)
	defer mr.Close()
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()
	cache := NewRedisCache(client, time.Minute)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: modelFood, PortionEstimate: "100 g", Confidence: 0.95},
		},
		guessUsage: Usage{Provider: "stub"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, cache, meter)
	ctx := context.Background()

	resA, err := resolver.ResolveText(ctx, userA, phrase)
	require.NoError(t, err)
	require.Equal(t, TierAuto, resA.Tier)
	require.Equal(t, quinoa.ID, resA.Candidates[0].Item.ID)
	callsAfterA := provider.calls
	require.Greater(t, callsAfterA, 0)

	resB, err := resolver.ResolveText(ctx, userB, phrase)
	require.NoError(t, err)
	require.Greater(t, provider.calls, callsAfterA,
		"user B must not be served from user A's cache entry — the provider must be reached again")
	for _, c := range resB.Candidates {
		require.NotEqual(t, quinoa.ID, c.Item.ID,
			"user A's personally aliased food item must never leak into user B's resolution via a shared cache key")
	}
}

// A meal whose two items resolve at different confidences must stamp each
// candidate with its OWN tier. Before per-item tiers, the resolution reported
// only the best item's tier (tierRank keeps the MAX), so the weak item was
// indistinguishable from the strong one.
func TestResolveText_PerItemTiers_WeakItemKeepsItsOwnTier(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test2b'") })
	repo := nutrition.NewRepository(db)

	strong := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Grilled chicken breast", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "grilled chicken breast", strong.ID)
	weak := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "White rice, cooked", Brand: "test2b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 130,
	})
	seedAlias(t, db, "white rice cooked", weak.ID)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "grilled chicken breast", PortionEstimate: "100 g", Confidence: 0.95},
			{Food: "white rice cooked", PortionEstimate: "150 g", Confidence: 0.40},
		},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
	}
	resolver := NewResolver(provider, repo, NoCache{}, &stubMeter{withinBudget: true})

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "chicken and rice")

	require.NoError(t, err)
	require.Len(t, res.Candidates, 2)
	require.Equal(t, TierAuto, res.Candidates[0].Tier)
	require.Equal(t, TierFollowUp, res.Candidates[1].Tier)
	// The aggregate deliberately still reports the BEST item's tier — it
	// answers "is anything here loggable?", not "is everything certain?".
	require.Equal(t, TierAuto, res.Tier)
}
