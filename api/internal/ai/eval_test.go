//go:build eval

// Eval harness for the resolution engine. NOT part of `go test` — run with:
//
//	set -a && . ./.env && set +a
//	KORA_EVAL=1 KORA_EVAL_PROVIDER=gemini \
//	  go test -tags eval ./internal/ai/ -run TestEvalChat -v
//
// Point KORA_EVAL_DATASET at a dir of chat.jsonl/photos.jsonl (defaults to
// ../../testdata/eval using chat.sample.jsonl when chat.jsonl is absent).
// KORA_EVAL_PROVIDER=gemini|gateway|fallback selects the provider under test for
// A/B. Use "gateway" to measure the path production actually serves.
//
// NOTE: this is package ai_test (external test package), not package ai.
// package ai/providers imports package ai (for ai.Guess/ai.Usage), so a
// same-package test file here that also imports providers would be a compile
// import cycle regardless of build tags. ai_test avoids that the standard Go
// way, at the cost of needing an `ai.` qualifier on every exported symbol
// used below (all of which are already exported).
package ai_test

import (
	"bufio"
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/auth"
	"github.com/tesserix/kora/api/internal/config"
	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
)

type chatCase struct {
	Phrase       string  `json:"phrase"`
	ExpectedName string  `json:"expected_name"`
	ExpectedKcal float64 `json:"expected_kcal"`
	Grams        float64 `json:"grams"`
}

func requireEval(t *testing.T) {
	if os.Getenv("KORA_EVAL") != "1" {
		t.Skip("set KORA_EVAL=1 to run the eval harness")
	}
}

// evalProvider builds the provider under test from KORA_EVAL_PROVIDER.
//
// "gateway" is the one that matters for release decisions: production runs with
// AI_GATEWAY_ENABLED=true and config.go refuses to boot without it, so the
// direct Gemini path this harness used to be limited to is NOT what serves
// users. Measuring gemini and reporting it as the production quality number
// measures a path nobody is on. Run gemini and gateway over the same dataset to
// get the A/B the gateway rollout was supposed to be gated on.
//
// The gateway is in-cluster (ClusterIP), so a run from a laptop needs a
// port-forward and AI_GATEWAY_BASE_URL pointed at it:
//
//	kubectl -n agentgateway-system port-forward svc/kora-ai 8080:8080
//	AI_GATEWAY_BASE_URL=http://localhost:8080/v1 \
//	AI_GATEWAY_API_KEY=$(kubectl -n kora get secret \
//	  kora-ai-gateway-client-credentials -o jsonpath='{.data.kora-api}' | base64 -d) \
//	KORA_EVAL=1 KORA_EVAL_PROVIDER=gateway \
//	  go test -tags eval ./internal/ai/ -run TestEvalChat -v
//
// Each branch constructs only the provider it returns. Building Gemini
// unconditionally used to make a gateway or fallback run impossible without a
// Gemini key it never called.
func evalProvider(t *testing.T, cfg config.Config) ai.Provider {
	switch os.Getenv("KORA_EVAL_PROVIDER") {
	case "gateway":
		if cfg.AIGatewayBaseURL == "" || cfg.AIGatewayAPIKey == "" {
			t.Skip("KORA_EVAL_PROVIDER=gateway but AI_GATEWAY_BASE_URL/AI_GATEWAY_API_KEY are unset")
		}
		return providers.NewAgentGatewayProvider(cfg.AIGatewayAPIKey, cfg.AIGatewayBaseURL, cfg.AIGatewayModel)
	case "fallback":
		if cfg.OpenAIAPIKey == "" {
			t.Skip("KORA_EVAL_PROVIDER=fallback but no OPENAI_API_KEY set")
		}
		return providers.NewOpenAIProvider(cfg.OpenAIAPIKey, cfg.OpenAIBaseURL, cfg.OpenAIModel, cfg.OpenAIJSONObject)
	default:
		gemini, err := providers.NewGeminiProvider(context.Background(), cfg.GeminiAPIKey)
		if err != nil {
			t.Fatalf("gemini init: %v", err)
		}
		return gemini
	}
}

// evalContext returns the context the harness makes provider calls with.
//
// KORA_EVAL_END_USER_TOKEN carries a Firebase ID token, which the gateway
// REQUIRES on the conversation, structured and default sections of the kora-ai
// route (AgentgatewayPolicy/kora-user-auth, jwtAuthentication Strict). Without
// it every identify, decompose and coach call through the gateway returns
// 401 "authentication failure: no bearer token found" — so a gateway arm for
// anything other than embeddings cannot run without one.
//
// Mint one against the project's Firebase Web API key; it is valid ~1h, which
// is far longer than a 50-phrase run. Nothing is persisted here: the token is
// read from the environment and never written to the recorded output.
func evalContext(t *testing.T) context.Context {
	ctx := context.Background()
	token := os.Getenv("KORA_EVAL_END_USER_TOKEN")
	if token == "" {
		if os.Getenv("KORA_EVAL_PROVIDER") == "gateway" {
			t.Log("KORA_EVAL_PROVIDER=gateway with no KORA_EVAL_END_USER_TOKEN: " +
				"non-embedding calls will 401 (see AgentgatewayPolicy/kora-user-auth)")
		}
		return ctx
	}
	return auth.WithVerifiedToken(ctx, token)
}

func loadChatCases(t *testing.T) []chatCase {
	dir := os.Getenv("KORA_EVAL_DATASET")
	if dir == "" {
		dir = filepath.Join("..", "..", "testdata", "eval")
	}
	path := filepath.Join(dir, "chat.jsonl")
	if _, err := os.Stat(path); err != nil {
		path = filepath.Join(dir, "chat.sample.jsonl")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open dataset: %v", err)
	}
	defer f.Close()
	var cases []chatCase
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var c chatCase
		if err := json.Unmarshal([]byte(line), &c); err != nil {
			t.Fatalf("bad dataset line %q: %v", line, err)
		}
		cases = append(cases, c)
	}
	return cases
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sort.Float64s(xs)
	n := len(xs)
	if n%2 == 1 {
		return xs[n/2]
	}
	return (xs[n/2-1] + xs[n/2]) / 2
}

func TestEvalChat(t *testing.T) {
	requireEval(t)
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	foods := nutrition.NewRepository(db)
	provider := evalProvider(t, cfg)
	resolver := ai.NewResolver(provider, foods, ai.NoCache{}, unlimitedMeter{})

	cases := loadChatCases(t)
	if len(cases) == 0 {
		t.Skip("no chat cases in dataset")
	}

	var idHits, resolved, hallucinated int
	var kcalErrs []float64
	uid := uuid.New()
	ctx := context.Background()

	for _, c := range cases {
		res, err := resolver.ResolveText(ctx, uid, c.Phrase)
		if err != nil {
			t.Logf("resolve %q: %v", c.Phrase, err)
			continue
		}
		if len(res.Candidates) == 0 {
			continue
		}
		resolved++
		top := res.Candidates[0]
		if top.Item.ID == uuid.Nil {
			hallucinated++ // no real row backing the candidate
		}
		if strings.Contains(strings.ToLower(top.Item.Name), strings.ToLower(c.ExpectedName)) {
			idHits++
		}
		if c.ExpectedKcal > 0 {
			refKcal := c.ExpectedKcal
			gotKcal := top.Item.KcalPer100g * c.Grams / 100
			kcalErrs = append(kcalErrs, math.Abs(gotKcal-refKcal)/refKcal)
		}
	}

	n := float64(len(cases))
	idAcc := float64(idHits) / n
	resolvedRate := float64(resolved) / n
	medErr := median(kcalErrs)
	t.Logf("provider=%s chat: id_acc=%.2f resolved=%.2f median_kcal_err=%.2f hallucinated=%d (n=%d)",
		provider.Name(), idAcc, resolvedRate, medErr, hallucinated, len(cases))

	if hallucinated != 0 {
		t.Errorf("hallucinated rows: %d (want 0)", hallucinated)
	}
	if idAcc < 0.90 {
		t.Errorf("chat top-1 id accuracy %.2f < 0.90", idAcc)
	}
	if resolvedRate < 0.90 {
		t.Errorf("resolved-entry correctness %.2f < 0.90", resolvedRate)
	}
	if len(kcalErrs) > 0 && medErr > 0.20 {
		t.Errorf("median kcal error %.2f > 0.20", medErr)
	}
}

// unlimitedMeter satisfies the resolver's Meter interface without touching the
// billing table — the eval measures resolution quality, not budget.
type unlimitedMeter struct{}

func (unlimitedMeter) Record(ctx context.Context, userID uuid.UUID, u ai.Usage, costUSD float64) error {
	return nil
}
func (unlimitedMeter) WithinBudget(ctx context.Context, userID uuid.UUID) (bool, error) {
	return true, nil
}
