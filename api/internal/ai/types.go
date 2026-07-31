// Package ai owns AI-assisted food resolution: provider clients, routing,
// and the resolution service. The LLM identifies foods; nutrition numbers
// always come from the nutrition index (never from the model).
package ai

import "github.com/tesserix/kora/api/internal/nutrition"

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

// ResolvedCandidate is a resolved food with nutrition taken ONLY from the
// FoodItem row (never from the LLM).
type ResolvedCandidate struct {
	Item         nutrition.FoodItem `json:"item"`
	PortionGrams float64            `json:"portion_grams"`
	Kcal         float64            `json:"kcal"`
	MatchScore   float64            `json:"match_score"`
	MatchTier    string             `json:"match_tier"`
}

// Resolution is the engine's answer for one resolve request.
type Resolution struct {
	Candidates       []ResolvedCandidate `json:"candidates"`
	Tier             Tier                `json:"tier"`
	FollowUpQuestion string              `json:"follow_up_question,omitempty"`
	IsEstimate       bool                `json:"is_estimate"`
	KcalLow          float64             `json:"kcal_low,omitempty"`
	KcalHigh         float64             `json:"kcal_high,omitempty"`
	Provenance       string              `json:"provenance"`
	// Transcript is the speech-to-text transcript for a voice resolve, set
	// only by Resolver.ResolveVoice on a successful (non-blank) transcription.
	// It exists so a mobile client has a SERVER-DERIVED phrase to send back as
	// FoodLog.InputPhrase on an ai_voice log — without it, a voice log could
	// never carry the input_phrase a later correction needs to teach the food
	// index. Every other resolve path (ResolveText, ResolvePhoto) leaves this
	// blank; a text log already has the client-supplied phrase for
	// input_phrase, and a photo has no phrase at all.
	Transcript string `json:"transcript,omitempty"`
}
