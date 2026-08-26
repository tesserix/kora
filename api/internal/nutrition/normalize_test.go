package nutrition

import "testing"

func TestNormalize(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Grilled Chicken Breast", "grilled chicken breast"},
		{"  Brown   Rice  ", "brown rice"},
		{"Eggs, scrambled!", "egg scrambled"},
		{"Greek yogurt (plain)", "greek yogurt plain"},
		{"oats", "oat"},
		{"glass", "glass"}, // -ss unchanged
		{"", ""},
	}
	for _, c := range cases {
		if got := Normalize(c.in); got != c.want {
			t.Errorf("Normalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestSearchableMethodDropsNonMethods pins kora#467's third component.
//
// identify emits "raw" as a cooking_method for anything uncooked (the
// `vegemite on toast` case in ranking.sample.jsonl does). Folding that into the
// similarity string biases retrieval toward rows whose names contain "raw",
// which is backwards for a signal whose purpose is to stop raw rows winning.
//
// Measured: without this guard, "weet-bix with milk" moved from `Milk` to
// `Milk, cow, fluid, regular fat (~3.5%), raw` — unpasteurised milk, a
// different product. That case is multi-guess and cannot carry an expectation
// in the ranking harness (it checks rank-1 of EVERY guess), and the obvious
// substring "Milk" would match the WRONG row too — so it is pinned here
// instead, where the assertion can actually discriminate.
func TestSearchableMethodDropsNonMethods(t *testing.T) {
	for _, m := range []string{"raw", "RAW", " raw ", "uncooked", "none", "fresh", ""} {
		if got := searchableMethod(m); got != "" {
			t.Errorf("searchableMethod(%q) = %q, want \"\" — a non-method must not reach the search string", m, got)
		}
	}
	for _, m := range []string{"grilled", "fried", "roast", "boiled", "steamed", "baked"} {
		if got := searchableMethod(m); got == "" {
			t.Errorf("searchableMethod(%q) = \"\", want it kept — a real cooking method must reach the search string", m)
		}
	}
}
