// Package bodyread reads a smart-scale result screenshot into a
// body-composition measurement (kora#314). It is a thin service over
// ai.Provider.IdentifyBodyComposition: downscale the image, check the
// cache, meter and call the provider, validate what comes back, and cache
// the validated answer. It never writes to internal/tracking — this
// package only reads and returns; PR B's confirm flow is what eventually
// saves a reading.
package bodyread

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
)

// ErrBudgetExhausted means the caller (or the platform) has exhausted an AI
// quota or cost cap — mirrors recipes.ErrBudgetExhausted exactly. The
// handler turns it into a 429: nothing was wrong with the screenshot, so
// telling the user to retry immediately would be a lie.
var ErrBudgetExhausted = errors.New("bodyread: ai budget exhausted")

// callTypeIdentifyBodyComposition labels every provider call this package
// makes in ai_usage_events and the Prometheus AI metrics. Duplicated as a
// literal rather than imported from internal/ai/providers (unexported
// there) — the same choice recipes.go makes for its own call-type
// constants. It matches providers.callTypeIdentifyBodyComposition and is
// already registered in metrics.classByCallType (Task 1-3), so no metrics
// wiring is needed here.
const callTypeIdentifyBodyComposition = "identify_body_composition"

// cacheTTL bounds how long a validated Result is cached, keyed by the
// downscaled image's content hash. Matches ai.RedisCache's 24h TTL
// (cmd/api/main.go's buildResolveHandler) so both caches age out on the
// same rhythm — there is no reason for one to outlive the other.
const cacheTTL = 24 * time.Hour

// Result is what Reader.Read returns: a validated reading plus whatever
// validateReading discarded from it, plus whether anything at all survived.
type Result struct {
	Reading ai.BodyCompositionReading `json:"reading"`
	Dropped []DroppedField            `json:"dropped_fields"`
	// Unreadable is true only when EVERY field is nil after validation,
	// including no reading date — nothing at all was legible. A reading
	// with some fields nil and others populated is a PARTIAL success, not
	// unreadable (rule #12): the handler maps Unreadable to 422, everything
	// else — including a heavily-dropped partial reading — to 200.
	Unreadable bool `json:"unreadable"`
}

// Reader reads a body-composition screenshot end to end: downscale, cache,
// meter, provider call, validate, cache the validated answer.
type Reader struct {
	provider ai.Provider
	cache    Cache
	meter    ai.Meter
}

// NewReader builds a Reader over its collaborators. The meter is REQUIRED,
// not optional — mirrors recipes.NewParser's exact reasoning: every
// provider call this package makes is billed upstream, and an unmetered
// endpoint would both escape the per-user cap and corrupt the global one
// that protects resolve, recipes, and coach. billing.Meter satisfies
// ai.Meter structurally.
func NewReader(provider ai.Provider, cache Cache, meter ai.Meter) *Reader {
	return &Reader{provider: provider, cache: cache, meter: meter}
}

// withinBudget gates a read before the first provider call, exactly as
// recipes.Parser.withinBudget and ai.Resolver.resolve do.
func (s *Reader) withinBudget(ctx context.Context, userID uuid.UUID) error {
	ok, err := s.meter.WithinBudget(ctx, userID)
	if err != nil {
		return fmt.Errorf("bodyread: read: check budget: %w", err)
	}
	if !ok {
		return ErrBudgetExhausted
	}
	return nil
}

// record meters one provider call. Metering failures must never break a
// read — a user's screenshot cannot depend on the billing table being
// reachable — so the error is deliberately ignored, matching
// recipes.Parser.record.
func (s *Reader) record(ctx context.Context, userID uuid.UUID, u ai.Usage, err error) {
	if u.Provider == "" {
		u.Provider = s.provider.Name()
	}
	u.CallType = callTypeIdentifyBodyComposition
	switch {
	case err == nil && u.Outcome == "":
		u.Outcome = ai.OutcomeOK
	case err != nil && errors.Is(err, context.DeadlineExceeded):
		u.Outcome = ai.OutcomeTimeout
	case err != nil:
		u.Outcome = ai.OutcomeError
	}
	_ = s.meter.Record(ctx, userID, u, ai.EstimateCostUSD(u))
}

// recordCollected meters every provider call a read actually made: the legs
// ai.Router abandoned via retry (drained from the request's usage
// collector) plus the one whose result was returned — mirrors
// recipes.Parser.recordCollected.
func (s *Reader) recordCollected(ctx context.Context, userID uuid.UUID, collector *ai.UsageCollector, returned ai.Usage, err error) {
	for _, abandoned := range collector.Drain() {
		s.record(ctx, userID, abandoned, nil)
	}
	s.record(ctx, userID, returned, err)
}

// Read downscales image, checks the cache, meters and calls the provider,
// validates the response, and caches the validated answer.
func (s *Reader) Read(ctx context.Context, userID uuid.UUID, image []byte, mime string) (Result, error) {
	// Downscale FIRST — it is the cheapest lever available (shrinking before
	// the provider call saves the most tokens/latency of anything in this
	// path) and it changes what actually gets sent to the provider, so the
	// cache key below is deliberately computed on the DOWNSCALED bytes, not
	// the original upload. Keying on the original bytes would let two
	// differently-sized-but-identical-content uploads (say, the same photo
	// re-exported at two resolutions) miss each other's cache entries even
	// though they'd downscale to the exact same thing sent to the provider,
	// and — more importantly — a cache HIT must reflect what a cache MISS
	// would have actually asked the provider to look at.
	downscaled, downscaledMime, err := downscaleForProvider(image, mime)
	if err != nil {
		// downscaleForProvider never actually returns an error (decode/
		// encode failures fall back to the original bytes instead) — this
		// branch exists only so a future change to that contract fails
		// loudly here rather than silently proceeding with a zero-value
		// image.
		return Result{}, fmt.Errorf("bodyread: read: downscale: %w", err)
	}

	sum := sha256.Sum256(downscaled)
	// "body_composition" is a kind distinct from ai.CacheKey's "photo" kind
	// used by ResolvePhoto — required so a scale screenshot and a meal photo
	// that happen to hash identically (astronomically unlikely, but the
	// point of using a distinct kind at all is to not have to rely on that)
	// can never collide in the shared key space. This Reader's OWN cache
	// (see cache.go) is Redis-connection-adjacent to but namespace-separate
	// from ai.RedisCache regardless, so a collision here could only ever
	// happen if a future change merged the two stores — the distinct kind
	// keeps that safe even then.
	key := ai.CacheKey("body_composition", userID, hex.EncodeToString(sum[:]))

	// Cache is checked BEFORE the budget check — mirrors ai.Resolver.resolve
	// exactly: a cache hit costs nothing to serve, so it must never be
	// gated behind a budget check that exists to protect PAID provider
	// calls.
	if cached, ok := s.cache.Get(ctx, key); ok {
		return *cached, nil
	}

	if err := s.withinBudget(ctx, userID); err != nil {
		return Result{}, err
	}

	providerCtx, collector := ai.WithUsageCollector(ctx)
	reading, usage, err := s.provider.IdentifyBodyComposition(providerCtx, downscaled, downscaledMime)
	s.recordCollected(ctx, userID, collector, usage, err)
	// image is never written to disk or any persistent store beyond this
	// point — do not add caching-to-disk here; the CACHE above stores only
	// the parsed Result, never the bytes. This is the last line in this
	// function that touches the image/downscaled bytes at all.
	if err != nil {
		// A provider error (timeout, 5xx, malformed response, etc.) is NOT
		// the same as "unreadable" — the provider never answered at all, so
		// there is nothing to validate. This propagates as a real Go error
		// for the handler to map to a 5xx, distinct from the 422
		// Result.Unreadable path below, which only fires once the provider
		// HAS answered but nothing in that answer survives validation.
		return Result{}, fmt.Errorf("bodyread: read: provider: %w", err)
	}

	// Resolve the model's VERBATIM date text (reading.ReadingDateText) into
	// a calendar date BEFORE validateReading runs, so the same future-date
	// and parse-failure guards validateReading already applies to every
	// other field also cover a resolved date — this is Go code deriving a
	// date by an explicit rule (see date_resolve.go), never the model
	// guessing a year, which is the fabrication kora#314 forbids.
	now := time.Now()
	reading.ReadingDate = resolveReadingDateText(reading.ReadingDateText, now)

	validated, dropped := validateReading(reading, now)
	result := Result{
		Reading:    validated,
		Dropped:    dropped,
		Unreadable: isEmpty(validated),
	}

	// Cache the FINAL, VALIDATED answer — never the raw pre-validation
	// reading — so a cache hit can never resurrect a value validateReading
	// already decided was implausible.
	s.cache.Set(ctx, key, result)

	return result, nil
}

// isEmpty reports whether every field of a reading is nil — nothing at all
// survived validation. Used to set Result.Unreadable.
func isEmpty(r ai.BodyCompositionReading) bool {
	return r.WeightKg == nil &&
		r.BodyFatPct == nil &&
		r.SubcutaneousFatPct == nil &&
		r.VisceralFatRating == nil &&
		r.SkeletalMusclePct == nil &&
		r.MuscleMassKg == nil &&
		r.BodyWaterPct == nil &&
		r.ProteinPct == nil &&
		r.BoneMassKg == nil &&
		r.ScaleBMRKcal == nil &&
		r.ReadingDate == nil
}
