package main

import (
	"encoding/json"
	"strings"

	"github.com/tesserix/kora/api/internal/labelocr"
)

// Synthetic fixtures retain both historical schemas; product OCR uses labelocr.Check.
func guardedLabel(state string) labelocr.ConsumptionPlan {
	var fixture struct {
		Label struct {
			Basis  string   `json:"basis"`
			Energy *float64 `json:"energy_kcal"`
		} `json:"label"`
		Basis    string          `json:"label_basis"`
		Energy   *float64        `json:"energy_kcal"`
		Amount   json.RawMessage `json:"consumed_amount"`
		Conflict json.RawMessage `json:"conflicting_user_amount"`
	}
	if json.Unmarshal([]byte(state), &fixture) != nil {
		return labelocr.ConsumptionPlan{Action: "retake", Reason: "invalid_fixture"}
	}
	basis, energy := fixture.Label.Basis, fixture.Label.Energy
	if fixture.Basis != "" {
		basis, energy = strings.Replace(fixture.Basis, "per100", "per_100", 1), fixture.Energy
	}
	label := labelocr.Label{Basis: basis, Per100: labelocr.Nutrients{EnergyKcal: energy}}
	if basis == "per_serving" {
		label.PerServing = label.Per100
	}
	var rawAmount struct {
		Value  *float64 `json:"value"`
		Amount *float64 `json:"amount"`
		Unit   string   `json:"unit"`
	}
	var amount *labelocr.Consumption
	if json.Unmarshal(fixture.Amount, &rawAmount) == nil {
		value := rawAmount.Value
		if value == nil {
			value = rawAmount.Amount
		}
		if value != nil {
			amount = &labelocr.Consumption{Value: *value, Unit: rawAmount.Unit, Conflicting: len(fixture.Conflict) > 0 && string(fixture.Conflict) != "null"}
		}
	}
	return labelocr.PlanConsumption(label, amount)
}
