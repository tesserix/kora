package main

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/nutrition"
	"github.com/tesserix/kora/api/internal/units"
)

func TestBackfillItem(t *testing.T) {
	tests := []struct {
		name       string
		item       nutrition.FoodItem
		wantOK     bool
		wantName   string
		wantAmount float64
	}{
		{
			name:       "seeded cup serving is parsed",
			item:       nutrition.FoodItem{ServingDesc: "1 cup (158g)"},
			wantOK:     true,
			wantName:   "cup",
			wantAmount: 158,
		},
		{
			name:       "seeded sachet serving is parsed",
			item:       nutrition.FoodItem{ServingDesc: "1 sachet (16.5g)"},
			wantOK:     true,
			wantName:   "sachet",
			wantAmount: 16.5,
		},
		{
			name:       "unparseable description falls back to the curated table",
			item:       nutrition.FoodItem{Name: "White rice, cooked", ServingDesc: "per serving"},
			wantOK:     true,
			wantName:   "cup",
			wantAmount: 158,
		},
		{
			name:   "unparseable description with no curated entry is skipped",
			item:   nutrition.FoodItem{Name: "Grilled chicken breast", ServingDesc: "per serving"},
			wantOK: false,
		},
		{
			name:   "a row that already has units is left alone",
			item:   nutrition.FoodItem{ServingDesc: "1 cup (158g)", ServingUnits: json.RawMessage(`[{"name":"bowl","amount":1,"base_amount":300}]`)},
			wantOK: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := backfillItem(tt.item)
			assert.Equal(t, tt.wantOK, ok)
			if !tt.wantOK {
				return
			}
			var parsed []units.ServingUnit
			require.NoError(t, json.Unmarshal(got, &parsed))
			require.Len(t, parsed, 1)
			assert.Equal(t, tt.wantName, parsed[0].Name)
			assert.InDelta(t, tt.wantAmount, parsed[0].BaseAmount, 1e-9)
		})
	}
}
