package units

import (
	"encoding/json"
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

// TestResolveEnteredNamedServing proves ResolveEntered resolves a valid
// named serving straight from raw ServingUnits JSON, exactly like ToBase
// would given the already-decoded slice — this is the entry point foodlog
// and savedmeals both call so an entered unit resolves identically on every
// surface.
func TestResolveEnteredNamedServing(t *testing.T) {
	raw := json.RawMessage(`[{"name":"sachet","amount":1,"base_amount":16.5}]`)

	got, err := ResolveEntered(2, "sachet", "g", raw)
	require.NoError(t, err)
	assert.InDelta(t, 33.0, got, 1e-9)
}

// TestResolveEnteredUnknownUnit proves an unresolvable unit surfaces
// ErrNoConversion rather than a guessed default — the same failure ToBase
// itself returns, unwrapped, so callers can httpx.ValidationError it with
// UnrecognisedUnitMessage.
func TestResolveEnteredUnknownUnit(t *testing.T) {
	raw := json.RawMessage(`[]`)

	got, err := ResolveEntered(1, "handful", "g", raw)
	assert.ErrorIs(t, err, ErrNoConversion)
	assert.Zero(t, got)
}

// TestResolveEnteredMalformedServingUnits proves a malformed serving_units
// JSON degrades to an empty slice rather than failing the resolution outright
// — a decode error must never break entry, it just means no named serving
// resolves for this row.
func TestResolveEnteredMalformedServingUnits(t *testing.T) {
	raw := json.RawMessage(`not valid json`)

	got, err := ResolveEntered(1, "sachet", "g", raw)
	assert.ErrorIs(t, err, ErrNoConversion)
	assert.Zero(t, got)
}

func TestDecodeServingUnitsMalformedYieldsEmpty(t *testing.T) {
	assert.Empty(t, DecodeServingUnits(json.RawMessage(`not valid json`)))
	assert.Empty(t, DecodeServingUnits(nil))
	assert.Empty(t, DecodeServingUnits(json.RawMessage(``)))
}

func TestParsePhrase(t *testing.T) {
	tests := []struct {
		phrase     string
		wantAmount float64
		wantUnit   string
		wantOK     bool
	}{
		{phrase: "150g", wantAmount: 150, wantUnit: "g", wantOK: true},
		{phrase: "1 tbsp", wantAmount: 1, wantUnit: "tbsp", wantOK: true},
		{phrase: "2 sachets", wantAmount: 2, wantUnit: "sachets", wantOK: true},
		{phrase: "", wantOK: false},
		{phrase: "a pinch", wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.phrase, func(t *testing.T) {
			amount, unit, ok := ParsePhrase(tt.phrase)
			require.Equal(t, tt.wantOK, ok)
			if tt.wantOK {
				assert.InDelta(t, tt.wantAmount, amount, 1e-9)
				assert.Equal(t, tt.wantUnit, unit)
			}
		})
	}
}
