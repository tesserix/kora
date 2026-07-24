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

// withFallback runs primary against a child context bounded by budget. If
// primary returns an error (including the child context's own deadline
// being exceeded), fallback is retried against a fresh context derived from
// the original parent ctx (not the expired child), itself bounded by the
// same budget. The result of whichever call served the request is returned
// as-is, including its Usage — providers set Usage.Provider themselves, so
// the caller can tell who served just by inspecting it.
func withFallback[T any](ctx context.Context, budget time.Duration, primary, fallback func(context.Context) (T, Usage, error)) (T, Usage, error) {
	primaryCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	result, usage, err := primary(primaryCtx)
	if err == nil && primaryCtx.Err() == nil {
		return result, usage, nil
	}

	fallbackCtx, fallbackCancel := context.WithTimeout(ctx, budget)
	defer fallbackCancel()
	return fallback(fallbackCtx)
}

func (r *Router) IdentifyText(ctx context.Context, phrase string) ([]Guess, Usage, error) {
	return withFallback(ctx, r.textBudgetOrDefault(),
		func(c context.Context) ([]Guess, Usage, error) { return r.Primary.IdentifyText(c, phrase) },
		func(c context.Context) ([]Guess, Usage, error) { return r.Fallback.IdentifyText(c, phrase) },
	)
}

func (r *Router) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]Guess, Usage, error) {
	return withFallback(ctx, r.photoBudgetOrDefault(),
		func(c context.Context) ([]Guess, Usage, error) { return r.Primary.IdentifyPhoto(c, image, mime) },
		func(c context.Context) ([]Guess, Usage, error) { return r.Fallback.IdentifyPhoto(c, image, mime) },
	)
}

func (r *Router) Decompose(ctx context.Context, dish string) ([]IngredientGuess, Usage, error) {
	return withFallback(ctx, r.textBudgetOrDefault(),
		func(c context.Context) ([]IngredientGuess, Usage, error) { return r.Primary.Decompose(c, dish) },
		func(c context.Context) ([]IngredientGuess, Usage, error) { return r.Fallback.Decompose(c, dish) },
	)
}

func (r *Router) Embed(ctx context.Context, text string) ([]float32, Usage, error) {
	return withFallback(ctx, r.textBudgetOrDefault(),
		func(c context.Context) ([]float32, Usage, error) { return r.Primary.Embed(c, text) },
		func(c context.Context) ([]float32, Usage, error) { return r.Fallback.Embed(c, text) },
	)
}

func (r *Router) Name() string {
	return "router(" + r.Primary.Name() + "->" + r.Fallback.Name() + ")"
}
