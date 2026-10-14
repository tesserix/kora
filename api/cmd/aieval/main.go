// Command aieval runs the real resolver over a golden Langfuse dataset through
// the AI gateway, records the run as a Langfuse experiment and gates it against
// the dataset's accepted baseline. Exit 0 passes, 1 regressed, 2 could not run.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
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
	defaultIssuer = "https://auth.tesserix.app"
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
	if !hasBaseline && !accept {
		slog.Error("aieval: no accepted baseline; run with -accept to establish one", "dataset", dataset)
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
	results, runErr := aieval.Run(ctx, resolver, lf, run, items)
	summary := aieval.Summarize(results)
	flushCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := shutdown(flushCtx); err != nil {
		slog.Warn("aieval: traces not flushed", "err", err)
	}

	if runErr != nil {
		slog.Error("aieval: experiment incomplete", "err", runErr)
		return exitBroken
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

// withEndUserToken supplies the Zitadel access token the gateway requires,
// minting one for the eval machine user when none is given.
func withEndUserToken(ctx context.Context) (context.Context, error) {
	if token := os.Getenv("KORA_EVAL_END_USER_TOKEN"); token != "" {
		return auth.WithVerifiedToken(ctx, token), nil
	}
	issuer := strings.TrimSuffix(os.Getenv("ZITADEL_ISSUER"), "/")
	if issuer == "" {
		issuer = defaultIssuer
	}
	projectID, clientID, secret := os.Getenv("ZITADEL_PROJECT_ID"), os.Getenv("KORA_EVAL_CLIENT_ID"), os.Getenv("KORA_EVAL_CLIENT_SECRET")
	if projectID == "" || clientID == "" || secret == "" {
		return ctx, fmt.Errorf("set KORA_EVAL_END_USER_TOKEN, or ZITADEL_PROJECT_ID, KORA_EVAL_CLIENT_ID and KORA_EVAL_CLIENT_SECRET")
	}
	token, err := mintEvalToken(ctx, issuer+"/oauth/v2/token", projectID, clientID, secret)
	if err != nil {
		return ctx, err
	}
	return auth.WithVerifiedToken(ctx, token), nil
}

// mintEvalToken runs the client credentials grant for the eval machine user.
// The project audience scope is what lets the gateway's Kora rule accept the
// token. The machine user must be set to issue JWT access tokens: an opaque
// one would fail every gateway call, so it is refused here with that cause.
func mintEvalToken(ctx context.Context, tokenURL, projectID, clientID, secret string) (string, error) {
	form := url.Values{
		"grant_type": {"client_credentials"},
		"scope":      {"openid urn:zitadel:iam:org:project:id:" + projectID + ":aud"},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth(url.QueryEscape(clientID), url.QueryEscape(secret))
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return "", fmt.Errorf("mint eval token: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&out) != nil || out.AccessToken == "" {
		return "", fmt.Errorf("mint eval token: status %d", resp.StatusCode)
	}
	if strings.Count(out.AccessToken, ".") != 2 {
		return "", fmt.Errorf("mint eval token: not a JWT; set the eval machine user's access token type to JWT")
	}
	return out.AccessToken, nil
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
