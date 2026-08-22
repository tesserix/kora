// api/internal/health/service_test.go
package health

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/tesserix/kora/api/internal/tracking"
)

type fakeWriter struct {
	calls []tracking.WeightInput
	err   error
}

func (f *fakeWriter) AddWeightEntry(_ context.Context, _ uuid.UUID, in tracking.WeightInput) (tracking.WeightEntry, error) {
	if f.err != nil {
		return tracking.WeightEntry{}, f.err
	}
	f.calls = append(f.calls, in)
	return tracking.WeightEntry{ID: uuid.New()}, nil
}

func rec(kg float64) WeightRecord {
	return WeightRecord{HKUUID: uuid.New(), WeightKg: kg, RecordedAt: time.Now(), LocalDate: "2026-08-23"}
}

// One bad record must not discard the good ones beside it: the device
// re-sends whole windows, so a single malformed sample would otherwise block
// every sync that contained it, forever.
func TestSyncAcceptsGoodRecordsAndReportsBadOnes(t *testing.T) {
	w := &fakeWriter{}
	bad := rec(0) // fails the weight bounds
	resp, err := NewService(w).Sync(context.Background(), uuid.New(), SyncRequest{
		Weights: []WeightRecord{rec(70.4), bad, rec(71.1)},
	})
	require.NoError(t, err)
	require.Equal(t, 2, resp.Accepted)
	require.Len(t, resp.Rejected, 1)
	require.Equal(t, bad.HKUUID, resp.Rejected[0].HKUUID)
	require.Len(t, w.calls, 2)
}

// Every synced row is a weight and nothing else. A 0 in a composition column
// is a measurement claim (migration 000039).
func TestSyncWritesHealthKitSourceAndNoComposition(t *testing.T) {
	w := &fakeWriter{}
	_, err := NewService(w).Sync(context.Background(), uuid.New(), SyncRequest{Weights: []WeightRecord{rec(70.4)}})
	require.NoError(t, err)
	require.Len(t, w.calls, 1)

	in := w.calls[0]
	require.Equal(t, tracking.SourceHealthKit, in.Composition.Source)
	require.NotNil(t, in.HKUUID)
	require.Nil(t, in.Composition.BodyFatPct)
	require.Nil(t, in.Composition.MuscleMassKg)
	require.Nil(t, in.Composition.VisceralFatRating)
}
