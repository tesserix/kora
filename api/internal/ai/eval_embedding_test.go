//go:build eval

// Cross-provider embedding agreement check. NOT part of `go test` — run with:
//
//	set -a && . ./.env && set +a
//	KORA_EVAL=1 KORA_EVAL_EMBED_OUT=/tmp/emb.gemini.json \
//	  go test -tags eval ./internal/ai/ -run TestEvalEmbedding -v
//
// then the other arm, comparing against the first:
//
//	KORA_EVAL=1 KORA_EVAL_PROVIDER=gateway \
//	KORA_EVAL_EMBED_OUT=/tmp/emb.gateway.json \
//	KORA_EVAL_EMBED_BASELINE=/tmp/emb.gemini.json \
//	  go test -tags eval ./internal/ai/ -run TestEvalEmbedding -v
//
// WHY this exists, and why it is the embedding path specifically:
//
// The food index is embedded once, offline, by cmd/embed — which has its own
// AI_GATEWAY_ENABLED switch. Queries are embedded at request time by the API,
// which has another. If those two paths ever produce different vectors for the
// same text, nothing errors: nutrition.Resolve's embedding tier just quietly
// retrieves worse matches forever. An index built through one provider and
// queried through the other is a silent recall regression, which is exactly
// the class of failure a rollout gate is supposed to catch and exactly what no
// test covered.
//
// Cosine similarity is the measurement because that is what retrieval actually
// uses; identical bytes are not required and would be a stricter bar than the
// system cares about.
//
// The embedding route is also the ONLY gateway capability reachable without a
// Firebase end-user token: AgentgatewayPolicy/kora-user-auth targets the
// conversation, structured and default sections of the kora-ai HTTPRoute, and
// the embedding section is not among them. So this arm can be run today while
// identify and coach cannot.
package ai_test

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tesserix/kora/api/internal/config"
)

// embedFloor is the cosine similarity below which two providers are treated as
// disagreeing. Deliberately strict: both paths request gemini-embedding-001 at
// 768 dimensions, so anything materially below 1.0 means they are NOT the same
// embedding space and the index cannot be shared between them.
const embedFloor = 0.99

func cosine(a, b []float32) float64 {
	if len(a) != len(b) || len(a) == 0 {
		return 0
	}
	var dot, na, nb float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		na += float64(a[i]) * float64(a[i])
		nb += float64(b[i]) * float64(b[i])
	}
	if na == 0 || nb == 0 {
		return 0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

func TestEvalEmbedding(t *testing.T) {
	requireEval(t)
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	provider := evalProvider(t, cfg)
	phrases := loadPhrases(t)
	ctx := context.Background()

	vectors := make(map[string][]float32, len(phrases))
	var tokens int
	var estimated int
	var latencies []float64
	var dims int

	for _, phrase := range phrases {
		start := time.Now()
		vec, usage, err := provider.Embed(ctx, phrase)
		elapsed := time.Since(start)
		if err != nil {
			t.Errorf("embed %q: %v", phrase, err)
			continue
		}
		if dims == 0 {
			dims = len(vec)
		} else if len(vec) != dims {
			t.Errorf("embed %q: width %d, expected %d — a provider changing width mid-run breaks the index", phrase, len(vec), dims)
		}
		vectors[phrase] = vec
		tokens += usage.TokensIn
		if usage.Estimated {
			estimated++
		}
		latencies = append(latencies, elapsed.Seconds())
	}

	t.Logf("provider=%s embedded=%d dims=%d tokens_in=%d estimated_calls=%d",
		provider.Name(), len(vectors), dims, tokens, estimated)
	t.Logf("provider=%s latency_s: median=%.2f p95=%.2f max=%.2f",
		provider.Name(), median(latencies), percentile(latencies, 0.95), percentile(latencies, 1.0))

	if out := os.Getenv("KORA_EVAL_EMBED_OUT"); out != "" {
		writeVectors(t, out, vectors)
		t.Logf("wrote %d vectors to %s", len(vectors), out)
	}

	baselinePath := os.Getenv("KORA_EVAL_EMBED_BASELINE")
	if baselinePath == "" {
		t.Log("no KORA_EVAL_EMBED_BASELINE set — recorded only, no cross-provider comparison")
		return
	}
	baseline := readVectors(t, baselinePath)

	var sims []float64
	worst, worstPhrase := 2.0, ""
	for phrase, vec := range vectors {
		ref, ok := baseline[phrase]
		if !ok {
			t.Logf("phrase %q absent from baseline, skipping", phrase)
			continue
		}
		if len(ref) != len(vec) {
			t.Errorf("phrase %q: baseline width %d vs %d — the two providers are not the same embedding space",
				phrase, len(ref), len(vec))
			continue
		}
		sim := cosine(vec, ref)
		sims = append(sims, sim)
		if sim < worst {
			worst, worstPhrase = sim, phrase
		}
	}
	if len(sims) == 0 {
		t.Fatal("no overlapping phrases between this run and the baseline")
	}
	t.Logf("cosine vs %s: median=%.6f min=%.6f (worst: %q) n=%d",
		filepath.Base(baselinePath), median(sims), worst, worstPhrase, len(sims))

	if worst < embedFloor {
		t.Errorf("min cosine %.6f < %.2f for %q: the index and live queries would disagree if built and served through different providers",
			worst, embedFloor, worstPhrase)
	}
}

func writeVectors(t *testing.T, path string, vectors map[string][]float32) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(vectors); err != nil {
		t.Fatalf("encode %s: %v", path, err)
	}
}

func readVectors(t *testing.T, path string) map[string][]float32 {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read baseline %s: %v", path, err)
	}
	var out map[string][]float32
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode baseline %s: %v", path, err)
	}
	return out
}
