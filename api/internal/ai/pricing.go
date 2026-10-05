package ai

// modelPrice is a per-model token price in USD per 1,000,000 tokens.
//
// These are LIST-PRICE PROXIES, not amounts actually billed.
//
// CORRECTED 2026-08-27: this comment used to say the live stack runs on free
// tiers "where real spend is $0". That is no longer true of PRODUCTION. The
// deployed API takes the AI_GATEWAY_ENABLED branch of cmd/api/main.go, and
// upstream all three Kora backends resolve to Vertex AI in tesseracthub-480811
// on workload identity — which is billed. The free-tier framing survives only
// for local development.
//
// So the $ caps now throttle against a real bill as well as a shared quota,
// and the numbers below are the closest thing Kora has to a cost signal. They
// remain PROXIES: approximate public list rates as of 2026-07, matched by
// model name, and the gateway may price differently. Actual spend is visible
// in GCP billing for tesseracthub-480811, never here. Values can drift without
// affecting correctness — they only shape the throttle threshold.
//
// Measured against production on 2026-08-27, for scale: one quota-consuming
// user action costs roughly $0.0004 all-in (including the embedding and
// decomposition sub-calls it triggers), so the 300/month per-user request cap
// is worth about $0.13 — some 2% of perUserMonthlyCostCapUSD. The REQUEST caps
// bind long before the COST caps, by roughly fifty times.
type modelPrice struct {
	inPerM  float64
	outPerM float64
}

var modelPrices = map[string]modelPrice{
	// https://docs.anthropic.com/en/docs/about-claude/pricing (2026-10-05).
	"claude-sonnet-5-5":           {inPerM: 2.00, outPerM: 10.00},
	"gemini-3.5-flash":            {inPerM: 0.30, outPerM: 2.50},
	"gemini-3.5-flash-lite":       {inPerM: 0.10, outPerM: 0.40},
	"gemini-embedding-001":        {inPerM: 0.15, outPerM: 0.0},
	"meta/llama-3.3-70b-instruct": {inPerM: 0.60, outPerM: 0.60},
	"gpt-5-mini":                  {inPerM: 0.25, outPerM: 2.00},
}

// defaultModelPrice is used for any model not in modelPrices, so an unrecognized
// model is never treated as free (which would silently disable the budget gate).
var defaultModelPrice = modelPrice{inPerM: 0.50, outPerM: 1.50}

// EstimateCostUSD returns the list-price-proxy USD cost of one provider call.
func EstimateCostUSD(u Usage) float64 {
	p, ok := modelPrices[u.Model]
	if !ok {
		p = defaultModelPrice
	}
	return float64(u.TokensIn)/1_000_000*p.inPerM + float64(u.TokensOut)/1_000_000*p.outPerM
}
