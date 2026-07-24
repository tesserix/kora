package ai

import (
	"context"
	"time"
)

// Latency budgets per call type. Photo identification is allowed more time
// than the smaller text-oriented calls (identify, decompose, embed) because
// vision models are inherently slower.
const (
	photoBudget = 3 * time.Second
	textBudget  = 1500 * time.Millisecond

	// fallbackBudget is deliberately generous: the fallback provider only runs
	// after the primary has already failed or timed out, so latency there is a
	// last-resort cost we accept rather than fail the resolve. It also absorbs
	// slow cold starts on free-tier fallback endpoints (NVIDIA NIM cold start
	// was measured at ~75s). Bounded only so a truly hung fallback can't pin a
	// request forever; the request's own context still applies on top.
	fallbackBudget = 90 * time.Second

	// transcribeBudget bounds a transcription call. Audio is a recorded note,
	// not a latency-critical interaction, and can take several seconds, so this
	// is generous (well above the measured ~3s latency and the 12 MiB cap's
	// worst case). There is no meaningful fallback for audio — only the
	// multimodal primary can transcribe — so Transcribe calls the primary
	// directly and surfaces its real error instead of masking it behind the
	// fallback's guaranteed "not supported".
	transcribeBudget = 30 * time.Second
)

// Router composes a Primary and Fallback Provider. Every call is attempted
// against Primary first, bounded by a per-call-type latency budget; if
// Primary errors or fails to finish within its budget, the call is retried
// against Fallback with a fresh budget of its own. Router implements
// Provider so it is a drop-in replacement wherever a single Provider is
// expected.
type Router struct {
	Primary  Provider
	Fallback Provider

	// PhotoBudget/TextBudget override the default latency budgets
	// (photoBudget/textBudget) when non-zero. Production code should leave
	// these unset; tests use them to keep the latency-fallback path fast
	// and deterministic instead of waiting out the real multi-second
	// production budgets.
	PhotoBudget time.Duration
	TextBudget  time.Duration

	// FallbackBudget overrides the default fallbackBudget when non-zero. Tests
	// use it to keep the fallback-latency path fast; production leaves it unset.
	FallbackBudget time.Duration
}

func (r *Router) photoBudgetOrDefault() time.Duration {
	if r.PhotoBudget > 0 {
		return r.PhotoBudget
	}
	return photoBudget
}

func (r *Router) textBudgetOrDefault() time.Duration {
	if r.TextBudget > 0 {
		return r.TextBudget
	}
	return textBudget
}

func (r *Router) fallbackBudgetOrDefault() time.Duration {
	if r.FallbackBudget > 0 {
		return r.FallbackBudget
	}
	return fallbackBudget
}

// withFallback runs primary against a child context bounded by budget. If
// primary returns an error (including the child context's own deadline
// being exceeded), fallback is retried against a fresh context derived from
// the original parent ctx (not the expired child), bounded by its own
// fbBudget — deliberately more generous than the primary budget, since the
// fallback only runs after the fast path already failed. The result of
// whichever call served the request is returned as-is, including its Usage —
// providers set Usage.Provider themselves, so the caller can tell who served
// just by inspecting it.
func withFallback[T any](ctx context.Context, budget, fbBudget time.Duration, primary, fallback func(context.Context) (T, Usage, error)) (T, Usage, error) {
	primaryCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	result, usage, err := primary(primaryCtx)
	if err == nil && primaryCtx.Err() == nil {
		return result, usage, nil
	}

	fallbackCtx, fallbackCancel := context.WithTimeout(ctx, fbBudget)
	defer fallbackCancel()
	return fallback(fallbackCtx)
}

func (r *Router) IdentifyText(ctx context.Context, phrase string) ([]Guess, Usage, error) {
	return withFallback(ctx, r.textBudgetOrDefault(), r.fallbackBudgetOrDefault(),
		func(c context.Context) ([]Guess, Usage, error) { return r.Primary.IdentifyText(c, phrase) },
		func(c context.Context) ([]Guess, Usage, error) { return r.Fallback.IdentifyText(c, phrase) },
	)
}

func (r *Router) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]Guess, Usage, error) {
	return withFallback(ctx, r.photoBudgetOrDefault(), r.fallbackBudgetOrDefault(),
		func(c context.Context) ([]Guess, Usage, error) { return r.Primary.IdentifyPhoto(c, image, mime) },
		func(c context.Context) ([]Guess, Usage, error) { return r.Fallback.IdentifyPhoto(c, image, mime) },
	)
}

func (r *Router) Decompose(ctx context.Context, dish string) ([]IngredientGuess, Usage, error) {
	return withFallback(ctx, r.textBudgetOrDefault(), r.fallbackBudgetOrDefault(),
		func(c context.Context) ([]IngredientGuess, Usage, error) { return r.Primary.Decompose(c, dish) },
		func(c context.Context) ([]IngredientGuess, Usage, error) { return r.Fallback.Decompose(c, dish) },
	)
}

func (r *Router) Embed(ctx context.Context, text string) ([]float32, Usage, error) {
	return withFallback(ctx, r.textBudgetOrDefault(), r.fallbackBudgetOrDefault(),
		func(c context.Context) ([]float32, Usage, error) { return r.Primary.Embed(c, text) },
		func(c context.Context) ([]float32, Usage, error) { return r.Fallback.Embed(c, text) },
	)
}

func (r *Router) Transcribe(ctx context.Context, audio []byte, mime string) (string, Usage, error) {
	tctx, cancel := context.WithTimeout(ctx, transcribeBudget)
	defer cancel()
	return r.Primary.Transcribe(tctx, audio, mime)
}

func (r *Router) Name() string {
	return "router(" + r.Primary.Name() + "->" + r.Fallback.Name() + ")"
}
