package ai

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

// defaultPortionGrams is used when a portion phrase is empty or doesn't
// match any known pattern.
const defaultPortionGrams = 100.0

// namedUnitGrams maps a real-world unit the caller actually named ("1 cup",
// "1 egg", "1 slice") to a pragmatic gram estimate. Keys are matched against
// the lowercased, trimmed input. The unit's MASS is still an estimate, but
// the unit itself is information the user/model supplied — naming "1 egg"
// is the same kind of signal as the task's own "two eggs" example — so a hit
// here is never an assumed portion.
var namedUnitGrams = map[string]float64{
	"1 cup":    240,
	"1 cups":   240,
	"1 breast": 170,
	"1 slice":  30,
	"1 egg":    50,
}

// sizeAdjectiveGrams maps a bare size adjective ("medium", "small", "large")
// to a pragmatic gram estimate. Unlike namedUnitGrams, a size adjective names
// no real-world unit and carries no numeric signal from the caller at all —
// it is a generic lookup WE trigger on their behalf once we know what food it
// is, not something they told us. A model emitting PortionEstimate: "medium"
// must not render as confidently as a user who typed "120g", so a hit here IS
// an assumed portion. Keep this distinction: collapsing the two tables back
// together is exactly the mistake this comment exists to prevent.
var sizeAdjectiveGrams = map[string]float64{
	"medium": 120,
	"small":  90,
	"large":  170,
}

// gramsPattern matches a leading number (integer or decimal) followed by
// optional whitespace and a "g"/"gram"/"grams" unit.
var gramsPattern = regexp.MustCompile(`^(\d+(?:\.\d+)?)\s*g(?:ram(?:s)?)?$`)

// parsePortionGrams maps a free-text portion phrase (as returned by an AI
// provider's PortionEstimate field) to a gram estimate. It is a pure,
// pragmatic best-effort mapping — never a scientific conversion — and always
// falls back to defaultPortionGrams for empty or unrecognized input so the
// resolver always has a usable number to multiply against the food row's
// per-100g values.
func parsePortionGrams(s string) float64 {
	norm := strings.ToLower(strings.TrimSpace(s))
	if norm == "" {
		return defaultPortionGrams
	}

	if grams, ok := namedUnitGrams[norm]; ok {
		return grams
	}
	if grams, ok := sizeAdjectiveGrams[norm]; ok {
		return grams
	}

	if m := gramsPattern.FindStringSubmatch(norm); m != nil {
		if grams, err := strconv.ParseFloat(m[1], 64); err == nil {
			return grams
		}
	}

	return defaultPortionGrams
}

// wordCounts covers the small counts a model actually writes out. Anything
// larger arrives as a numeral.
var wordCounts = map[string]float64{
	"one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
	"six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}

// singular trims one trailing plural "s" so "portions" and "portion" name the
// same serving. Deliberately naive, matching units.singular: the vocabulary is
// small and closed, and "ss" endings ("glass") are left alone.
func singular(name string) string {
	if strings.HasSuffix(name, "s") && !strings.HasSuffix(name, "ss") && len(name) > 2 {
		return strings.TrimSuffix(name, "s")
	}
	return name
}

// splitCountAndUnit reads "2 portions", "one sachet" or a bare "sachet" into a
// count and a unit name. A phrase with no leading count means one of the thing.
func splitCountAndUnit(norm string) (float64, string) {
	fields := strings.Fields(norm)
	if len(fields) == 0 {
		return 0, ""
	}
	if len(fields) == 1 {
		return 1, fields[0]
	}
	if n, err := strconv.ParseFloat(fields[0], 64); err == nil && n > 0 {
		return n, strings.Join(fields[1:], " ")
	}
	if n, ok := wordCounts[fields[0]]; ok {
		return n, strings.Join(fields[1:], " ")
	}
	return 1, norm
}

// servingGramsFromPhrase resolves a phrase against the food's OWN named
// servings. A row's own serving is better evidence than the generic table:
// a "cup" of one product is not a cup of another.
func servingGramsFromPhrase(norm string, item nutrition.FoodItem) (float64, bool) {
	servings := units.DecodeServingUnits(item.ServingUnits)
	if len(servings) == 0 {
		return 0, false
	}
	count, name := splitCountAndUnit(norm)
	if count <= 0 || name == "" {
		return 0, false
	}
	for _, serving := range servings {
		if serving.Amount > 0 && singular(serving.Name) == singular(name) {
			return (serving.BaseAmount / serving.Amount) * count, true
		}
	}
	return 0, false
}

// portionGramsFor is parsePortionGrams with the resolved food in hand. The
// second return value, assumed, reports whether grams is the silent flat
// default (defaultPortionGrams) rather than a value derived from either the
// caller's own phrase or the food's own known serving data. Callers must
// pass this straight through to ResolvedCandidate.PortionAssumed rather than
// re-deriving the condition themselves — re-deriving it is exactly how the
// flag and the actual portion could drift apart.
//
// The AI path previously multiplied every unrecognised phrase by a flat 100 g,
// which is the same defect afe2db0 fixed for barcode scans: one 16.5 g NESCAFÉ
// sachet was filed as 545 kcal instead of ~90. That fix never reached the
// text, photo and voice paths, because the portion was computed from the
// model's phrase alone while the food it had resolved to sat unused beside it.
//
// Precedence, most specific first:
//
//  1. An explicit mass ("45 g"). Nothing is more specific than a stated figure.
//     NOT assumed — the user/model stated a figure.
//  2. One of the FOOD'S OWN named servings ("2 portions"), resolved against
//     that row's mass rather than a generic one. NOT assumed — both the
//     phrase and the food's own data agree.
//  3. The curated phrase table, for foods that name no such serving of their
//     own. Split in two by what kind of signal the phrase carries:
//     3a. A named unit ("1 cup" → 240 g). NOT assumed — the phrase named a
//         real-world unit; the table just maps it to a pragmatic estimate.
//     3b. A bare size adjective ("medium" → 120 g). ASSUMED — the phrase
//         carries no unit and no number at all; the table is a generic
//         estimate we are supplying on the caller's behalf, not information
//         they gave us.
//  4. A branded food's own serving mass. OpenFoodFacts' serving_quantity is a
//     real package serving — what a person actually consumes — so it is a far
//     better default than 100 g when nothing else matched. NOT assumed — a
//     serving size IS known for this food, exactly like the barcode and
//     alias paths' own ServingGrams fallback.
//  5. The flat default. ASSUMED — no phrase signal and no food-specific
//     serving data at all.
//
// Step 4 is restricted to OFF provenance ON PURPOSE. A USDA reference serving
// is not a portion anyone eats: "Turkey, whole, meat and skin, raw" carries
// 5717 g. Falling back to that would turn an unrecognised phrase into a whole
// bird, which is far worse than the 100 g it replaces.
func portionGramsFor(phrase string, item nutrition.FoodItem) (grams float64, assumed bool) {
	norm := strings.ToLower(strings.TrimSpace(phrase))

	if m := gramsPattern.FindStringSubmatch(norm); m != nil {
		if grams, err := strconv.ParseFloat(m[1], 64); err == nil {
			return grams, false
		}
	}
	if grams, ok := servingGramsFromPhrase(norm, item); ok {
		return grams, false
	}
	if grams, ok := namedUnitGrams[norm]; ok {
		return grams, false
	}
	if grams, ok := sizeAdjectiveGrams[norm]; ok {
		return grams, true
	}
	if item.Provenance == nutrition.ProvenanceOFF && item.ServingGrams > 0 {
		return item.ServingGrams, false
	}
	// Nothing food-specific applied and no phrase signal matched; fall through
	// to the phrase-only mapping so the flat default lives in exactly one
	// place. This is the one true "assumed" case.
	return parsePortionGrams(norm), true
}
