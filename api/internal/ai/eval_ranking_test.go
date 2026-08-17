//go:build eval

// Provider-free ranking diagnostic for the resolution engine. NOT part of
// `go test` — run with:
//
//	set -a && . ./.env && set +a
//	KORA_EVAL=1 go test -tags eval ./internal/ai/ -run TestEvalRanking -v
//
// Sibling of TestEvalChat in eval_test.go, and deliberately its opposite:
// TestEvalChat calls a real AI provider (costs money, nondeterministic, measures
// the whole pipeline), while this calls NO provider at all and measures only the
// matching/ranking layer — nutrition.Resolve plus the phrase-coverage damping.
// That makes it cheap, repeatable and byte-stable, which is what a regression
// suite for index and scoring changes has to be.
//
// The guess strings that identify WOULD have emitted are read from the dataset
// instead of being generated, so a run exercises exactly the same index queries
// production made without paying for an LLM call. Embeddings are likewise not
// requested: nutrition.Resolve is handed a nil query vector, so its embedding
// tier is skipped and only the deterministic alias/full-text tiers run. A
// ranking change that only shows up once embeddings are in play is therefore
// out of this harness's scope BY DESIGN — determinism was the trade.
//
// READ-ONLY. It opens the database, runs SELECTs through nutrition.Repository
// and writes nothing. It must stay that way: internal/nutrition's ordinary
// tests truncate the shared dev food_items table (kora#151), and this file must
// never become another way to lose the index.
//
// Same conventions as eval_test.go: `eval` build tag, package ai_test,
// KORA_EVAL* env vars, dataset under testdata/eval.
package ai_test

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/tesserix/kora/api/internal/ai"
	"github.com/tesserix/kora/api/internal/config"
	"github.com/tesserix/kora/api/internal/database"
	"github.com/tesserix/kora/api/internal/nutrition"
)

// rankingTopK is how many candidates per guess the report shows. Larger than
// production's resolveTopK on purpose: the point is to see what ELSE the index
// offered, including the correct row sitting at rank 4 behind a branded
// single-token product.
const rankingTopK = 10

// defaultIdentifyConfidence is the confidence identify was measured emitting on
// both kora#184 production failures. Cases may override it per guess; the
// default is stated here once so the dataset does not have to repeat a number
// that is a property of the model, not of the case.
const defaultIdentifyConfidence = 0.95

type rankingGuess struct {
	Food            string  `json:"food"`
	PortionEstimate string  `json:"portion_estimate"`
	CookingMethod   string  `json:"cooking_method"`
	Confidence      float64 `json:"confidence"`
}

type rankingCase struct {
	Phrase string         `json:"phrase"`
	Guess  []rankingGuess `json:"guesses"`
	// ExpectedName is a substring expected in the top-1 item name, recorded
	// ONLY where the right answer is genuinely known (today: Coke Zero). It is
	// left empty everywhere the answer is still a judgement call — an invented
	// expectation would turn this diagnostic into a scoreboard that lies.
	ExpectedName string `json:"expected_name"`
	Note         string `json:"note"`
}

func (c rankingCase) guesses() []ai.Guess {
	out := make([]ai.Guess, 0, len(c.Guess))
	for _, g := range c.Guess {
		conf := g.Confidence
		if conf <= 0 {
			conf = defaultIdentifyConfidence
		}
		out = append(out, ai.Guess{
			Food:            g.Food,
			PortionEstimate: g.PortionEstimate,
			CookingMethod:   g.CookingMethod,
			Confidence:      conf,
		})
	}
	return out
}

func loadRankingCases(t *testing.T) []rankingCase {
	t.Helper()
	path := filepath.Join(evalDatasetDir(), "ranking.jsonl")
	if _, err := os.Stat(path); err != nil {
		path = filepath.Join(evalDatasetDir(), "ranking.sample.jsonl")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open ranking dataset: %v", err)
	}
	defer f.Close()

	var cases []rankingCase
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var c rankingCase
		if err := json.Unmarshal([]byte(line), &c); err != nil {
			t.Fatalf("bad ranking dataset line %q: %v", line, err)
		}
		if len(c.Guess) == 0 {
			t.Fatalf("ranking case %q has no guesses", c.Phrase)
		}
		cases = append(cases, c)
	}
	if err := sc.Err(); err != nil {
		t.Fatalf("read ranking dataset: %v", err)
	}
	return cases
}

// evalDatasetDir is shared with TestEvalChat's loader semantics: KORA_EVAL_DATASET
// wins, otherwise testdata/eval relative to this package.
func evalDatasetDir() string {
	if dir := os.Getenv("KORA_EVAL_DATASET"); dir != "" {
		return dir
	}
	return filepath.Join("..", "..", "testdata", "eval")
}

// rankingRow is one candidate for one guess: the unit of both outputs.
type rankingRow struct {
	Phrase      string
	Guess       string
	Rank        int
	Name        string
	Brand       string
	Provenance  string
	Kcal        float64
	MatchScore  float64
	MatchTier   string
	Coverage    float64
	Factor      float64
	TierBefore  ai.Tier
	TierAfter   ai.Tier
	Shadowed    bool
	Expected    string
	ExpectedHit string
}

// bareWordShadow reports whether this row is a bare single-token query landing
// on a branded OpenFoodFacts product row whose name is that same single token —
// the "286 single-token OFF rows" problem. Surfacing which words do this is a
// primary output of the harness, so it is computed as data rather than left for
// a human to eyeball out of the table.
func bareWordShadow(guess string, c nutrition.Candidate) bool {
	if c.Item.Provenance != nutrition.ProvenanceOFF {
		return false
	}
	if len(strings.Fields(guess)) != 1 {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(c.Item.Name), strings.TrimSpace(guess))
}

func TestEvalRanking(t *testing.T) {
	requireEval(t)

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	db, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		t.Fatalf("db: %v", err)
	}
	foods := nutrition.NewRepository(db)

	cases := loadRankingCases(t)
	if len(cases) == 0 {
		t.Skip("no ranking cases in dataset")
	}

	// uuid.Nil deliberately: no user, so no personal alias can match and the
	// run measures the index as it stands for everybody. A personal alias is
	// per-account state, which is exactly the kind of thing that would make two
	// runs differ.
	anonUser := uuid.Nil
	ctx := context.Background()

	var rows []rankingRow
	for _, c := range cases {
		guesses := c.guesses()
		// One coverage/factor for the whole case, matching resolveGuesses:
		// coverage is a property of the phrase and the guess set together.
		coverage := ai.EvalPhraseCoverage(c.Phrase, guesses)
		factor := ai.EvalReductionFactor(coverage)

		for _, g := range guesses {
			// nil query vector = no provider call, no AI spend, no embedding
			// tier. See the file header.
			cands, err := foods.Resolve(ctx, anonUser, g.Food, nil, rankingTopK)
			if err != nil {
				t.Fatalf("resolve %q (phrase %q): %v", g.Food, c.Phrase, err)
			}
			if len(cands) == 0 {
				rows = append(rows, rankingRow{
					Phrase: c.Phrase, Guess: g.Food, Rank: 0,
					Name: "(no candidates)", Coverage: coverage, Factor: factor,
					TierBefore: ai.TierFollowUp, TierAfter: ai.TierFollowUp,
					Expected: c.ExpectedName, ExpectedHit: "-",
				})
				continue
			}
			for i, cand := range cands {
				perCandFactor := ai.EvalFactorForTier(cand.MatchTier, factor)
				hit := "-"
				if c.ExpectedName != "" && i == 0 {
					hit = "MISS"
					if strings.Contains(strings.ToLower(cand.Item.Name), strings.ToLower(c.ExpectedName)) {
						hit = "HIT"
					}
				}
				rows = append(rows, rankingRow{
					Phrase:      c.Phrase,
					Guess:       g.Food,
					Rank:        i + 1,
					Name:        cand.Item.Name,
					Brand:       cand.Item.Brand,
					Provenance:  cand.Item.Provenance,
					Kcal:        cand.Item.KcalPer100g,
					MatchScore:  cand.MatchScore,
					MatchTier:   cand.MatchTier,
					Coverage:    coverage,
					Factor:      factor,
					TierBefore:  ai.EvalTierWithReduction(g.Confidence, cand.MatchScore, 1),
					TierAfter:   ai.EvalTierWithReduction(g.Confidence, cand.MatchScore, perCandFactor),
					Shadowed:    bareWordShadow(g.Food, cand),
					Expected:    c.ExpectedName,
					ExpectedHit: hit,
				})
			}
		}
	}

	// Deterministic order. Rows are already appended in dataset order, but the
	// sort is explicit so the output cannot drift if the loop above is ever
	// reordered — and so nothing here can depend on map iteration order.
	// Ranks within a guess keep the index's own ordering; ties inside the index
	// are the index's business, and a tie that reorders between runs is a
	// finding this harness should show, not hide.
	caseIdx := make(map[string]int, len(cases))
	for i, c := range cases {
		if _, seen := caseIdx[c.Phrase]; !seen {
			caseIdx[c.Phrase] = i
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if a, b := caseIdx[rows[i].Phrase], caseIdx[rows[j].Phrase]; a != b {
			return a < b
		}
		return false
	})

	writeRankingTSV(t, rows)
	logRankingTable(t, rows)
	logRankingSummary(t, cases, rows)
}

// rankingTSVHeader is the machine-readable schema. Floats are printed at fixed
// precision so two runs over an unchanged index diff to nothing.
var rankingTSVHeader = []string{
	"phrase", "guess", "rank", "name", "brand", "provenance", "kcal_per_100g",
	"match_score", "match_tier", "coverage", "factor", "tier_before",
	"tier_after", "bare_word_shadow", "expected_name", "expected_hit",
}

func (r rankingRow) tsv() string {
	return strings.Join([]string{
		r.Phrase,
		r.Guess,
		fmt.Sprintf("%d", r.Rank),
		r.Name,
		r.Brand,
		r.Provenance,
		fmt.Sprintf("%.2f", r.Kcal),
		fmt.Sprintf("%.6f", r.MatchScore),
		r.MatchTier,
		fmt.Sprintf("%.6f", r.Coverage),
		fmt.Sprintf("%.6f", r.Factor),
		string(r.TierBefore),
		string(r.TierAfter),
		fmt.Sprintf("%t", r.Shadowed),
		r.Expected,
		r.ExpectedHit,
	}, "\t")
}

// writeRankingTSV emits the diffable form. This is the ONLY file the harness
// writes, and it is outside the database by construction.
func writeRankingTSV(t *testing.T, rows []rankingRow) {
	t.Helper()
	out := os.Getenv("KORA_EVAL_RANKING_OUT")
	if out == "" {
		out = filepath.Join(evalDatasetDir(), "ranking.out.tsv")
	}
	var b strings.Builder
	b.WriteString(strings.Join(rankingTSVHeader, "\t"))
	b.WriteString("\n")
	for _, r := range rows {
		b.WriteString(r.tsv())
		b.WriteString("\n")
	}
	if err := os.WriteFile(out, []byte(b.String()), 0o644); err != nil {
		t.Fatalf("write ranking tsv: %v", err)
	}
	abs, _ := filepath.Abs(out)
	t.Logf("machine-readable output: %s (%d rows)", abs, len(rows))
}

func logRankingTable(t *testing.T, rows []rankingRow) {
	t.Helper()
	var b strings.Builder
	b.WriteString("\n")
	lastKey := ""
	for _, r := range rows {
		key := r.Phrase + "\x00" + r.Guess
		if key != lastKey {
			lastKey = key
			fmt.Fprintf(&b, "\n%s\n  guess %q  coverage=%.3f factor=%.3f (floor %.2f)\n",
				r.Phrase, r.Guess, r.Coverage, r.Factor, ai.EvalPhraseCoverageFloor)
			fmt.Fprintf(&b, "  %-4s %-44s %-10s %9s %8s %-14s %-10s %-10s %s\n",
				"rank", "name", "prov", "kcal/100g", "score", "match_tier", "before", "after", "flags")
		}
		flags := ""
		if r.Shadowed {
			flags += "SHADOW "
		}
		if r.ExpectedHit != "-" && r.ExpectedHit != "" {
			flags += r.ExpectedHit
		}
		name := r.Name
		if r.Brand != "" {
			name += " [" + r.Brand + "]"
		}
		if len(name) > 44 {
			name = name[:41] + "..."
		}
		fmt.Fprintf(&b, "  %-4d %-44s %-10s %9.1f %8.4f %-14s %-10s %-10s %s\n",
			r.Rank, name, r.Provenance, r.Kcal, r.MatchScore, r.MatchTier,
			string(r.TierBefore), string(r.TierAfter), strings.TrimSpace(flags))
	}
	t.Log(b.String())
}

func logRankingSummary(t *testing.T, cases []rankingCase, rows []rankingRow) {
	t.Helper()
	var shadowed []string
	seen := map[string]bool{}
	for _, r := range rows {
		if r.Rank == 1 && r.Shadowed && !seen[r.Guess] {
			seen[r.Guess] = true
			shadowed = append(shadowed, fmt.Sprintf("%s -> %q (%0.0f kcal/100g, score %.4f)",
				r.Guess, r.Name, r.Kcal, r.MatchScore))
		}
	}
	sort.Strings(shadowed)

	var expectedMiss, expectedHit int
	for _, r := range rows {
		switch r.ExpectedHit {
		case "HIT":
			expectedHit++
		case "MISS":
			expectedMiss++
		}
	}

	var b strings.Builder
	fmt.Fprintf(&b, "\nranking summary: cases=%d rows=%d expected_known=%d hit=%d miss=%d\n",
		len(cases), len(rows), expectedHit+expectedMiss, expectedHit, expectedMiss)
	fmt.Fprintf(&b, "bare single-token queries landing on a branded OFF row at rank 1: %d\n", len(shadowed))
	for _, s := range shadowed {
		fmt.Fprintf(&b, "  %s\n", s)
	}
	t.Log(b.String())

	// The ONLY assertion. Cases with a known expected answer are regression
	// guards and must not break; everything else is diagnostic output, and
	// failing on a number nobody has yet decided is correct would make the
	// harness lie about what is known.
	if expectedMiss > 0 {
		t.Errorf("%d case(s) with a known expected answer regressed", expectedMiss)
	}
}
