package units

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParse(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []ServingUnit
	}{
		{
			name:  "single count serving with grams",
			input: "1 cup (158g)",
			want:  []ServingUnit{{Name: "cup", Amount: 1, BaseAmount: 158}},
		},
		{
			name:  "plural count serving divides by the count",
			input: "2 biscuits (30g)",
			want:  []ServingUnit{{Name: "biscuit", Amount: 1, BaseAmount: 15}},
		},
		{
			name:  "fractional base amount is preserved",
			input: "1 sachet (16.5g)",
			want:  []ServingUnit{{Name: "sachet", Amount: 1, BaseAmount: 16.5}},
		},
		{
			name:  "size adjective is kept as the unit name",
			input: "1 medium (118g)",
			want:  []ServingUnit{{Name: "medium", Amount: 1, BaseAmount: 118}},
		},
		{
			name:  "millilitre serving",
			input: "1 glass (250ml)",
			want:  []ServingUnit{{Name: "glass", Amount: 1, BaseAmount: 250}},
		},
		{
			name:  "leading-mass form with no parenthetical",
			input: "45g pack",
			want:  []ServingUnit{{Name: "pack", Amount: 1, BaseAmount: 45}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Parse(tt.input)
			require.NoError(t, err)
			assert.Equal(t, tt.want, got)
		})
	}
}

func TestParseNoUnits(t *testing.T) {
	for _, input := range []string{"", "per serving", "about a handful"} {
		t.Run(input, func(t *testing.T) {
			got, err := Parse(input)
			assert.ErrorIs(t, err, ErrNoUnits)
			assert.Nil(t, got)
		})
	}
}
