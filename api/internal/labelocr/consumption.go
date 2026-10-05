package labelocr

import "math"

// Consumption describes an explicitly supplied amount, never the printed serving size.
type Consumption struct {
	Value       float64 `json:"value"`
	Unit        string  `json:"unit"`
	Conflicting bool    `json:"conflicting"`
}

// ConsumptionPlan contains a preview, not permission to save a diary entry.
type ConsumptionPlan struct {
	Action    string     `json:"action"`
	Reason    string     `json:"reason"`
	Nutrients *Nutrients `json:"nutrients,omitempty"`
}

// PlanConsumption checks measurements in code independently of any model answer.
func PlanConsumption(label Label, amount *Consumption) ConsumptionPlan {
	unit := map[string]string{BasisPer100g: "g", BasisPer100ml: "ml", "per_serving": "servings"}[label.Basis]
	source, divisor := label.Per100, 100.0
	if label.Basis == "per_serving" {
		source, divisor = label.PerServing, 1
	}
	if unit == "" || source.EnergyKcal == nil || source.hasNonFinite() {
		return ConsumptionPlan{Action: "retake", Reason: "label_evidence_required"}
	}
	invalid := label.Basis != "per_serving" && source.outOfRange()
	for _, value := range []*float64{source.EnergyKcal, source.ProteinG, source.FatG, source.SaturatedFatG, source.CarbohydrateG, source.SugarsG, source.FibreG, source.SodiumMg} {
		invalid = invalid || (value != nil && *value < 0)
	}
	if label.NeedsReview || len(label.Issues) > 0 || invalid || source.atwaterMismatch() {
		return ConsumptionPlan{Action: "review", Reason: "label_review_required"}
	}
	if amount == nil || amount.Conflicting || amount.Value <= 0 || math.IsNaN(amount.Value) || math.IsInf(amount.Value, 0) || amount.Unit != unit {
		return ConsumptionPlan{Action: "ask_amount", Reason: "positive_compatible_amount_required"}
	}
	factor := amount.Value / divisor
	if factor == 0 {
		return ConsumptionPlan{Action: "ask_amount", Reason: "amount_underflow"}
	}
	nutrients := source.scaled(factor)
	if nutrients.hasNonFinite() {
		return ConsumptionPlan{Action: "ask_amount", Reason: "amount_overflow"}
	}
	for _, pair := range [][2]*float64{
		{source.EnergyKcal, nutrients.EnergyKcal}, {source.ProteinG, nutrients.ProteinG},
		{source.FatG, nutrients.FatG}, {source.SaturatedFatG, nutrients.SaturatedFatG},
		{source.CarbohydrateG, nutrients.CarbohydrateG}, {source.SugarsG, nutrients.SugarsG},
		{source.FibreG, nutrients.FibreG}, {source.SodiumMg, nutrients.SodiumMg},
	} {
		if pair[0] != nil && *pair[0] > 0 && *pair[1] == 0 {
			return ConsumptionPlan{Action: "ask_amount", Reason: "nutrient_underflow"}
		}
	}
	return ConsumptionPlan{Action: "calculate", Reason: "validated_measurements", Nutrients: &nutrients}
}
