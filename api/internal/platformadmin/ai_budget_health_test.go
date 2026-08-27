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
			return map[string]int64{
				"global_month_spend_usd_cents":    600,
				"global_month_cap_usd_cents":      50000,
				"global_month_headroom_usd_cents": 49400,
			}, nil
		},
	}

	rec := call(t, http.MethodGet, "/admin/health", "/admin/health",
		NewHealthHandler(probes, nil).Health)
	require.Equal(t, http.StatusOK, rec.Code)

	for _, raw := range decode(t, rec)["data"].(map[string]any)["dependencies"].([]any) {
		row := raw.(map[string]any)
		if row["name"] != DepAIBudget {
			continue
		}
		assert.Equal(t, StatusOK, row["status"])
		metrics := row["metrics"].(map[string]any)
		assert.Equal(t, float64(600), metrics["global_month_spend_usd_cents"])
		assert.Equal(t, float64(50000), metrics["global_month_cap_usd_cents"],
			"the ceiling must travel with the spend, or the surface answers only half the question")
		assert.Equal(t, float64(49400), metrics["global_month_headroom_usd_cents"])
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
