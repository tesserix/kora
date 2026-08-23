package database

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// kora#45. The six tape measurements have to be nullable doubles on
// weight_entries. Nullability is the load-bearing half: a tape is used
// piecemeal, so a NOT NULL column would force an untaken measurement to be
// stored as a 0 that reads as a measurement forever.
func TestTapeMeasurementColumnsAreNullableDoubles(t *testing.T) {
	db := testDB(t)

	for _, col := range []string{"neck_cm", "chest_cm", "waist_cm", "hip_cm", "arm_cm", "thigh_cm"} {
		t.Run(col, func(t *testing.T) {
			var row struct {
				DataType   string
				IsNullable string
			}
			require.NoError(t, db.Raw(`
				SELECT data_type, is_nullable FROM information_schema.columns
				WHERE table_name = 'weight_entries' AND column_name = ?`, col).
				Scan(&row).Error)

			require.Equal(t, "double precision", row.DataType,
				"%s must be a double: a tape reads in fractions of a centimetre", col)
			assert.Equal(t, "YES", row.IsNullable,
				"%s must be nullable so an untaken measurement stays absent, never 0", col)
		})
	}
}
