// Package ai owns AI-assisted food resolution: provider clients, routing,
// and the resolution service. The LLM identifies foods; nutrition numbers
// always come from the nutrition index (never from the model).
package ai

import "github.com/tesserix/kora/api/internal/nutrition"

// Guess is a single food identification from a provider. It carries NO
// nutrition numbers — only identity + portion + confidence.
type Guess struct {
	// Food is the food CORE — the thing itself, with the brand and any
	// distinguishing qualifiers split out into the fields below rather than
	// left inside this string.
	Food string `json:"food"`

	// Brand is the retail or restaurant brand the user named, empty when they
	// named none. kora#212 Phase 3 exists because this used to have nowhere to
	// go: "El Janah 1/2 chicken with Chips" reached the resolver as the single
	// word "chicken", and no amount of downstream scoring can recover
	// information identify already discarded. With the brand preserved, the
	// resolver can REQUIRE a brand match instead of guessing from a bare noun.
	//
	// Empty is meaningful and must stay distinguishable from "unknown": it is
	// what tells the resolver the query is unqualified, which is the condition
	// Phase 2's generic-preference policy keys on.
	Brand string `json:"brand"`

	// Qualifiers are the words that narrow which variant of Food this is —
	// "charcoal", "grilled", "wholemeal", "large" — excluding the portion and
	// the cooking method, which have their own fields. Kept as a list rather
	// than folded back into Food so the resolver can choose to search with or
	// without them: "charcoal chicken" finds the right row when it exists, and
	// falls back to "chicken" when it does not, which a single pre-joined
	// string cannot express.
	Qualifiers []string `json:"qualifiers"`

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

// BodyCompositionReading is what a smart-scale screenshot legibly shows,
// read by a vision model (kora#314). Every field is a POINTER because
// absent must not collapse into zero — the same reasoning as
// tracking.BodyComposition (internal/tracking/model.go), which this
// mirrors field-for-field on purpose so a reading can be handed straight
// into that struct's shape without renaming.
//
// This type carries ONLY measured values. BMI, fat-free mass, fat mass in
// kg, metabolic age, and qualitative bands are structurally impossible to
// return here: there is no field for them, so a model that tries to supply
// one anyway has it silently dropped by encoding/json. See
// migrations/000039_body_composition.up.sql for why each is excluded.
type BodyCompositionReading struct {
	WeightKg           *float64 `json:"weight_kg,omitempty"`
	BodyFatPct         *float64 `json:"body_fat_pct,omitempty"`
	SubcutaneousFatPct *float64 `json:"subcutaneous_fat_pct,omitempty"`
	// VisceralFatRating is a vendor RATING, not a percentage — see the
	// struct doc on tracking.BodyComposition for the same warning. Never
	// render or validate this as a 0-100 percent.
	VisceralFatRating *float64 `json:"visceral_fat_rating,omitempty"`
	// SkeletalMusclePct and MuscleMassKg are DIFFERENT quantities (a scale
	// like Renpho reports both) — never derive one from the other.
	SkeletalMusclePct *float64 `json:"skeletal_muscle_pct,omitempty"`
	MuscleMassKg      *float64 `json:"muscle_mass_kg,omitempty"`
	BodyWaterPct      *float64 `json:"body_water_pct,omitempty"`
	ProteinPct        *float64 `json:"protein_pct,omitempty"`
	// BoneMassKg is bone MASS, not bone DENSITY/BMD/T-score.
	BoneMassKg *float64 `json:"bone_mass_kg,omitempty"`
	// ScaleBMRKcal is the scale's own BMR estimate — comparison only, never
	// wired to Kora's own Mifflin-St Jeor target (see tracking.BodyComposition).
	ScaleBMRKcal *float64 `json:"scale_bmr_kcal,omitempty"`
	// ReadingDate is the calendar date the SCREENSHOT ITSELF shows for this
	// reading, "YYYY-MM-DD", nil when not legible. Never a timestamp, never
	// inferred as "today" — a reading may be days old by the time it's
	// uploaded (kora#314).
	ReadingDate *string `json:"reading_date,omitempty"`
}

// Usage records one provider call for metering.
type Usage struct {
	Provider  string
	Model     string
	CallType  string // identify_text | identify_photo | decompose | embed
	TokensIn  int
	TokensOut int
	LatencyMs int
	// Outcome distinguishes "this call happened" from "this call answered".
	// Before #81 only successes were recorded at all, so a never-working path
	// and a never-attempted path were indistinguishable in ai_usage_events —
	// which is how three stacked photo bugs stayed invisible. Failures are now
	// recorded too, which means cost queries MUST filter on this or they will
	// over-count instead of the old under-count.
	Outcome string
}

// Usage.Outcome values.
const (
	OutcomeOK      = "ok"
	OutcomeError   = "error"
	OutcomeTimeout = "timeout"
)

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
	// Tier is this item's OWN confidence, not the resolution's. Resolution.Tier
	// keeps the max across items (it answers "is anything loggable?"), so
	// without a per-item tier a weak item is invisible beside a strong one.
	Tier Tier `json:"tier"`
	// PortionAssumed reports that no serving size was known for this food and
	// the portion below is a system estimate, not a measurement. It is
	// deliberately separate from MatchScore: a barcode identifies the food
	// exactly (score 1.0 is honest), while the portion is still a guess.
	// Collapsing the two would either overstate the portion or understate the
	// match. The client must not render an assumed portion as an exact figure.
	PortionAssumed bool `json:"portion_assumed"`
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
