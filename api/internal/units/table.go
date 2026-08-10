package units

import (
	"regexp"
	"strings"
)

// Table is the curated fallback consulted only when a food row carries no
// parseable serving unit of its own. It is deliberately small.
//
// Cups need a per-food density that neither OpenFoodFacts nor USDA publishes
// in usable form, so this covers staples where the figure is well established
// and stops there. For most branded products a cup conversion is simply
// absent, and the item falls back to its named serving or raw mass. That is
// the intended trade: an absent conversion is recoverable by the user, a
// fabricated density silently corrupts every total that uses it.
//
// Keyed by a lowercase keyword matched against the food's name. Reviewed like
// code — adding an entry means asserting the figure is real.
var Table = map[string][]ServingUnit{
	"rice":  {{Name: "cup", Amount: 1, BaseAmount: 158}},
	"flour": {{Name: "cup", Amount: 1, BaseAmount: 125}},
	"milk":  {{Name: "cup", Amount: 1, BaseAmount: 250}},
	"oat":   {{Name: "cup", Amount: 1, BaseAmount: 90}},
	"sugar": {{Name: "cup", Amount: 1, BaseAmount: 200}},
	"bread": {{Name: "slice", Amount: 1, BaseAmount: 35}},
}

// wordSeparator splits a food name into its words. Anything that is not a
// letter or digit is a boundary, so "White rice, cooked" yields
// ["white", "rice", "cooked"].
var wordSeparator = regexp.MustCompile(`[^a-z0-9]+`)

// words returns the set of lowercase words in a food name.
func words(foodName string) map[string]bool {
	out := map[string]bool{}
	for _, w := range wordSeparator.Split(strings.ToLower(foodName), -1) {
		if w != "" {
			out[w] = true
		}
	}
	return out
}

// Fallback returns the curated serving units for a food name, or nil when the
// food is not in the table. Consulted ONLY after Parse has failed on the row's
// own label text — the row's own serving description is always better evidence
// than a category-level guess.
//
// A keyword must appear as a WHOLE WORD of the name, never as a bare
// substring. The substring form silently contradicted rows' own labels: the
// seeded "Rolled oats, dry" carries the label "1/2 cup (40g)", which Parse
// cannot read, and a substring match on "oat" would then persist cup = 90 g
// against a row that says 40 g. A word match declines instead, and an absent
// conversion is recoverable by the user where a fabricated one is not.
//
// When a food name matches multiple keywords, the longest keyword wins,
// deterministically. On length tie, the lexicographically smallest keyword wins,
// so the result is stable regardless of Go's randomized map iteration order.
func Fallback(foodName string) []ServingUnit {
	nameWords := words(foodName)
	var longest string
	for keyword := range Table {
		if nameWords[keyword] {
			// Prefer longer keywords, or lexicographically smaller on tie.
			if len(keyword) > len(longest) || (len(keyword) == len(longest) && keyword < longest) {
				longest = keyword
			}
		}
	}
	if longest == "" {
		return nil
	}
	return Table[longest]
}
