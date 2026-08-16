package ai

import (
	"context"
	"strings"
	"time"
)

// Latency budgets per call type. Photo identification is allowed more time
// than the smaller text-oriented calls (identify, decompose, embed) because
// vision models are inherently slower.
const (
	// photoBudget bounds the vision call. This was 3s, which no multimodal
	// model could meet — so in practice EVERY photo resolve timed out here and
	// fell through to the fallback, which could not serve it either (see
	// IdentifyPhoto). identify_photo has never recorded a successful call.
	// 20s is generous but this is a one-shot user-initiated capture, not a
	// latency-critical interaction, and the gateway now allows 100s per try.
	photoBudget = 20 * time.Second

	// photoAttempts is 2 — one retry, no more.
	//
	// The photo path is the app's core action AND its only single point of
	// failure: every text path has a fallback leg, while IdentifyPhoto calls
	// the primary directly because the deployed fallback is text-only (see
	// IdentifyPhoto). So a single transient 503 took photo logging down
	// completely (kora#179).
	//
	// Two attempts rather than three because the retry has to fit inside
	// photoBudget, which has to fit inside the 25s client deadline. One retry
	// is what the reported incident needed — a 5.7s failure with 14s of budget
	// still unspent.
	photoAttempts = 2

	// Long enough for a demand spike to pass, short enough to leave room for
	// the second attempt inside the budget. No jitter: this is one call per
	// user-initiated capture, not a fleet retrying in lockstep, so there is no
	// thundering herd to spread.
	photoRetryDelay = 750 * time.Millisecond

	// Below this much remaining budget a second attempt cannot plausibly
	// finish, so it would spend a paid call to produce an answer that arrives
	// after the client has already given up.
	minRetryHeadroom = 3 * time.Second
	textBudget       = 1500 * time.Millisecond

	// clientRequestTimeout mirrors REQUEST_TIMEOUT_MS in
	// apps/mobile/src/lib/api.ts — the per-attempt deadline after which the
	// app aborts the request. It is NOT a budget; it is the hard ceiling every
	// user-facing budget on this Router has to fit inside, because work the
	// server does past it is work nobody is listening for (and, for a provider
	// call, money spent on an answer that is thrown away).
	// TestGenerateBudgetsFitInsideTheMobileClientDeadline reads the real
	// constant out of that file, so the two cannot drift silently.
	clientRequestTimeout = 25 * time.Second

	// generateBudget bounds free-form/structured generation calls (recipe
	// parsing, coach Q&A) — GenerateText, not IdentifyText. textBudget's
	// 1.5s was sized for IdentifyText's short "what food is this?" call and
	// is far too tight for generation: recipe extraction measured directly
	// against Gemini (no Router) took ~6s and succeeded, but under the
	// Router's 1.5s textBudget the primary was killed, the call fell through
	// to the NVIDIA fallback, and the whole request 502'd at 25s
	// (POST /v1/recipes/parse -> 502, latency_ms 25004).
	//
	// That 25s was then read as "the fallback took ~23.5s" and the budget was
	// sized to 25s to match. It was in fact clientRequestTimeout to within
	// 4ms: the APP hung up, and the server's own work was never bounded at
	// all. A 25s primary budget is unusable — it equals the client's deadline,
	// so the fallback leg could never be reached from the app, and
	// withFallback derives the fallback context from the PARENT ctx, making
	// the budgets additive (25s + 90s = a 115s request nobody was waiting on).
	//
	// 10s clears the ~6s measured generation latency with real headroom and,
	// paired with generateFallbackBudget below, leaves the whole two-leg
	// sequence inside the client's patience with margin for the network and
	// the rest of the request. textBudget itself must NOT change:
	// IdentifyText's fast 1.5s failover is depended on by the food-resolve hot
	// path.
	generateBudget = 10 * time.Second

	// generateFallbackBudget bounds the SECOND leg of a generation call,
	// replacing the shared 90s fallbackBudget on this one path. 90s is right
	// for a resolve, which the client waits on differently, but on a
	// generation the fallback only has whatever is left of the client's 25s
	// after the primary spent its own budget. 10s + 12s = 22s, which fits
	// inside clientRequestTimeout with ~3s of margin — so the fallback is
	// actually reachable from the app, which is the entire point of having
	// one.
	generateFallbackBudget = 12 * time.Second

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

	// GenerateBudget overrides the default generateBudget when non-zero, in
	// the same style as PhotoBudget/TextBudget. Production code should leave
	// this unset; tests use it to keep GenerateText's latency-fallback path
	// fast and deterministic instead of waiting out the real 25s production
	// budget.
	GenerateBudget time.Duration

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

func (r *Router) generateBudgetOrDefault() time.Duration {
	if r.GenerateBudget > 0 {
		return r.GenerateBudget
	}
	return generateBudget
}

// generateFallbackBudgetOrDefault is the fallback budget for GenerateText.
// The FallbackBudget field still overrides it, so tests that shorten the
// fallback leg keep working on every call type.
func (r *Router) generateFallbackBudgetOrDefault() time.Duration {
	if r.FallbackBudget > 0 {
		return r.FallbackBudget
	}
	return generateFallbackBudget
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
		usage.Outcome = OutcomeOK
		return result, usage, nil
	}

	// The primary ran and was billed upstream even though its answer is being
	// thrown away — cancelling a client context does not stop the provider
	// from processing or charging for the request. Dropping it here is what
	// made COGS a one-directional undercount even on SUCCESSFUL resolves
	// (#81). Deposit it so the Resolver meters both legs.
	if primaryCtx.Err() != nil {
		usage.Outcome = OutcomeTimeout
	} else {
		usage.Outcome = OutcomeError
	}
	addUsage(ctx, usage)

	fallbackCtx, fallbackCancel := context.WithTimeout(ctx, fbBudget)
	defer fallbackCancel()
	result, fbUsage, fbErr := fallback(fallbackCtx)
	if fbErr != nil {
		fbUsage.Outcome = OutcomeError
	} else {
		fbUsage.Outcome = OutcomeOK
	}
	return result, fbUsage, fbErr
}

func (r *Router) IdentifyText(ctx context.Context, phrase string) ([]Guess, Usage, error) {
	return withFallback(ctx, r.textBudgetOrDefault(), r.fallbackBudgetOrDefault(),
		func(c context.Context) ([]Guess, Usage, error) { return r.Primary.IdentifyText(c, phrase) },
		func(c context.Context) ([]Guess, Usage, error) { return r.Fallback.IdentifyText(c, phrase) },
	)
}

// IdentifyPhoto calls the primary DIRECTLY — no fallback — for the same
// reason Transcribe does.
//
// OpenAIProvider drives text and vision from ONE configured model (p.model),
// and the deployed fallback is meta/llama-3.3-70b-instruct: text-only. Handing
// it a base64 image guaranteed a failure, so the old fallback path did nothing
// but spend a paid call and ~27s of latency to replace the primary's real
// error with a meaningless one. Surfacing the primary's error is strictly more
// useful, and cheaper.
//
// Restore the fallback only alongside a vision-capable fallback model — and if
// so, give it its own model config rather than reusing p.model, which the text
// paths depend on.
func (r *Router) IdentifyPhoto(ctx context.Context, image []byte, mime string) ([]Guess, Usage, error) {
	pctx, cancel := context.WithTimeout(ctx, r.photoBudgetOrDefault())
	defer cancel()

	var last Usage
	for attempt := 1; ; attempt++ {
		guesses, usage, err := r.Primary.IdentifyPhoto(pctx, image, mime)
		// Carry the failed attempt's cost forward. ai_usage_events records
		// failures as well as successes (see Usage.Outcome), so dropping a
		// retried attempt's tokens would under-count spend — the same class of
		// gap kora#152 tracks for the abandoned fallback leg.
		usage.TokensIn += last.TokensIn
		usage.TokensOut += last.TokensOut
		usage.LatencyMs += last.LatencyMs
		if err == nil {
			return guesses, usage, nil
		}
		last = usage
		if attempt >= photoAttempts || !isTransientProviderError(err) || !hasRetryHeadroom(pctx) {
			return nil, usage, err
		}
		if !sleepWithin(pctx, photoRetryDelay) {
			return nil, usage, err
		}
	}
}

// isTransientProviderError reports whether an error is the provider saying
// "not now" rather than "no".
//
// Deliberately NARROW. It matches 503/UNAVAILABLE only — Google documents that
// status as temporary and asks callers to try again, and the observed failure
// (kora#179) was verbatim "This model is currently experiencing high demand.
// Spikes in demand are usually temporary. Please try again later."
//
// **429 is excluded on purpose.** cmd/embed reached the same conclusion from
// production evidence and states it plainly: retrying a rate-limit rejection
// spends further requests against the very quota whose exhaustion caused the
// failure, which makes the outage deeper rather than shorter. That reasoning
// holds here, and holds harder — Gemini's free tier caps embeddings at 1,000
// per project per DAY, so a quota failure will not clear inside a user-facing
// request no matter how long we wait.
func isTransientProviderError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "503") ||
		strings.Contains(msg, "unavailable") ||
		strings.Contains(msg, "high demand") ||
		strings.Contains(msg, "overloaded")
}

// hasRetryHeadroom reports whether enough of the photo budget remains to be
// worth another attempt.
//
// The retry lives INSIDE photoBudget rather than extending it, which is what
// keeps clientRequestTimeout intact: the app aborts at 25s, so a second full
// 20s attempt would produce an answer nobody is listening for, and a paid call
// for it. A 503 fails fast — 5.7s in the reported incident — so in the case
// this exists for there is ample room; a first attempt that instead consumed
// the budget by timing out leaves none, and correctly gets no retry.
func hasRetryHeadroom(ctx context.Context) bool {
	deadline, ok := ctx.Deadline()
	if !ok {
		return true
	}
	return time.Until(deadline) > photoRetryDelay+minRetryHeadroom
}

// sleepWithin waits out the backoff unless the context ends first, in which
// case there is nothing left to retry into.
func sleepWithin(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
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

func (r *Router) GenerateText(ctx context.Context, systemPrompt, userPrompt string) (string, Usage, error) {
	return withFallback(ctx, r.generateBudgetOrDefault(), r.generateFallbackBudgetOrDefault(),
		func(c context.Context) (string, Usage, error) {
			return r.Primary.GenerateText(c, systemPrompt, userPrompt)
		},
		func(c context.Context) (string, Usage, error) {
			return r.Fallback.GenerateText(c, systemPrompt, userPrompt)
		},
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
