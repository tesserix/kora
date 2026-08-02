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
	c        goldenCase
	score    float64
	top      string
	tier     string
	hasMatch bool // false only when Resolve returned zero candidates
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
			r.hasMatch = true
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
	require.Greater(t, checked, 0,
		"zero confident answers (auto or confirm tier) were found — the tier system has collapsed to always-hedging, "+
			"and this test verified nothing; if this fails, check that tierOf thresholds are reachable with the golden set scores")
	require.Empty(t, violations,
		"%d confidently-wrong answer(s) found — the system committed to a wrong top-1 instead of hedging:\n%s",
		len(violations), strings.Join(violations, "\n"))
}

// TestTiersAreNotDegenerate is the test whose absence let a correct, tested,
// deployed tier system sit completely inert in production. Every resolve
// returned match_tier full_text, score 0.717-0.726, tier confirm.
//
// It only looks at queries that matched at least one candidate. The
// "absent" band (queries for foods genuinely not in the index) always
// returns zero candidates and defaults to tier follow_up / score 0 — that
// signal comes from the index having nothing to rank, not from the scoring
// formula, and mixing it in would let a degenerate, constant-scoring
// formula hide behind those absent-band entries: they alone are enough to
// make seenTiers["follow_up"] > 0 and to widen the score range past 0.30,
// even when every *matched* query scores identically. Confirmed by mutation
// test (Task 5 Step 4): before this exclusion, restoring the old constant
// score plus removing the ambiguity factor still passed this guard, because
// the 6 absent-band entries alone satisfied both checks.
func TestTiersAreNotDegenerate(t *testing.T) {
	results := runGolden(t)

	seenTiers := map[string]int{}
	min, max := 1.0, 0.0
	noMatch := 0
	for _, r := range results {
		if !r.hasMatch {
			noMatch++
			continue
		}
		seenTiers[r.tier]++
		if r.score < min {
			min = r.score
		}
		if r.score > max {
			max = r.score
		}
	}
	t.Logf("tier distribution (matched queries only): %v, score range [%.4f, %.4f], %d queries had no candidates",
		seenTiers, min, max, noMatch)

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

// TestGoldenSetTierMatchesExpectation enforces the golden set's expect_tier
// field, which was advisory (unasserted) until the floors were calibrated.
//
// It splits disagreements into two kinds because they carry very different
// risk:
//
//   - Escalation: expect_tier is follow_up (the case was authored as one the
//     system should hedge on) but the observed tier is confirm or auto. This
//     is the dangerous direction — the system would commit to or
//     quick-confirm something its own author expected it to question — so
//     it is zero-tolerance.
//   - Other drift: every other disagreement, in either direction (confirm
//     expected but got auto, confirm expected but got follow_up, etc). None
//     of these involve a case authored as "hedge" turning confident, so none
//     carry that risk. This bucket is dominated by a known coarse label:
//     every unambiguous-band case shipped with expect_tier "confirm" as a
//     blanket placeholder, without knowing which of those queries would
//     land an exact 1.0 match (auto) versus a near match below the confirm
//     floor (follow_up). Measured at calibration time this was 29/54 cases,
//     entirely accounted for by that placeholder gap (19 unambiguous exact
//     matches plus cheddar cheese landing in auto instead of confirm; 8
//     unambiguous plus peanut butter landing in follow_up instead of
//     confirm). So this side is a logged count against a floor, not
//     zero-tolerance — the floor exists so a real regression (e.g. the
//     scorer collapsing back toward constant scores) still trips this test.
func TestGoldenSetTierMatchesExpectation(t *testing.T) {
	results := runGolden(t)

	var escalations, other []string
	matched := 0
	for _, r := range results {
		if r.tier == r.c.ExpectTier {
			matched++
			continue
		}
		msg := fmt.Sprintf("%q (%s): expected %s, got %s (score %.4f)",
			r.c.Query, r.c.Band, r.c.ExpectTier, r.tier, r.score)
		if r.c.ExpectTier == "follow_up" {
			escalations = append(escalations, msg)
		} else {
			other = append(other, msg)
		}
	}

	t.Logf("expect_tier agreement: %d/%d exact matches", matched, len(results))
	t.Logf("other drift (non-dangerous direction): %d", len(other))
	for _, m := range other {
		t.Logf("  drift: %s", m)
	}
	t.Logf("escalations (expected follow_up, observed confident): %d", len(escalations))
	for _, m := range escalations {
		t.Logf("  ESCALATION: %s", m)
	}

	require.Empty(t, escalations,
		"%d case(s) expected to hedge (follow_up) but the system committed to confirm/auto instead — "+
			"this is the dangerous direction, never acceptable:\n%s",
		len(escalations), strings.Join(escalations, "\n"))

	require.LessOrEqual(t, len(other), 35,
		"%d cases disagreed with expect_tier outside the dangerous direction; that's above the "+
			"known-label-gap baseline (~29) and may indicate a real scoring regression, not just "+
			"the coarse blanket-\"confirm\" placeholder on the unambiguous band",
		len(other))
}

// TestCalibrationFloorsMatchAI guards the tierOf duplication above. tierOf
// cannot import ai (internal/ai imports internal/nutrition, so it would be a
// cycle), and a silent drift between the two would make every calibration
// number a lie.
func TestCalibrationFloorsMatchAI(t *testing.T) {
	raw, err := os.ReadFile("../ai/types.go")
	require.NoError(t, err)
	require.Contains(t, string(raw), "tierAutoFloor    = 0.90",
		"ai.tierAutoFloor changed; update tierOf in this file to match")
	require.Contains(t, string(raw), "tierConfirmFloor = 0.70",
		"ai.tierConfirmFloor changed; update tierOf in this file to match")
}
