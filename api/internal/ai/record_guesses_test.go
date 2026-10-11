//go:build eval

// Records what identify ACTUALLY emits for a list of phrases, so ranking cases
// carry real provider output instead of guesses someone imagined.
//
//	set -a && . ./.env && set +a
//	KORA_EVAL=1 KORA_EVAL_RECORD=1 \
//	  go test -tags eval ./internal/ai/ -run TestRecordGuesses -v
//
// COSTS MONEY and is nondeterministic, which is why it is gated behind its own
// KORA_EVAL_RECORD flag on top of KORA_EVAL: the ranking harness must stay free
// and byte-stable, and nothing in CI may ever call a provider.
//
// It goes through ai.Router — the real production path, primary plus fallback —
// rather than either provider directly. A stub or a bare provider here would
// record output the product never actually produces, which is the whole failure
// this file exists to avoid.
//
// Output is ranking-dataset JSONL on stdout and to KORA_EVAL_RECORD_OUT. It is
// NOT written into ranking.sample.jsonl automatically: every recorded case still
// needs a human to decide whether the right answer is genuinely known before it
// earns an expected_name.
package ai_test

import (
	"bufio"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/ai/providers"
	"github.com/tesserix/kora/api/internal/config"
)

func TestRecordGuesses(t *testing.T) {
	requireEval(t)
	if os.Getenv("KORA_EVAL_RECORD") == "" {
		t.Skip("set KORA_EVAL_RECORD=1 to call the live provider (costs money)")
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	ctx := evalContext(t)

	// The primary honours KORA_EVAL_PROVIDER (see evalProvider in eval_test.go),
	// so this can record through the agent gateway — the provider production
	// actually runs — and not only through direct Gemini. Recording gemini and
	// calling it the production baseline describes a path nobody is on.
	// Default is unchanged: no KORA_EVAL_PROVIDER still means direct Gemini.
	primary := evalProvider(t, cfg)
	// The real production shape, mirroring buildResolveHandler in cmd/api: a
	// Router ONLY when a fallback exists, and the bare provider otherwise.
	//
	// This used to build &ai.Router{Primary: primary} with a nil Fallback and
	// claim it "still works, it simply has nothing to fall back TO". It does
	// not: Router.IdentifyText's fallback closure dereferences r.Fallback
	// unconditionally (router.go:271), so the first phrase the primary fails
	// or times out on panics on a nil pointer instead of surfacing the error.
	// Production never hits it because main.go:330 only constructs a Router
	// when a fallback is configured — so the fix here is to match that shape
	// rather than to record through a Router production would never build.
	var under ai.Provider = primary
	if cfg.OpenAIAPIKey != "" {
		under = &ai.Router{
			Primary:  primary,
			Fallback: providers.NewOpenAIProvider(cfg.OpenAIAPIKey, cfg.OpenAIBaseURL, cfg.OpenAIModel, cfg.OpenAIJSONObject),
		}
	} else {
		t.Log("no OPENAI_API_KEY: recording through the primary alone, exactly as production runs with no fallback configured")
	}

	phrases := loadPhrases(t)
	stamp := time.Now().UTC().Format("2006-01-02")

	outPath := os.Getenv("KORA_EVAL_RECORD_OUT")
	if outPath == "" {
		outPath = filepath.Join("..", "..", "testdata", "eval", "recorded.jsonl")
	}
	f, err := os.Create(outPath)
	if err != nil {
		t.Fatalf("create %s: %v", outPath, err)
	}
	defer f.Close()

	// Token and latency totals make a run comparable against another provider,
	// which is the whole point of being able to aim this at the gateway: #251
	// gates the rollout on quality, latency and token savings, and none of the
	// three can be argued without a number from both arms over one phrase set.
	// KORA_EVAL_RECORD_DELAY paces the run. A free-tier Gemini key allows 15
	// requests/minute, and an unpaced 50-phrase run burns through it in seconds
	// — which does not read as a rate limit, it reads as the provider being
	// broken for half the dataset. Pacing is what makes the arm a baseline
	// rather than a partial one. Default is 0: a paid key or the gateway needs
	// no delay, and forcing one on every run would quadruple its wall time.
	var delay time.Duration
	if raw := os.Getenv("KORA_EVAL_RECORD_DELAY"); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil {
			t.Fatalf("KORA_EVAL_RECORD_DELAY %q: %v", raw, err)
		}
		delay = d
		t.Logf("pacing %v between phrases", delay)
	}

	var recorded, failed int
	var inTokens, outTokens, estimated int
	var latencies []float64
	for i, phrase := range phrases {
		if delay > 0 && i > 0 {
			time.Sleep(delay)
		}
		start := time.Now()
		guesses, usage, err := under.IdentifyText(ctx, phrase)
		elapsed := time.Since(start)
		if err != nil {
			// Loud, and NOT fatal: one phrase the provider refuses must not
			// discard the whole recording run.
			t.Errorf("identify %q: %v", phrase, err)
			failed++
			continue
		}
		line, err := json.Marshal(map[string]any{
			"phrase":  phrase,
			"guesses": guesses,
			"note":    "RECORDED from the live provider via ai.Router on " + stamp + ". expected_name deliberately unset — see README: it is only recorded where the right answer is genuinely known.",
		})
		if err != nil {
			t.Fatalf("marshal %q: %v", phrase, err)
		}
		if _, err := f.Write(append(line, '\n')); err != nil {
			t.Fatalf("write: %v", err)
		}
		t.Logf("%-28s -> %s", phrase, summarise(guesses))
		inTokens += usage.TokensIn
		outTokens += usage.TokensOut
		if usage.Estimated {
			// A run whose tokens are proxies rather than provider-reported
			// counts cannot settle a token-savings argument. Surface it rather
			// than letting an estimate be quoted as a measurement.
			estimated++
		}
		latencies = append(latencies, elapsed.Seconds())
		recorded++
	}
	t.Logf("recorded %d phrase(s), %d failed, into %s", recorded, failed, outPath)
	t.Logf("provider=%s tokens: in=%d out=%d total=%d (per phrase in=%.1f out=%.1f), estimated_calls=%d/%d",
		primary.Name(), inTokens, outTokens, inTokens+outTokens,
		perPhrase(inTokens, recorded), perPhrase(outTokens, recorded), estimated, recorded)
	t.Logf("provider=%s latency_s: median=%.2f p95=%.2f max=%.2f (n=%d)",
		primary.Name(), median(latencies), percentile(latencies, 0.95), percentile(latencies, 1.0), len(latencies))
}

func perPhrase(total, n int) float64 {
	if n == 0 {
		return 0
	}
	return float64(total) / float64(n)
}

// percentile takes the nearest-rank value of a sorted copy. Deliberately not
// interpolating: these runs are tens of samples, where interpolation invents
// precision the sample size does not support.
func percentile(xs []float64, p float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sorted := append([]float64(nil), xs...)
	sort.Float64s(sorted)
	i := int(math.Ceil(p*float64(len(sorted)))) - 1
	if i < 0 {
		i = 0
	}
	if i >= len(sorted) {
		i = len(sorted) - 1
	}
	return sorted[i]
}

func summarise(gs []ai.Guess) string {
	parts := make([]string, 0, len(gs))
	for _, g := range gs {
		s := g.Food
		if g.Brand != "" {
			s += " [brand=" + g.Brand + "]"
		}
		if g.CookingMethod != "" {
			s += " [" + g.CookingMethod + "]"
		}
		if len(g.Qualifiers) > 0 {
			s += " (" + strings.Join(g.Qualifiers, ",") + ")"
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, " + ")
}

// loadPhrases reads one phrase per line from the AU phrase list, skipping blanks
// and # comments.
func loadPhrases(t *testing.T) []string {
	t.Helper()
	path := os.Getenv("KORA_EVAL_PHRASES")
	if path == "" {
		path = filepath.Join("..", "..", "testdata", "eval", "au_phrases.txt")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open phrases %s: %v", path, err)
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out = append(out, line)
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("read phrases: %v", err)
	}
	if len(out) == 0 {
		t.Fatalf("no phrases in %s", path)
	}
	return out
}
