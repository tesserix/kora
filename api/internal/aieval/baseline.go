package aieval

import "fmt"

// Margins absorb run-to-run model noise; a drop beyond them is a regression.
const (
	top1Margin        = 0.02
	precisionMargin   = 0.02
	calibrationMargin = 0.03
)

// Compare lists how run regressed against the accepted baseline; empty means it passes.
func Compare(run, baseline Summary) []string {
	if run.Graded != baseline.Graded {
		return []string{fmt.Sprintf("graded items changed from %d to %d: accept a new baseline", baseline.Graded, run.Graded)}
	}
	var regressions []string
	if run.Top1 < baseline.Top1-top1Margin {
		regressions = append(regressions, fmt.Sprintf("top1 %.3f < baseline %.3f", run.Top1, baseline.Top1))
	}
	if run.AutoPrecision < baseline.AutoPrecision-precisionMargin {
		regressions = append(regressions, fmt.Sprintf("auto_precision %.3f < baseline %.3f", run.AutoPrecision, baseline.AutoPrecision))
	}
	if run.CalibrationError > baseline.CalibrationError+calibrationMargin {
		regressions = append(regressions, fmt.Sprintf("calibration_error %.3f > baseline %.3f", run.CalibrationError, baseline.CalibrationError))
	}
	return regressions
}
