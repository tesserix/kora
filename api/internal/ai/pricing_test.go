package ai

import (
	"math"
	"testing"
)

func TestEstimateCostUSDKnownModel(t *testing.T) {
	// gemini-3.5-flash-lite: $0.10/1M in, $0.40/1M out (list-price proxy).
	// 1000 in + 500 out => 1000/1e6*0.10 + 500/1e6*0.40 = 0.0001 + 0.0002 = 0.0003
	got := EstimateCostUSD(Usage{Model: "gemini-3.5-flash-lite", TokensIn: 1000, TokensOut: 500})
	if math.Abs(got-0.0003) > 1e-9 {
		t.Fatalf("flash-lite cost = %v, want 0.0003", got)
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
