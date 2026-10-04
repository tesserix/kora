package accuracy

import (
	"testing"

	"github.com/google/uuid"
	"github.com/lib/pq"
	"github.com/stretchr/testify/assert"

	"github.com/tesserix/kora/api/internal/resolveoutcome"
)

func outcome(tier string, candidates ...uuid.UUID) resolveoutcome.Outcome {
	trace := "0af7651916cd43dd8448eb211c80319c"
	o := resolveoutcome.Outcome{ID: uuid.New(), Tier: tier, Mode: resolveoutcome.ModeText, TraceID: &trace}
	for _, c := range candidates {
		o.CandidateFoodItemIDs = append(o.CandidateFoodItemIDs, c.String())
	}
	return o
}

func byName(scores []Score) map[string]Score {
	out := map[string]Score{}
	for _, s := range scores {
		out[s.Name] = s
	}
	return out
}

func TestKeepingAnAutoItemScoresItCorrect(t *testing.T) {
	rice, dal := uuid.New(), uuid.New()
	o := outcome("auto", rice, dal)

	got := byName(CaptureScores(o, 1, dal, false))

	assert.Equal(t, 1.0, got[ScoreTop1Correct].Value)
	assert.Equal(t, 1.0, got[ScoreTierCorrect].Value)
	for _, s := range got {
		assert.Equal(t, *o.TraceID, s.TraceID)
		assert.Equal(t, o.ID.String()+"-1-"+s.Name, s.ID, "a stable per-item id so a later correction overwrites it")
		assert.Equal(t, "1", s.Metadata["item_index"])
	}
}

func TestEachItemOnAPlateIsScoredSeparately(t *testing.T) {
	rice, dal := uuid.New(), uuid.New()
	o := outcome("auto", rice, dal)

	first := byName(CaptureScores(o, 0, rice, false))[ScoreTop1Correct]
	second := byName(CaptureScores(o, 1, dal, false))[ScoreTop1Correct]

	assert.NotEqual(t, first.ID, second.ID)
	assert.Equal(t, 1.0, first.Value)
	assert.Equal(t, 1.0, second.Value)
}

func TestReplacingAnItemScoresItWrong(t *testing.T) {
	got := byName(CaptureScores(outcome("auto", uuid.New()), 0, uuid.New(), true))

	assert.Equal(t, 0.0, got[ScoreTop1Correct].Value)
	assert.Equal(t, 0.0, got[ScoreTierCorrect].Value)
	assert.Equal(t, "corrected", got[ScoreTop1Correct].Comment)
}

func TestOnlyAnAutoTierIsScoredForTier(t *testing.T) {
	food := uuid.New()

	_, scored := byName(CaptureScores(outcome("confirm", food), 0, food, false))[ScoreTierCorrect]

	assert.False(t, scored, "only an auto tier claims it needs no confirmation")
}

func TestTheChosenFoodIsTheLabel(t *testing.T) {
	chosen := uuid.New()

	got := byName(CaptureScores(outcome("auto", uuid.New()), 0, chosen, true))

	assert.Equal(t, chosen.String(), got[ScoreTop1Correct].Metadata["food_item_id"])
	assert.Equal(t, "text", got[ScoreTop1Correct].Metadata["mode"])
}

func TestAnItemOutsideTheResolutionHasNothingToScore(t *testing.T) {
	food := uuid.New()
	o := outcome("auto", food)

	assert.Empty(t, CaptureScores(o, 1, food, false))
	assert.Empty(t, CaptureScores(o, -1, food, false))
}

func TestAnUntracedOutcomeHasNothingToScore(t *testing.T) {
	o := resolveoutcome.Outcome{ID: uuid.New(), Tier: "auto", CandidateFoodItemIDs: pq.StringArray{uuid.NewString()}}

	assert.Empty(t, CaptureScores(o, 0, uuid.New(), false))
}
