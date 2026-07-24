package ai

import (
	"regexp"
	"strconv"
	"strings"
)

// defaultPortionGrams is used when a portion phrase is empty or doesn't
// match any known pattern.
const defaultPortionGrams = 100.0

// namedPortionGrams maps common qualitative/countable portion phrases to a
// pragmatic gram estimate. Keys are matched against the lowercased,
// trimmed input.
var namedPortionGrams = map[string]float64{
	"1 cup":    240,
	"1 cups":   240,
	"1 breast": 170,
	"1 slice":  30,
	"1 egg":    50,
	"medium":   120,
	"small":    90,
	"large":    170,
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

	if grams, ok := namedPortionGrams[norm]; ok {
		return grams
	}

	if m := gramsPattern.FindStringSubmatch(norm); m != nil {
		if grams, err := strconv.ParseFloat(m[1], 64); err == nil {
			return grams
		}
	}

	return defaultPortionGrams
}
