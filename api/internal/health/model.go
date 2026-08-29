// Package health ingests data read from a platform health store (Apple
// HealthKit today -- kora#30) and written into Kora's own tables.
//
// The device reconciles BEFORE posting: HealthKit returns every writing
// source's samples with no deduplication, and only the device can apply
// HealthKit's source-priority rules. Two bugs in this repo came from ignoring
// that (#140, #327). This package therefore trusts that what arrives is
// already reconciled, and its job is validation, identity and storage.
package health

import (
	"time"

	"github.com/google/uuid"
)

// WeightRecord is one weight sample as the device read it.
type WeightRecord struct {
	// HKUUID is the HealthKit sample's identifier and the dedup key. Required:
	// without it a re-sync would duplicate the reading.
	HKUUID     uuid.UUID `json:"hk_uuid"`
	WeightKg   float64   `json:"weight_kg"`
	RecordedAt time.Time `json:"recorded_at"`
	// LocalDate is the device-local day at capture, "YYYY-MM-DD" (kora#84).
	LocalDate string `json:"local_date"`
	// SourceName is HealthKit's own name for the writing app or device
	// ("Withings", "Apple Watch"). Recorded for provenance, never used to
	// decide whether two readings may share a trend line -- weight_entries.source
	// does that, and it is 'healthkit' for everything here.
	SourceName string `json:"source_name"`
}

type SyncRequest struct {
	Weights []WeightRecord `json:"weights"`
}

// RejectedRecord names one record the batch declined and why. A malformed
// sample must not discard the good ones alongside it.
type RejectedRecord struct {
	HKUUID uuid.UUID `json:"hk_uuid"`
	Reason string    `json:"reason"`
}

type SyncResponse struct {
	Accepted int              `json:"accepted"`
	Rejected []RejectedRecord `json:"rejected"`
}
