package ingest

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConvertSRLegacy(t *testing.T) {
	in, err := os.Open("testdata/sr_legacy_sample.json")
	require.NoError(t, err)
	defer in.Close()

	var out bytes.Buffer
	stats, err := ConvertSRLegacy(in, &out)
	require.NoError(t, err)

	// The third record has no energy (1008) and must be dropped rather than
	// emitted as a zero-calorie row, which would later read as a measurement.
	require.Equal(t, 2, stats.Converted)
	require.Equal(t, 1, stats.Skipped)

	var rows []row
	require.NoError(t, json.Unmarshal(out.Bytes(), &rows))
	require.Len(t, rows, 2)

	// Names go in verbatim — no shortening. Shortening would collapse distinct
	// cuts into one row via the name+brand dedup and silently lose coverage.
	require.Equal(t, "Cheese, cheddar", rows[0].Name)
	require.Equal(t, 403.0, rows[0].KcalPer100g)
	require.Equal(t, 22.9, rows[0].ProteinPer100g)
	require.Equal(t, 3.09, rows[0].CarbsPer100g)
	require.Equal(t, 33.1, rows[0].FatPer100g)
	// The first portion supplies the serving; 1062 (kJ) must never be used.
	require.Equal(t, 132.0, rows[0].ServingGrams)
	require.Equal(t, "cup, diced (132 g)", rows[0].ServingDesc)

	// No portions -> fall back to 100 g rather than 0, which would make a
	// portion-scaled log silently zero.
	require.Equal(t, "Spices, oregano, dried", rows[1].Name)
	require.Equal(t, 100.0, rows[1].ServingGrams)
	require.Equal(t, "100 g", rows[1].ServingDesc)
	// Fibre is absent on this record and defaults to 0.
	require.Equal(t, 0.0, rows[1].FiberPer100g)
}
