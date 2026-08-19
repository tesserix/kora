// Command embed backfills the food_items.embedding column so the nutrition
// resolver's embedding tier (Resolve's MatchEmbedding path) has vectors to
// search.
//
// Agent Gateway is the preferred backend and receives only Kora's logical
// model. Vertex and Gemini remain available solely for explicitly disabled
// legacy/local gateway mode. With no configured backend the command logs and
// exits 0 rather than crashing, since the rest of the engine builds/tests
// without credentials.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/genai"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/billing"
	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
)

const (
	// batchSize is how many missing-embedding rows are pulled per round trip.
	batchSize = 100
	// embedAttempts is how many times a single row's embed is tried before
	// counting it as failed.
	embedAttempts = 3
	// defaultVertexLocation matches config.Load's VERTEX_LOCATION default and
	// providers.NewVertexProvider's own fallback. It is spelled out here only
	// so the startup log reports the location actually used; see
	// NewVertexProvider for why "global" and not a region.
	defaultVertexLocation = "global"
)

// embedBaseDelay is the initial backoff between retry attempts, doubled each
// time. A var, not a const, purely so tests can zero it. With the production
// value a single persistently-failing row costs 1.5s of sleeping, which would
// make the retry tests slow for no benefit — they are asserting the retry
// COUNT, not the wall-clock delay.
var embedBaseDelay = 500 * time.Millisecond

// embedder is the subset of a provider's embedding capability cmd/embed needs.
// It is providers.GeminiProvider.Embed's FULL signature, ai.Usage included, so
// providers.GeminiProvider satisfies it directly — which covers both backends,
// since NewVertexProvider returns the same struct as NewGeminiProvider.
//
// The Usage used to be dropped by a two-value adapter here. That discarded the
// metering for every embed this command makes — thousands per backfill, the
// single largest embedding consumer in the system — so the food index's spend
// appeared in neither ai_usage_events nor kora_ai_calls_total, and "total COGS
// = resolution + derived" was false at the org level (kora#97). Narrowing an
// interface is cheap; the thing it narrowed away was the entire cost signal.
type embedder interface {
	Embed(ctx context.Context, text string) ([]float32, ai.Usage, error)
}

// usageRecorder records one AI provider call that no user made.
//
// Declared as an interface here, not taken as a concrete billing.Meter, for
// the same reason ai.Meter is: run must stay testable without a database.
// billing.Meter satisfies it structurally, so billing.NewMeter(db) is passed
// straight in with no adapter.
type usageRecorder interface {
	RecordSystem(ctx context.Context, u ai.Usage, costUSD float64) error
}

// store is the subset of nutrition.Repository run needs.
type store interface {
	RowsMissingEmbedding(ctx context.Context, limit int) ([]nutrition.FoodItem, error)
	SetEmbedding(ctx context.Context, id uuid.UUID, vec []float32) error
}

// meter records one provider call against the platform, with no owning user.
//
// Recording must NEVER break the backfill — the embeddings are the point, the
// accounting is not — so a metering error is logged and swallowed, exactly as
// ai.Resolver.record swallows it on the user-facing path.
//
// Note the cost will usually be $0.00: providers.GeminiProvider.Embed does not
// populate TokensIn, so ai.EstimateCostUSD has nothing to price. The CALL is
// still the thing worth counting — kora_ai_calls_total{call_type="embed"} and
// the ai_usage_events row are what make the backfill's volume visible at all.
// A token count added to Embed later prices it with no change here.
func meter(ctx context.Context, rec usageRecorder, u ai.Usage, outcome string) {
	if rec == nil || u.Provider == "" {
		// No Provider means the call never reached one — a stub, or a zero
		// value. Recording it would pad the meter with phantom calls, the same
		// guard ai.Resolver.recordAll applies.
		return
	}
	u.Outcome = outcome
	if err := rec.RecordSystem(ctx, u, ai.EstimateCostUSD(u)); err != nil {
		log.Printf("cmd/embed: record usage: %v", err)
	}
}

// embedBackend names which provider main will construct.
type embedBackend int

const (
	// backendNone means nothing is configured — the run is skipped.
	backendNone embedBackend = iota
	backendGateway
	backendVertex
	backendGemini
)

// chooseBackend applies the SAME precedence as cmd/api's buildResolveHandler:
// Vertex wins when configured, the API key is the fallback, and neither means
// disabled.
//
// The reason is stronger here than it is there. This command's whole job is
// bulk embedding, and the Gemini free tier — which is what a GEMINI_API_KEY
// from the billing-disabled kora-app-e6d38 project buys — caps embeddings at
// 1,000 per project per DAY, shared with the resolver's own embed calls. At
// ~15k rows that is a fortnight of backfill for a job that should take
// minutes, and it is the documented reason the index stalled at 607 of 5,669
// rows (kora#97). Vertex is authenticated by the workload's service account
// against a billing-enabled project, so it has neither the cap nor the key.
//
// The API-key path stays for local development, where there is no Workload
// Identity to authenticate against.
func chooseBackend(gatewayEnabled bool, vertexProject, geminiAPIKey string) embedBackend {
	switch {
	case gatewayEnabled:
		return backendGateway
	case vertexProject != "":
		return backendVertex
	case geminiAPIKey != "":
		return backendGemini
	default:
		return backendNone
	}
}

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("cmd/embed: DATABASE_URL required")
	}

	vertexProject := os.Getenv("VERTEX_PROJECT")
	vertexLocation := os.Getenv("VERTEX_LOCATION")
	if vertexLocation == "" {
		vertexLocation = defaultVertexLocation
	}
	geminiAPIKey := os.Getenv("GEMINI_API_KEY")
	gatewayEnabled := os.Getenv("AI_GATEWAY_ENABLED") == "true"
	gatewayAPIKey := os.Getenv("AI_GATEWAY_API_KEY")
	gatewayBaseURL := os.Getenv("AI_GATEWAY_BASE_URL")
	gatewayModel := os.Getenv("AI_GATEWAY_MODEL")
	if gatewayModel == "" {
		gatewayModel = "kora-auto"
	}

	// An unconfigured environment SKIPS AND EXITS 0, even though the rest of
	// this command now treats stopping early as a failure. The two are not the
	// same event. Giving up is a run that was asked to embed rows and could
	// not; this is a deployment that never asked. cmd/embed is chained into
	// the sync-wave-0 seed Job, which must stay green in environments that
	// deliberately run without AI credentials (CI, a bare dev cluster) — the
	// same tolerance cmd/api shows by leaving the resolve endpoints unmounted
	// rather than refusing to boot. Failing here would red-line those
	// environments permanently on a condition that is correct for them, which
	// is exactly the kind of always-on alarm that trained everyone to ignore
	// this Job in the first place.
	backend := chooseBackend(gatewayEnabled, vertexProject, geminiAPIKey)
	if backend == backendNone {
		log.Println("cmd/embed: no embedding backend (AI gateway, VERTEX_PROJECT, and GEMINI_API_KEY are unset); skipping")
		os.Exit(0)
	}
	if backend == backendGateway && (gatewayAPIKey == "" || gatewayBaseURL == "") {
		log.Fatal("cmd/embed: AI_GATEWAY_API_KEY and AI_GATEWAY_BASE_URL are required when AI_GATEWAY_ENABLED=true")
	}

	ctx := context.Background()

	db, err := database.Connect(url)
	if err != nil {
		log.Fatal(err)
	}
	repo := nutrition.NewRepository(db)

	var provider embedder
	switch backend {
	case backendGateway:
		provider = providers.NewAgentGatewayProvider(gatewayAPIKey, gatewayBaseURL, gatewayModel)
		log.Printf("cmd/embed: private agent gateway model=%s base_url=%s", gatewayModel, gatewayBaseURL)
	case backendVertex:
		provider, err = providers.NewVertexProvider(ctx, vertexProject, vertexLocation)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("cmd/embed: vertex ai project=%s location=%s", vertexProject, vertexLocation)
	case backendGemini:
		provider, err = providers.NewGeminiProvider(ctx, geminiAPIKey)
		if err != nil {
			log.Fatal(err)
		}
		log.Println("cmd/embed: gemini api key")
	}

	res := run(ctx, repo, provider, billing.NewMeter(db))
	log.Printf("cmd/embed: embedded %d food items, failed %d, gave up %t", res.embedded, res.failed, res.gaveUp)
	os.Exit(exitCode(res))
}

// isRateLimited reports whether err is the provider's rate-limit / quota
// rejection rather than a transient blip. The genai SDK surfaces every non-2xx
// response as a genai.APIError carrying the HTTP status in Code (see
// newAPIError in google.golang.org/genai/api_client.go), and
// providers.GeminiProvider.Embed wraps that error with %w, so errors.As
// reaches it through the wrapping.
//
// The message fallback is a deliberate backstop, not a guess: the embedder
// interface is provider-agnostic (an ai.Router-backed embedder can surface an
// OpenAI-compatible error instead), and any layer that stringifies the error
// before it reaches here would defeat errors.As. Matching the documented
// Gemini/HTTP vocabulary — 429, RESOURCE_EXHAUSTED, "rate limit", "quota" —
// is the best available signal in that case. A false positive costs one
// missed retry; a false negative costs three requests against the very quota
// that just rejected us.
func isRateLimited(err error) bool {
	if err == nil {
		return false
	}
	var apiErr genai.APIError
	if errors.As(err, &apiErr) &&
		(apiErr.Code == http.StatusTooManyRequests || strings.EqualFold(apiErr.Status, "RESOURCE_EXHAUSTED")) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "429") ||
		strings.Contains(msg, "resource_exhausted") ||
		strings.Contains(msg, "rate limit") ||
		strings.Contains(msg, "ratelimit") ||
		strings.Contains(msg, "too many requests") ||
		strings.Contains(msg, "quota")
}

// embedWithRetry absorbs a transient provider blip. The 2026-08-02 run lost
// 69 rows to exactly that and reported success. Three attempts, not more: a
// sustained outage is already handled by the whole-batch bail-out below, and
// retrying every row five times against a dead provider only delays the same
// answer.
//
// A rate-limit rejection is exempted from retrying entirely. The documented
// production failure is Gemini's free-tier ~100 req/min cap; retrying spends
// three requests per row against the quota whose exhaustion caused the
// failure, which makes the outage worse and deeper. Fail the row on the first
// 429 and let it stay in RowsMissingEmbedding for the next run.
//
// EVERY ATTEMPT IS METERED, not just the one whose result is returned. Each
// one reached the provider and consumed its quota, so a run that burns three
// calls per row must show three. Recording only successes is how a failing
// path comes to look free — the exact under-count #81 removed from the
// user-facing metering.
func embedWithRetry(ctx context.Context, e embedder, rec usageRecorder, name string) ([]float32, error) {
	var lastErr error
	delay := embedBaseDelay
	for attempt := 1; attempt <= embedAttempts; attempt++ {
		vec, usage, err := e.Embed(ctx, name)
		if err == nil {
			meter(ctx, rec, usage, ai.OutcomeOK)
			return vec, nil
		}
		meter(ctx, rec, usage, ai.OutcomeError)
		lastErr = err
		if isRateLimited(err) {
			return nil, err
		}
		if attempt < embedAttempts {
			time.Sleep(delay)
			delay *= 2
		}
	}
	return nil, lastErr
}

// outcome is what one run achieved. gaveUp is the field that decides the exit
// code; embedded and failed are for the operator's log line.
type outcome struct {
	embedded int
	failed   int
	// gaveUp reports that run STOPPED EARLY with work still outstanding —
	// either it could not read the queue at all, or a whole batch failed and
	// continuing would have re-fetched the same never-completed rows forever.
	// It is false only when run drained the queue: RowsMissingEmbedding came
	// back empty, meaning everything it was asked to embed is embedded.
	gaveUp bool
}

// exitCode maps a run's outcome to a process exit code: red if and only if the
// run gave up.
//
// THIS REVERSES THE EARLIER "progress means green" RULING, deliberately.
// That rule returned 0 whenever the run embedded at least one row, so a run
// that logged "entire batch of 100 rows failed to embed; stopping" after
// finishing 11% of its work still exited 0. The Kubernetes Job reported
// Complete, ArgoCD stayed green, and the food index sat at 42% embedded for
// weeks with nobody notified (kora#97). An exit code that cannot say "I
// stopped early" is not reporting on the thing that goes wrong.
//
// The two objections the old ruling raised are answered rather than ignored:
//
//   - "A partial rate-limit failure red-lines real progress, then re-runs the
//     whole seed/ingest/embed chain up to six times against the very quota
//     that was exhausted." That objection was about the free tier's ~1,000/day
//     embedding cap. The backfill now runs on Vertex against a billing-enabled
//     project (see chooseBackend), so the quota that made a retry storm
//     destructive is gone. And note the old rule did not actually prevent the
//     retries — a rate limit that empties the FIRST batch was red under it too.
//   - "One permanently un-embeddable row red-lines every deploy forever."
//     True, and that is now the intended report: it means the index can never
//     be completed, which is a bug in a row or in the embedder, not weather.
//     The old rule's answer was the kora_food_index_missing gauge — which
//     existed throughout the period the index sat at 42% and did not raise
//     anyone. A permanent red is at least read once.
//
// Two shapes stay GREEN, and both matter:
//
//   - a run that embedded everything it was asked to, however much or little;
//     and
//   - a run with nothing to do (the steady state — this Job runs on every
//     ArgoCD sync, and almost every one of those has an empty queue).
func exitCode(o outcome) int {
	if o.gaveUp {
		return 1
	}
	return 0
}

// run streams food_items missing an embedding, embeds each with retry, and
// reports how many succeeded, how many failed permanently, and whether it
// stopped short of draining the queue.
func run(ctx context.Context, s store, e embedder, rec usageRecorder) outcome {
	var o outcome
	for {
		rows, err := s.RowsMissingEmbedding(ctx, batchSize)
		if err != nil {
			log.Printf("cmd/embed: fetch rows: %v", err)
			o.failed++
			o.gaveUp = true
			return o
		}
		if len(rows) == 0 {
			// The queue is drained: everything asked for is embedded. This is
			// the only successful exit from the loop.
			return o
		}

		succeeded := 0
		for _, row := range rows {
			vec, err := embedWithRetry(ctx, e, rec, row.Name)
			if err != nil {
				log.Printf("cmd/embed: embed %q (%s): %v", row.Name, row.ID, err)
				o.failed++
				continue
			}
			if err := s.SetEmbedding(ctx, row.ID, vec); err != nil {
				log.Printf("cmd/embed: set embedding %q (%s): %v", row.Name, row.ID, err)
				o.failed++
				continue
			}
			o.embedded++
			succeeded++
		}

		// A batch where nothing succeeded would return the same rows forever —
		// they are never marked done. Stop, and say so: this is giving up with
		// work outstanding, which exitCode reports as a failure however many
		// rows earlier batches managed.
		if succeeded == 0 {
			log.Printf("cmd/embed: entire batch of %d rows failed to embed; stopping", len(rows))
			o.gaveUp = true
			return o
		}
	}
}
