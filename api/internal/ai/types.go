// Package ai owns AI-assisted food resolution: provider clients, routing,
// and the resolution service. The LLM identifies foods; nutrition numbers
// always come from the nutrition index (never from the model).
package ai

// Guess is a single food identification from a provider. It carries NO
// nutrition numbers — only identity + portion + confidence.
type Guess struct {
	Food            string  `json:"food"`
	PortionEstimate string  `json:"portion_estimate"`
	CookingMethod   string  `json:"cooking_method"`
	Confidence      float64 `json:"confidence"`
}

// IngredientGuess is a decomposed ingredient (identity + portion only).
type IngredientGuess struct {
	Ingredient      string  `json:"ingredient"`
	PortionEstimate string  `json:"portion_estimate"`
	Confidence      float64 `json:"confidence"`
}

// Usage records one provider call for metering.
type Usage struct {
	Provider  string
	Model     string
	CallType  string // identify_text | identify_photo | decompose | embed
	TokensIn  int
	TokensOut int
	LatencyMs int
}

// Tier classifies resolution confidence.
type Tier string

const (
	TierAuto     Tier = "auto"      // >= 0.90 one-tap
	TierConfirm  Tier = "confirm"   // 0.70-0.90 one quick confirm
	TierFollowUp Tier = "follow_up" // < 0.70 targeted question
)

const (
	tierAutoFloor    = 0.90
	tierConfirmFloor = 0.70
)

// TierFor combines LLM identify-confidence with the top resolution match
// score (the limiting one wins).
func TierFor(identifyConf, matchScore float64) Tier {
	c := identifyConf
	if matchScore < c {
		c = matchScore
	}
	switch {
	case c >= tierAutoFloor:
		return TierAuto
	case c >= tierConfirmFloor:
		return TierConfirm
	default:
		return TierFollowUp
	}
}
