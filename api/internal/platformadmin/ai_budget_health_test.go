package platformadmin

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestHealthReportsTheAIBudget — kora#485's read half.
//
// globalMonthlyCostCapUSD is a kill switch on the whole product's AI, and
// before this the only way to read it was to open meter.go. An operator
// watching spend climb could see the number rising and not the ceiling it was
// rising toward; the first symptom of the cap firing is "AI stopped working
// for everyone".
//
// Asserts the CEILING and the HEADROOM travel with the spend. A row carrying
// only the spend would reproduce exactly the blindness this closes.
func TestHealthReportsTheAIBudget(t *testing.T) {
	probes := map[string]Probe{
		DepAIBudget: func(context.Context) (map[string]int64, error) {
			return map[string]int64{"per_user_daily_requests_cap": 20}, nil
		},
	}
	moneyProbes := map[string]MoneyProbe{
		DepAIBudget: func(context.Context) (map[string]Money, error) {
			return map[string]Money{
				"global_month_spend":    {Amount: 600, Currency: "USD"},
				"global_month_cap":      {Amount: 50000, Currency: "USD"},
				"global_month_headroom": {Amount: 49400, Currency: "USD"},
			}, nil
		},
	}

	rec := call(t, http.MethodGet, "/admin/health", "/admin/health",
		NewHealthHandler(probes, nil).WithMoneyProbes(moneyProbes).Health)
	require.Equal(t, http.StatusOK, rec.Code)

	for _, raw := range decode(t, rec)["data"].(map[string]any)["dependencies"].([]any) {
		row := raw.(map[string]any)
		if row["name"] != DepAIBudget {
			continue
		}
		assert.Equal(t, StatusOK, row["status"])
		budget := row["budget"].(map[string]any)
		cap := budget["global_month_cap"].(map[string]any)
		// §4.2: money is { amount, currency }, never a bare number whose unit
		// lives in its field name. The conformance suite rejected the first
		// pass here for exactly that.
		assert.Equal(t, float64(50000), cap["amount"],
			"the ceiling must travel with the spend, or the surface answers only half the question")
		assert.Equal(t, "USD", cap["currency"],
			"every money value must name its currency explicitly")
		assert.Equal(t, float64(600), budget["global_month_spend"].(map[string]any)["amount"])
		assert.Equal(t, float64(49400), budget["global_month_headroom"].(map[string]any)["amount"])
		return
	}
	t.Fatalf("%s is missing from the health payload", DepAIBudget)
}

// TestAIBudgetIsRegisteredAsADependency — an unregistered name never reaches
// the payload at all, however good the probe is.
func TestAIBudgetIsRegisteredAsADependency(t *testing.T) {
	for _, key := range DependencyRegistry {
		if key.Name == DepAIBudget {
			assert.True(t, key.Instrumented,
				"the budget is a measurement, so it must be marked instrumented or its metrics are dropped")
			return
		}
	}
	t.Fatalf("%s is not in DependencyRegistry", DepAIBudget)
}
