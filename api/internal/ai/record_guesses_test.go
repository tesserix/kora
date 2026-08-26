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
	"context"
	"encoding/json"
	"os"
	"path/filepath"
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
	ctx := context.Background()

	gemini, err := providers.NewGeminiProvider(ctx, cfg.GeminiAPIKey)
	if err != nil {
		t.Fatalf("gemini init: %v", err)
	}
	// The real production shape: Router with a primary and a fallback. If the
	// fallback is unconfigured the Router still works, it simply has nothing to
	// fall back TO — recorded output is then primary-only, which is worth
	// knowing and is why this logs it rather than silently proceeding.
	router := &ai.Router{Primary: gemini}
	if cfg.OpenAIAPIKey != "" {
		router.Fallback = providers.NewOpenAIProvider(cfg.OpenAIAPIKey, cfg.OpenAIBaseURL, cfg.OpenAIModel, cfg.OpenAIJSONObject)
	} else {
		t.Log("no OPENAI_API_KEY: recording through the primary only, with no fallback")
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

	var recorded, failed int
	for _, phrase := range phrases {
		guesses, _, err := router.IdentifyText(ctx, phrase)
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
		recorded++
	}
	t.Logf("recorded %d phrase(s), %d failed, into %s", recorded, failed, outPath)
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
