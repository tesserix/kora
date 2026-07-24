package ingest

import (
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func TestLoadFileStampsProvenanceAndSkipsInvalid(t *testing.T) {
	items, err := LoadFile("testdata/sample.json", nutrition.ProvenanceUSDA)
	require.NoError(t, err)
	require.Len(t, items, 1) // "Bad Row" (kcal 0) skipped
	require.Equal(t, "Test Oats", items[0].Name)
	require.Equal(t, nutrition.ProvenanceUSDA, items[0].Provenance)
}
