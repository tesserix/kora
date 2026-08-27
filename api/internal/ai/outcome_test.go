package ai

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"gorm.io/gorm"
	"math"
	"strconv"
	"strings"

	"github.com/tesserix/kora/api/internal/nutrition"
)

// recordingSink captures what the resolver reported, so each branch can be
// checked against the kind it is supposed to produce.
type recordingSink struct{ got []ResolveOutcome }

func (s *recordingSink) Record(_ context.Context, o ResolveOutcome) { s.got = append(s.got, o) }

func (s *recordingSink) kinds() []string {
	out := make([]string, 0, len(s.got))
	for _, o := range s.got {
		out = append(out, o.Kind)
	}
	return out
}

// TestABareResolverRecordsNothing — measurement must be optional. Every test
// in this package builds a Resolver without a sink, and a nil one must be a
// no-op rather than a panic.
func TestABareResolverRecordsNothing(t *testing.T) {
	r := Resolver{}
	assert.NotPanics(t, func() {
		r.recordOutcome(context.Background(), ResolveOutcome{Kind: outcomeResolved})
	})
}

// TestResolveTextRecordsEachBranch walks the branches that do not need a
// database and pins the kind each one reports.
//
// Despite the name it is NOT every branch: the two the /admin/inbox triage
// queue reads — below_floor and no_match — need real index rows and live in
// TestBelowFloorIsRecordedWhenEveryCandidateMissesTheFloor and
// TestNoMatchIsRecordedWhenNothingResolvesAndNothingDecomposes below.
//
// This is the test that matters: the branches already existed and were only
// logged, so the risk is not that they are wrong now but that a later edit
// moves a return past its recorder and the table quietly stops describing
// reality. A kind assertion per branch turns that into a failure.
func TestResolveTextRecordsEachBranch(t *testing.T) {
	// A real repository, not a zero one: ResolveText consults the personal
	// alias index BEFORE anything else, so a nil *gorm.DB panics there long
	// before the branch under test is reached.
	db := testDB(t)
	repo := nutrition.NewRepository(db)
	userID := seedTestUser(t, db)

	t.Run("budget exhausted", func(t *testing.T) {
		sink := &recordingSink{}
		r := NewResolver(&stubProvider{}, repo,
			NoCache{}, &stubMeter{withinBudget: false}).WithOutcomeSink(sink)

		res, err := r.ResolveText(context.Background(), userID, "anything")

		require.NoError(t, err)
		require.Equal(t, TierFollowUp, res.Tier)
		require.Equal(t, []string{outcomeBudget}, sink.kinds())

		got := sink.got[0]
		assert.Equal(t, userID, got.UserID)
		assert.Equal(t, modeText, got.Mode)
		require.NotNil(t, got.Phrase)
		assert.Equal(t, "anything", *got.Phrase)
	})

	t.Run("identify fails", func(t *testing.T) {
		sink := &recordingSink{}
		r := NewResolver(&stubProvider{guessErr: errors.New("provider down")},
			repo, NoCache{}, &stubMeter{withinBudget: true}).
			WithOutcomeSink(sink)

		_, err := r.ResolveText(context.Background(), userID, "toast")

		require.Error(t, err)
		assert.Equal(t, []string{outcomeError}, sink.kinds(),
			"a provider failure is an error, never an index gap — the two drive different fixes")
	})

	t.Run("cache hit", func(t *testing.T) {
		sink := &recordingSink{}
		cached := Resolution{Tier: TierAuto, Candidates: []ResolvedCandidate{{
			Item: nutrition.FoodItem{ID: uuid.New()}, MatchScore: 0.97,
		}}}
		r := NewResolver(&stubProvider{}, repo,
			&fixedCache{res: cached}, &stubMeter{withinBudget: true}).
			WithOutcomeSink(sink)

		_, err := r.ResolveText(context.Background(), userID, "toast")

		require.NoError(t, err)
		require.Equal(t, []string{outcomeCache}, sink.kinds())

		// A cache hit still reports the cached resolution's tier and top
		// candidate: it IS a resolution, just one nobody paid for again.
		got := sink.got[0]
		assert.Equal(t, string(TierAuto), got.Tier)
		assert.Equal(t, 1, got.CandidateCount)
		require.NotNil(t, got.TopScore)
		assert.InDelta(t, 0.97, *got.TopScore, 1e-9)
	})
}

// TestVoiceIsRecordedAsVoiceNotText — ResolveVoice delegates to the text
// pipeline, so without threading the mode every transcript would be filed
// under `text` and the voice path would be invisible in its own table.
func TestVoiceIsRecordedAsVoiceNotText(t *testing.T) {
	db := testDB(t)
	userID := seedTestUser(t, db)

	sink := &recordingSink{}
	// Budget ALLOWED, and a real (empty) index: the transcript must actually
	// reach the text pipeline, which is the code path that would misfile it.
	//
	// An earlier version of this test exhausted the budget instead — so
	// ResolveVoice returned at its OWN budget branch, never delegated, and
	// reverting the delegation to ResolveText still passed. The mutation
	// survived; this is the fix.
	r := NewResolver(&stubProvider{
		transcript: "two eggs " + uuid.NewString(),
		guesses:    []Guess{{Food: "eggs", Confidence: 0.9}},
		guessUsage: Usage{Provider: "stub"},
	}, nutrition.NewRepository(db), NoCache{}, &stubMeter{withinBudget: true}).
		WithOutcomeSink(sink)

	_, err := r.ResolveVoice(context.Background(), userID, []byte("audio"), "audio/m4a")

	require.NoError(t, err)
	require.NotEmpty(t, sink.got)
	// The recorded kind is whatever the empty index produced; the MODE is what
	// is under test, and it must be voice on every row the attempt wrote.
	for _, o := range sink.got {
		assert.Equal(t, modeVoice, o.Mode, "a voice resolve must never be recorded as text")
	}
	assert.NotContains(t, sink.kinds(), outcomeBudget,
		"the budget branch would return before the text pipeline and prove nothing")
}

// TestBlankTranscriptIsItsOwnKind — a capture failure is neither a provider
// fault nor an index gap, and folding it into either would send someone to the
// wrong fix. It is recorded rather than dropped so the voice denominator stays
// honest.
func TestBlankTranscriptIsItsOwnKind(t *testing.T) {
	sink := &recordingSink{}
	// No DB needed: a blank transcript returns before the text pipeline.
	r := NewResolver(&stubProvider{transcript: "   ", guessUsage: Usage{Provider: "stub"}},
		nutrition.Repository{}, NoCache{}, &stubMeter{withinBudget: true}).
		WithOutcomeSink(sink)

	res, err := r.ResolveVoice(context.Background(), uuid.New(), []byte("silence"), "audio/m4a")

	require.NoError(t, err)
	assert.Equal(t, TierFollowUp, res.Tier)
	require.Equal(t, []string{outcomeTranscriptBlank}, sink.kinds())
	assert.Nil(t, sink.got[0].Phrase, "there was no transcript to record")
}

// TestOutcomeForReadsTheResolutionRatherThanRecomputing — the tier and score
// must come off the Resolution the resolver produced. Recomputing either here
// would make this table a second opinion about confidence, and ai.TierFor owns
// that decision.
func TestOutcomeForReadsTheResolutionRatherThanRecomputing(t *testing.T) {
	id := uuid.New()
	res := Resolution{
		Tier: TierConfirm,
		Candidates: []ResolvedCandidate{
			{Item: nutrition.FoodItem{ID: id}, MatchScore: 0.81},
			{Item: nutrition.FoodItem{ID: uuid.New()}, MatchScore: 0.42},
		},
	}

	o := outcomeFor(uuid.New(), outcomeResolved, modeText, phrasePtr("toast"), res)

	assert.Equal(t, string(TierConfirm), o.Tier)
	assert.Equal(t, 2, o.CandidateCount)
	require.NotNil(t, o.TopFoodItemID)
	assert.Equal(t, id, *o.TopFoodItemID, "the TOP candidate, not any candidate")
	require.NotNil(t, o.TopScore)
	assert.InDelta(t, 0.81, *o.TopScore, 1e-9)
}

func TestOutcomeForWithNoCandidatesCarriesNoTop(t *testing.T) {
	o := outcomeFor(uuid.New(), outcomeNoMatch, modeText, phrasePtr("mcspicy"), Resolution{})

	assert.Equal(t, 0, o.CandidateCount)
	assert.Nil(t, o.TopFoodItemID, "nil, not a zero uuid — there was no candidate")
	assert.Nil(t, o.TopScore, "nil, not 0.0 — a score of zero is a real value")
}

// TestPhrasePtrDistinguishesAbsentFromEmpty — a photo has no phrase; a text
// resolve of "" has an empty one. Collapsing them would make the stored row
// unable to say which happened.
func TestPhrasePtrDistinguishesAbsentFromEmpty(t *testing.T) {
	assert.Nil(t, phrasePtr(""))
	require.NotNil(t, phrasePtr("toast"))
	assert.Equal(t, "toast", *phrasePtr("toast"))
}

// fixedCache always hits, so the cache branch can be exercised without a
// Redis. NoCache is the always-miss counterpart the other tests use.
type fixedCache struct{ res Resolution }

func (c *fixedCache) Get(context.Context, string) (*Resolution, bool) { return &c.res, true }
func (c *fixedCache) Set(context.Context, string, Resolution)         {}
func (c *fixedCache) Delete(context.Context, string) error            { return nil }
func (c *fixedCache) DeleteByUser(context.Context, uuid.UUID) error   { return nil }

var _ Cache = (*fixedCache)(nil)

// seedNonsenseFood inserts one food row whose name no real index row can
// match, and schedules its cleanup.
//
// Nonsense on purpose. The two tests below are the only ones in this package
// that depend on what the nutrition index CONTAINS, and dev and prod diverge
// (18,876 rows against 26,120). A query built from invented tokens recalls the
// seeded row and nothing else, which is what keeps these tests from becoming
// another casualty of that divergence.
//
// normalized_name is a plain column, not a generated one (migration 000004
// backfills it with lower(btrim(name))), so it has to be written here or the
// trigram search will never see the row.
func seedNonsenseFood(t *testing.T, db *gorm.DB, name string, embedding string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	require.NoError(t, db.Exec(
		`INSERT INTO food_items (id, name, normalized_name, provenance,
		     kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, embedding)
		 VALUES (?, ?, lower(btrim(?)), 'curated', 100, 5, 10, 2, CAST(? AS vector))`,
		id, name, name, embedding).Error)
	t.Cleanup(func() { db.Exec("DELETE FROM food_items WHERE id = ?", id) })
	return id
}

// unitVector renders a 768-dimension pgvector literal whose first two
// components are x and y and whose remaining components are zero.
//
// Two axes are all the below-floor test needs: with unit inputs the cosine
// similarity between [1,0,...] and [x,y,0,...] is simply x, which makes the
// resulting score arithmetic rather than a measurement.
func unitVector(x, y float64) string {
	parts := make([]string, embeddingDims)
	for i := range parts {
		parts[i] = "0"
	}
	parts[0] = strconv.FormatFloat(x, 'f', -1, 64)
	parts[1] = strconv.FormatFloat(y, 'f', -1, 64)
	return "[" + strings.Join(parts, ",") + "]"
}

// embeddingDims matches the vector(768) column added in migration 000004.
const embeddingDims = 768

// TestNoMatchIsRecordedWhenNothingResolvesAndNothingDecomposes pins the kind
// the INDEX-GAP branch reports.
//
// Reached only via the POST-DECOMPOSE site: ResolveText passes the phrase
// itself as decomposeSubject, so the subject is never empty for a real query
// and the earlier no-candidate return is unreachable for text. Getting here
// means the guess recalled nothing AND decomposition produced nothing usable.
//
// This kind and below_floor are the two Kind.NeedsHuman admits, so this is
// the assertion standing between the resolver and a permanently empty
// /admin/inbox.
func TestNoMatchIsRecordedWhenNothingResolvesAndNothingDecomposes(t *testing.T) {
	db := testDB(t)
	repo := nutrition.NewRepository(db)
	userID := seedTestUser(t, db)

	sink := &recordingSink{}
	// No ingredients: decomposeAndEstimate collects no candidates and reports
	// resolved=false, which is the only route to no_match from text.
	r := NewResolver(&stubProvider{
		guesses:     []Guess{{Food: "zqxvwl mordanthene", Confidence: 0.9}},
		ingredients: nil,
	}, repo, NoCache{}, &stubMeter{withinBudget: true}).WithOutcomeSink(sink)

	res, err := r.ResolveText(context.Background(), userID, "zqxvwl mordanthene")

	require.NoError(t, err)
	require.Empty(t, res.Candidates,
		"premise: the invented guess must recall nothing, or this is not the index-gap branch")
	require.Equal(t, []string{outcomeNoMatch}, sink.kinds(),
		"an index gap must be recorded as no_match — it is one of the two kinds the inbox queue reads")

	got := sink.got[0]
	assert.Equal(t, modeText, got.Mode)
	assert.Equal(t, 0, got.CandidateCount)
	assert.Nil(t, got.TopFoodItemID, "there was no candidate, so there is no top food")
}

// TestBelowFloorIsRecordedWhenEveryCandidateMissesTheFloor pins the kind the
// NEAR-MISS branch reports.
//
// below_floor and no_match demand opposite fixes — a floor that is too high is
// lowered, an index gap is closed by adding data — so recording one as the
// other is worse than recording neither.
//
// # Why this test seeds an EMBEDDING
//
// below_floor is unreachable through the full-text path. quality() is
// 0.4*Coverage + 0.3*Precision + 0.3*Trigram, and Coverage is always 1.0
// within the full-text candidate set because plainto_tsquery ANDs every term.
// So any row the full-text query recalls already scores at least 0.4 — the
// floor itself. The branch is only reachable via the embedding path, where
// quality() takes embeddingFactor*EmbSim instead and Coverage can be zero.
//
// That is also why nobody has seen this branch locally: repository.go notes
// that both the local and CI databases have zero embedded rows. Seeding one
// makes the arithmetic exact — 0.85 * 0.4 = 0.34, comfortably under the 0.40
// floor — and, being the ONLY embedded row, immune to the dev/prod index
// divergence that this package's other data-dependent tests trip over.
func TestBelowFloorIsRecordedWhenEveryCandidateMissesTheFloor(t *testing.T) {
	db := testDB(t)
	repo := nutrition.NewRepository(db)
	userID := seedTestUser(t, db)
	// The name shares NO token with the query, so Coverage stays 0 and the
	// lexical half of quality() cannot rescue the score above the floor.
	foodID := seedNonsenseFood(t, db, "Krundelfast Portionwise Assemblage", unitVector(1, 0))

	sink := &recordingSink{}
	// cos([1,0,...], [0.4, 0.9165..., ...]) = 0.4, so EmbSim is 0.4 and the
	// score is 0.85*0.4 = 0.34.
	r := NewResolver(&stubProvider{
		guesses:   []Guess{{Food: "zqxvwl", Confidence: 0.9}},
		embedding: paddedVector(0.4, float32(math.Sqrt(1-0.4*0.4))),
	}, repo, NoCache{}, &stubMeter{withinBudget: true}).WithOutcomeSink(sink)

	res, err := r.ResolveText(context.Background(), userID, "zqxvwl")

	require.NoError(t, err)
	require.NotEmpty(t, res.Candidates,
		"premise changed: the seeded row is no longer recalled, so this test no longer proves what it claims")
	top := topCandidateScore(res)
	require.Less(t, top, minReturnableMatchScore,
		"premise changed: the seeded row now scores at or above the floor (%v), so this is no longer the below-floor branch", top)
	require.Greater(t, top, 0.0)

	require.Equal(t, []string{outcomeBelowFloor}, sink.kinds(),
		"an all-below-floor candidate set must be recorded as below_floor — it is one of the two kinds the inbox queue reads")

	got := sink.got[0]
	assert.Equal(t, modeText, got.Mode)
	require.NotNil(t, got.TopFoodItemID)
	assert.Equal(t, foodID, *got.TopFoodItemID,
		"the recorded top food must be the near-miss row an operator would act on")
	require.NotNil(t, got.TopScore)
	assert.Less(t, *got.TopScore, minReturnableMatchScore)
}

// paddedVector builds the 768-component query vector matching the seeded row's
// dimensionality; pgvector rejects a comparison between differing dimensions.
func paddedVector(x, y float32) []float32 {
	v := make([]float32, embeddingDims)
	v[0], v[1] = x, y
	return v
}

// TestPhotoWithNoGuessesRecordsNoMatchAtTheFirstSite pins the OTHER no_match
// site — the one text can never reach.
//
// There are two `outcomeNoMatch` recorders in resolve(). ResolveText passes
// `func(guesses) string { return phrase }` as decomposeSubject, so its subject
// is never empty for a real query and it always falls through to the
// post-decompose site (pinned above). ResolvePhoto's decomposeSubject returns
// "" when there are no guesses, which is the only way to reach the FIRST site:
// no candidate AND nothing to decompose, so the engine never calls the
// provider's Decompose at all.
//
// Worth its own test because the two sites report the same kind for opposite
// reasons, and a refactor that collapsed them would look harmless.
func TestPhotoWithNoGuessesRecordsNoMatchAtTheFirstSite(t *testing.T) {
	db := testDB(t)
	repo := nutrition.NewRepository(db)
	userID := seedTestUser(t, db)

	sink := &recordingSink{}
	// No guesses at all: decomposeSubject returns "", so the first site fires.
	// ingredients is deliberately NON-empty — if the resolver ever reached
	// decomposition it would produce a `decomposed` outcome instead, so this
	// doubles as proof that Decompose was never consulted.
	r := NewResolver(&stubProvider{
		guesses:     nil,
		ingredients: []IngredientGuess{{Ingredient: "butter"}},
	}, repo, NoCache{}, &stubMeter{withinBudget: true}).WithOutcomeSink(sink)

	res, err := r.ResolvePhoto(context.Background(), userID, []byte("fake-jpeg-bytes"), "image/jpeg")

	require.NoError(t, err)
	require.Empty(t, res.Candidates)
	require.Equal(t, []string{outcomeNoMatch}, sink.kinds(),
		"a photo that identified nothing is an index gap, not a decomposition")

	got := sink.got[0]
	assert.Equal(t, modePhoto, got.Mode, "a photo must never be filed under text")
	assert.Nil(t, got.Phrase, "a photo has no phrase — nil, not an empty string")
	assert.Equal(t, 0, got.CandidateCount)
}
