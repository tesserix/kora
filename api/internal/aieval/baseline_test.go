package aieval

import (
	"strings"
	"testing"
)

func TestCompareAcceptsAnUnchangedRun(t *testing.T) {
	base := Summary{Graded: 40, Top1: 0.8, AutoPrecision: 0.9, CalibrationError: 0.1}
	if got := Compare(base, base); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestCompareToleratesNoiseWithinTheMargins(t *testing.T) {
	base := Summary{Graded: 40, Top1: 0.8, AutoPrecision: 0.9, CalibrationError: 0.1}
	run := Summary{Graded: 40, Top1: 0.79, AutoPrecision: 0.89, CalibrationError: 0.12}
	if got := Compare(run, base); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestCompareFlagsEachRegressedMetric(t *testing.T) {
	base := Summary{Graded: 40, Top1: 0.8, AutoPrecision: 0.9, CalibrationError: 0.1}
	run := Summary{Graded: 40, Top1: 0.7, AutoPrecision: 0.8, CalibrationError: 0.2}
	got := strings.Join(Compare(run, base), "\n")
	for _, metric := range []string{"top1", "auto_precision", "calibration_error"} {
		if !strings.Contains(got, metric) {
			t.Errorf("missing %s in %q", metric, got)
		}
	}
}

func TestCompareRefusesABaselineFromADifferentDataset(t *testing.T) {
	base := Summary{Graded: 40, Top1: 0.8}
	run := Summary{Graded: 41, Top1: 0.9}
	got := Compare(run, base)
	if len(got) != 1 || !strings.Contains(got[0], "graded") {
		t.Fatalf("got %v", got)
	}
}

func TestCompareImprovementsAreNotRegressions(t *testing.T) {
	base := Summary{Graded: 40, Top1: 0.7, AutoPrecision: 0.8, CalibrationError: 0.2}
	run := Summary{Graded: 40, Top1: 0.9, AutoPrecision: 0.95, CalibrationError: 0.05}
	if got := Compare(run, base); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestCompareRejectsRunsWithoutGradedCases(t *testing.T) {
	if got := Compare(Summary{Cases: 3}, Summary{Cases: 3}); len(got) == 0 {
		t.Fatal("an evaluation with no graded cases passed the accuracy gate")
	}
}
