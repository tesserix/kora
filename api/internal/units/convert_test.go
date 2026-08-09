package units

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestToBase(t *testing.T) {
	sachet := []ServingUnit{{Name: "sachet", Amount: 1, BaseAmount: 16.5}}

	tests := []struct {
		name     string
		amount   float64
		unit     string
		baseUnit string
		units    []ServingUnit
		want     float64
	}{
		{name: "base unit passes through", amount: 140, unit: "g", baseUnit: "g", want: 140},
		{name: "millilitre base passes through", amount: 200, unit: "ml", baseUnit: "ml", want: 200},
		{name: "one named serving", amount: 1, unit: "sachet", baseUnit: "g", units: sachet, want: 16.5},
		{name: "two named servings", amount: 2, unit: "sachet", baseUnit: "g", units: sachet, want: 33},
		{name: "unit name is case-insensitive", amount: 1, unit: "Sachet", baseUnit: "g", units: sachet, want: 16.5},
		{name: "kilogram scales to grams", amount: 1.5, unit: "kg", baseUnit: "g", want: 1500},
		{name: "litre scales to millilitres", amount: 1, unit: "L", baseUnit: "ml", want: 1000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ToBase(tt.amount, tt.unit, tt.baseUnit, tt.units)
			require.NoError(t, err)
			assert.InDelta(t, tt.want, got, 1e-9)
		})
	}
}

func TestToBaseErrors(t *testing.T) {
	sachet := []ServingUnit{{Name: "sachet", Amount: 1, BaseAmount: 16.5}}

	tests := []struct {
		name     string
		amount   float64
		unit     string
		baseUnit string
		units    []ServingUnit
		wantErr  error
	}{
		{name: "unknown unit is an error not a guess", amount: 1, unit: "cup", baseUnit: "g", units: sachet, wantErr: ErrNoConversion},
		{name: "mass unit against a volume base", amount: 1, unit: "kg", baseUnit: "ml", wantErr: ErrNoConversion},
		{name: "zero amount is rejected", amount: 0, unit: "g", baseUnit: "g", wantErr: ErrInvalidAmount},
		{name: "negative amount is rejected", amount: -5, unit: "g", baseUnit: "g", wantErr: ErrInvalidAmount},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ToBase(tt.amount, tt.unit, tt.baseUnit, tt.units)
			assert.ErrorIs(t, err, tt.wantErr)
			assert.Zero(t, got)
		})
	}
}

func TestTableCoversStaples(t *testing.T) {
	// The table is deliberately small. This test pins the promise made in the
	// spec — cups work for the staples and are honestly absent elsewhere —
	// so shrinking it below that is a visible failure, not a silent one.
	for _, key := range []string{"rice", "flour", "milk"} {
		t.Run(key, func(t *testing.T) {
			cups, ok := Table[key]
			require.True(t, ok, "expected a curated entry for %q", key)
			assert.NotEmpty(t, cups)
		})
	}
}

func TestFallback(t *testing.T) {
	tests := []struct {
		name     string
		foodName string
		wantUnit string // "" means no curated entry
	}{
		{name: "keyword matches anywhere in the name", foodName: "White rice, cooked", wantUnit: "cup"},
		{name: "match is case-insensitive", foodName: "Plain FLOUR", wantUnit: "cup"},
		{name: "bread gets a slice, not a cup", foodName: "Wholemeal bread", wantUnit: "slice"},
		{name: "an unlisted food gets nothing", foodName: "Grilled chicken breast", wantUnit: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Fallback(tt.foodName)
			if tt.wantUnit == "" {
				assert.Empty(t, got)
				return
			}
			require.Len(t, got, 1)
			assert.Equal(t, tt.wantUnit, got[0].Name)
		})
	}
}

func TestFallbackMultipleMatches(t *testing.T) {
	// When a food name matches multiple keywords, the longest wins.
	// "oat milk" matches both "oat" (3 chars) and "milk" (4 chars) → "milk" (250).
	// "rice milk" matches both "rice" (4 chars) and "milk" (4 chars) → "milk" (lexicographically smaller).
	tests := []struct {
		name         string
		foodName     string
		wantBaseUnit float64
	}{
		{name: "oat milk matches milk not oat", foodName: "Oat milk", wantBaseUnit: 250},
		{name: "rice milk tie breaks to milk (longer than rice by lex)", foodName: "rice milk", wantBaseUnit: 250},
		{name: "sugar bread matches bread not sugar", foodName: "sugar bread", wantBaseUnit: 35},
		{name: "single keyword still works", foodName: "Plain rice", wantBaseUnit: 158},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Fallback(tt.foodName)
			require.Len(t, got, 1)
			assert.Equal(t, tt.wantBaseUnit, got[0].BaseAmount)
		})
	}
}

func TestFallbackDeterministic(t *testing.T) {
	// Repeated calls for the same multi-match food must return the same result.
	// Go randomizes map iteration order, so this test ensures we're not picking
	// whichever keyword the range happens to visit first.
	const iterations = 50
	expected := Fallback("oat milk")
	for i := 0; i < iterations; i++ {
		got := Fallback("oat milk")
		require.Len(t, expected, 1)
		require.Len(t, got, 1)
		assert.Equal(t, expected[0].BaseAmount, got[0].BaseAmount, "iteration %d returned different result", i)
		assert.Equal(t, expected[0].Name, got[0].Name, "iteration %d returned different unit name", i)
	}
}
