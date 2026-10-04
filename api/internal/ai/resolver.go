package ai

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"

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

	// defaultAliasPortionGrams is the last rung of the alias short-circuit's
	// portion fallback chain (last logged portion -> serving_grams -> this),
	// matching the 100g convention the barcode resolve path already uses.
	defaultAliasPortionGrams = 100
)

// budgetFollowUpQuestion is returned when a user has exhausted an AI quota
// window — resolution degrades gracefully to manual logging rather than
// failing the request.
const budgetFollowUpQuestion = "You've reached your AI usage limit — search and log manually."

// noResolvableGuessFollowUpQuestion is used when at least one guess was
// identified but none of them resolved to a confident nutrition-index match.
const noResolvableGuessFollowUpQuestion = "Which of these best matches what you ate?"

// minReturnableMatchScore is the floor below which the engine says it does not
// know, instead of returning its nearest row.
//
// Chosen from MEASURED production resolutions, not intuition — the same
// standard internal/nutrition/score.go holds its weights to. Observed on
// 2026-08-15/16, with the outcome judged against what the user actually ate:
//
//	0.349  "McSpicy Chicken Burger" -> McDONALD'S Bacon Ranch Salad    WRONG
//	0.399  "McSpicy Chicken Patty"  -> Chicken patty, frozen, cooked   WRONG
//	0.424  "McDonald's meal"        -> McDONALD'S, Hamburger           vague query
//	0.4425 "croissant"              -> Croissants, cheese              RIGHT (117 vs ~114 kcal)
//	0.522  "McChicken sandwich"     -> McDONALD'S, McCHICKEN Sandwich  RIGHT
//	0.566  "pear"                   -> Pears, raw                      RIGHT
//
// Every correct match observed scored >= 0.4425; every clearly wrong one
// <= 0.399. 0.40 sits in that gap, and the gap — not the precise value — is
// what this rests on. It is one figure read off real outcomes, NOT seven
// parameters fitted to a golden set, which score.go rightly calls "overfitting
// dressed as rigour".
//
// WHY A FLOOR IS NEEDED AT ALL: 98% of the index was USDA until the AFCD and
// OpenFoodFacts imports (kora#184), so for an Australian user the right row
// frequently did not exist. A resolver that always returns its nearest row then
// fabricates — three wrong branded foods, 870 kcal, one tap from the diary. The
// index is better now, but no index covers everything, and "I don't know" has
// to be reachable.
const minReturnableMatchScore = 0.40

// blankTranscriptFollowUp is returned when transcription yields no usable
// speech — the user recorded silence or noise.
const blankTranscriptFollowUp = "I couldn't make out any food from that — try again or type it."

// Meter records AI provider usage and reserves user quota before provider work.
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

// PortionSource is the subset of foodlog.Repository the personal-alias
// short-circuit needs: the grams from the caller's most recent log of a
// given phrase. It is declared locally (rather than depending on
// foodlog.Repository directly) because package foodlog already imports
// package ai (for ai.CacheKey, used by its resolution-cache invalidation) —
// importing foodlog from here would be a compile-time import cycle.
// foodlog.Repository satisfies this interface structurally at the
// construction site where Resolver is actually built (see cmd/api/main.go).
type PortionSource interface {
	LastPortionForPhrase(ctx context.Context, userID uuid.UUID, phrase string) (float64, bool, error)
}

// Resolver is the resolution engine: it turns a free-text phrase or a photo
// into a Resolution. All nutrition numbers in the result come from
// nutrition.FoodItem rows looked up via the foods repository — never from
// the AI provider, whose Guess/IngredientGuess types structurally carry no
// nutrition numbers at all.
type Resolver struct {
	provider      Provider
	foods         nutrition.Repository
	cache         Cache
	meter         Meter
	portionSource PortionSource
	locales       LocaleSource
	outcomes      OutcomeSink
}

// LocaleSource reports the food locale to prefer for a user (kora#212 Phase 4).
//
// Narrow on purpose: the Resolver needs one string per resolve and must not
// gain a dependency on the whole user package to get it. cmd/api adapts the
// user repository to this shape.
//
// Implementations must NOT fail a resolve. A user that cannot be loaded, or
// whose timezone is unrecognised, yields nutrition.LocaleUnknown — no
// preference — because a locale nudge is worth strictly less than an answer.
type LocaleSource interface {
	LocaleFor(ctx context.Context, userID uuid.UUID) nutrition.Locale
}

// NewResolver builds a Resolver over its collaborators.
func NewResolver(p Provider, foods nutrition.Repository, cache Cache, meter Meter) Resolver {
	return Resolver{provider: p, foods: foods, cache: cache, meter: meter}
}

// WithPortionSource attaches an optional source of the caller's last logged
// portion for a phrase, following the same functional-option pattern as
// foodlog.Service.WithResolutionCache — added instead of a NewResolver
// parameter so every existing construction site (production and test) keeps
// working unchanged. A nil PortionSource (the default) is safe: the
// personal-alias short-circuit simply falls back to the food's
// ServingGrams, then defaultAliasPortionGrams — it never panics.
func (r Resolver) WithPortionSource(ps PortionSource) Resolver {
	r.portionSource = ps
	return r
}

// WithLocales attaches an optional source of the user's food locale, following
// the same functional-option pattern as WithPortionSource and
// foodlog.Service.WithResolutionCache — chosen over a NewResolver parameter so
// every existing construction site, production and test, keeps working
// unchanged.
//
// A nil LocaleSource (the default) means every query resolves with
// nutrition.LocaleUnknown, which applies no locale preference at all. That is
// exactly the pre-Phase-4 behaviour, so leaving it unset is a safe no-op rather
// than a silent downgrade.
// WithOutcomeSink attaches the recorder for resolve outcomes (kora#459).
//
// An optional builder, like WithPortionSource and WithLocales, rather than a
// NewResolver argument: a nil sink records nothing and every existing call
// site keeps compiling. Measurement is the one collaborator this resolver must
// be able to run entirely without.
func (r Resolver) WithOutcomeSink(s OutcomeSink) Resolver {
	r.outcomes = s
	return r
}

func (r Resolver) WithLocales(ls LocaleSource) Resolver {
	r.locales = ls
	return r
}

// localeFor returns the caller's food locale, or unknown when no LocaleSource
// is attached.
func (r Resolver) localeFor(ctx context.Context, userID uuid.UUID) nutrition.Locale {
	if r.locales == nil {
		return nutrition.LocaleUnknown
	}
	return r.locales.LocaleFor(ctx, userID)
}

// ResolveText resolves a free-text food phrase to a Resolution. Before
// touching the LLM at all, it checks whether the caller has personally
// corrected this exact raw phrase (see nutrition.Repository.AddAlias /
// LookupPersonalAlias) — the fix for the bug where a correction was keyed on
// the user's raw wording but only ever looked up under the model's own
// guess string, so it silently never applied on this path. A hit returns
// instantly with no provider call and no metering, since no AI work
// happened; a miss, or any lookup error, falls through to the existing
// cache -> budget -> identify -> resolve pipeline unchanged.
func (r Resolver) ResolveText(ctx context.Context, userID uuid.UUID, phrase string) (Resolution, error) {
	return r.resolveTextAs(ctx, userID, phrase, modeText)
}

// resolveTextAs is ResolveText with the MODE threaded through, so a voice
// resolve is recorded as voice rather than as the text resolve it delegates
// to. Without it every transcript would be filed under `text` and the voice
// path would be invisible in its own outcome table (kora#459).
func (r Resolver) resolveTextAs(ctx context.Context, userID uuid.UUID, phrase, mode string) (Resolution, error) {
	if res, ok := r.aliasShortCircuit(ctx, userID, phrase); ok {
		r.recordOutcome(ctx, outcomeFor(userID, outcomeAlias, mode, phrasePtr(phrase), res))
		return res, nil
	}

	key := CacheKey("phrase", userID, phrase)
	return r.resolve(ctx, userID, key, phrase, mode,
		func(c context.Context) ([]Guess, Usage, error) { return r.provider.IdentifyText(c, phrase) },
		func(guesses []Guess) string { return phrase },
	)
}

// aliasShortCircuit checks whether userID has personally corrected phrase to
// a specific food item. On a hit (ok=true) it returns a complete, one-
// candidate Resolution built directly from that food row: Tier is always
// TierAuto (a personal correction is the most confident signal there is) and
// the candidate's Kcal is computed ONLY from the row — top.KcalPer100g *
// grams / 100 — never fabricated. ok=false means "no short-circuit, the
// caller should fall through to the normal LLM pipeline" — covering both a
// genuine miss and a lookup error, since a lookup failure must never break
// resolution.
func (r Resolver) aliasShortCircuit(ctx context.Context, userID uuid.UUID, phrase string) (Resolution, bool) {
	item, found, err := r.foods.LookupPersonalAlias(ctx, userID, phrase)
	if err != nil {
		slog.WarnContext(ctx, "ai: personal alias lookup failed, falling through to LLM path",
			"error", err, "user_id", userID)
		return Resolution{}, false
	}
	if !found {
		return Resolution{}, false
	}

	grams, assumed := r.resolveAliasPortion(ctx, userID, phrase, item)
	return Resolution{
		Candidates: []ResolvedCandidate{{
			Item:         item,
			PortionGrams: grams,
			Kcal:         item.KcalPer100g * grams / 100,
			MatchScore:   1.0,
			// Reported as MatchPersonalAlias for the same reason
			// nutrition.Resolve's personal branch is: this IS the user's own
			// alias, and stamping it "alias" would make the same event report
			// two different tiers depending only on whether the raw phrase or
			// the model's wording happened to hit it.
			MatchTier:      nutrition.MatchPersonalAlias,
			Tier:           TierAuto,
			PortionAssumed: assumed,
		}},
		Tier:       TierAuto,
		Provenance: item.Provenance,
	}, true
}

// resolveAliasPortion picks the portion (grams) for an alias short-circuit
// hit: the user's last logged portion for this exact phrase, falling back to
// the food's own serving size, falling back to defaultAliasPortionGrams. A
// nil portionSource (no PortionSource wired) or a lookup error is treated the
// same as "no prior log" — logged and folded into the same fallback chain —
// since an alias hit still deserves an answer even without portion history.
//
// The second return value, assumed, is true ONLY on the final rung
// (defaultAliasPortionGrams) — a real prior log or the food's own
// ServingGrams are both actual data, not assumptions. Callers must pass this
// straight through to ResolvedCandidate.PortionAssumed rather than
// re-deriving the condition themselves.
//
// The serving rung is gated on plausibleServingGrams, not on ServingGrams > 0
// (kora#144). It is the same rung as portionGramsFor's step 4 and has to obey
// the same rule: a stored serving is only evidence of a portion when it is one
// a person plausibly eats in a sitting. USDA rows carry whole-animal reference
// masses — "Turkey, whole, meat and skin, raw" is 5717 g — and a bare > 0 test
// admits them, so an alias hit with no logged portion could log ten thousand
// calories AND report PortionAssumed: false, i.e. as a measured figure the
// card would not even hedge. That an alias implies user history mitigates the
// odds but not the outcome: the rung fires precisely when the phrase has NO
// prior portion, and nothing bounds what row an alias points at. Falling to
// the flat 100 g default instead is wrong by a factor the user can see and
// correct, and it says so (assumed = true).
//
// Deliberately not applied to resolve's barcode sibling: that path only ever
// sees packaged OFF products, where serving_quantity is a real package serving
// and the reference-mass class does not arise.
func (r Resolver) resolveAliasPortion(ctx context.Context, userID uuid.UUID, phrase string, item nutrition.FoodItem) (grams float64, assumed bool) {
	if r.portionSource != nil {
		grams, found, err := r.portionSource.LastPortionForPhrase(ctx, userID, phrase)
		if err != nil {
			slog.WarnContext(ctx, "ai: last portion lookup failed, falling back to serving size",
				"error", err, "user_id", userID)
		} else if found {
			return grams, false
		}
	}
	if plausibleServingGrams(item.ServingGrams) {
		return item.ServingGrams, false
	}
	return defaultAliasPortionGrams, true
}

// ResolvePhoto resolves a food photo to a Resolution. It shares the exact
// same identify → resolveGuesses → decompose flow as ResolveText, keyed by
// the image's content hash instead of a phrase.
func (r Resolver) ResolvePhoto(ctx context.Context, userID uuid.UUID, image []byte, mime string) (Resolution, error) {
	sum := sha256.Sum256(image)
	key := CacheKey("photo", userID, hex.EncodeToString(sum[:]))
	// The empty phrase is load-bearing, not a placeholder: a photo says nothing
	// that identify could have discarded, so phraseCoverage returns 1 and the
	// reduction factor is exactly 1.0 — this path behaves as it always has.
	return r.resolve(ctx, userID, key, "", modePhoto,
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
// phrase is the user's original utterance, threaded through to resolveGuesses
// so confidence can be damped by how much of it the guesses actually account
// for. ResolvePhoto passes "" (no phrase exists), which makes that damping a
// no-op there.
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
	phrase string,
	mode string,
	identify func(context.Context) ([]Guess, Usage, error),
	decomposeSubject func([]Guess) string,
) (Resolution, error) {
	if cached, ok := r.cache.Get(ctx, key); ok {
		r.recordOutcome(ctx, outcomeFor(userID, outcomeCache, mode, phrasePtr(phrase), *cached))
		return *cached, nil
	}

	ok, err := r.meter.WithinBudget(ctx, userID)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve: check budget: %w", err)
	}
	if !ok {
		res := Resolution{
			Tier:             TierFollowUp,
			FollowUpQuestion: budgetFollowUpQuestion,
			Provenance:       "budget",
		}
		r.recordOutcome(ctx, outcomeFor(userID, outcomeBudget, mode, phrasePtr(phrase), res))
		return res, nil
	}

	// A provider call is billed upstream whether or not it produces a usable
	// answer, so it is metered on BOTH paths. Recording only successes made
	// COGS a one-directional undercount and left failing AI paths with no
	// trace at all — so a never-working path and a never-attempted path could
	// not be told apart (#81).
	sinkCtx, sink := withUsageSink(ctx)
	modelCtx, modelSpan := startSpan(sinkCtx, "resolve.model")
	guesses, usage, err := identify(modelCtx)
	modelSpan.SetAttributes(attribute.Int("kora.resolve.guesses", len(guesses)))
	if err != nil {
		modelSpan.SetStatus(codes.Error, "identify failed")
	}
	modelSpan.End()
	if err != nil {
		usage.Outcome = OutcomeError
		r.recordAll(ctx, userID, sink.drain(), usage)
		r.recordOutcome(ctx, outcomeFor(userID, outcomeError, mode, phrasePtr(phrase), Resolution{}))
		return Resolution{}, fmt.Errorf("ai: resolve: identify: %w", err)
	}
	r.recordAll(ctx, userID, sink.drain(), usage)

	matchCtx, matchSpan := startSpan(ctx, "resolve.index_match")
	res, err := r.resolveGuesses(matchCtx, userID, phrase, guesses)
	matchSpan.SetAttributes(attribute.Int("kora.resolve.candidates", len(res.Candidates)))
	if err != nil {
		matchSpan.SetStatus(codes.Error, "index match failed")
	}
	matchSpan.End()
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve: resolve guesses: %w", err)
	}

	if res.Tier == TierAuto || res.Tier == TierConfirm {
		r.cache.Set(ctx, key, res)
		r.recordOutcome(ctx, outcomeFor(userID, outcomeResolved, mode, phrasePtr(phrase), res))
		return res, nil
	}

	// A weak match beats a decomposition, always (#180).
	//
	// decomposeAndEstimate sums ingredient rows at portionGramsFor's flat 100 g
	// default with NOTHING scaling them to the finished dish, so it can only
	// ever produce a number LARGER than the food — usually by an order of
	// magnitude. Replacing a real index row with that is strictly worse than
	// showing the row and letting the user correct it.
	//
	// Measured: a photographed mini croissant (identified "croissant" at 0.99)
	// matched `Croissants, cheese` at 0.4425 — 117 kcal against a ~114 kcal
	// truth — and was discarded for a 2248-3041 kcal decomposition. The answer
	// was already in hand.
	//
	// Decomposition is kept for the case it was designed for, below: a
	// composite dish with NO index row at all.
	// ...but only when the match is strong enough to be worth correcting rather
	// than worth disowning. Below minReturnableMatchScore the honest answer is
	// "I couldn't identify that", which the client already renders — its
	// follow-up branch offers Search manually, and FoodPicker is a better
	// outcome than a confidently-wrong branded row the user must notice and
	// undo. kora#184.
	if returnableWeakMatch(res) {
		// Blanked for the same reason decomposeAndEstimate leaves it blank: the
		// client renders its dedicated follow-up branch only when tier is
		// follow_up AND this is non-empty, and that branch DISCARDS the
		// candidate list and dead-ends at "Search manually". Blank keeps the
		// normal detected-card path, where each item carries its own tier and
		// an uncertain row is tappable — which is exactly the correction
		// affordance a low-confidence match wants.
		//
		// Deliberately NOT cached: a weak answer should not be pinned for the
		// cache's 24h, unlike the auto/confirm path above.
		res.FollowUpQuestion = ""
		slog.InfoContext(ctx, "ai: returning low-confidence match rather than decomposing",
			"guesses", summariseGuesses(guesses),
			"tier", string(res.Tier),
			"top", topCandidateName(res),
			"score", topCandidateScore(res),
		)
		r.recordOutcome(ctx, outcomeFor(userID, outcomeWeakMatch, mode, phrasePtr(phrase), res))
		return res, nil
	}

	if len(res.Candidates) > 0 {
		// Reached only when every candidate is below the floor. The follow-up
		// question is deliberately LEFT set (resolveGuesses set it when the best
		// tier was follow_up), which is what makes the client take its
		// "couldn't identify that / search manually" branch instead of the card.
		//
		// Logged at the same key as the return-anyway case above so the two
		// stay comparable: this line is the evidence minReturnableMatchScore
		// gets recalibrated from, and a floor that can never be re-measured is
		// a magic number waiting to rot.
		slog.InfoContext(ctx, "ai: abstaining — best match below the floor",
			"guesses", summariseGuesses(guesses),
			"tier", string(res.Tier),
			"top", topCandidateName(res),
			"score", topCandidateScore(res),
			"floor", minReturnableMatchScore,
		)
		r.recordOutcome(ctx, outcomeFor(userID, outcomeBelowFloor, mode, phrasePtr(phrase), res))
		return res, nil
	}

	subject := decomposeSubject(guesses)
	if subject == "" {
		// No candidate AND nothing to decompose: the engine simply has no answer.
		//
		// Logged because it is otherwise INDISTINGUISHABLE in production from
		// the abstain-by-floor case above, and the two demand opposite
		// responses: a floor that is too high is fixed by lowering it, an index
		// gap only by adding data. On 2026-08-16 a device test of "McSpicy"
		// correctly showed "couldn't identify that", and nothing in the logs
		// could say which of the two had produced it.
		slog.InfoContext(ctx, "ai: no match and nothing to decompose",
			"guesses", summariseGuesses(guesses),
			"candidates", len(res.Candidates),
		)
		r.recordOutcome(ctx, outcomeFor(userID, outcomeNoMatch, mode, phrasePtr(phrase), res))
		return res, nil
	}

	// Reaching here now means NOTHING resolved — the case decomposition exists
	// for. Still logged, because the estimate it produces is unscaled (see
	// above) and any implausible total a user reports passes through this line.
	// Food names are user content; they are the whole diagnostic value here.
	slog.WarnContext(ctx, "ai: nothing resolved; decomposing into ingredients",
		"subject", subject,
		"guesses", summariseGuesses(guesses),
	)

	estimate, resolved, err := r.decomposeAndEstimate(ctx, userID, subject)
	if err != nil {
		r.recordOutcome(ctx, outcomeFor(userID, outcomeError, mode, phrasePtr(phrase), res))
		return Resolution{}, fmt.Errorf("ai: resolve: decompose: %w", err)
	}
	if !resolved {
		// Decomposition ran and produced nothing usable, so the attempt ends
		// where the no-candidate branch above ends: an index gap.
		r.recordOutcome(ctx, outcomeFor(userID, outcomeNoMatch, mode, phrasePtr(phrase), res))
		return res, nil
	}

	r.cache.Set(ctx, key, estimate)
	r.recordOutcome(ctx, outcomeFor(userID, outcomeDecomposed, mode, phrasePtr(phrase), estimate))
	return estimate, nil
}

// ResolveVoice transcribes an audio clip and resolves the transcript through
// the same pipeline as ResolveText. Transcription is metered separately; the
// transcript is just a search phrase, so the hard invariant and tiers are
// unchanged. Cached by audio content hash so identical clips don't re-transcribe.
func (r Resolver) ResolveVoice(ctx context.Context, userID uuid.UUID, audio []byte, mime string) (Resolution, error) {
	sum := sha256.Sum256(audio)
	key := CacheKey("voice", userID, hex.EncodeToString(sum[:]))
	if cached, ok := r.cache.Get(ctx, key); ok {
		// No phrase: this hit is keyed on the AUDIO hash, so the transcript
		// was never produced on this request and inventing one from the
		// cached resolution would attribute words to the user they did not
		// say on this attempt.
		r.recordOutcome(ctx, outcomeFor(userID, outcomeCache, modeVoice, nil, *cached))
		return *cached, nil
	}

	ok, err := r.meter.WithinBudget(ctx, userID)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve voice: check budget: %w", err)
	}
	if !ok {
		res := Resolution{Tier: TierFollowUp, FollowUpQuestion: budgetFollowUpQuestion, Provenance: "budget"}
		// Voice has its OWN budget gate, ahead of the text pipeline's. Without
		// a recorder here a voice attempt refused for budget would leave no
		// row at all, and the voice denominator would silently exclude exactly
		// the users who hit their cap.
		r.recordOutcome(ctx, outcomeFor(userID, outcomeBudget, modeVoice, nil, res))
		return res, nil
	}

	// Same both-paths metering as `resolve` above — see #81. Transcribe has no
	// fallback (router.go), so the sink is normally empty here, but it is
	// drained anyway rather than assuming that stays true.
	sinkCtx, sink := withUsageSink(ctx)
	transcript, usage, err := r.provider.Transcribe(sinkCtx, audio, mime)
	if err != nil {
		usage.Outcome = OutcomeError
		r.recordAll(ctx, userID, sink.drain(), usage)
		r.recordOutcome(ctx, outcomeFor(userID, outcomeError, modeVoice, nil, Resolution{}))
		return Resolution{}, fmt.Errorf("ai: resolve voice: transcribe: %w", err)
	}
	r.recordAll(ctx, userID, sink.drain(), usage)

	transcript = strings.TrimSpace(transcript)
	if transcript == "" {
		res := Resolution{Tier: TierFollowUp, FollowUpQuestion: blankTranscriptFollowUp, Provenance: "voice"}
		// A CAPTURE failure, not an index one: the microphone picked up
		// nothing usable. Recorded with its own kind rather than folded into
		// `error` (a provider fault) or `no_match` (an index gap), because it
		// is neither and both of those drive different fixes. Counted, so the
		// voice denominator stays honest.
		r.recordOutcome(ctx, outcomeFor(userID, outcomeTranscriptBlank, modeVoice, nil, res))
		return res, nil
	}

	// Reuse the full text pipeline (identify → resolve → tiers → decompose),
	// recorded as VOICE — see resolveTextAs.
	res, err := r.resolveTextAs(ctx, userID, transcript, modeVoice)
	if err != nil {
		return Resolution{}, fmt.Errorf("ai: resolve voice: %w", err)
	}
	// Carry the transcript on the returned Resolution so a mobile client has
	// a server-derived phrase for FoodLog.InputPhrase on an ai_voice log. Set
	// AFTER the blank-transcript guard above, so that follow-up Resolution
	// stays exactly as it was (no transcript to carry for silence/noise).
	res.Transcript = transcript
	if res.Tier == TierAuto || res.Tier == TierConfirm {
		r.cache.Set(ctx, key, res)
	}
	return res, nil
}

// record meters one provider call. Metering failures must never break
// resolution — a user's food logging cannot depend on the billing table
// being reachable — so the error is deliberately ignored here.
func (r Resolver) record(ctx context.Context, userID uuid.UUID, u Usage) {
	if u.Outcome == "" {
		u.Outcome = OutcomeOK
	}
	_ = r.meter.Record(ctx, userID, u, EstimateCostUSD(u))
}

// recordAll meters every provider call a resolve actually made: the legs the
// router abandoned (drained from the request's usage sink) plus the one whose
// result was returned. A leg with no Provider is one that never ran — a stub
// or an empty zero value — and is skipped so the meter is not padded with
// phantom calls.
func (r Resolver) recordAll(ctx context.Context, userID uuid.UUID, abandoned []Usage, returned Usage) {
	for _, u := range abandoned {
		if u.Provider == "" {
			continue
		}
		r.record(ctx, userID, u)
	}
	if returned.Provider == "" {
		return
	}
	r.record(ctx, userID, returned)
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
//
// phrase is the user's ORIGINAL utterance (empty on the photo path, which has
// none). It never reaches the index — every lookup below still searches on
// guess.Food — it only measures how much of what the user said the guesses
// collectively kept, and damps the tier accordingly. Without it the pipeline is
// most confident exactly when identify discarded the most: "El Janah 1/2
// chicken with Chips" became the bare guess "chicken", which matched an
// OpenFoodFacts row literally named `Chicken` at a perfect 1.0 and auto-logged
// 280 kcal/100g without asking (kora#184).
func (r Resolver) resolveGuesses(ctx context.Context, userID uuid.UUID, phrase string, guesses []Guess) (Resolution, error) {
	var candidates []ResolvedCandidate
	bestTier := TierFollowUp
	bestRank := -1
	provenance := ""

	// Resolved ONCE for the whole resolution, not per guess: the locale is a
	// property of the user, and a multi-item meal would otherwise repeat the
	// same lookup for every food in it.
	locale := r.localeFor(ctx, userID)

	// One factor for the whole resolution: coverage is a property of the
	// phrase and the guess set together, not of any single candidate.
	coverage := phraseCoverage(phrase, guesses)
	factor := reductionFactor(coverage)

	// What the tiers WOULD have been without the damping, tracked so the log
	// below can report the change rather than just the outcome.
	undampedBest := TierFollowUp
	undampedRank := -1
	damped := 0

	for _, guess := range guesses {
		vec, embErr := r.embedForResolution(ctx, userID, guess.Food)
		if embErr != nil {
			// Embedding is an optional signal-booster (tier 3 in
			// nutrition.Resolve); a failure here must not fail the whole
			// resolve, it just means the embedding tier is skipped. The helper
			// still records any usage the provider reported for the failed call.
			vec = nil
		}

		// Pass the STRUCTURED guess, not just guess.Food. This is the point of
		// kora#212 Phase 3: the brand the user named reaches the index instead
		// of being dropped on the floor here, which is what made "El Janah 1/2
		// chicken with Chips" arrive as the bare word "chicken".
		cands, err := r.foods.ResolveQuery(ctx, userID, nutrition.Query{
			Text:          guess.Food,
			Brand:         guess.Brand,
			Qualifiers:    guess.Qualifiers,
			CookingMethod: guess.CookingMethod,
			Locale:        locale,
		}, vec, resolveTopK)
		if err != nil {
			return Resolution{}, fmt.Errorf("ai: resolve guesses: %w", err)
		}
		if len(cands) == 0 {
			continue
		}

		top := cands[0]
		grams, assumed := portionGramsFor(guess.PortionEstimate, top.Item)
		// Kcal comes ONLY from the nutrition-index row's per-100g value —
		// never from the guess, which structurally cannot carry one.
		kcal := top.Item.KcalPer100g * grams / 100

		// Per-candidate, not per-resolution: one guess in a meal may land on the
		// user's own alias while another does not, and only the former has
		// earned the exemption.
		tier := tierWithReduction(guess.Confidence, top.MatchScore, factorForTier(top.MatchTier, factor))

		undamped := tierWithReduction(guess.Confidence, top.MatchScore, 1)
		if undamped != tier {
			damped++
		}
		if rank := tierRank(undamped); rank > undampedRank {
			undampedRank = rank
			undampedBest = undamped
		}

		candidates = append(candidates, ResolvedCandidate{
			Item:           top.Item,
			PortionGrams:   grams,
			Kcal:           kcal,
			MatchScore:     top.MatchScore,
			MatchTier:      top.MatchTier,
			Tier:           tier,
			PortionAssumed: assumed,
		})

		if rank := tierRank(tier); rank > bestRank {
			bestRank = rank
			bestTier = tier
			provenance = top.Item.Provenance
		}
	}

	// phraseCoverageFloor is argued from principle and checked against two
	// production cases; minReturnableMatchScore (above) was DERIVED from
	// measured outcomes, and this line is what lets the floor be held to that
	// same standard later. Each record pairs the coverage that was measured
	// with the tier change it caused, so a sweep of production logs can answer
	// "at what coverage did damping start costing correct answers?".
	//
	// Emitted ONLY when the damping actually moved a tier, which is both the
	// interesting event and self-limiting: at most one line per resolve, and
	// none at all on the photo path or on a fully-accounted-for phrase.
	//
	// PRIVACY: the user's utterance is NOT logged, and must not be. What goes
	// out is the coverage ratio, its denominator as a COUNT (phrase_tokens),
	// and the model's own guesses — the same summariseGuesses already emitted
	// by the sibling log lines in resolve(). The phrase itself is the one field
	// that could carry anything a user typed, and it is precisely the field the
	// coverage figure already summarises.
	if damped > 0 {
		slog.InfoContext(ctx, "ai: phrase coverage damped the tier",
			"coverage", coverage,
			"factor", factor,
			"phrase_tokens", nutrition.PhraseTokenCount(phrase),
			"floor", phraseCoverageFloor,
			"tier_before", string(undampedBest),
			"tier_after", string(bestTier),
			"damped_candidates", damped,
			"candidates", len(candidates),
			"guesses", summariseGuesses(guesses),
		)
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

// returnableWeakMatch reports whether a below-confirm resolution is still worth
// showing as itself, rather than abstaining.
//
// A separate function purely so the boundary is testable without driving real
// scoring: the interesting cases are "just under" and "exactly on" the floor,
// and reproducing those through full-text ranking would be a test of the
// ranker, not of this decision.
func returnableWeakMatch(res Resolution) bool {
	return len(res.Candidates) > 0 && topCandidateScore(res) >= minReturnableMatchScore
}

// estimateIngredientTier computes a decomposed ingredient's own tier from its
// nutrition-index match score alone — IngredientGuess carries no LLM
// identify-confidence to combine it with the way Guess.Confidence does in
// resolveGuesses, so TierFor is fed the same score twice and only the floor
// comparisons apply — then caps the result at TierConfirm. The cap exists
// because a decomposed ingredient (e.g. "olive oil" or "butter", invented by
// Provider.Decompose for a dish like "grilled chicken breast") is an LLM
// INFERENCE, not a food the user actually named: even a perfect string match
// to the index should not become a one-tap TierAuto log. A weak match,
// though, must still be free to fall all the way to TierFollowUp so the
// per-item uncertain-row UI can surface it — that's the entire point of this
// tiering.
func estimateIngredientTier(matchScore float64) Tier {
	tier := TierFor(matchScore, matchScore)
	if tier == TierAuto {
		return TierConfirm
	}
	return tier
}

// Diagnostics for the decomposition fallback log (#180). Kept as plain
// functions returning already-formatted values so the log call site stays one
// statement, and so a nil/empty Resolution can never panic the request it is
// only trying to explain.

// summariseGuesses renders what the model actually said, which is the single
// most useful field when an answer is wrong: it separates "identify was wrong"
// from "identify was right and the index match failed".
func summariseGuesses(guesses []Guess) string {
	if len(guesses) == 0 {
		return ""
	}
	parts := make([]string, 0, len(guesses))
	for _, g := range guesses {
		// PortionEstimate is included because omitting it caused a wrong
		// diagnosis (#184): a phrase logged as `chicken@0.95; chips@0.95`
		// looked like the model had discarded the user's stated "1/2", when a
		// live call showed it had returned "1/2 chicken" all along. The loss
		// was downstream, in portion mapping. A field absent from a log is not
		// a field absent from the data.
		parts = append(parts, fmt.Sprintf("%s@%.2f[%s]", g.Food, g.Confidence, g.PortionEstimate))
	}
	return strings.Join(parts, "; ")
}

// topCandidateName is the index row that came closest and was still rejected.
// Empty when nothing resolved at all — a meaningfully different failure.
func topCandidateName(res Resolution) string {
	if len(res.Candidates) == 0 {
		return ""
	}
	return res.Candidates[0].Item.Name
}

// topCandidateScore pairs with the name above: the score that failed to clear
// the tier threshold. Without it there is no way to tell a near miss (tune the
// threshold) from a genuine non-match (fix the matching).
func topCandidateScore(res Resolution) float64 {
	if len(res.Candidates) == 0 {
		return 0
	}
	return res.Candidates[0].MatchScore
}

// decomposeAndEstimate decomposes subject into ingredients, resolves each
// ingredient's top candidate, and sums kcal from those resolved rows (never
// from the LLM) into a ±estimateBand low/high range. The bool return reports
// whether at least one ingredient resolved; when false, the caller must keep
// its prior follow-up Resolution instead of presenting an empty estimate.
func (r Resolver) decomposeAndEstimate(ctx context.Context, userID uuid.UUID, subject string) (Resolution, bool, error) {
	providerCtx, collector := WithUsageCollector(ctx)
	ingredients, usage, err := r.provider.Decompose(providerCtx, subject)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			usage.Outcome = OutcomeTimeout
		} else {
			usage.Outcome = OutcomeError
		}
		r.recordAll(ctx, userID, collector.Drain(), usage)
		return Resolution{}, false, fmt.Errorf("ai: decompose: %w", err)
	}
	r.recordAll(ctx, userID, collector.Drain(), usage)

	var candidates []ResolvedCandidate
	var totalKcal float64
	bestTier := TierFollowUp
	bestRank := -1

	for _, ing := range ingredients {
		vec, embErr := r.embedForResolution(ctx, userID, ing.Ingredient)
		if embErr != nil {
			// Embedding remains an optional ranking signal. Failure falls back
			// to text matching after any reported provider usage is recorded.
			vec = nil
		}

		cands, err := r.foods.Resolve(ctx, userID, ing.Ingredient, vec, resolveTopK)
		if err != nil {
			return Resolution{}, false, fmt.Errorf("ai: decompose: resolve ingredient: %w", err)
		}
		if len(cands) == 0 {
			continue
		}

		top := cands[0]
		grams, assumed := portionGramsFor(ing.PortionEstimate, top.Item)
		// Kcal comes ONLY from the row — same invariant as resolveGuesses.
		kcal := top.Item.KcalPer100g * grams / 100
		totalKcal += kcal

		tier := estimateIngredientTier(top.MatchScore)

		candidates = append(candidates, ResolvedCandidate{
			Item:           top.Item,
			PortionGrams:   grams,
			Kcal:           kcal,
			MatchScore:     top.MatchScore,
			MatchTier:      top.MatchTier,
			Tier:           tier,
			PortionAssumed: assumed,
		})

		if rank := tierRank(tier); rank > bestRank {
			bestRank = rank
			bestTier = tier
		}
	}

	if len(candidates) == 0 {
		return Resolution{}, false, nil
	}

	// FollowUpQuestion is deliberately left empty even when bestTier is
	// TierFollowUp. apps/mobile/app/capture.tsx only renders its dedicated
	// follow-up branch when tier == follow_up AND follow_up_question is
	// non-empty, and that branch discards the candidate list and dead-ends at
	// "Search manually" — leaving this blank instead makes the client render
	// the normal detected-card path, with each ingredient's own per-item tier
	// intact so the uncertain-row UI (tap to pick the right food) is what the
	// user actually sees. Setting a question here would look like an
	// oversight fix but would actually regress the whole point of per-item
	// tiering on this path.
	return Resolution{
		Candidates: candidates,
		Tier:       bestTier,
		IsEstimate: true,
		KcalLow:    totalKcal * (1 - estimateBand),
		KcalHigh:   totalKcal * (1 + estimateBand),
		Provenance: "estimate",
	}, true, nil
}

func (r Resolver) embedForResolution(ctx context.Context, userID uuid.UUID, text string) ([]float32, error) {
	ctx, span := startSpan(ctx, "resolve.embed")
	defer span.End()
	providerCtx, collector := WithUsageCollector(ctx)
	vec, usage, err := r.provider.Embed(providerCtx, text)
	if err != nil {
		span.SetStatus(codes.Error, "embed failed")
		if errors.Is(err, context.DeadlineExceeded) {
			usage.Outcome = OutcomeTimeout
		} else {
			usage.Outcome = OutcomeError
		}
	}
	r.recordAll(ctx, userID, collector.Drain(), usage)
	return vec, err
}
