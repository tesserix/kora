package ai

import (
	"encoding/json"
	"testing"

	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestParsePortionGrams(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  float64
	}{
		{"grams number", "150 g", 150},
		{"grams no space", "150g", 150},
		{"gram word", "80 gram", 80},
		{"grams word", "80 grams", 80},
		{"one cup", "1 cup", 240},
		{"one breast", "1 breast", 170},
		{"one slice", "1 slice", 30},
		{"one egg", "1 egg", 50},
		{"medium", "medium", 120},
		{"small", "small", 90},
		{"large", "large", 170},
		{"case insensitive", "1 CUP", 240},
		{"empty", "", 100},
		{"unknown phrase", "a handful of something", 100},
		{"decimal grams", "62.5 g", 62.5},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parsePortionGrams(tt.input)
			if got != tt.want {
				t.Errorf("parsePortionGrams(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

// offItem is a branded OpenFoodFacts row: serving_grams is a real package
// serving, which is what a person actually consumes.
func offItem(servingGrams float64, servingUnits string) nutrition.FoodItem {
	item := nutrition.FoodItem{Provenance: nutrition.ProvenanceOFF, ServingGrams: servingGrams}
	if servingUnits != "" {
		item.ServingUnits = json.RawMessage(servingUnits)
	}
	return item
}

// TestPortionGramsForUsesTheFoodsOwnServing is the AI-path counterpart of the
// barcode fix in afe2db0. That fix stopped a scan filing a 16.5 g NESCAFÉ
// sachet as a flat 100 g (545 kcal instead of ~90); the text, photo and voice
// paths kept the bug, because parsePortionGrams only ever saw the model's
// free-text phrase and never the food it had resolved to.
func TestPortionGramsForUsesTheFoodsOwnServing(t *testing.T) {
	const portionUnits = `[{"name":"portion","amount":1,"base_amount":16.5}]`

	tests := []struct {
		name   string
		phrase string
		item   nutrition.FoodItem
		want   float64
	}{
		{
			name:   "an unrecognised phrase falls back to a branded food's own serving",
			phrase: "one sachet",
			item:   offItem(16.5, portionUnits),
			want:   16.5,
		},
		{
			name:   "an empty phrase falls back to a branded food's own serving",
			phrase: "",
			item:   offItem(16.5, portionUnits),
			want:   16.5,
		},
		{
			// The row's OWN named serving beats the generic table: a cup of
			// this product is whatever the product says it is.
			name:   "a phrase naming the food's own serving resolves against it",
			phrase: "2 portions",
			item:   offItem(16.5, portionUnits),
			want:   33,
		},
		{
			name:   "a worded count against the food's own serving",
			phrase: "one portion",
			item:   offItem(16.5, portionUnits),
			want:   16.5,
		},
		{
			// An explicit mass is the most specific thing anyone can say.
			name:   "an explicit gram figure still wins over the serving",
			phrase: "45 g",
			item:   offItem(16.5, portionUnits),
			want:   45,
		},
		{
			// USDA reference servings are arbitrary — "Turkey, whole, raw" is
			// 5717 g. Falling back to those would log a whole bird where the
			// flat default logs 100 g, so non-branded rows keep the default.
			name:   "a USDA row keeps the flat default rather than its reference serving",
			phrase: "some turkey",
			item:   nutrition.FoodItem{Provenance: nutrition.ProvenanceUSDA, ServingGrams: 5717},
			want:   defaultPortionGrams,
		},
		{
			name:   "the generic table still applies when the food names no such serving",
			phrase: "1 cup",
			item:   offItem(16.5, portionUnits),
			want:   240,
		},
		{
			name:   "a branded row with no serving mass keeps the flat default",
			phrase: "one sachet",
			item:   offItem(0, ""),
			want:   defaultPortionGrams,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := portionGramsFor(tt.phrase, tt.item); got != tt.want {
				t.Fatalf("portionGramsFor(%q) = %v, want %v", tt.phrase, got, tt.want)
			}
		})
	}
}
