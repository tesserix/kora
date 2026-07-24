package ai

import "testing"

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
