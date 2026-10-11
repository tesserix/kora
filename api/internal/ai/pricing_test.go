package ai

import (
	"math"
	"testing"
)

func TestEstimateCostUSDKnownModel(t *testing.T) {
	// Vertex global list rates verified 2026-10-11: $0.30 input, $2.50 output / million.
	got := EstimateCostUSD(Usage{Model: "gemini-3.5-flash-lite", TokensIn: 1000, TokensOut: 500})
	if math.Abs(got-0.00155) > 1e-9 {
		t.Fatalf("flash-lite cost = %v, want 0.00155", got)
	}
}

func TestEstimateCostUSDUnknownModelUsesDefaultNonzero(t *testing.T) {
	got := EstimateCostUSD(Usage{Model: "some-future-model", TokensIn: 1_000_000, TokensOut: 0})
	if got <= 0 {
		t.Fatalf("unknown model cost = %v, want > 0 (default proxy rate)", got)
	}
}

func TestEstimateCostUSDNVIDIAFallback(t *testing.T) {
	// meta/llama-3.3-70b-instruct: $0.60/1M in + out.
	got := EstimateCostUSD(Usage{Model: "meta/llama-3.3-70b-instruct", TokensIn: 1_000_000, TokensOut: 1_000_000})
	if math.Abs(got-1.20) > 1e-9 {
		t.Fatalf("nvidia cost = %v, want 1.20", got)
	}
}

// TestEstimateCostUSDGeminiEmbeddingNonZeroWhenMetered pins the actual
// production defect kora#376 found: gemini-embedding-001 is priced correctly
// in pricing.go ({inPerM: 0.15}) — the bug was upstream, GeminiProvider.Embed
// recording TokensIn: 0 for every successful call regardless of price. This
// asserts the pricing side is not the thing that needs fixing: once a caller
// supplies a real TokensIn (as the estimator in providers/gemini.go now
// does), cost comes out non-zero with no change to this file.
func TestEstimateCostUSDGeminiEmbeddingNonZeroWhenMetered(t *testing.T) {
	got := EstimateCostUSD(Usage{Model: "gemini-embedding-001", TokensIn: 4, CallType: "embed", Estimated: true})
	if got <= 0 {
		t.Fatalf("gemini-embedding-001 cost = %v, want > 0 once TokensIn is populated", got)
	}
}

func TestEstimateCostUSDLabelReviewModel(t *testing.T) {
	got := EstimateCostUSD(Usage{Model: "claude-sonnet-5-5", TokensIn: 3000, TokensOut: 500})
	if math.Abs(got-0.011) > 1e-9 {
		t.Fatalf("label review cost = %v, want 0.011", got)
	}
}

func TestCurrentVertexGlobalRates(t *testing.T) {
	for model, want := range map[string]float64{"gemini-3.5-flash": 10.5, "gemini-3.5-flash-lite": 2.8} {
		if got := EstimateCostUSD(Usage{Model: model, TokensIn: 1_000_000, TokensOut: 1_000_000}); math.Abs(got-want) > 1e-9 {
			t.Errorf("%s: got %v want %v", model, got, want)
		}
	}
}
