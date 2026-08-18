package ai

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRouter_PrimarySucceeds_IdentifyText(t *testing.T) {
	primary := &stubProvider{
		name:       "primary-stub",
		guesses:    []Guess{{Food: "apple", Confidence: 0.9}},
		guessUsage: Usage{Provider: "primary-stub"},
	}
	fallback := &stubProvider{name: "fallback-stub"}
	r := &Router{Primary: primary, Fallback: fallback}

	guesses, usage, err := r.IdentifyText(context.Background(), "apple")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "apple", Confidence: 0.9}}, guesses)
	assert.Equal(t, "primary-stub", usage.Provider)
	assert.Equal(t, 1, primary.calls)
	assert.Equal(t, 0, fallback.calls, "fallback must not be called when primary succeeds")
}

func TestRouter_PrimarySucceeds_Embed(t *testing.T) {
	primary := &stubProvider{
		name:       "primary-stub",
		embedding:  []float32{0.1, 0.2, 0.3},
		embedUsage: Usage{Provider: "primary-stub"},
	}
	fallback := &stubProvider{name: "fallback-stub"}
	r := &Router{Primary: primary, Fallback: fallback}

	vec, usage, err := r.Embed(context.Background(), "chicken breast")

	require.NoError(t, err)
	assert.Equal(t, []float32{0.1, 0.2, 0.3}, vec)
	assert.Equal(t, "primary-stub", usage.Provider)
	assert.Equal(t, 0, fallback.calls)
}

func TestRouter_PrimaryErrors_FallsBackToFallback_IdentifyText(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", guessErr: errors.New("primary exploded")}
	fallback := &stubProvider{
		name:       "fallback-stub",
		guesses:    []Guess{{Food: "banana", Confidence: 0.8}},
		guessUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback}

	guesses, usage, err := r.IdentifyText(context.Background(), "banana")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "banana", Confidence: 0.8}}, guesses)
	assert.Equal(t, "fallback-stub", usage.Provider)
	assert.Equal(t, 1, fallback.calls)
}

func TestRouter_PrimaryErrors_FallsBackToFallback_Embed(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", embedErr: errors.New("primary exploded")}
	fallback := &stubProvider{
		name:       "fallback-stub",
		embedding:  []float32{0.4, 0.5},
		embedUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback}

	vec, usage, err := r.Embed(context.Background(), "rice")

	require.NoError(t, err)
	assert.Equal(t, []float32{0.4, 0.5}, vec)
	assert.Equal(t, "fallback-stub", usage.Provider)
}

// TestRouter_PrimaryExceedsBudget_FallsBack verifies the latency-fallback
// path deterministically and fast: the primary stub blocks on ctx.Done()
// (simulating a hung call), and the Router's TextBudget field is overridden
// to a small value so the test doesn't need to wait out the real 1.5s
// production budget. Router.TextBudget/PhotoBudget default to the package
// consts (textBudget/photoBudget) when zero, so overriding them here doesn't
// touch production behavior.
func TestRouter_PrimaryExceedsBudget_FallsBack(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", block: true}
	fallback := &stubProvider{
		name:       "fallback-stub",
		guesses:    []Guess{{Food: "slow-timeout-fallback"}},
		guessUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback, TextBudget: 20 * time.Millisecond}

	start := time.Now()
	guesses, usage, err := r.IdentifyText(context.Background(), "slow")
	elapsed := time.Since(start)

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "slow-timeout-fallback"}}, guesses)
	assert.Equal(t, "fallback-stub", usage.Provider)
	assert.Less(t, elapsed, 500*time.Millisecond, "router must give up on primary within its budget, not the production default")
}

func TestRouter_PrimaryExceedsBudget_FallsBack_Embed(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", block: true}
	fallback := &stubProvider{
		name:       "fallback-stub",
		embedding:  []float32{0.9},
		embedUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback, TextBudget: 20 * time.Millisecond}

	vec, usage, err := r.Embed(context.Background(), "slow")

	require.NoError(t, err)
	assert.Equal(t, []float32{0.9}, vec)
	assert.Equal(t, "fallback-stub", usage.Provider)
}

// TestRouter_FallbackGetsGenerousBudget verifies the fallback is NOT capped at
// the primary's tight latency budget: primary times out fast (20ms), and the
// fallback takes longer than that budget (60ms) but well under its own
// FallbackBudget (500ms), so it must still succeed. Before the dedicated
// fallback budget, the fallback shared the 20ms cap and would be cancelled.
func TestRouter_FallbackGetsGenerousBudget(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", block: true}
	fallback := &stubProvider{
		name:       "fallback-stub",
		delay:      60 * time.Millisecond,
		guesses:    []Guess{{Food: "slow-but-served"}},
		guessUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback, TextBudget: 20 * time.Millisecond, FallbackBudget: 500 * time.Millisecond}

	guesses, usage, err := r.IdentifyText(context.Background(), "slow")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "slow-but-served"}}, guesses)
	assert.Equal(t, "fallback-stub", usage.Provider)
	assert.Equal(t, 1, fallback.calls)
}

func TestRouter_BothError_ReturnsFallbackError(t *testing.T) {
	primaryErr := errors.New("primary exploded")
	fallbackErr := errors.New("fallback exploded too")
	primary := &stubProvider{name: "primary-stub", guessErr: primaryErr}
	fallback := &stubProvider{name: "fallback-stub", guessErr: fallbackErr}
	r := &Router{Primary: primary, Fallback: fallback}

	guesses, _, err := r.IdentifyText(context.Background(), "apple")

	require.Error(t, err)
	assert.ErrorIs(t, err, fallbackErr)
	assert.Nil(t, guesses)
}

func TestRouter_BothError_ReturnsFallbackError_Embed(t *testing.T) {
	primaryErr := errors.New("primary exploded")
	fallbackErr := errors.New("fallback exploded too")
	primary := &stubProvider{name: "primary-stub", embedErr: primaryErr}
	fallback := &stubProvider{name: "fallback-stub", embedErr: fallbackErr}
	r := &Router{Primary: primary, Fallback: fallback}

	vec, _, err := r.Embed(context.Background(), "apple")

	require.Error(t, err)
	assert.ErrorIs(t, err, fallbackErr)
	assert.Nil(t, vec)
}

// TestRouter_Transcribe_NoFallback_ReturnsPrimaryError proves Transcribe does
// NOT fall back: audio has no meaningful fallback (only the multimodal
// primary can transcribe), so a primary error must be surfaced directly
// instead of being masked behind the fallback's guaranteed "not supported".
func TestRouter_Transcribe_NoFallback_ReturnsPrimaryError(t *testing.T) {
	primaryErr := errors.New("gemini transcribe boom")
	primary := &stubProvider{name: "primary-stub", transcriptErr: primaryErr}
	fallback := &stubProvider{name: "fallback-stub", transcript: "should not be used"}
	r := &Router{Primary: primary, Fallback: fallback}
	_, _, err := r.Transcribe(context.Background(), []byte("audio"), "audio/mp4")
	require.ErrorIs(t, err, primaryErr)
	assert.Equal(t, 0, fallback.calls, "Transcribe must not fall back (audio has no text-model fallback)")
}

// TestRouter_Transcribe_PrimarySucceeds proves the positive path still works
// now that Transcribe calls the primary directly.
func TestRouter_Transcribe_PrimarySucceeds(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", transcript: "chicken and rice", transcriptUsage: Usage{Provider: "primary-stub"}}
	fallback := &stubProvider{name: "fallback-stub"}
	r := &Router{Primary: primary, Fallback: fallback}
	got, usage, err := r.Transcribe(context.Background(), []byte("audio"), "audio/mp4")
	require.NoError(t, err)
	assert.Equal(t, "chicken and rice", got)
	assert.Equal(t, "primary-stub", usage.Provider)
	assert.Equal(t, 0, fallback.calls)
}

// TestRouterGenerateText_PrimarySucceeds proves GenerateText delegates to
// Primary and never touches Fallback when Primary succeeds.
func TestRouterGenerateText_PrimarySucceeds(t *testing.T) {
	primary := &stubProvider{
		name:      "primary-stub",
		text:      "hi",
		textUsage: Usage{Provider: "fake", Model: "m"},
	}
	fallback := &stubProvider{name: "fallback-stub"}
	r := &Router{Primary: primary, Fallback: fallback}

	got, usage, err := r.GenerateText(context.Background(), "sys", "user")

	require.NoError(t, err)
	assert.Equal(t, "hi", got)
	assert.Equal(t, "fake", usage.Provider)
	assert.Equal(t, "m", usage.Model)
	assert.Equal(t, 0, fallback.calls, "fallback must not be called when primary succeeds")
}

// TestRouterGenerateText_PrimaryErrors_FallsBack proves GenerateText retries
// against Fallback when Primary errors, and returns the fallback's text.
func TestRouterGenerateText_PrimaryErrors_FallsBack(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", textErr: errors.New("primary exploded")}
	fallback := &stubProvider{
		name:      "fallback-stub",
		text:      "fallback text",
		textUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback}

	got, usage, err := r.GenerateText(context.Background(), "sys", "user")

	require.NoError(t, err)
	assert.Equal(t, "fallback text", got)
	assert.Equal(t, "fallback-stub", usage.Provider)
	assert.Equal(t, 1, fallback.calls)
}

// TestRouter_GenerateText_UsesGenerateBudget_NotTextBudget proves GenerateText
// is bounded by generateBudget (overridden here via GenerateBudget), not
// textBudget. The primary stub sleeps for 60ms — well past a 20ms TextBudget
// (which is deliberately also set here to prove it is NOT what's applied) but
// comfortably inside a 500ms GenerateBudget — so the primary must succeed
// rather than being cut off and falling back. Before generateBudget existed,
// GenerateText shared IdentifyText's tight 1.5s production budget, which was
// too short for real recipe-extraction generation (~6s measured) and caused
// every parse to fall through to the fallback, 502ing at 25s.
func TestRouter_GenerateText_UsesGenerateBudget_NotTextBudget(t *testing.T) {
	primary := &stubProvider{
		name:      "primary-stub",
		delay:     60 * time.Millisecond,
		text:      "generated text",
		textUsage: Usage{Provider: "primary-stub"},
	}
	fallback := &stubProvider{name: "fallback-stub"}
	r := &Router{
		Primary:        primary,
		Fallback:       fallback,
		TextBudget:     20 * time.Millisecond,
		GenerateBudget: 500 * time.Millisecond,
	}

	got, usage, err := r.GenerateText(context.Background(), "sys", "user")

	require.NoError(t, err)
	assert.Equal(t, "generated text", got)
	assert.Equal(t, "primary-stub", usage.Provider)
	assert.Equal(t, 0, fallback.calls, "GenerateText must get the generous generateBudget, not the tight textBudget that killed recipe parsing")
}

// TestRouter_IdentifyText_StillUsesTextBudget proves IdentifyText's fast 1.5s
// failover is untouched by the addition of generateBudget: the primary stub
// sleeps 60ms, which exceeds a 20ms TextBudget, so IdentifyText must still
// fall back — GenerateBudget being generous must not leak into IdentifyText.
func TestRouter_IdentifyText_StillUsesTextBudget(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", delay: 60 * time.Millisecond, guesses: []Guess{{Food: "should-not-be-used"}}}
	fallback := &stubProvider{
		name:       "fallback-stub",
		guesses:    []Guess{{Food: "fallback-guess"}},
		guessUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{
		Primary:        primary,
		Fallback:       fallback,
		TextBudget:     20 * time.Millisecond,
		GenerateBudget: 500 * time.Millisecond,
	}

	guesses, usage, err := r.IdentifyText(context.Background(), "slow")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "fallback-guess"}}, guesses)
	assert.Equal(t, "fallback-stub", usage.Provider)
	assert.Equal(t, 1, fallback.calls, "IdentifyText must still be bounded by the tight textBudget, not generateBudget")
}

// TestRouter_GenerateBudget_IsGenerousEnoughForRecipeParsing guards the
// production constant itself. Recipe extraction measured ~6s against Gemini
// directly; generateBudget must clear that with real headroom, unlike the old
// 1.5s textBudget that killed every recipe parse and forced a 25s fallback
// failure (502 parse_failed).
func TestRouter_GenerateBudget_IsGenerousEnoughForRecipeParsing(t *testing.T) {
	assert.GreaterOrEqual(t, generateBudget, 10*time.Second,
		"generateBudget must clear the ~6s measured recipe-extraction latency with real headroom")
	// This used to pin textBudget at 1500ms, guarding against generation's
	// sizing bleeding into the resolve hot path. The guard's INTENT survives —
	// the two budgets must stay independent — but its number did not. 1.5s was
	// sized for the pre-Vertex primary; once the engine moved, it was shorter
	// than the provider's own round trip, so IdentifyText failed over on every
	// single call and the claim it asserted ("IdentifyText's fast failover
	// depends on it") had become the opposite of true (kora#247).
	//
	// textBudget now carries its own guards, which is where a claim about its
	// size belongs: TestTextBudgetClearsTheMeasuredPrimaryLatency and
	// TestTextBudgetsFitInsideTheMobileClientDeadline.
	assert.NotEqual(t, generateBudget, textBudget,
		"generate and text budgets must stay independent; sizing one must not silently resize the other")
}

// mobileRequestTimeoutMs reads REQUEST_TIMEOUT_MS straight out of the mobile
// client rather than restating it, so this test fails if EITHER side of the
// relationship moves. The file is found relative to this package.
func mobileRequestTimeoutMs(t *testing.T) time.Duration {
	t.Helper()
	path := filepath.Join("..", "..", "..", "apps", "mobile", "src", "lib", "api.ts")
	src, err := os.ReadFile(path)
	require.NoError(t, err, "the mobile client's api.ts is the other half of this contract")

	m := regexp.MustCompile(`REQUEST_TIMEOUT_MS\s*=\s*([0-9_]+)`).FindSubmatch(src)
	require.NotNil(t, m, "REQUEST_TIMEOUT_MS not found in %s — it is what bounds every budget here", path)
	ms, err := strconv.Atoi(strings.ReplaceAll(string(m[1]), "_", ""))
	require.NoError(t, err)
	return time.Duration(ms) * time.Millisecond
}

// TestGenerateBudgetsFitInsideTheMobileClientDeadline is the relationship the
// old constant-only assertion could not express, and the one that actually
// broke: generateBudget was set to exactly the client's own abort deadline, so
// the fallback leg was unreachable from the app and the server kept working
// (and paying a second provider) on a request nobody was listening for.
//
// Both legs together must finish inside the client's patience, with margin for
// the network, the food-index resolution that follows the provider call, and
// the rest of the request.
func TestGenerateBudgetsFitInsideTheMobileClientDeadline(t *testing.T) {
	clientDeadline := mobileRequestTimeoutMs(t)

	assert.Equal(t, clientDeadline, clientRequestTimeout,
		"clientRequestTimeout must mirror the mobile client's REQUEST_TIMEOUT_MS")
	assert.Less(t, generateBudget, clientDeadline,
		"a primary budget at or above the client's deadline makes the fallback unreachable from the app")
	assert.LessOrEqual(t, generateBudget+generateFallbackBudget, clientDeadline-2*time.Second,
		"primary + fallback must both fit inside the client's deadline with margin, or the fallback leg is theatre")
}

func TestRouter_Name(t *testing.T) {
	r := &Router{
		Primary:  &stubProvider{name: "primary-stub"},
		Fallback: &stubProvider{name: "fallback-stub"},
	}

	assert.Equal(t, "router(primary-stub->fallback-stub)", r.Name())
}

var _ Provider = (*Router)(nil)

// TestRouter_IdentifyPhoto_DoesNotFallBack pins the deliberate absence of a
// photo fallback, mirroring Transcribe.
//
// This is not a style choice, it is a production finding. The fallback is an
// OpenAI-compatible endpoint driven by ONE configured model (OpenAIProvider
// uses p.model for text and vision alike), and prod sets that to
// meta/llama-3.3-70b-instruct — text-only. So every photo resolve did this:
// Gemini got photoBudget to answer, timed out, and the call fell through to a
// model that cannot see the image, which then burned ~27s before failing.
// Observed as POST /v1/resolve/photo -> 500 in latency_ms 30450, and it is why
// identify_photo has never recorded a successful call.
//
// A fallback that cannot serve the request is strictly worse than none: it
// costs a paid call, adds ~27s of latency, and MASKS the primary's real error
// behind a guaranteed failure. Transcribe already reasons this way in its own
// comment. If a vision-capable fallback is ever configured, restore it
// deliberately — and delete this test on purpose, not by accident.
func TestRouter_IdentifyPhoto_DoesNotFallBack(t *testing.T) {
	primary := &stubProvider{name: "primary-stub", guessErr: errors.New("gemini exploded")}
	fallback := &stubProvider{
		name:       "fallback-stub",
		guesses:    []Guess{{Food: "blind-fallback-guess", Confidence: 0.9}},
		guessUsage: Usage{Provider: "fallback-stub"},
	}
	r := &Router{Primary: primary, Fallback: fallback}

	_, _, err := r.IdentifyPhoto(context.Background(), []byte("jpeg-bytes"), "image/jpeg")

	require.Error(t, err, "the primary's real error must surface, not be masked by a blind fallback")
	assert.Contains(t, err.Error(), "gemini exploded")
	assert.Equal(t, 1, primary.calls)
	assert.Equal(t, 0, fallback.calls, "a text-only fallback must never be handed a photo")
}

// TestRouter_IdentifyPhoto_GivesPrimaryTheFullPhotoBudget guards the budget
// itself. photoBudget was 3s — far too short for a multimodal call, which is
// what forced every photo resolve onto the fallback in the first place. The
// stub sleeps past the old 3s value; if photoBudget regresses to anything at
// or below it, this fails.
func TestRouter_IdentifyPhoto_GivesPrimaryTheFullPhotoBudget(t *testing.T) {
	assert.Greater(t, photoBudget, 3*time.Second,
		"3s cannot accommodate a vision call; that budget is what starved the primary")

	primary := &stubProvider{
		name:       "primary-stub",
		guesses:    []Guess{{Food: "omelette", Confidence: 0.9}},
		guessUsage: Usage{Provider: "primary-stub"},
		delay:      50 * time.Millisecond,
	}
	r := &Router{Primary: primary, Fallback: &stubProvider{name: "fallback-stub"}}

	guesses, usage, err := r.IdentifyPhoto(context.Background(), []byte("jpeg-bytes"), "image/jpeg")

	require.NoError(t, err)
	assert.Equal(t, []Guess{{Food: "omelette", Confidence: 0.9}}, guesses)
	assert.Equal(t, "primary-stub", usage.Provider)
}

// flakyPhotoProvider returns errs[i] on call i+1, then succeeds. Purpose-built
// because stubProvider returns one fixed error for every call, and the whole
// point here is a provider that answers differently the second time.
type flakyPhotoProvider struct {
	Provider
	errs  []error
	calls int
	usage Usage
}

func (f *flakyPhotoProvider) IdentifyPhoto(context.Context, []byte, string) ([]Guess, Usage, error) {
	f.calls++
	if f.calls <= len(f.errs) {
		return nil, f.usage, f.errs[f.calls-1]
	}
	return []Guess{{Food: "croissant", Confidence: 0.9}}, f.usage, nil
}

// kora#179. A photo capture failed on device because Gemini answered
// "Error 503 ... This model is currently experiencing high demand. Spikes in
// demand are usually temporary. Please try again later."
//
// That took the app's CORE action down completely, after 5.7s, with 14s of the
// photo budget still unspent — and the photo path is the only one with no
// fallback leg to catch it (IdentifyPhoto calls the primary directly, because
// the deployed fallback is text-only).
func TestRouter_IdentifyPhoto_RetriesATransient503(t *testing.T) {
	primary := &flakyPhotoProvider{
		errs:  []error{errors.New("gemini: generate content: Error 503, Message: This model is currently experiencing high demand., Status: UNAVAILABLE")},
		usage: Usage{Provider: "gemini", TokensIn: 10, LatencyMs: 100},
	}
	r := &Router{Primary: primary, Fallback: &stubProvider{name: "fallback-stub"}}

	guesses, usage, err := r.IdentifyPhoto(context.Background(), []byte("jpeg"), "image/jpeg")

	require.NoError(t, err, "a documented-temporary error must not fail the capture on first sight")
	require.Len(t, guesses, 1)
	assert.Equal(t, 2, primary.calls, "exactly one retry")
	// The failed attempt's cost is carried forward — ai_usage_events records
	// failures too, so dropping it would under-count spend.
	assert.Equal(t, 20, usage.TokensIn, "both attempts' tokens must be accounted for")
	assert.Equal(t, 200, usage.LatencyMs)
}

// The counterpart, and the more important guarantee of the two: a rate limit
// must NOT be retried.
//
// cmd/embed reached this from production evidence and says so plainly —
// retrying a rate-limit rejection spends further requests against the very
// quota whose exhaustion caused the failure, deepening the outage. It holds
// harder here: Gemini's free tier caps embeddings at 1,000 per project per
// DAY, so no user-facing wait can clear it.
func TestRouter_IdentifyPhoto_DoesNotRetryARateLimit(t *testing.T) {
	primary := &flakyPhotoProvider{
		errs: []error{
			errors.New("gemini: Error 429, Message: Resource has been exhausted, Status: RESOURCE_EXHAUSTED"),
			errors.New("second call that must never happen"),
		},
	}
	r := &Router{Primary: primary, Fallback: &stubProvider{name: "fallback-stub"}}

	_, _, err := r.IdentifyPhoto(context.Background(), []byte("jpeg"), "image/jpeg")

	require.Error(t, err)
	assert.Contains(t, err.Error(), "429", "the rate limit itself must surface, not a retry's error")
	assert.Equal(t, 1, primary.calls, "a rate limit must be surfaced immediately, never retried")
}

func TestIsTransientProviderError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"the reported 503", errors.New("Error 503, Status: UNAVAILABLE"), true},
		{"high demand wording", errors.New("This model is currently experiencing high demand"), true},
		{"overloaded", errors.New("provider overloaded"), true},
		{"rate limit is NOT transient for our purposes", errors.New("Error 429, RESOURCE_EXHAUSTED"), false},
		{"a real failure", errors.New("invalid image encoding"), false},
		{"auth failure", errors.New("Error 401, unauthorized"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, isTransientProviderError(tt.err))
		})
	}
}

// measuredPrimaryLatency is the primary provider's observed round-trip against
// production on 2026-08-18, sampled through /v1/resolve/photo — the one path
// that calls the primary DIRECTLY with no fallback (see IdentifyPhoto), so it
// isolates provider latency from any fallback or retry: 2.699s, 1.920s,
// 2.457s, 2.157s.
//
// It is a floor for sizing any primary budget. A budget below it does not make
// the primary "fast"; it makes the primary lose every race and hands the call
// to the fallback unconditionally, which is kora#247.
const measuredPrimaryLatency = 2700 * time.Millisecond

// TestTextBudgetsFitInsideTheMobileClientDeadline is exactly the relationship
// TestGenerateBudgetsFitInsideTheMobileClientDeadline pins for generation,
// applied to the RESOLVE TEXT path — which never had it. That gap is how
// kora#247 shipped: textBudget (1.5s) plus the SHARED fallbackBudget (90s) is
// 91.5s, and withFallback derives the fallback context from the parent, so the
// two are additive. Every uncached resolve therefore spent ~92s and 500'd,
// while the app had already given up at 25s.
func TestTextBudgetsFitInsideTheMobileClientDeadline(t *testing.T) {
	clientDeadline := mobileRequestTimeoutMs(t)

	assert.Less(t, textBudget, clientDeadline,
		"a primary budget at or above the client's deadline makes the fallback unreachable from the app")
	assert.LessOrEqual(t, textBudget+textFallbackBudget, clientDeadline-2*time.Second,
		"primary + fallback must both fit inside the client's deadline with margin, or the fallback leg is theatre")
}

// A budget under the provider's real latency is not a fast failover — it is a
// guaranteed one. kora#247: textBudget was 1.5s against a ~2.4s provider, so
// the primary never once served a text resolve and every call fell through to
// a fallback that was itself failing.
func TestTextBudgetClearsTheMeasuredPrimaryLatency(t *testing.T) {
	assert.GreaterOrEqual(t, textBudget, 2*measuredPrimaryLatency,
		"textBudget must clear the measured primary latency with headroom, or the primary loses every race")
}

// The resolve text path must not silently inherit the shared 90s
// fallbackBudget again. That constant is sized for a leg nobody is waiting on;
// this one is on the user's critical path.
func TestTextFallbackBudgetIsNotTheSharedNinetySecondOne(t *testing.T) {
	assert.NotEqual(t, fallbackBudget, textFallbackBudget,
		"the text path needs its own fallback budget; the shared one is 90s and the client gives up at 25s")

	r := &Router{}
	assert.Equal(t, textFallbackBudget, r.textFallbackBudgetOrDefault(),
		"IdentifyText must resolve its fallback budget from the text-specific constant")
}
