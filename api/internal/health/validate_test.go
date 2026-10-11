// api/internal/health/validate_test.go
package health

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestValidateWeight(t *testing.T) {
	valid := WeightRecord{
		HKUUID: uuid.New(), WeightKg: 70.4,
		RecordedAt: time.Now().Add(-time.Hour), LocalDate: "2026-08-23",
	}
	require.NoError(t, validateWeight(valid))

	t.Run("rejects a missing sample id", func(t *testing.T) {
		r := valid
		r.HKUUID = uuid.Nil
		require.Error(t, validateWeight(r), "without an id the write cannot be idempotent")
	})

	// Same bounds internal/bodyread applies, and for the same reason: the
	// floor catches a decimal misread, the ceiling catches a garbled value.
	// A stored impossible weight deforms every chart drawn from it forever.
	for _, kg := range []float64{0, -1, 19.9, 300.1} {
		r := valid
		r.WeightKg = kg
		require.Error(t, validateWeight(r))
	}

	t.Run("rejects a future reading", func(t *testing.T) {
		r := valid
		r.RecordedAt = time.Now().Add(48 * time.Hour)
		require.Error(t, validateWeight(r))
	})

	t.Run("rejects a malformed local date", func(t *testing.T) {
		r := valid
		r.LocalDate = "23/08/2026"
		require.Error(t, validateWeight(r))
	})
}
