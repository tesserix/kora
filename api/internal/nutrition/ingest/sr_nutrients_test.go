package ingest

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSRLegacyPreservesSodiumSugarAndRAE(t *testing.T) {
	in := `{"SRLegacyFoods":[{"description":"Measured food","foodNutrients":[
		{"nutrient":{"id":1008},"amount":100},{"nutrient":{"id":1003},"amount":5},
		{"nutrient":{"id":1005},"amount":15},{"nutrient":{"id":1004},"amount":2},
		{"nutrient":{"id":1093},"amount":420},{"nutrient":{"id":2000},"amount":0},
		{"nutrient":{"id":1104},"amount":9999},{"nutrient":{"id":1106},"amount":12}
	]}]}`
	var out bytes.Buffer
	stats, err := ConvertSRLegacy(strings.NewReader(in), &out)
	require.NoError(t, err)
	require.Equal(t, 1, stats.Converted)
	var rows []row
	require.NoError(t, json.Unmarshal(out.Bytes(), &rows))
	require.NotNil(t, rows[0].SodiumMgPer100g)
	require.Equal(t, 420.0, *rows[0].SodiumMgPer100g)
	require.Equal(t, 0.0, *rows[0].SugarPer100g)
	require.Equal(t, 12.0, *rows[0].VitaminARAEUgPer100g)
	require.Nil(t, rows[0].VitaminDUgPer100g)
}
