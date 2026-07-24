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
