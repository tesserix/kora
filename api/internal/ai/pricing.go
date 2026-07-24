package ai

// modelPrice is a per-model token price in USD per 1,000,000 tokens.
//
// These are LIST-PRICE PROXIES, not amounts actually billed: the live stack
// runs on free tiers (Gemini free, NVIDIA NIM free) where real spend is $0.
// Pricing calls at their paid list rate lets the monthly $ budget cap
// (billing.Meter.WithinBudget) throttle a heavy user before they exhaust the
// free-tier quota that protects everyone else. Values are approximate public
// list rates as of 2026-07 and can drift without affecting correctness — they
// only shape the throttle threshold.
type modelPrice struct {
	inPerM  float64
	outPerM float64
}

var modelPrices = map[string]modelPrice{
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
