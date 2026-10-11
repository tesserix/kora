package health

import (
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Same bounds internal/bodyread uses. 20kg is generous enough for a real adult
// outlier while still catching a decimal misread; 300kg catches an extra digit.
// Neither is a clinical judgement.
//
// These bounds MUST stay at least as tight as tracking.AddWeightEntry's check
// (weight_kg > 0). If either bound is loosened, a record passing this validation
// but failing the tracking check would cause Service.Sync to abort the whole batch
// with a 500; validation issues should instead be per-record rejections with 200.
// Keep the bounds linked: if loosening, update both or document the exception.
const (
	weightMinKg = 20.0
	weightMaxKg = 300.0
	// One day of grace, matching internal/bodyread's reading-date rule: the
	// device's clock and the server's need not agree on the calendar day.
	futureGrace     = 24 * time.Hour
	localDateLayout = "2006-01-02"
)

func validateWeight(r WeightRecord) error {
	if r.HKUUID == uuid.Nil {
		return fmt.Errorf("hk_uuid is required")
	}
	if r.WeightKg < weightMinKg || r.WeightKg > weightMaxKg {
		return fmt.Errorf("weight_kg %.4g outside %g-%g", r.WeightKg, weightMinKg, weightMaxKg)
	}
	if r.RecordedAt.After(time.Now().Add(futureGrace)) {
		return fmt.Errorf("recorded_at is in the future")
	}
	if _, err := time.Parse(localDateLayout, r.LocalDate); err != nil {
		return fmt.Errorf("local_date %q is not YYYY-MM-DD", r.LocalDate)
	}
	return nil
}
