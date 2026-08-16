package ai

import (
	"math"
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

// fractionWords covers the fraction names a person or model actually writes.
// Both the singular and plural forms are listed rather than routed through
// singular(), because these are matched as counts, not as serving names.
var fractionWords = map[string]float64{
	"half":     0.5,
	"halves":   0.5,
	"third":    1.0 / 3.0,
	"thirds":   1.0 / 3.0,
	"quarter":  0.25,
	"quarters": 0.25,
	"fourth":   0.25,
	"fourths":  0.25,
}

// vulgarFractions maps the Unicode vulgar fraction characters an iOS keyboard
// or a model can emit. Keyed by the character itself so a lookup is a plain
// map hit rather than a rune classification.
var vulgarFractions = map[string]float64{
	"½": 0.5,
	"⅓": 1.0 / 3.0,
	"⅔": 2.0 / 3.0,
	"¼": 0.25,
	"¾": 0.75,
	"⅕": 0.2,
	"⅖": 0.4,
	"⅗": 0.6,
	"⅘": 0.8,
	"⅙": 1.0 / 6.0,
	"⅚": 5.0 / 6.0,
	"⅐": 1.0 / 7.0,
	"⅛": 0.125,
	"⅜": 0.375,
	"⅝": 0.625,
	"⅞": 0.875,
	"⅑": 1.0 / 9.0,
	"⅒": 0.1,
}

// maxPortionCount bounds a leading count. Nobody eats a hundred servings in a
// sitting, so a larger figure is a parsing artefact (a stray year, a barcode
// fragment) rather than a portion; rejecting it leaves the phrase to the
// downstream rungs exactly as any other unrecognised phrase.
const maxPortionCount = 100

// plausibleCount keeps the "n > 0" standard the numeric path always applied and
// adds the upper bound. A NaN or ±Inf from a pathological ParseFloat input
// fails both comparisons.
func plausibleCount(n float64) bool {
	return n > 0 && n <= maxPortionCount
}

// parseFractionToken reads a single token that is wholly or partly a fraction:
// an ASCII "3/4", a Unicode "¾", or the two glued together as "1¾". Zero or
// negative numerators and denominators are rejected rather than producing an
// infinity or a NaN downstream.
func parseFractionToken(tok string) (float64, bool) {
	if v, ok := vulgarFractions[tok]; ok {
		return v, true
	}
	// A vulgar fraction glued to a leading whole number: "1½".
	for glyph, v := range vulgarFractions {
		if whole, ok := strings.CutSuffix(tok, glyph); ok && whole != "" {
			n, err := strconv.ParseFloat(whole, 64)
			if err != nil || n < 0 || n != math.Trunc(n) {
				return 0, false
			}
			return n + v, true
		}
	}
	num, den, ok := strings.Cut(tok, "/")
	if !ok {
		return 0, false
	}
	n, err := strconv.ParseFloat(num, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	d, err := strconv.ParseFloat(den, 64)
	if err != nil || d <= 0 {
		return 0, false
	}
	return n / d, true
}

// parseCountToken reads one token as a count: a plain number, a fraction in any
// supported spelling, a written-out numeral, or a fraction word.
func parseCountToken(tok string) (float64, bool) {
	if n, err := strconv.ParseFloat(tok, 64); err == nil {
		return n, true
	}
	if n, ok := parseFractionToken(tok); ok {
		return n, true
	}
	if n, ok := wordCounts[tok]; ok {
		return n, true
	}
	if n, ok := fractionWords[tok]; ok {
		return n, true
	}
	return 0, false
}

// parseLeadingCount reads the count off the front of a phrase's fields and
// reports how many fields it consumed. Two-field forms are tried first so the
// "1" of "1 1/2 cups" is not mistaken for the whole count, leaving "1/2 cups"
// as a unit name that matches nothing.
func parseLeadingCount(fields []string) (count float64, consumed int, ok bool) {
	if len(fields) >= 2 {
		if n, ok := parseTwoFieldCount(fields[0], fields[1]); ok && plausibleCount(n) {
			return n, 2, true
		}
	}
	if n, ok := parseCountToken(fields[0]); ok && plausibleCount(n) {
		return n, 1, true
	}
	return 0, 0, false
}

// parseTwoFieldCount reads the count forms that span two fields: a mixed number
// ("1 1/2"), an article plus a fraction word ("a half"), and a numeral times a
// fraction word ("three quarters").
func parseTwoFieldCount(first, second string) (float64, bool) {
	if first == "a" || first == "an" {
		if frac, ok := fractionWords[second]; ok {
			return frac, true
		}
		return 0, false
	}
	if n, ok := wordCounts[first]; ok {
		if frac, ok := fractionWords[second]; ok {
			return n * frac, true
		}
		return 0, false
	}
	whole, err := strconv.ParseFloat(first, 64)
	if err != nil || whole < 1 || whole != math.Trunc(whole) {
		return 0, false
	}
	frac, ok := parseFractionToken(second)
	if !ok || frac <= 0 {
		return 0, false
	}
	return whole + frac, true
}

// splitCountAndUnit reads "2 portions", "one sachet", "1/2 chicken", "half
// chicken", "1 1/2 cups" or a bare "sachet" into a count and a unit name. A
// phrase with no leading count means one of the thing.
//
// The fraction forms are kora#184: "1/2 chicken" is neither a float nor a
// wordCounts key, so it used to degrade to count 1 with the whole phrase as the
// unit name, match no serving, and land on the flat 100 g default — silently
// discarding a stated quantity worth several hundred calories.
//
// A count that consumes the whole phrase leaves no unit behind, so it is not
// treated as a count at all: the fall-through below reproduces the previous
// behaviour for a bare "2" or a bare "1/2", where there is nothing to resolve
// the count against.
func splitCountAndUnit(norm string) (float64, string) {
	fields := strings.Fields(norm)
	if len(fields) == 0 {
		return 0, ""
	}
	if count, consumed, ok := parseLeadingCount(fields); ok && consumed < len(fields) {
		return count, strings.Join(fields[consumed:], " ")
	}
	if len(fields) == 1 {
		return 1, fields[0]
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

// Bounds on a food's own stored serving size, for deciding whether it is a
// portion a person plausibly eats in one sitting.
//
// Chosen from the shipped index rather than intuition. Of 7,764 USDA rows
// carrying a serving: 7,470 fall within 1-500 g, 276 sit above 500 g, and 18
// below 1 g. The rows above the ceiling are precisely the pathological ones —
// "Turkey, whole, meat and skin, raw" (5717 g), "Canada Goose, breast meat
// only, skinless, raw" (4405 g) — i.e. whole-animal reference masses, not
// servings. So the bound admits ~96% of real servings and excludes exactly the
// class the original OFF-only restriction was written to exclude.
//
// The floor is data hygiene, not nutrition: a sub-gram "serving" is a parsing
// artefact rather than a food anyone portions out.
const (
	minPlausibleServingGrams = 1
	maxPlausibleServingGrams = 500
)

func plausibleServingGrams(g float64) bool {
	return g >= minPlausibleServingGrams && g <= maxPlausibleServingGrams
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
//     real-world unit; the table just maps it to a pragmatic estimate.
//     3b. A bare size adjective ("medium" → 120 g). ASSUMED — the phrase
//     carries no unit and no number at all; the table is a generic
//     estimate we are supplying on the caller's behalf, not information
//     they gave us.
//  4. A branded food's own serving mass. OpenFoodFacts' serving_quantity is a
//     real package serving — what a person actually consumes — so it is a far
//     better default than 100 g when nothing else matched. NOT assumed — a
//     serving size IS known for this food, exactly like the barcode and
//     alias paths' own ServingGrams fallback.
//  5. The flat default. ASSUMED — no phrase signal and no food-specific
//     serving data at all.
//
// Step 4 was once restricted to OFF provenance, to keep USDA reference servings
// out: "Turkey, whole, meat and skin, raw" carries 5717 g, and falling back to
// that would turn an unrecognised phrase into a whole bird. The concern is real
// but the instrument was too blunt — it discarded ~7,470 perfectly sensible
// USDA servings to exclude ~276 absurd ones, and a photographed croissant
// therefore reported the flat 100 g default (414 kcal) instead of its own
// 28.35 g serving (~117 kcal) (kora#180).
//
// It is now a plausibility bound on the VALUE rather than a ban on the source,
// which keeps the turkey out and lets the croissant in. See
// plausibleServingGrams for how the bounds were chosen.
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
	if plausibleServingGrams(item.ServingGrams) {
		return item.ServingGrams, false
	}
	// Nothing food-specific applied and no phrase signal matched; fall through
	// to the phrase-only mapping so the flat default lives in exactly one
	// place. This is the one true "assumed" case.
	return parsePortionGrams(norm), true
}
