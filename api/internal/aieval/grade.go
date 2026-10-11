// Package aieval scores the resolver against golden Langfuse datasets with
// plain code, so a prompt, model or gateway change is measured before it ships.
package aieval

import (
	"math"
	"strings"

	"github.com/tesserix/kora/api/internal/ai"
)

const (
	defaultKcalTolerance = 0.15
	calibrationBins      = 10
)

// Expected is a dataset item's label. An item with neither field is a judgement call and is not graded.
type Expected struct {
	FoodItemID    string  `json:"food_item_id,omitempty"`
	Name          string  `json:"name,omitempty"`
	Kcal          float64 `json:"kcal,omitempty"`
	KcalTolerance float64 `json:"kcal_tolerance,omitempty"`
}

// Result is one item's grade.
type Result struct {
	Graded      bool
	Top1Correct bool
	Auto        bool
	Confidence  float64
	KcalWithin  *bool
}

// Grade checks the resolver's top candidate against the label.
func Grade(res ai.Resolution, exp Expected) Result {
	r := Result{Graded: exp.FoodItemID != "" || exp.Name != ""}
	if len(res.Candidates) == 0 {
		return r
	}
	top := res.Candidates[0]
	r.Auto = res.Tier == ai.TierAuto
	r.Confidence = math.Max(0, math.Min(1, top.MatchScore))
	if exp.FoodItemID != "" {
		r.Top1Correct = top.Item.ID.String() == exp.FoodItemID
	} else if exp.Name != "" {
		r.Top1Correct = strings.Contains(strings.ToLower(top.Item.Name), strings.ToLower(exp.Name))
	}
	if exp.Kcal > 0 {
		tol := exp.KcalTolerance
		if tol <= 0 {
			tol = defaultKcalTolerance
		}
		within := math.Abs(top.Kcal-exp.Kcal) <= tol*exp.Kcal
		r.KcalWithin = &within
	}
	return r
}

// Summary is a run's headline numbers over graded items.
type Summary struct {
	Cases            int     `json:"cases"`
	Graded           int     `json:"graded"`
	Top1             float64 `json:"top1"`
	AutoPrecision    float64 `json:"auto_precision"`
	CalibrationError float64 `json:"calibration_error"`
}

// Summarize computes top-1, precision of auto-tier answers, and expected calibration error.
func Summarize(results []Result) Summary {
	s := Summary{Cases: len(results)}
	var correct, auto, autoCorrect int
	var bins [calibrationBins]struct {
		n       int
		correct int
		conf    float64
	}
	for _, r := range results {
		if !r.Graded {
			continue
		}
		s.Graded++
		if r.Top1Correct {
			correct++
		}
		if r.Auto {
			auto++
			if r.Top1Correct {
				autoCorrect++
			}
		}
		b := &bins[min(int(r.Confidence*calibrationBins), calibrationBins-1)]
		b.n++
		b.conf += r.Confidence
		if r.Top1Correct {
			b.correct++
		}
	}
	if s.Graded == 0 {
		return s
	}
	s.Top1 = float64(correct) / float64(s.Graded)
	if auto > 0 {
		s.AutoPrecision = float64(autoCorrect) / float64(auto)
	}
	for _, b := range bins {
		if b.n == 0 {
			continue
		}
		gap := math.Abs(float64(b.correct)/float64(b.n) - b.conf/float64(b.n))
		s.CalibrationError += gap * float64(b.n) / float64(s.Graded)
	}
	return s
}
