// Command aieval runs the real resolver over a golden Langfuse dataset through
// the AI gateway, records the run as a Langfuse experiment and gates it against
// the dataset's accepted baseline. Exit 0 passes, 1 regressed, 2 could not run.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/aieval"
	"github.com/tesserix/kora/api/internal/aitrace"
	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
)

const (
	exitRegressed = 1
	exitBroken    = 2
	signInURL     = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key="
)

func main() {
	dataset := flag.String("dataset", "kora-capture-text", "Langfuse dataset to run")
	seed := flag.String("seed", "", "upsert labelled cases from this JSONL file into the dataset, then exit")
	run := flag.String("run", "", "experiment run name (default <dataset>-<UTC time>)")
	accept := flag.Bool("accept", false, "accept this run as the dataset's new baseline")
	flag.Parse()

	ctx := context.Background()
	host, publicKey, secretKey := os.Getenv("KORA_LANGFUSE_HOST"), os.Getenv("KORA_LANGFUSE_PUBLIC_KEY"), os.Getenv("KORA_LANGFUSE_SECRET_KEY")
	if host == "" || publicKey == "" || secretKey == "" {
		fail(fmt.Errorf("KORA_LANGFUSE_HOST, KORA_LANGFUSE_PUBLIC_KEY and KORA_LANGFUSE_SECRET_KEY are required"))
	}
	lf := aieval.NewClient(host, publicKey, secretKey)
	if *seed != "" {
		fail(seedDataset(ctx, lf, *dataset, *seed))
		return
	}
	if *run == "" {
		*run = *dataset + "-" + time.Now().UTC().Format("20060102T1504Z")
	}
	os.Exit(evaluate(ctx, lf, *dataset, *run, *accept))
}

func evaluate(ctx context.Context, lf *aieval.Client, dataset, run string, accept bool) int {
	items, err := lf.Items(ctx, dataset)
	if err != nil || len(items) == 0 {
		slog.Error("aieval: no items to run", "dataset", dataset, "err", err)
		return exitBroken
	}
	baseline, hasBaseline, err := lf.Baseline(ctx, dataset)
	if err != nil {
		slog.Error("aieval: baseline unreadable", "err", err)
		return exitBroken
	}
	resolver, err := buildResolver()
	if err != nil {
		slog.Error("aieval: resolver unavailable", "err", err)
		return exitBroken
	}
	ctx, err = withEndUserToken(ctx)
	if err != nil {
		slog.Error("aieval: no end-user token for the gateway", "err", err)
		return exitBroken
	}
	shutdown, err := aitrace.Setup(ctx, aitrace.Config{Endpoint: os.Getenv("KORA_AI_TRACE_ENDPOINT"), Environment: "eval", Release: os.Getenv("KORA_RELEASE")})
	if err != nil {
		slog.Error("aieval: tracing unavailable", "err", err)
		return exitBroken
	}
	summary := aieval.Summarize(aieval.Run(ctx, resolver, lf, run, items))
	flushCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := shutdown(flushCtx); err != nil {
		slog.Warn("aieval: traces not flushed", "err", err)
	}

	report, _ := json.Marshal(map[string]any{"dataset": dataset, "run": run, "summary": summary, "baseline": baseline})
	fmt.Println(string(report))
	if accept {
		if err := lf.AcceptBaseline(ctx, dataset, summary, run); err != nil {
			slog.Error("aieval: baseline not accepted", "err", err)
			return exitBroken
		}
		slog.Info("aieval: baseline accepted", "run", run)
		return 0
	}
	if !hasBaseline {
		slog.Warn("aieval: no accepted baseline yet; rerun with -accept to set one", "dataset", dataset)
		return 0
	}
	if regressions := aieval.Compare(summary, baseline); len(regressions) > 0 {
		for _, r := range regressions {
			slog.Error("aieval: regression", "detail", r)
		}
		return exitRegressed
	}
	slog.Info("aieval: no regression against baseline", "run", run)
	return 0
}

func seedDataset(ctx context.Context, lf *aieval.Client, dataset, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	items, err := aieval.SeedItems(dataset, f)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	for _, it := range items {
		if err := lf.UpsertItem(ctx, dataset, it); err != nil {
			return err
		}
	}
	slog.Info("aieval: seeded", "dataset", dataset, "items", len(items))
	return nil
}

// buildResolver matches production's gateway wiring, minus the cache so every item reaches the model.
func buildResolver() (ai.Resolver, error) {
	baseURL, key := os.Getenv("AI_GATEWAY_BASE_URL"), os.Getenv("AI_GATEWAY_API_KEY")
	if baseURL == "" || key == "" {
		return ai.Resolver{}, fmt.Errorf("AI_GATEWAY_BASE_URL and AI_GATEWAY_API_KEY are required")
	}
	model := os.Getenv("AI_GATEWAY_MODEL")
	if model == "" {
		model = "kora-auto"
	}
	db, err := database.Connect(os.Getenv("DATABASE_URL"))
	if err != nil {
		return ai.Resolver{}, fmt.Errorf("connect database: %w", err)
	}
	provider := providers.NewAgentGatewayProvider(key, baseURL, model)
	foods := nutrition.NewRepository(db).WithEmbedder(embedder{p: provider})
	return ai.NewResolver(provider, foods, ai.NoCache{}, noMeter{}), nil
}

// withEndUserToken supplies the Firebase ID token the gateway requires, minting one for the eval account when none is given.
func withEndUserToken(ctx context.Context) (context.Context, error) {
	if token := os.Getenv("KORA_EVAL_END_USER_TOKEN"); token != "" {
		return auth.WithVerifiedToken(ctx, token), nil
	}
	apiKey, email, password := os.Getenv("KORA_EVAL_FIREBASE_API_KEY"), os.Getenv("KORA_EVAL_EMAIL"), os.Getenv("KORA_EVAL_PASSWORD")
	if apiKey == "" || email == "" || password == "" {
		return ctx, fmt.Errorf("set KORA_EVAL_END_USER_TOKEN, or KORA_EVAL_FIREBASE_API_KEY, KORA_EVAL_EMAIL and KORA_EVAL_PASSWORD")
	}
	body, _ := json.Marshal(map[string]any{"email": email, "password": password, "returnSecureToken": true})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, signInURL+apiKey, bytes.NewReader(body))
	if err != nil {
		return ctx, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return ctx, fmt.Errorf("sign in eval account: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		IDToken string `json:"idToken"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&out) != nil || out.IDToken == "" {
		return ctx, fmt.Errorf("sign in eval account: status %d", resp.StatusCode)
	}
	return auth.WithVerifiedToken(ctx, out.IDToken), nil
}

type embedder struct{ p ai.Provider }

func (e embedder) Embed(ctx context.Context, text string) ([]float32, error) {
	vec, _, err := e.p.Embed(ctx, text)
	return vec, err
}

// noMeter keeps eval spend out of real users' AI budgets.
type noMeter struct{}

func (noMeter) Record(context.Context, uuid.UUID, ai.Usage, float64) error { return nil }

func (noMeter) WithinBudget(context.Context, uuid.UUID) (bool, error) { return true, nil }

func fail(err error) {
	if err != nil {
		slog.Error("aieval", "err", strings.TrimSpace(err.Error()))
		os.Exit(exitBroken)
	}
}
