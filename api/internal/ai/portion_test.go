package ai

import (
	"encoding/json"
	"math"
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

// TestSplitCountAndUnitFractions is kora#184. splitCountAndUnit read a leading
// count with ParseFloat or wordCounts, and a fraction is neither: "1/2 chicken"
// became count 1 with "1/2 chicken" as the unit name, matched no serving, and
// fell through to the flat 100 g default. Half a charcoal chicken is 600-800
// kcal, so the stated quantity was being discarded, not rounded.
func TestSplitCountAndUnitFractions(t *testing.T) {
	const third = 1.0 / 3.0

	tests := []struct {
		name      string
		phrase    string
		wantCount float64
		wantUnit  string
	}{
		// Unchanged behaviour: plain numbers, decimals, words and bare units.
		{"plain integer", "2 portions", 2, "portions"},
		{"decimal", "1.5 cups", 1.5, "cups"},
		{"word count", "one sachet", 1, "sachet"},
		{"word count above one", "three portions", 3, "portions"},
		{"bare unit", "sachet", 1, "sachet"},
		{"multi-word unit", "2 slices bread", 2, "slices bread"},
		{"no leading count", "a handful of rice", 1, "a handful of rice"},

		// ASCII fractions.
		{"half as a fraction", "1/2 chicken", 0.5, "chicken"},
		{"three quarters as a fraction", "3/4 cup", 0.75, "cup"},
		{"quarter as a fraction", "1/4 pizza", 0.25, "pizza"},
		{"improper fraction", "3/2 portions", 1.5, "portions"},

		// Mixed numbers.
		{"mixed number", "1 1/2 cups", 1.5, "cups"},
		{"mixed number with multi-word unit", "2 1/4 slices bread", 2.25, "slices bread"},

		// Unicode vulgar fractions, bare and glued to a whole number.
		{"unicode half", "½ chicken", 0.5, "chicken"},
		{"unicode quarter", "¼ pizza", 0.25, "pizza"},
		{"unicode three quarters", "¾ cup", 0.75, "cup"},
		{"unicode third", "⅓ portion", third, "portion"},
		{"unicode glued to a whole number", "1½ cups", 1.5, "cups"},

		// Word forms.
		{"half as a word", "half chicken", 0.5, "chicken"},
		{"quarter as a word", "quarter pizza", 0.25, "pizza"},
		{"article plus fraction word", "a half chicken", 0.5, "chicken"},
		{"numeral times fraction word", "three quarters cup", 0.75, "cup"},
		{"two thirds", "two thirds cup", 2 * third, "cup"},

		// Malformed and absurd input falls back to the previous "no usable
		// count" behaviour rather than producing NaN, Inf or a nonsense mass.
		{"zero denominator", "1/0 chicken", 1, "1/0 chicken"},
		{"zero over zero", "0/0 chicken", 1, "0/0 chicken"},
		{"zero numerator", "0/2 chicken", 1, "0/2 chicken"},
		{"negative numerator", "-1/2 chicken", 1, "-1/2 chicken"},
		{"negative count", "-2 portions", 1, "-2 portions"},
		{"zero count", "0 portions", 1, "0 portions"},
		{"non-numeric fraction", "a/b chicken", 1, "a/b chicken"},
		{"empty numerator", "/2 chicken", 1, "/2 chicken"},
		{"absurd count", "5000 portions", 1, "5000 portions"},
		{"absurd mixed number", "5000 1/2 portions", 1, "5000 1/2 portions"},

		// A count with nothing left to count is not a count: there is no unit
		// to resolve it against, exactly as before this change.
		{"bare fraction", "1/2", 1, "1/2"},
		{"bare number", "2", 1, "2"},

		{"empty", "", 0, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			count, unit := splitCountAndUnit(tt.phrase)
			if math.Abs(count-tt.wantCount) > 1e-9 {
				t.Errorf("splitCountAndUnit(%q) count = %v, want %v", tt.phrase, count, tt.wantCount)
			}
			if unit != tt.wantUnit {
				t.Errorf("splitCountAndUnit(%q) unit = %q, want %q", tt.phrase, unit, tt.wantUnit)
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
	// A whole charcoal chicken, as a row that names "chicken" as its own
	// serving — the shape "1/2 chicken" needs in order to resolve at all.
	const chickenUnits = `[{"name":"chicken","amount":1,"base_amount":1400}]`

	tests := []struct {
		name        string
		phrase      string
		item        nutrition.FoodItem
		want        float64
		wantAssumed bool
	}{
		{
			name:        "an unrecognised phrase falls back to a branded food's own serving",
			phrase:      "one sachet",
			item:        offItem(16.5, portionUnits),
			want:        16.5,
			wantAssumed: false,
		},
		{
			name:        "an empty phrase falls back to a branded food's own serving",
			phrase:      "",
			item:        offItem(16.5, portionUnits),
			want:        16.5,
			wantAssumed: false,
		},
		{
			// The row's OWN named serving beats the generic table: a cup of
			// this product is whatever the product says it is.
			name:        "a phrase naming the food's own serving resolves against it",
			phrase:      "2 portions",
			item:        offItem(16.5, portionUnits),
			want:        33,
			wantAssumed: false,
		},
		{
			name:        "a worded count against the food's own serving",
			phrase:      "one portion",
			item:        offItem(16.5, portionUnits),
			want:        16.5,
			wantAssumed: false,
		},
		{
			// kora#184. "1/2 chicken" used to degrade to count 1 with the whole
			// phrase as the unit name, match no serving, and report the flat
			// 100 g default — roughly a tenth of what was actually eaten.
			name:        "a fractional count resolves against the food's own serving",
			phrase:      "1/2 chicken",
			item:        offItem(0, chickenUnits),
			want:        700,
			wantAssumed: false,
		},
		{
			name:        "a worded fraction resolves against the food's own serving",
			phrase:      "half chicken",
			item:        offItem(0, chickenUnits),
			want:        700,
			wantAssumed: false,
		},
		{
			name:        "a unicode fraction resolves against the food's own serving",
			phrase:      "½ chicken",
			item:        offItem(0, chickenUnits),
			want:        700,
			wantAssumed: false,
		},
		{
			name:        "a mixed number resolves against the food's own serving",
			phrase:      "1 1/2 portions",
			item:        offItem(16.5, portionUnits),
			want:        24.75,
			wantAssumed: false,
		},
		{
			// A stated quantity is a stated quantity whether or not it is
			// fractional: this must never be marked assumed.
			name:        "a fractional count is not an assumed portion",
			phrase:      "1/4 portion",
			item:        offItem(16.5, portionUnits),
			want:        4.125,
			wantAssumed: false,
		},
		{
			// The malformed guard, end to end: no count is read, nothing else
			// matches, so this is the ordinary silent-default case.
			name:        "a zero denominator falls through to the default",
			phrase:      "1/0 chicken",
			item:        offItem(0, chickenUnits),
			want:        defaultPortionGrams,
			wantAssumed: true,
		},
		{
			// Scope guard for kora#184: parsing the fraction only pays off when
			// the matched row names the serving. Without one, the phrase is as
			// unrecognised as it ever was.
			name:        "a fraction against a row naming no such serving keeps the default",
			phrase:      "1/2 chicken",
			item:        offItem(0, portionUnits),
			want:        defaultPortionGrams,
			wantAssumed: true,
		},
		{
			// An explicit mass is the most specific thing anyone can say.
			name:        "an explicit gram figure still wins over the serving",
			phrase:      "45 g",
			item:        offItem(16.5, portionUnits),
			want:        45,
			wantAssumed: false,
		},
		{
			// USDA reference servings are arbitrary — "Turkey, whole, raw" is
			// 5717 g. Falling back to those would log a whole bird where the
			// flat default logs 100 g, so non-branded rows keep the default.
			// Nothing food-specific applied and the phrase carried no usable
			// signal either, so this IS the silent-default case.
			name:        "a USDA row keeps the flat default rather than its reference serving",
			phrase:      "some turkey",
			item:        nutrition.FoodItem{Provenance: nutrition.ProvenanceUSDA, ServingGrams: 5717},
			want:        defaultPortionGrams,
			wantAssumed: true,
		},
		{
			// The user's own phrase mapped through the curated table is still a
			// real signal from what they said — not a silent assumption.
			name:        "the generic table still applies when the food names no such serving",
			phrase:      "1 cup",
			item:        offItem(16.5, portionUnits),
			want:        240,
			wantAssumed: false,
		},
		{
			// No phrase signal AND no food-specific serving data at all — the
			// pure silent-default case.
			name:        "a branded row with no serving mass keeps the flat default",
			phrase:      "one sachet",
			item:        offItem(0, ""),
			want:        defaultPortionGrams,
			wantAssumed: true,
		},
		{
			// namedUnitGrams rung, isolated from any OFF/ServingGrams
			// influence: a model reporting PortionEstimate "1 cup" (e.g. for
			// "1 cup rice") named a real-world unit — that's the user/model
			// supplying information, so it must NOT be marked assumed. This
			// must fail if "1 cup" is ever moved into sizeAdjectiveGrams.
			name:        "a named unit like '1 cup' is not assumed",
			phrase:      "1 cup",
			item:        nutrition.FoodItem{Provenance: nutrition.ProvenanceAFCD},
			want:        240,
			wantAssumed: false,
		},
		{
			// sizeAdjectiveGrams rung: a model reporting PortionEstimate
			// "medium" (e.g. for "medium apple") named no unit and no number
			// at all — we are supplying the 120g estimate on its behalf, not
			// relaying something it said. This must fail if "medium" is ever
			// moved into namedUnitGrams.
			name:        "a bare size adjective like 'medium' IS assumed",
			phrase:      "medium",
			item:        nutrition.FoodItem{Provenance: nutrition.ProvenanceAFCD},
			want:        120,
			wantAssumed: true,
		},
		{
			// A second size adjective, to prove the whole sizeAdjectiveGrams
			// table is treated this way, not just "medium" specifically.
			name:        "another bare size adjective like 'large' IS assumed",
			phrase:      "large",
			item:        nutrition.FoodItem{Provenance: nutrition.ProvenanceAFCD},
			want:        170,
			wantAssumed: true,
		},
		{
			// kora#180. A USDA serving used to be discarded wholesale, so a
			// photographed croissant reported the 100 g default -- 414 kcal
			// against a ~117 kcal truth. The exclusion existed to keep whole
			// birds out (see below); it is now a plausibility bound instead,
			// so a sensible USDA serving is honoured like any other.
			name:        "a plausible USDA serving is used, not the flat default",
			phrase:      "",
			item:        nutrition.FoodItem{Provenance: nutrition.ProvenanceUSDA, ServingGrams: 28.35},
			want:        28.35,
			wantAssumed: false,
		},
		{
			// The case the original OFF-only restriction was written for, and
			// which the bound must keep excluding: "Turkey, whole, meat and
			// skin, raw" really does carry 5717 g. 100 g is wrong, but it is
			// far less wrong than a whole bird.
			name:        "an implausible USDA serving is rejected, falling to the default",
			phrase:      "",
			item:        nutrition.FoodItem{Provenance: nutrition.ProvenanceUSDA, ServingGrams: 5717},
			want:        100,
			wantAssumed: true,
		},
		{
			// OFF servings are real package servings and must keep working
			// exactly as before -- the bound is additive, not a replacement.
			name:        "an OFF branded serving still wins",
			phrase:      "",
			item:        nutrition.FoodItem{Provenance: nutrition.ProvenanceOFF, ServingGrams: 37.5},
			want:        37.5,
			wantAssumed: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, assumed := portionGramsFor(tt.phrase, tt.item)
			if got != tt.want {
				t.Fatalf("portionGramsFor(%q) grams = %v, want %v", tt.phrase, got, tt.want)
			}
			if assumed != tt.wantAssumed {
				t.Fatalf("portionGramsFor(%q) assumed = %v, want %v", tt.phrase, assumed, tt.wantAssumed)
			}
		})
	}
}
