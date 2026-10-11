package aieval

import (
	"math"
	"testing"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/nutrition"
)

func resolution(tier ai.Tier, name string, id uuid.UUID, kcal, score float64) ai.Resolution {
	return ai.Resolution{Tier: tier, Candidates: []ai.ResolvedCandidate{{
		Item: nutrition.FoodItem{ID: id, Name: name}, Kcal: kcal, MatchScore: score, Tier: tier,
	}}}
}

func TestGradeMatchesTheExpectedNameCaseInsensitively(t *testing.T) {
	got := Grade(resolution(ai.TierAuto, "Coke Zero, can", uuid.New(), 1, 0.9), Expected{Name: "coke zero"})
	if !got.Graded || !got.Top1Correct || !got.Auto || got.Confidence != 0.9 {
		t.Fatalf("got %+v", got)
	}
}

func TestGradePrefersTheFoodRowOverTheName(t *testing.T) {
	want := uuid.New()
	got := Grade(resolution(ai.TierAuto, "Coke Zero", uuid.New(), 1, 0.9), Expected{Name: "Coke Zero", FoodItemID: want.String()})
	if got.Top1Correct {
		t.Fatal("a different row with the same name must not count as correct")
	}
}

func TestGradeLeavesAJudgementCallUngraded(t *testing.T) {
	if got := Grade(resolution(ai.TierAuto, "Chicken", uuid.New(), 280, 1), Expected{}); got.Graded {
		t.Fatalf("got %+v", got)
	}
}

func TestGradeCountsNoCandidatesAsWrong(t *testing.T) {
	got := Grade(ai.Resolution{Tier: ai.TierFollowUp}, Expected{Name: "Egg"})
	if !got.Graded || got.Top1Correct || got.Auto || got.Confidence != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestGradeChecksKcalWithinTolerance(t *testing.T) {
	cases := []struct {
		name string
		kcal float64
		exp  Expected
		want bool
	}{
		{"inside the default 15%", 110, Expected{Name: "Egg", Kcal: 100}, true},
		{"outside the default 15%", 120, Expected{Name: "Egg", Kcal: 100}, false},
		{"inside a stated tolerance", 140, Expected{Name: "Egg", Kcal: 100, KcalTolerance: 0.5}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Grade(resolution(ai.TierAuto, "Egg", uuid.New(), tc.kcal, 1), tc.exp)
			if got.KcalWithin == nil || *got.KcalWithin != tc.want {
				t.Fatalf("got %+v, want %v", got.KcalWithin, tc.want)
			}
		})
	}
}

func TestGradeSkipsKcalWithoutAReference(t *testing.T) {
	if got := Grade(resolution(ai.TierAuto, "Egg", uuid.New(), 155, 1), Expected{Name: "Egg"}); got.KcalWithin != nil {
		t.Fatalf("got %v", *got.KcalWithin)
	}
}

func TestSummarizeExcludesUngradedCases(t *testing.T) {
	s := Summarize([]Result{
		{Graded: true, Top1Correct: true, Auto: true, Confidence: 1},
		{Graded: true, Top1Correct: false, Auto: true, Confidence: 1},
		{Graded: true, Top1Correct: true, Auto: false, Confidence: 0.5},
		{Graded: false, Top1Correct: false},
	})
	if s.Cases != 4 || s.Graded != 3 {
		t.Fatalf("got %+v", s)
	}
	if math.Abs(s.Top1-2.0/3) > 1e-9 || s.AutoPrecision != 0.5 {
		t.Fatalf("got %+v", s)
	}
}

func TestSummarizeCalibrationErrorIsZeroWhenConfidenceMatchesAccuracy(t *testing.T) {
	s := Summarize([]Result{
		{Graded: true, Top1Correct: true, Confidence: 1},
		{Graded: true, Top1Correct: false, Confidence: 0},
	})
	if s.CalibrationError != 0 {
		t.Fatalf("got %v", s.CalibrationError)
	}
}

func TestSummarizeCalibrationErrorWeighsBinsBySize(t *testing.T) {
	// Three confident misses and one confident hit: bin 0.9 has accuracy 0.25.
	s := Summarize([]Result{
		{Graded: true, Top1Correct: true, Confidence: 0.95},
		{Graded: true, Confidence: 0.95},
		{Graded: true, Confidence: 0.95},
		{Graded: true, Confidence: 0.95},
	})
	if math.Abs(s.CalibrationError-0.7) > 1e-9 {
		t.Fatalf("got %v", s.CalibrationError)
	}
}

func TestSummarizeOfNothingIsEmpty(t *testing.T) {
	if s := Summarize(nil); s.Graded != 0 || s.Top1 != 0 || s.CalibrationError != 0 {
		t.Fatalf("got %+v", s)
	}
}
