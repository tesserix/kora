package ai

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

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
