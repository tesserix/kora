// api/internal/health/service.go
package health

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/tracking"
)

// WeightWriter is the slice of tracking.Repository this package needs. Narrow
// on purpose: it keeps the ingest path testable without a database and makes
// the dependency direction obvious.
type WeightWriter interface {
	AddWeightEntry(ctx context.Context, userID uuid.UUID, in tracking.WeightInput) (tracking.WeightEntry, error)
}

type Service struct{ weights WeightWriter }

func NewService(weights WeightWriter) Service { return Service{weights: weights} }

// Sync ingests one batch. Records are validated and written INDIVIDUALLY: a
// malformed sample is reported and skipped rather than failing the batch,
// because the device re-sends whole windows and one bad record would
// otherwise poison every future sync containing it.
//
// A WRITE failure is different from a validation failure -- it means the
// database is unhappy, not the record -- so it aborts and returns an error,
// leaving the device's anchor unmoved so the window is retried.
func (s Service) Sync(ctx context.Context, userID uuid.UUID, req SyncRequest) (SyncResponse, error) {
	resp := SyncResponse{Rejected: []RejectedRecord{}}

	for _, r := range req.Weights {
		if err := validateWeight(r); err != nil {
			resp.Rejected = append(resp.Rejected, RejectedRecord{HKUUID: r.HKUUID, Reason: err.Error()})
			continue
		}
		localDate, err := time.Parse(localDateLayout, r.LocalDate)
		if err != nil {
			resp.Rejected = append(resp.Rejected, RejectedRecord{HKUUID: r.HKUUID, Reason: err.Error()})
			continue
		}
		hk := r.HKUUID
		if _, err := s.weights.AddWeightEntry(ctx, userID, tracking.WeightInput{
			WeightKg:  r.WeightKg,
			LoggedAt:  r.RecordedAt,
			LocalDate: localDate,
			HKUUID:    &hk,
			// Source is the ONLY composition field set. Everything else stays
			// nil: this is a weight, not a body-composition reading.
			Composition: tracking.BodyComposition{Source: tracking.SourceHealthKit},
		}); err != nil {
			return SyncResponse{}, err
		}
		resp.Accepted++
	}
	return resp, nil
}
