package ai

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/nutrition"
)

const (
	// resolveTopK bounds how many ranked candidates nutrition.Repository.Resolve
	// returns per identified food/ingredient. The resolver only ever uses the
	// top candidate, but a small K keeps the query cheap while leaving room
	// for a future "did you mean" alternatives list.
	resolveTopK = 5

	// estimateBand is the ± fraction applied around a decomposed dish's
	// summed kcal to produce a low/high range, reflecting that a
	// decomposition-based estimate is inherently less precise than a direct
	// food match.
	estimateBand = 0.15
)

// budgetFollowUpQuestion is returned when a user has exhausted their monthly
// AI budget — resolution degrades gracefully to manual logging rather than
// failing the request.
const budgetFollowUpQuestion = "You've reached your AI limit this month — search and log manually."

// noResolvableGuessFollowUpQuestion is used when at least one guess was
// identified but none of them resolved to a confident nutrition-index match.
const noResolvableGuessFollowUpQuestion = "Which of these best matches what you ate?"

// blankTranscriptFollowUp is returned when transcription yields no usable
// speech — the user recorded silence or noise.
const blankTranscriptFollowUp = "I couldn't make out any food from that — try again or type it."

// Meter records AI provider usage and enforces monthly cost budgets.
//
// This is declared locally rather than depending on the concrete
// billing.Meter type because package billing already imports package ai (for
// ai.Usage) — importing billing from here would be a compile-time import
// cycle. billing.Meter satisfies this interface structurally: its Record and
// WithinBudget methods have the exact signatures below (ai.Usage IS Usage
// from this package's perspective), so production code wires
// billing.NewMeter(db) straight into NewResolver without any adapter.
type Meter interface {
	Record(ctx context.Context, userID uuid.UUID, u Usage, costUSD float64) error
	WithinBudget(ctx context.Context, userID uuid.UUID) (bool, error)
}

// Resolver is the resolution engine: it turns a free-text phrase or a photo
// into a Resolution. All nutrition numbers in the result come from
// nutrition.FoodItem rows looked up via the foods repository — never from
// the AI provider, whose Guess/IngredientGuess types structurally carry no
// nutrition numbers at all.
type Resolver struct {
	provider Provider
	foods    nutrition.Repository
	cache    Cache
	meter    Meter
}

// NewResolver builds a Resolver over its collaborators.
func NewResolver(p Provider, foods nutrition.Repository, cache Cache, meter Meter) Resolver {
	return Resolver{provider: p, foods: foods, cache: cache, meter: meter}
}

// ResolveText resolves a free-text food phrase to a Resolution.
func (r Resolver) ResolveText(ctx context.Context, userID uuid.UUID, phrase string) (Resolution, error) {
	key := CacheKey("phrase", phrase)
	return r.resolve(ctx, userID, key,
		func(c context.Context) ([]Guess, Usage, error) { return r.provider.IdentifyText(c, phrase) },
		func(guesses []Guess) string { return phrase },
	)
}

// ResolvePhoto resolves a food photo to a Resolution. It shares the exact
// same identify → resolveGuesses → decompose flow as ResolveText, keyed by
// the image's content hash instead of a phrase.
func (r Resolver) ResolvePhoto(ctx context.Context, userID uuid.UUID, image []byte, mime string) (Resolution, error) {
	sum := sha256.Sum256(image)
	key := CacheKey("photo", hex.EncodeToString(sum[:]))
	return r.resolve(ctx, userID, key,
		func(c context.Context) ([]Guess, Usage, error) { return r.provider.IdentifyPhoto(c, image, mime) },
		func(guesses []Guess) string {
			if len(guesses) == 0 {
				return ""
			}
			return guesses[0].Food
		},
	)
}

// resolve implements the shared cache → budget → identify → resolveGuesses
// → decompose flow for both ResolveText and ResolvePhoto.
//
// decomposeSubject derives the dish name passed to Provider.Decompose from
// the identified guesses (ResolveText uses the original phrase directly;
// ResolvePhoto has no phrase, so it uses the top guess's Food). An empty
// result means there is nothing to decompose, so the follow-up Resolution
// from resolveGuesses is returned as-is.
func (r Resolver) resolve(
	ctx context.Context,
	userID uuid.UUID,
	key string,
	identify func(context.Context) ([]Guess, Usage, error),
	decomposeSubject func([]Guess) string,
) (Resolution, error) {
	if cached, ok := r.cache.Get(ctx, key); ok {
		return *cached, nil
	}

	ok, err := r.meter.WithinBudget(ctx, userID)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve: check budget: %w", err)
	}
	if !ok {
		return Resolution{
			Tier:             TierFollowUp,
			FollowUpQuestion: budgetFollowUpQuestion,
			Provenance:       "budget",
		}, nil
	}

	guesses, usage, err := identify(ctx)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve: identify: %w", err)
	}
	r.record(ctx, userID, usage)

	res, err := r.resolveGuesses(ctx, userID, guesses)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve: resolve guesses: %w", err)
	}

	if res.Tier == TierAuto || res.Tier == TierConfirm {
		r.cache.Set(ctx, key, res)
		return res, nil
	}

	subject := decomposeSubject(guesses)
	if subject == "" {
		return res, nil
	}

	estimate, resolved, err := r.decomposeAndEstimate(ctx, userID, subject)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve: decompose: %w", err)
	}
	if !resolved {
		return res, nil
	}

	r.cache.Set(ctx, key, estimate)
	return estimate, nil
}

// ResolveVoice transcribes an audio clip and resolves the transcript through
// the same pipeline as ResolveText. Transcription is metered separately; the
// transcript is just a search phrase, so the hard invariant and tiers are
// unchanged. Cached by audio content hash so identical clips don't re-transcribe.
func (r Resolver) ResolveVoice(ctx context.Context, userID uuid.UUID, audio []byte, mime string) (Resolution, error) {
	sum := sha256.Sum256(audio)
	key := CacheKey("voice", hex.EncodeToString(sum[:]))
	if cached, ok := r.cache.Get(ctx, key); ok {
		return *cached, nil
	}

	ok, err := r.meter.WithinBudget(ctx, userID)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve voice: check budget: %w", err)
	}
	if !ok {
		return Resolution{Tier: TierFollowUp, FollowUpQuestion: budgetFollowUpQuestion, Provenance: "budget"}, nil
	}

	transcript, usage, err := r.provider.Transcribe(ctx, audio, mime)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve voice: transcribe: %w", err)
	}
	r.record(ctx, userID, usage)

	transcript = strings.TrimSpace(transcript)
	if transcript == "" {
		return Resolution{Tier: TierFollowUp, FollowUpQuestion: blankTranscriptFollowUp, Provenance: "voice"}, nil
	}

	// Reuse the full text pipeline (identify → resolve → tiers → decompose).
	res, err := r.ResolveText(ctx, userID, transcript)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve voice: %w", err)
	}
	if res.Tier == TierAuto || res.Tier == TierConfirm {
		r.cache.Set(ctx, key, res)
	}
	return res, nil
}

// record meters one provider call. Metering failures must never break
// resolution — a user's food logging cannot depend on the billing table
// being reachable — so the error is deliberately ignored here.
func (r Resolver) record(ctx context.Context, userID uuid.UUID, u Usage) {
	_ = r.meter.Record(ctx, userID, u, EstimateCostUSD(u))
}

// tierRank orders tiers from least to most confident so the "best" guess
// among several can be picked by comparison.
func tierRank(t Tier) int {
	switch t {
	case TierAuto:
		return 3
	case TierConfirm:
		return 2
	default:
		return 1
	}
}

// resolveGuesses resolves each identified Guess against the nutrition index
// and builds ResolvedCandidates. THE INVARIANT GUARD: Guess carries no
// nutrition numbers (see types.go), so the only way a candidate's Kcal is
// computed is top.Item.KcalPer100g * grams / 100 — from the row, never from
// the guess.
func (r Resolver) resolveGuesses(ctx context.Context, userID uuid.UUID, guesses []Guess) (Resolution, error) {
	var candidates []ResolvedCandidate
	bestTier := TierFollowUp
	bestRank := -1
	provenance := ""

	for _, guess := range guesses {
		vec, embUsage, embErr := r.provider.Embed(ctx, guess.Food)
		if embErr != nil {
			// Embedding is an optional signal-booster (tier 3 in
			// nutrition.Resolve); a failure here must not fail the whole
			// resolve, it just means the embedding tier is skipped. A failed
			// embed also contributes no real usage, so it must not create a
			// noise metering row.
			vec = nil
		} else {
			r.record(ctx, userID, embUsage)
		}

		cands, err := r.foods.Resolve(ctx, userID, guess.Food, vec, resolveTopK)
		if err != nil {
			return Resolution{}, fmt.Errorf("ai: resolve guesses: %w", err)
		}
		if len(cands) == 0 {
			continue
		}

		top := cands[0]
		grams := parsePortionGrams(guess.PortionEstimate)
		// Kcal comes ONLY from the nutrition-index row's per-100g value —
		// never from the guess, which structurally cannot carry one.
		kcal := top.Item.KcalPer100g * grams / 100

		candidates = append(candidates, ResolvedCandidate{
			Item:         top.Item,
			PortionGrams: grams,
			Kcal:         kcal,
			MatchScore:   top.MatchScore,
			MatchTier:    top.MatchTier,
		})

		tier := TierFor(guess.Confidence, top.MatchScore)
		if rank := tierRank(tier); rank > bestRank {
			bestRank = rank
			bestTier = tier
			provenance = top.Item.Provenance
		}
	}

	res := Resolution{
		Candidates: candidates,
		Tier:       bestTier,
		Provenance: provenance,
	}
	if bestTier == TierFollowUp {
		res.FollowUpQuestion = noResolvableGuessFollowUpQuestion
	}
	return res, nil
}

// decomposeAndEstimate decomposes subject into ingredients, resolves each
// ingredient's top candidate, and sums kcal from those resolved rows (never
// from the LLM) into a ±estimateBand low/high range. The bool return reports
// whether at least one ingredient resolved; when false, the caller must keep
// its prior follow-up Resolution instead of presenting an empty estimate.
func (r Resolver) decomposeAndEstimate(ctx context.Context, userID uuid.UUID, subject string) (Resolution, bool, error) {
	ingredients, usage, err := r.provider.Decompose(ctx, subject)
	if err != nil {
		return Resolution{}, false, fmt.Errorf("ai: decompose: %w", err)
	}
	r.record(ctx, userID, usage)

	var candidates []ResolvedCandidate
	var totalKcal float64

	for _, ing := range ingredients {
		vec, embUsage, embErr := r.provider.Embed(ctx, ing.Ingredient)
		if embErr != nil {
			// A failed embed contributes no real usage and must not create a
			// noise metering row; the embedding tier is simply skipped.
			vec = nil
		} else {
			r.record(ctx, userID, embUsage)
		}

		cands, err := r.foods.Resolve(ctx, userID, ing.Ingredient, vec, resolveTopK)
		if err != nil {
			return Resolution{}, false, fmt.Errorf("ai: decompose: resolve ingredient: %w", err)
		}
		if len(cands) == 0 {
			continue
		}

		top := cands[0]
		grams := parsePortionGrams(ing.PortionEstimate)
		// Kcal comes ONLY from the row — same invariant as resolveGuesses.
		kcal := top.Item.KcalPer100g * grams / 100
		totalKcal += kcal

		candidates = append(candidates, ResolvedCandidate{
			Item:         top.Item,
			PortionGrams: grams,
			Kcal:         kcal,
			MatchScore:   top.MatchScore,
			MatchTier:    top.MatchTier,
		})
	}

	if len(candidates) == 0 {
		return Resolution{}, false, nil
	}

	return Resolution{
		Candidates: candidates,
		Tier:       TierConfirm,
		IsEstimate: true,
		KcalLow:    totalKcal * (1 - estimateBand),
		KcalHigh:   totalKcal * (1 + estimateBand),
		Provenance: "estimate",
	}, true, nil
}
