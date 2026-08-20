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

	// Look the row up by BRAND, not by name. This lookup exists only to recover
	// the id of the row just inserted, so it must not depend on that row ranking
	// well against the rest of the index — and searching by name did.
	//
	// Search is `name ILIKE %q% OR brand ILIKE %q%`, ordered `name ASC` and
	// clamped to searchLimitMax (25). Seeding "Banana" and searching "Banana"
	// therefore competed with every OFF row containing the word, and the
	// thousands that sort alphabetically earlier ("Apple & Banana ...") filled
	// the 25 slots before the seeded row was reached. Every caller here seeds a
	// distinctive test brand, which matches nothing else in the index, so
	// searching on that returns the seeded rows and only those.
	//
	// Limit 0 asks Search for its own maximum; the constant is unexported.
	require.NotEmpty(t, item.Brand, "seedFoodItem needs a distinctive brand to find its row again")
	var got nutrition.FoodItem
	items, err := repo.Search(context.Background(), item.Brand, 0)
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

// TestResolveAliasPortion_AssumedFlag is a pure unit test (no DB) of the
// fallback chain resolveAliasPortion drives: it must report assumed=true
// ONLY on the final rung (defaultAliasPortionGrams), never when a real prior
// log or the food's own ServingGrams supplied the number.
func TestResolveAliasPortion_AssumedFlag(t *testing.T) {
	userID := uuid.New()
	phrase := "brekkie eggs"
	itemWithServing := nutrition.FoodItem{KcalPer100g: 120, ServingGrams: 150}
	itemNoServing := nutrition.FoodItem{KcalPer100g: 120, ServingGrams: 0}

	t.Run("last logged portion is a real measurement, not assumed", func(t *testing.T) {
		r := Resolver{}.WithPortionSource(&fakePortionSource{grams: map[string]float64{
			userID.String() + "|" + phrase: 220,
		}})
		grams, assumed := r.resolveAliasPortion(context.Background(), userID, phrase, itemWithServing)
		require.Equal(t, 220.0, grams)
		require.False(t, assumed)
	})

	t.Run("falling back to the food's own ServingGrams is not assumed", func(t *testing.T) {
		r := Resolver{}.WithPortionSource(&fakePortionSource{grams: map[string]float64{}})
		grams, assumed := r.resolveAliasPortion(context.Background(), userID, phrase, itemWithServing)
		require.Equal(t, 150.0, grams)
		require.False(t, assumed)
	})

	t.Run("falling all the way to the flat default is assumed", func(t *testing.T) {
		r := Resolver{}.WithPortionSource(&fakePortionSource{grams: map[string]float64{}})
		grams, assumed := r.resolveAliasPortion(context.Background(), userID, phrase, itemNoServing)
		require.Equal(t, float64(defaultAliasPortionGrams), grams)
		require.True(t, assumed)
	})

	t.Run("nil portion source still marks the flat default as assumed", func(t *testing.T) {
		r := Resolver{}
		grams, assumed := r.resolveAliasPortion(context.Background(), userID, phrase, itemNoServing)
		require.Equal(t, float64(defaultAliasPortionGrams), grams)
		require.True(t, assumed)
	})
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
	require.Equal(t, nutrition.MatchPersonalAlias, res.Candidates[0].MatchTier)
	require.Equal(t, 220.0, res.Candidates[0].PortionGrams, "portion must come from the user's last log of this phrase")
	// 120 kcal/100g * 220g / 100 = 264 — computed from the row, never fabricated.
	require.Equal(t, 264.0, res.Candidates[0].Kcal)
	require.False(t, res.Candidates[0].PortionAssumed, "a real prior log is a measurement, not an assumption")
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
	require.False(t, res.Candidates[0].PortionAssumed, "the food's own ServingGrams is real serving data, not an assumption")
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
	require.True(t, res.Candidates[0].PortionAssumed, "no prior log and no ServingGrams means the 100g is a silent fallback")
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
	require.False(t, res.Candidates[0].PortionAssumed, "an explicit portion phrase from the guess is not an assumption")
}

// TestResolveText_GuessWithNoPortionPhrase_MarksPortionAssumed covers a guess
// whose PortionEstimate is empty (the model gave no portion signal at all)
// against a food row with no OFF branded serving to fall back on —
// portionGramsFor's true silent-default rung. The candidate must be marked
// PortionAssumed so the client never renders the flat 100g as a measurement.
func TestResolveText_GuessWithNoPortionPhrase_MarksPortionAssumed(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test4g'") })
	repo := nutrition.NewRepository(db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Unmeasured snack", Brand: "test4g",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 300,
	})
	seedAlias(t, db, "unmeasured snack", item.ID)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "unmeasured snack", PortionEstimate: "", Confidence: 0.95},
		},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "unmeasured snack")

	require.NoError(t, err)
	require.Equal(t, TierAuto, res.Tier)
	require.Len(t, res.Candidates, 1)
	require.Equal(t, 100.0, res.Candidates[0].PortionGrams)
	require.True(t, res.Candidates[0].PortionAssumed, "no portion phrase and no serving data means the 100g is a silent fallback")
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

// TestResolveText_WeakConfidence_ReturnsCandidateWithoutQuestion covers a
// resolvable-but-weak match: the alias gives a perfect MatchScore, but the
// guess's own identify confidence is low, so TierFor's min() rule pulls the
// overall tier down to follow_up.
//
// This test previously asserted the OPPOSITE — that the resolution came back
// carrying its follow-up question. That was wrong, and shipped a dead end
// (#180): src/components/ResolutionResult.tsx:148-154 renders the follow-up
// branch as the question bubble plus a "Search manually" link and NEVER the
// candidate list, so "Which of these best matches what you ate?" was asked
// while displaying nothing to choose from. Blank keeps the client on the
// detected-card path, where the weak candidate is shown as an uncertain row
// the user can tap to correct.
func TestResolveText_WeakConfidence_ReturnsCandidateWithoutQuestion(t *testing.T) {
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
	require.False(t, res.IsEstimate)
	require.Len(t, res.Candidates, 1, "the weak match itself must survive")
	require.Empty(t, res.FollowUpQuestion,
		"a question the client renders WITHOUT its candidates is unanswerable — see the doc comment")
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
	for i, c := range res.Candidates {
		require.False(t, c.PortionAssumed, "candidate %d: an explicit portion phrase from decompose is not an assumption", i)
	}
}

// TestDecomposeAndEstimate_IngredientWithNoPortionPhrase_MarksPortionAssumed
// covers a decomposed ingredient whose PortionEstimate is empty — the LLM
// invented the ingredient but gave no portion signal — against a food row
// with no OFF branded serving. portionGramsFor falls all the way to the flat
// default here, so the candidate must be marked PortionAssumed.
func TestDecomposeAndEstimate_IngredientWithNoPortionPhrase_MarksPortionAssumed(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test3f'") })
	repo := nutrition.NewRepository(db)

	chicken := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Shredded chicken ingredient 3f", Brand: "test3f",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "shredded chicken 3f", chicken.ID)

	provider := &stubProvider{
		guesses:    []Guess{{Food: "qzzznonce unknown dish 3f", PortionEstimate: "1 serving", Confidence: 0.9}},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: []IngredientGuess{
			{Ingredient: "shredded chicken 3f", PortionEstimate: "", Confidence: 0.8},
		},
		ingredientsUsage: Usage{Provider: "stub", CallType: "decompose"},
	}
	meter := &stubMeter{withinBudget: true}
	resolver := NewResolver(provider, repo, NoCache{}, meter)

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "qzzznonce unknown dish 3f")

	require.NoError(t, err)
	require.True(t, res.IsEstimate)
	require.Len(t, res.Candidates, 1)
	require.Equal(t, 100.0, res.Candidates[0].PortionGrams)
	require.True(t, res.Candidates[0].PortionAssumed, "no portion phrase and no serving data means the 100g is a silent fallback")
}

// TestResolveText_EstimatePath_StampsConfirmTierOnEveryCandidate covers the
// decompose/estimate fallback, which builds candidates by a different path
// than resolveGuesses. Its items are inherently uncertain — the whole
// Resolution is TierConfirm and IsEstimate — so each candidate must say so
// rather than arriving with an empty tier the client has to guess about.
// TestResolveText_EstimatePath_CapsAliasMatchesAtConfirm is the end-to-end
// counterpart to TestDecomposeAndEstimate_PerfectScoringIngredientCappedAtConfirm:
// it drives the whole ResolveText -> decompose path with real alias rows.
// Both ingredients below resolve by ALIAS, which scores exactly 1.0 — so this
// asserts the cap, not the old blanket-TierConfirm behaviour the name used to
// claim. Without estimateIngredientTier's cap these would come back TierAuto.
func TestResolveText_EstimatePath_CapsAliasMatchesAtConfirm(t *testing.T) {
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
	require.Equal(t, "You've reached your AI usage limit — search and log manually.", res.FollowUpQuestion)
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

	// The spoken phrase carries the "zqxvoice" nonce, and so do the seeded row
	// and the alias (kora#151). A bare "banana" made this fixture share a
	// phrase with the shared dev index: the 89.0 assertion is only meaningful
	// if the resolve lands on THIS row, and with a plain phrase that depends
	// on this test's global alias out-ranking whatever "Banana" rows and
	// aliases the index already carries.
	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Zqxvoice banana", Brand: "test3a",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 89,
	})
	seedAlias(t, db, "zqxvoice banana", item.ID)

	provider := &stubProvider{
		transcript:      "zqxvoice banana",
		transcriptUsage: Usage{Provider: "stub", CallType: "transcribe"},
		guesses: []Guess{
			{Food: "zqxvoice banana", PortionEstimate: "100 g", Confidence: 0.95},
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
	require.Equal(t, item.ID, res.Candidates[0].Item.ID,
		"89.0 must come from the seeded row, not from an ambient row that happens to share it")
	// A successful voice resolve must carry the transcript back to the
	// caller — a mobile client has nothing else it can put in
	// FoodLog.InputPhrase for an ai_voice log.
	require.Equal(t, "zqxvoice banana", res.Transcript)

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
	//
	// DISJOINT from the phrase on purpose, and restored to that after the
	// kora#184 damping briefly forced it to be a superset: the personal-alias
	// exemption (see factorForTier) means near-zero phrase coverage no longer
	// damps a user's own correction, so this test can go back to the shape it
	// was written in — a model wording that shares nothing with the user's.
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

// The #184 defect, end to end: a guess that threw away most of the user's
// phrase matched an index row named after it at a perfect 1.0 and auto-logged.
// The phrase-coverage reduction must stop that, WITHOUT touching the two paths
// that legitimately reach auto — a phrase the guesses account for whole, and a
// photo, which has no phrase at all.
func TestResolveGuesses_PhraseCoverageDampsConfidence(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test184'") })
	repo := nutrition.NewRepository(db)

	// Named distinctively rather than bare "Chicken" only so seedFoodItem's
	// top-5 Search can find it in a 15k-row dev index; what stands in for the
	// real OpenFoodFacts `Chicken` row is the alias below, which is what gives
	// the bare guess its perfect 1.0.
	bareChicken := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Chicken test184", Brand: "test184",
		Provenance: nutrition.ProvenanceOFF, KcalPer100g: 280,
	})
	seedAlias(t, db, "chicken", bareChicken.ID)
	grilled := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Grilled chicken breast", Brand: "test184",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 165,
	})
	seedAlias(t, db, "grilled chicken breast", grilled.ID)

	newResolver := func(guesses []Guess) Resolver {
		return NewResolver(
			&stubProvider{guesses: guesses, guessUsage: Usage{Provider: "stub", CallType: "identify_text"}},
			repo, NoCache{}, &stubMeter{withinBudget: true})
	}

	t.Run("brand and dish discarded — no longer a one-tap auto-log", func(t *testing.T) {
		res, err := newResolver([]Guess{
			{Food: "chicken", PortionEstimate: "1/2", Confidence: 0.95},
		}).ResolveText(context.Background(), uuid.New(), "El Janah 1/2 chicken with Chips")

		require.NoError(t, err)
		require.Len(t, res.Candidates, 1)
		require.Equal(t, 1.0, res.Candidates[0].MatchScore,
			"MatchScore stays honest about the row's own match — only the tier is damped")
		require.Equal(t, TierConfirm, res.Candidates[0].Tier)
		require.NotEqual(t, TierAuto, res.Tier, "this is the #184 auto-log that must not happen")
	})

	t.Run("phrase accounted for whole — no penalty at all", func(t *testing.T) {
		res, err := newResolver([]Guess{
			{Food: "grilled chicken breast", PortionEstimate: "100 g", Confidence: 0.95},
		}).ResolveText(context.Background(), uuid.New(), "grilled chicken breast")

		require.NoError(t, err)
		require.Len(t, res.Candidates, 1)
		require.Equal(t, TierAuto, res.Candidates[0].Tier, "the regression guard: full coverage costs nothing")
	})

	t.Run("photo path is unaffected", func(t *testing.T) {
		res, err := newResolver([]Guess{
			{Food: "chicken", PortionEstimate: "1/2", Confidence: 0.95},
		}).ResolvePhoto(context.Background(), uuid.New(), []byte("fake-jpeg-bytes"), "image/jpeg")

		require.NoError(t, err)
		require.Len(t, res.Candidates, 1)
		require.Equal(t, TierAuto, res.Candidates[0].Tier,
			"a photo carries no phrase, so there is nothing for the model to have discarded")
	})
}

// The exemption and its boundary, as a pair — the whole point being that the
// two halves are IDENTICAL but for who owns the alias. In both, the user types
// one thing, identify answers with something wholly disjoint (phrase coverage
// ~0), and an exact alias resolves that answer at 1.0.
//
// A PERSONAL alias must still reach auto: it is the user's own correction
// coming back, and damping it asks them the very question they already
// answered by saving it. A GLOBAL alias must still be damped: it is curated
// data that merely matched identify's string, which is exactly the kora#184
// failure ("El Janah 1/2 chicken with Chips" -> a global-aliased `Chicken`).
func TestResolveGuesses_PersonalAliasIsExemptFromPhraseReduction(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test184b'") })
	repo := nutrition.NewRepository(db)
	ctx := context.Background()

	newResolver := func(guesses []Guess) Resolver {
		return NewResolver(
			&stubProvider{guesses: guesses, guessUsage: Usage{Provider: "stub", CallType: "identify_text"}},
			repo, NoCache{}, &stubMeter{withinBudget: true})
	}

	t.Run("the user's own alias still reaches auto at zero coverage", func(t *testing.T) {
		userID := seedTestUser(t, db)
		item := seedFoodItem(t, repo, nutrition.FoodItem{
			Name: "Personally aliased quinoa bowl", Brand: "test184b",
			Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 120,
		})
		// Disjoint by construction — no shared token, not even the nonce, so
		// phrase coverage is exactly 0 and the damping is at full strength. An
		// alias exists precisely because the user's wording and the model's
		// wording do not overlap.
		phrase := "brekkie plate " + uuid.NewString()
		modelFood := "quinoa medley (model) " + uuid.NewString()
		require.NoError(t, repo.AddAlias(ctx, userID, modelFood, item.ID))
		t.Cleanup(func() { db.Exec("DELETE FROM food_aliases WHERE food_item_id = ?", item.ID) })

		res, err := newResolver([]Guess{
			{Food: modelFood, PortionEstimate: "100 g", Confidence: 0.95},
		}).ResolveText(ctx, userID, phrase)

		require.NoError(t, err)
		require.Len(t, res.Candidates, 1)
		require.Equal(t, nutrition.MatchPersonalAlias, res.Candidates[0].MatchTier)
		require.Equal(t, TierAuto, res.Candidates[0].Tier,
			"a correction the user saved themselves must not be re-asked")
		require.Equal(t, TierAuto, res.Tier)
	})

	t.Run("a global alias at the same zero coverage is still damped", func(t *testing.T) {
		userID := seedTestUser(t, db)
		item := seedFoodItem(t, repo, nutrition.FoodItem{
			Name: "Globally aliased quinoa bowl", Brand: "test184b",
			Provenance: nutrition.ProvenanceOFF, KcalPer100g: 120,
		})
		// Disjoint on the same terms as the personal case above.
		phrase := "brekkie plate " + uuid.NewString()
		modelFood := "quinoa medley (global) " + uuid.NewString()
		// user_id NULL — curated, not this user's.
		seedAlias(t, db, modelFood, item.ID)
		t.Cleanup(func() { db.Exec("DELETE FROM food_aliases WHERE food_item_id = ?", item.ID) })

		res, err := newResolver([]Guess{
			{Food: modelFood, PortionEstimate: "100 g", Confidence: 0.95},
		}).ResolveText(ctx, userID, phrase)

		require.NoError(t, err)
		require.Len(t, res.Candidates, 1)
		require.Equal(t, nutrition.MatchAlias, res.Candidates[0].MatchTier)
		require.NotEqual(t, TierAuto, res.Candidates[0].Tier,
			"kora#184: curated data matching the model's own wording is not the user's say-so")
		require.Equal(t, 1.0, res.Candidates[0].MatchScore,
			"only the tier is damped — the row still matched the string it was searched with")
	})
}

// TestEstimateIngredientTier_CapsScoreAtConfirm is a pure table-driven test of
// the helper decomposeAndEstimate uses to turn a decomposed ingredient's raw
// nutrition-index MatchScore into its own Tier. It exercises the function
// directly (no DB, no provider) so the confirm-cap logic itself — the crux of
// this whole change — is proven in isolation from the harder-to-control real
// full-text/trigram scoring exercised by the integration tests below.
func TestEstimateIngredientTier_CapsScoreAtConfirm(t *testing.T) {
	tests := []struct {
		name       string
		matchScore float64
		want       Tier
	}{
		{"perfect score is capped at confirm, not auto", 1.0, TierConfirm},
		{"exactly at the auto floor is capped at confirm", 0.90, TierConfirm},
		{"just above the auto floor is capped at confirm", 0.95, TierConfirm},
		{"mid score lands on confirm on its own merits", 0.80, TierConfirm},
		{"exactly at the confirm floor is confirm", 0.70, TierConfirm},
		{"just below the confirm floor is follow_up", 0.6999, TierFollowUp},
		{"low score is follow_up", 0.36, TierFollowUp},
		{"zero score is follow_up", 0.0, TierFollowUp},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := estimateIngredientTier(tt.matchScore)
			require.Equal(t, tt.want, got, "matchScore=%v", tt.matchScore)
		})
	}
}

// TestDecomposeAndEstimate_LowScoringIngredientBecomesFollowUp covers a
// decomposed ingredient whose nutrition-index match is weak (real full-text
// scoring against a diluted, mostly-unrelated row — no alias, no embedding —
// yields a MatchScore well under the 0.70 confirm floor per score.go's
// coverage/precision/trigram formula: coverage=1, precision=1/11≈0.09,
// trigram≈0.17-0.19, lexical≈0.48). The candidate's own Tier must reflect
// that weakness as TierFollowUp, not the old hardcoded TierConfirm.
func TestDecomposeAndEstimate_LowScoringIngredientBecomesFollowUp(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test3a'") })
	repo := nutrition.NewRepository(db)

	seedFoodItem(t, repo, nutrition.FoodItem{
		Name:       "Rare zqxmarinade3a blend delta echo foxtrot golf hotel india juliet kilo",
		Brand:      "test3a",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 300,
	})

	provider := &stubProvider{
		// Nonce dish that resolves to nothing on the first pass, forcing the
		// decompose fallback.
		guesses:    []Guess{{Food: "qzzznonce marinade dish 3a", PortionEstimate: "1 serving", Confidence: 0.9}},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: []IngredientGuess{
			{Ingredient: "zqxmarinade3a", PortionEstimate: "50 g", Confidence: 0.8},
		},
		ingredientsUsage: Usage{Provider: "stub", CallType: "decompose"},
	}
	resolver := NewResolver(provider, repo, NoCache{}, &stubMeter{withinBudget: true})

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "qzzznonce marinade dish 3a")

	require.NoError(t, err)
	require.True(t, res.IsEstimate)
	require.Len(t, res.Candidates, 1)
	require.Less(t, res.Candidates[0].MatchScore, 0.70, "fixture must produce a genuinely weak match")
	require.Equal(t, TierFollowUp, res.Candidates[0].Tier)
	require.Equal(t, TierFollowUp, res.Tier)
}

// TestDecomposeAndEstimate_PerfectScoringIngredientCappedAtConfirm covers a
// decomposed ingredient that matches the nutrition index perfectly (alias,
// MatchScore 1.0). Even a perfect string match must NOT become TierAuto here
// — the ingredient itself is an LLM inference (Decompose invented it), not a
// food the user named, so a one-tap auto-log would be misplaced confidence.
func TestDecomposeAndEstimate_PerfectScoringIngredientCappedAtConfirm(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test3b'") })
	repo := nutrition.NewRepository(db)

	item := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Grilled tofu ingredient 3b", Brand: "test3b",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 140,
	})
	seedAlias(t, db, "grilled tofu 3b", item.ID)

	provider := &stubProvider{
		guesses:    []Guess{{Food: "qzzznonce tofu dish 3b", PortionEstimate: "1 serving", Confidence: 0.9}},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: []IngredientGuess{
			{Ingredient: "grilled tofu 3b", PortionEstimate: "100 g", Confidence: 0.8},
		},
		ingredientsUsage: Usage{Provider: "stub", CallType: "decompose"},
	}
	resolver := NewResolver(provider, repo, NoCache{}, &stubMeter{withinBudget: true})

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "qzzznonce tofu dish 3b")

	require.NoError(t, err)
	require.True(t, res.IsEstimate)
	require.Len(t, res.Candidates, 1)
	require.InDelta(t, 1.0, res.Candidates[0].MatchScore, 0.001, "fixture must produce a perfect match")
	require.Equal(t, TierConfirm, res.Candidates[0].Tier)
	require.NotEqual(t, TierAuto, res.Candidates[0].Tier)
	require.Equal(t, TierConfirm, res.Tier)
}

// TestDecomposeAndEstimate_MidScoringIngredientIsConfirm covers a decomposed
// ingredient with a genuine (non-alias) mid-range full-text match: coverage=1,
// precision=3/4=0.75, trigram≈0.74, lexical≈0.847 — comfortably inside the
// [0.70, 0.90) confirm band on its own merits, not because of the cap.
func TestDecomposeAndEstimate_MidScoringIngredientIsConfirm(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test3c'") })
	repo := nutrition.NewRepository(db)

	seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Seasoned tofu block 3c", Brand: "test3c",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 150,
	})

	provider := &stubProvider{
		guesses:    []Guess{{Food: "qzzznonce seasoned dish 3c", PortionEstimate: "1 serving", Confidence: 0.9}},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: []IngredientGuess{
			{Ingredient: "seasoned tofu 3c", PortionEstimate: "100 g", Confidence: 0.8},
		},
		ingredientsUsage: Usage{Provider: "stub", CallType: "decompose"},
	}
	resolver := NewResolver(provider, repo, NoCache{}, &stubMeter{withinBudget: true})

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "qzzznonce seasoned dish 3c")

	require.NoError(t, err)
	require.True(t, res.IsEstimate)
	require.Len(t, res.Candidates, 1)
	require.GreaterOrEqual(t, res.Candidates[0].MatchScore, 0.70, "fixture must land inside the confirm band")
	require.Less(t, res.Candidates[0].MatchScore, 0.90, "fixture must land inside the confirm band")
	require.Equal(t, TierConfirm, res.Candidates[0].Tier)
}

// TestDecomposeAndEstimate_ResolutionTierIsMaxAcrossItems covers a decompose
// result with mixed per-item tiers (one confirm-capped perfect match, one
// weak follow_up match): the Resolution's own Tier must be the MAX across
// items via tierRank — the same "is anything loggable?" semantics
// resolveGuesses already uses — not an average, and not hardcoded.
func TestDecomposeAndEstimate_ResolutionTierIsMaxAcrossItems(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test3d'") })
	repo := nutrition.NewRepository(db)

	strong := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Grilled tofu ingredient 3d", Brand: "test3d",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 140,
	})
	seedAlias(t, db, "grilled tofu 3d", strong.ID)
	seedFoodItem(t, repo, nutrition.FoodItem{
		Name:       "Rare zqxmarinade3d blend delta echo foxtrot golf hotel india juliet kilo",
		Brand:      "test3d",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 300,
	})

	provider := &stubProvider{
		guesses:    []Guess{{Food: "qzzznonce mixed dish 3d", PortionEstimate: "1 serving", Confidence: 0.9}},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: []IngredientGuess{
			{Ingredient: "grilled tofu 3d", PortionEstimate: "100 g", Confidence: 0.8},
			{Ingredient: "zqxmarinade3d", PortionEstimate: "10 g", Confidence: 0.8},
		},
		ingredientsUsage: Usage{Provider: "stub", CallType: "decompose"},
	}
	resolver := NewResolver(provider, repo, NoCache{}, &stubMeter{withinBudget: true})

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "qzzznonce mixed dish 3d")

	require.NoError(t, err)
	require.True(t, res.IsEstimate)
	require.Len(t, res.Candidates, 2)
	require.Equal(t, TierConfirm, res.Candidates[0].Tier)
	require.Equal(t, TierFollowUp, res.Candidates[1].Tier)
	// The resolution reports the BEST item's tier, exactly like resolveGuesses.
	require.Equal(t, TierConfirm, res.Tier)
}

// TestDecomposeAndEstimate_AllFollowUpProducesEmptyFollowUpQuestion covers the
// all-weak case: every ingredient's own match is below the confirm floor, so
// the resolution's Tier must be TierFollowUp too (max across items). Critically,
// FollowUpQuestion must stay EMPTY — apps/mobile/app/capture.tsx only renders
// its dedicated (candidate-discarding, "search manually") follow-up branch
// when tier == follow_up AND follow_up_question is non-empty. A non-empty
// question here would route the user into that dead-end branch instead of the
// normal detected-card view with tappable per-item uncertain rows, defeating
// the entire purpose of per-item tiering on the estimate path.
func TestDecomposeAndEstimate_AllFollowUpProducesEmptyFollowUpQuestion(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test3e'") })
	repo := nutrition.NewRepository(db)

	seedFoodItem(t, repo, nutrition.FoodItem{
		Name:       "Rare zqxweak3e blend delta echo foxtrot golf hotel india juliet kilo",
		Brand:      "test3e",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 300,
	})
	seedFoodItem(t, repo, nutrition.FoodItem{
		Name:       "Rare zqxweak3e2 blend delta echo foxtrot golf hotel india juliet kilo",
		Brand:      "test3e",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 300,
	})

	provider := &stubProvider{
		guesses:    []Guess{{Food: "qzzznonce weak dish 3e", PortionEstimate: "1 serving", Confidence: 0.9}},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
		ingredients: []IngredientGuess{
			{Ingredient: "zqxweak3e", PortionEstimate: "50 g", Confidence: 0.8},
			{Ingredient: "zqxweak3e2", PortionEstimate: "50 g", Confidence: 0.8},
		},
		ingredientsUsage: Usage{Provider: "stub", CallType: "decompose"},
	}
	resolver := NewResolver(provider, repo, NoCache{}, &stubMeter{withinBudget: true})

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "qzzznonce weak dish 3e")

	require.NoError(t, err)
	require.True(t, res.IsEstimate)
	require.Len(t, res.Candidates, 2)
	for i, c := range res.Candidates {
		require.Equal(t, TierFollowUp, c.Tier, "candidate %d", i)
	}
	require.Equal(t, TierFollowUp, res.Tier)
	require.Empty(t, res.FollowUpQuestion)
}

// TestResolveText_WeakMatch_PrefersCandidateOverDecomposition pins the fix for
// kora#180. A photographed croissant identified as "croissant" at 0.99 matched
// `Croissants, cheese` at 0.4425 — a ~117 kcal answer against a ~114 kcal truth
// — and the resolver threw it away because it missed the confirm floor, then
// returned a 2248-3041 kcal ingredient decomposition instead.
//
// decomposeAndEstimate sums ingredients at a flat 100 g default with no scaling
// to the finished dish, so it can only ever produce a number LARGER than the
// food. That makes it a strictly worse answer than the weak match it replaces
// whenever a match exists at all.
//
// The tier here is forced deterministically rather than by fuzzy scoring:
// TierFor takes the MINIMUM of identify-confidence and match score, so a
// seeded alias (match ~1.0) with a 0.5 confidence lands in follow_up.
func TestResolveText_WeakMatch_PrefersCandidateOverDecomposition(t *testing.T) {
	db := testDB(t)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE brand = 'test180'") })
	repo := nutrition.NewRepository(db)

	croissant := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Croissant test180", Brand: "test180",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 406,
	})
	seedAlias(t, db, "croissant 180", croissant.ID)

	// The ingredient MUST resolve too. Without it decomposeAndEstimate returns
	// resolved=false and the resolver falls back to `res` anyway — which looks
	// like a pass while never exercising the bug. The regression is a
	// SUCCESSFUL decomposition displacing a good candidate.
	flour := seedFoodItem(t, repo, nutrition.FoodItem{
		Name: "Wheat flour test180", Brand: "test180",
		Provenance: nutrition.ProvenanceAFCD, KcalPer100g: 364,
	})
	seedAlias(t, db, "wheat flour 180", flour.ID)

	provider := &stubProvider{
		guesses: []Guess{
			{Food: "croissant 180", PortionEstimate: "1 serving", Confidence: 0.5},
		},
		guessUsage: Usage{Provider: "stub", CallType: "identify_text"},
		// Present so that a regression is loud: if the resolver decomposes
		// despite holding a candidate, IsEstimate flips and these replace it.
		ingredients: []IngredientGuess{
			{Ingredient: "wheat flour 180", PortionEstimate: "100 g", Confidence: 0.8},
		},
		ingredientsUsage: Usage{Provider: "stub", CallType: "decompose"},
	}
	resolver := NewResolver(provider, repo, NoCache{}, &stubMeter{withinBudget: true})

	res, err := resolver.ResolveText(context.Background(), uuid.New(), "croissant 180")

	require.NoError(t, err)
	require.False(t, res.IsEstimate,
		"a weak match must be returned as itself, never replaced by an ingredient estimate")
	require.Len(t, res.Candidates, 1)
	require.Equal(t, "Croissant test180", res.Candidates[0].Item.Name)
	require.Equal(t, TierFollowUp, res.Tier)
	// The client's dedicated follow-up branch DISCARDS the candidate list and
	// dead-ends at "Search manually", so a question here would hide the very
	// answer this fix exists to surface.
	require.Empty(t, res.FollowUpQuestion,
		"blank keeps the client on the detected-card path, where the uncertain row is tappable")
}

// TestReturnableWeakMatch pins the abstain floor (kora#184) at the boundary,
// with the cases named by the real resolutions the floor was measured from.
//
// The floor exists because the engine had no way to say "I don't know": every
// query returned the nearest row it held, however far away. Against an index
// that was 98% USDA, an Australian user asking for a McSpicy got a Bacon Ranch
// Salad — and three such rows, 870 kcal, sat one tap from the diary.
//
// The values below are production measurements, not invented thresholds. If
// this test is ever changed, change it against fresh measurements from the
// "ai: abstaining" / "returning low-confidence match" log lines, which exist to
// keep this figure re-derivable.
func TestReturnableWeakMatch(t *testing.T) {
	withScore := func(score float64) Resolution {
		return Resolution{Candidates: []ResolvedCandidate{{MatchScore: score}}}
	}

	tests := []struct {
		name  string
		res   Resolution
		want  bool
		notes string
	}{
		{"no candidates at all", Resolution{}, false, "nothing to return; decomposition may still apply"},
		{"McSpicy -> Bacon Ranch Salad", withScore(0.349), false, "measured wrong"},
		{"McSpicy patty -> frozen chicken patty", withScore(0.399), false, "measured wrong"},
		{"exactly on the floor", withScore(0.40), true, "boundary is inclusive"},
		{"just under the floor", withScore(0.3999), false, "boundary is inclusive"},
		{"croissant -> Croissants, cheese", withScore(0.4425), true, "measured RIGHT: 117 vs ~114 kcal"},
		{"McChicken -> McCHICKEN Sandwich", withScore(0.522), true, "measured right"},
		{"pear -> Pears, raw", withScore(0.566), true, "measured right"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.want, returnableWeakMatch(tt.res), tt.notes)
		})
	}
}

// The floor must sit strictly BETWEEN the worst correct match and the best
// wrong one that were measured. Pinned separately from the table above because
// it is the property that makes 0.40 defensible at all: move the constant
// outside this gap and the separation it rests on is gone, whatever the table
// says.
func TestAbstainFloorSitsInTheMeasuredGap(t *testing.T) {
	const bestMeasuredWrong = 0.399   // McSpicy Chicken Patty -> Chicken patty, frozen
	const worstMeasuredRight = 0.4425 // croissant -> Croissants, cheese

	require.Greater(t, minReturnableMatchScore, bestMeasuredWrong,
		"the floor must reject every wrong match that was measured")
	require.LessOrEqual(t, minReturnableMatchScore, worstMeasuredRight,
		"the floor must keep every correct match that was measured — the croissant is the tight one")
}
