package ai

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// The three phrases below are the measured #184 failures. They are the reason
// the reduction factor exists, so they are pinned as tiers, end to end through
// phraseCoverage -> reductionFactor -> tierWithReduction, with the identify
// confidence and match score each one actually produced in production.
func TestReductionFactor_MeasuredFailures(t *testing.T) {
	tests := []struct {
		name         string
		phrase       string
		guesses      []Guess
		identifyConf float64
		matchScore   float64
		wantCoverage float64
		want         Tier
		notes        string
	}{
		{
			name:   "El Janah 1/2 chicken with Chips — only the brand is lost",
			phrase: "El Janah 1/2 chicken with Chips",
			guesses: []Guess{
				{Food: "1/2 chicken", PortionEstimate: "1/2", Confidence: 0.95},
				{Food: "chips", PortionEstimate: "100 g", Confidence: 0.95},
			},
			identifyConf: 0.95,
			matchScore:   1.0,
			wantCoverage: 4.0 / 6.0,
			want:         TierConfirm,
			notes:        "mild penalty: the food and the portion survived, so this is a question, not a discard",
		},
		{
			name:   "McSpicy chicken meal — guesses cover none of it",
			phrase: "McSpicy chicken meal",
			guesses: []Guess{
				{Food: "French Fries", PortionEstimate: "100 g", Confidence: 0.95},
				{Food: "Red Bull energy drink", PortionEstimate: "250 ml", Confidence: 0.95},
			},
			identifyConf: 0.95,
			matchScore:   1.0,
			wantCoverage: 0,
			want:         TierFollowUp,
			notes:        "heavy penalty: a 1.0 match on a food the user never mentioned is not confidence",
		},
		{
			name:         "grilled chicken breast — phrase kept whole",
			phrase:       "grilled chicken breast",
			guesses:      []Guess{{Food: "grilled chicken breast", PortionEstimate: "100 g", Confidence: 0.95}},
			identifyConf: 0.95,
			matchScore:   1.0,
			wantCoverage: 1,
			want:         TierAuto,
			notes:        "THE regression guard: full coverage must cost exactly nothing",
		},
		{
			name:         "photo path — no phrase at all",
			phrase:       "",
			guesses:      []Guess{{Food: "croissant", Confidence: 0.99}},
			identifyConf: 0.99,
			matchScore:   0.95,
			wantCoverage: 1,
			want:         TierAuto,
			notes:        "a photo says nothing that could have been discarded",
		},
		{
			name:         "stopword-only difference",
			phrase:       "chicken with rice",
			guesses:      []Guess{{Food: "chicken", Confidence: 0.95}, {Food: "rice", Confidence: 0.95}},
			identifyConf: 0.95,
			matchScore:   1.0,
			wantCoverage: 1,
			want:         TierAuto,
			notes:        "\"with\" is not information the model discarded",
		},
		{
			name:         "cooking method preserved outside Food",
			phrase:       "grilled chicken",
			guesses:      []Guess{{Food: "chicken", CookingMethod: "grilled", Confidence: 0.95}},
			identifyConf: 0.95,
			matchScore:   1.0,
			wantCoverage: 1,
			want:         TierAuto,
			notes:        "same rationale as PortionEstimate: identify kept it, just not in Food",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cov := phraseCoverage(tt.phrase, tt.guesses)
			require.InDelta(t, tt.wantCoverage, cov, 1e-9, tt.notes)
			require.Equal(t, tt.want,
				tierWithReduction(tt.identifyConf, tt.matchScore, reductionFactor(cov)), tt.notes)
		})
	}
}

// reductionFactor is a straight line from the floor (nothing of the phrase
// survived) to exactly 1.0 (all of it did). The endpoints are the load-bearing
// part: 1.0 must be exact, or every correct resolution pays a tax.
func TestReductionFactor_Shape(t *testing.T) {
	tests := []struct {
		name     string
		coverage float64
		want     float64
	}{
		{"nothing survived", 0, phraseCoverageFloor},
		{"half survived", 0.5, phraseCoverageFloor + (1-phraseCoverageFloor)*0.5},
		{"all survived", 1, 1},
		{"coverage below 0 clamps to the floor", -0.5, phraseCoverageFloor},
		{"coverage above 1 clamps to 1", 1.5, 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.InDelta(t, tt.want, reductionFactor(tt.coverage), 1e-9)
		})
	}
}

// A factor of 1.0 must be a literal no-op on the tier decision, whatever the
// two inputs are — this is what keeps the change invisible to the photo path
// and to every phrase the guesses fully account for.
func TestTierWithReduction_UnitFactorIsANoOp(t *testing.T) {
	pairs := [][2]float64{
		{0.95, 1.0}, {1.0, 0.95}, {0.90, 0.90}, {0.70, 0.85}, {0.6999, 1.0}, {0.2, 0.99},
	}
	for _, p := range pairs {
		require.Equal(t, TierFor(p[0], p[1]), tierWithReduction(p[0], p[1], 1),
			"factor 1.0 must reproduce TierFor exactly")
	}
}

// The floor is one constant and it has to sit in a defensible place: strong
// enough that a wholly-unaccounted-for phrase cannot stay loggable, gentle
// enough that losing a brand name off an otherwise-right answer still leaves a
// confirmable answer rather than an abstention.
func TestPhraseCoverageFloorIsDefensible(t *testing.T) {
	const measuredConfidence = 0.95 // identify's confidence on both #184 failures

	require.Less(t, measuredConfidence*reductionFactor(0), tierConfirmFloor,
		"zero phrase coverage must fall out of confirm entirely")
	require.Less(t, measuredConfidence*reductionFactor(4.0/6.0), tierAutoFloor,
		"losing a brand must cost the auto-log")
	require.GreaterOrEqual(t, measuredConfidence*reductionFactor(4.0/6.0), tierConfirmFloor,
		"...but must not cost the answer itself")
}
