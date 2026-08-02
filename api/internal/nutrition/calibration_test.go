package nutrition

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type goldenCase struct {
	Query      string `json:"query"`
	ExpectName string `json:"expect_name"`
	ExpectTier string `json:"expect_tier"`
	Band       string `json:"band"`
}

// tierOf mirrors ai.TierFor's thresholds. It is duplicated rather than
// imported because internal/ai imports internal/nutrition, and importing back
// would be a cycle. TestCalibrationFloorsMatchAI guards the duplication.
func tierOf(score float64) string {
	switch {
	case score >= 0.90:
		return "auto"
	case score >= 0.70:
		return "confirm"
	}
	return "follow_up"
}

func calibrationDB(t *testing.T) *gorm.DB {
	t.Helper()
	url := os.Getenv("CALIBRATION_DATABASE_URL")
	if url == "" {
		t.Skip("CALIBRATION_DATABASE_URL unset; see docs/superpowers/plans/2026-08-02-food-match-scoring.md Task 4")
	}
	db, err := gorm.Open(postgres.Open(url), &gorm.Config{})
	require.NoError(t, err)
	var n int64
	require.NoError(t, db.Raw("SELECT count(*) FROM food_items").Scan(&n).Error)
	require.Greater(t, n, int64(7000),
		"calibration DB has %d rows; it must hold the full index or every number here is meaningless", n)
	return db
}

func loadGolden(t *testing.T) []goldenCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden_queries.json")
	require.NoError(t, err)
	var cases []goldenCase
	require.NoError(t, json.Unmarshal(raw, &cases))
	require.GreaterOrEqual(t, len(cases), 40, "golden set must cover at least 40 queries")

	// The plan ships expect_name as "<from index>" placeholders to be filled in
	// from the real index. An unreplaced one would make the accuracy test
	// silently assert nothing.
	bands := map[string]int{}
	for _, c := range cases {
		require.NotContains(t, c.ExpectName, "<from index>",
			"golden case %q still has an unreplaced expect_name placeholder", c.Query)
		require.NotEmpty(t, c.Query)
		require.Contains(t, []string{"auto", "confirm", "follow_up"}, c.ExpectTier,
			"golden case %q has an invalid expect_tier %q", c.Query, c.ExpectTier)
		bands[c.Band]++
	}
	require.GreaterOrEqual(t, bands["unambiguous"], 15, "unambiguous band too small")
	require.GreaterOrEqual(t, bands["ambiguous"], 12, "ambiguous band too small")
	require.GreaterOrEqual(t, bands["absent"], 5, "absent band too small")
	return cases
}

type goldenResult struct {
	c     goldenCase
	score float64
	top   string
	tier  string
}

func runGolden(t *testing.T) []goldenResult {
	t.Helper()
	repo := NewRepository(calibrationDB(t))
	cases := loadGolden(t)
	out := make([]goldenResult, 0, len(cases))
	for _, c := range cases {
		cands, err := repo.Resolve(context.Background(), uuid.Nil, c.Query, nil, 5)
		require.NoError(t, err)
		r := goldenResult{c: c, tier: "follow_up"}
		if len(cands) > 0 {
			r.score = cands[0].MatchScore
			r.top = cands[0].Item.Name
			r.tier = tierOf(r.score)
		}
		out = append(out, r)
	}
	return out
}

// TestCalibrationReport prints the distribution Task 5 uses to set the floors.
// It asserts nothing beyond the run succeeding — reading it is the point.
func TestCalibrationReport(t *testing.T) {
	results := runGolden(t)
	sort.Slice(results, func(i, j int) bool { return results[i].score > results[j].score })
	fmt.Printf("\n%-28s %-12s %-9s %-10s %s\n", "QUERY", "BAND", "SCORE", "TIER", "TOP MATCH")
	for _, r := range results {
		fmt.Printf("%-28s %-12s %-9.4f %-10s %s\n", r.c.Query, r.c.Band, r.score, r.tier, r.top)
	}
	byBand := map[string][]float64{}
	for _, r := range results {
		byBand[r.c.Band] = append(byBand[r.c.Band], r.score)
	}
	fmt.Printf("\n%-12s %-6s %-9s %-9s %s\n", "BAND", "N", "MIN", "MAX", "MEAN")
	for band, scores := range byBand {
		min, max, sum := scores[0], scores[0], 0.0
		for _, s := range scores {
			if s < min {
				min = s
			}
			if s > max {
				max = s
			}
			sum += s
		}
		fmt.Printf("%-12s %-6d %-9.4f %-9.4f %.4f\n", band, len(scores), min, max, sum/float64(len(scores)))
	}
}

// TestGoldenSetAccuracy is a floor against outright ranking collapse, not a
// quality target. Raw top-1 accuracy conflates two very different failures —
// committing to a wrong answer, and correctly hedging on a hard query — so it
// is unsuitable as the system's real contract; TestNeverConfidentlyWrong is
// that contract. This test exists only to catch the case where the match
// formula stops ranking sensibly at all (e.g. regresses to picking
// essentially-random rows). The miss list below is still useful for spotting
// that kind of regression, so it stays.
func TestGoldenSetAccuracy(t *testing.T) {
	results := runGolden(t)
	correct, total := 0, 0
	var misses []string
	for _, r := range results {
		if r.c.Band == "absent" || r.c.ExpectName == "" {
			continue
		}
		total++
		if r.top == r.c.ExpectName {
			correct++
		} else {
			misses = append(misses, fmt.Sprintf("%q → got %q, want %q", r.c.Query, r.top, r.c.ExpectName))
		}
	}
	t.Logf("top-1 accuracy: %d/%d", correct, total)
	for _, m := range misses {
		t.Logf("  miss: %s", m)
	}
	require.GreaterOrEqual(t, float64(correct)/float64(total), 0.65,
		"top-1 accuracy below 65%%; this is a ranking-collapse floor, not a quality target — "+
			"if this fails, the match formula has stopped ranking sensibly, not merely hedged more than usual")
}

// TestNeverConfidentlyWrong is the real quality contract for the match
// formula. Raw top-1 accuracy is the wrong metric for a system designed to
// ask when it's uncertain: a wrong top-1 that the system flags follow_up
// shows the user an uncertain row and asks them to pick — that is correct,
// designed behaviour, not a defect. A wrong top-1 that the system calls auto
// or confirm silently logs bad data with no chance for the user to catch it
// — that is the actual failure mode this system exists to prevent. So the
// contract is not "top-1 is usually right", it's "top-1 is never wrong
// while the system is confident about it".
func TestNeverConfidentlyWrong(t *testing.T) {
	results := runGolden(t)
	checked := 0
	var violations []string
	for _, r := range results {
		if r.c.Band == "absent" || r.c.ExpectName == "" {
			continue
		}
		if r.tier != "auto" && r.tier != "confirm" {
			continue
		}
		checked++
		if r.top != r.c.ExpectName {
			violations = append(violations, fmt.Sprintf("%q → got %q, want %q (%s)", r.c.Query, r.top, r.c.ExpectName, r.tier))
		}
	}
	t.Logf("confident answers checked: %d, violations: %d", checked, len(violations))
	for _, v := range violations {
		t.Logf("  violation: %s", v)
	}
	require.Empty(t, violations,
		"%d confidently-wrong answer(s) found — the system committed to a wrong top-1 instead of hedging:\n%s",
		len(violations), strings.Join(violations, "\n"))
}

// TestTiersAreNotDegenerate is the test whose absence let a correct, tested,
// deployed tier system sit completely inert in production. Every resolve
// returned match_tier full_text, score 0.717-0.726, tier confirm.
func TestTiersAreNotDegenerate(t *testing.T) {
	results := runGolden(t)

	seenTiers := map[string]int{}
	min, max := 1.0, 0.0
	for _, r := range results {
		seenTiers[r.tier]++
		if r.score < min {
			min = r.score
		}
		if r.score > max {
			max = r.score
		}
	}
	t.Logf("tier distribution: %v, score range [%.4f, %.4f]", seenTiers, min, max)

	require.Greater(t, seenTiers["follow_up"], 0,
		"no query reached follow_up — the tier system is inert, which is the exact bug this work exists to fix")
	require.Greater(t, seenTiers["confirm"], 0, "no query reached confirm")
	require.Greater(t, max-min, 0.30,
		"score range is only %.4f wide; scores are still effectively constant", max-min)
}

// TestAmbiguousQueriesAskRatherThanGuess is the user-visible payoff: a query
// with many near-identical candidates must produce a question, not a guess.
func TestAmbiguousQueriesAskRatherThanGuess(t *testing.T) {
	results := runGolden(t)
	asked, total := 0, 0
	for _, r := range results {
		if r.c.Band != "ambiguous" {
			continue
		}
		total++
		if r.tier == "follow_up" {
			asked++
		} else {
			t.Logf("  %q scored %.4f (%s) — expected follow_up", r.c.Query, r.score, r.tier)
		}
	}
	require.Greater(t, total, 0, "golden set has no ambiguous band")
	require.GreaterOrEqual(t, float64(asked)/float64(total), 0.70,
		"only %d/%d ambiguous queries reached follow_up", asked, total)
}
