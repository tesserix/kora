package ai

import (
	"context"

	"github.com/google/uuid"
)

// ResolveOutcome is one resolve attempt's record, as this package reports it.
//
// A flat struct of primitives rather than resolveoutcome.Outcome, so package
// ai gains no dependency on the package that owns the table — the same
// consumer-declared-interface shape LocaleSource and PortionSource use, and
// the one that kept identity from having to import social (#453).
type ResolveOutcome struct {
	UserID uuid.UUID
	// Kind is which branch terminated the attempt. The strings match
	// resolveoutcome.Kind; they are declared there and mirrored in the
	// outcomeKind* constants below so a typo cannot reach the database.
	Kind string
	// Tier is this resolver's OWN tier for the attempt, empty where none was
	// reached. Never a threshold re-derived by the consumer.
	Tier string
	Mode string
	// Phrase is what the user said. Nil for a photo, which has none.
	Phrase         *string
	TopFoodItemID  *uuid.UUID
	TopScore       *float64
	CandidateCount int
	// CandidateIDs are the offered foods in rank order, so a later log can score where its pick ranked.
	CandidateIDs []uuid.UUID
}

// OutcomeSink records resolve outcomes.
//
// Implementations MUST NOT fail a resolve and MUST NOT return an error —
// the signature makes that a compile-time property rather than a convention
// somebody has to remember. See resolveoutcome.Repository.Record.
type OutcomeSink interface {
	Record(ctx context.Context, o ResolveOutcome)
}

// Outcome kinds, mirroring resolveoutcome.Kind. Declared as constants here so
// every call site in resolver.go is a symbol rather than a string literal.
const (
	outcomeCache      = "cache"
	outcomeAlias      = "alias"
	outcomeResolved   = "resolved"
	outcomeWeakMatch  = "weak_match"
	outcomeBelowFloor = "below_floor"
	outcomeNoMatch    = "no_match"
	outcomeDecomposed = "decomposed"
	outcomeBudget     = "budget"
	outcomeError      = "error"
	// outcomeTranscriptBlank is a voice capture that transcribed to nothing —
	// a capture failure, not an index gap and not a provider fault.
	outcomeTranscriptBlank = "transcript_blank"
)

// Resolve modes, mirroring resolveoutcome.Mode.
const (
	modeText  = "text"
	modePhoto = "photo"
	modeVoice = "voice"
)

// recordOutcome writes one attempt's outcome, if a sink is wired.
//
// Nil-safe: a Resolver built without WithOutcomeSink records nothing, exactly
// as one built without a cache caches nothing. Every test that constructs a
// bare Resolver keeps working.
func (r Resolver) recordOutcome(ctx context.Context, o ResolveOutcome) {
	if r.outcomes == nil {
		return
	}
	r.outcomes.Record(ctx, o)
}

// outcomeFor builds the record for a finished Resolution, reading the tier and
// the top candidate off the resolution itself rather than recomputing either.
func outcomeFor(userID uuid.UUID, kind, mode string, phrase *string, res Resolution) ResolveOutcome {
	o := ResolveOutcome{
		UserID:         userID,
		Kind:           kind,
		Tier:           string(res.Tier),
		Mode:           mode,
		Phrase:         phrase,
		CandidateCount: len(res.Candidates),
	}
	for _, c := range res.Candidates {
		o.CandidateIDs = append(o.CandidateIDs, c.Item.ID)
	}
	if len(res.Candidates) > 0 {
		top := res.Candidates[0]
		id := top.Item.ID
		score := top.MatchScore
		o.TopFoodItemID = &id
		o.TopScore = &score
	}
	return o
}

type resolutionIDKey struct{}

// WithResolutionID names the attempt a handler is about to resolve, so the recorded outcome and the response share one id.
func WithResolutionID(ctx context.Context, id uuid.UUID) context.Context {
	return context.WithValue(ctx, resolutionIDKey{}, id)
}

// ResolutionIDFrom returns the id WithResolutionID attached, if any.
func ResolutionIDFrom(ctx context.Context) (uuid.UUID, bool) {
	id, ok := ctx.Value(resolutionIDKey{}).(uuid.UUID)
	return id, ok
}

// phrasePtr returns a pointer to phrase, or nil when it is empty — so "a photo
// has no phrase" and "a text resolve of an empty string" stay distinguishable
// in the stored row.
func phrasePtr(phrase string) *string {
	if phrase == "" {
		return nil
	}
	return &phrase
}
