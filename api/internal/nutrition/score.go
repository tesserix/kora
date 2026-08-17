package nutrition

import (
	"math"
	"strings"
)

// Scoring weights, fixed by principle and deliberately NOT tuned against the
// golden set. Seven free parameters fitted to a set of that size would be
// overfitting dressed as rigour; only the tier floors in ai/types.go are
// calibrated against measured data.
const (
	weightCoverage  = 0.4
	weightPrecision = 0.3
	weightTrigram   = 0.3

	// embeddingFactor keeps an embedding-only match below an exact alias (1.0)
	// while still letting it outscore a weak lexical match.
	embeddingFactor = 0.85

	// ambiguityFloor is the multiplier applied when the top two candidates are
	// indistinguishable; ambiguitySlope is how fast confidence recovers as they
	// separate. A margin of 0.20 or more counts as unambiguous.
	ambiguityFloor = 0.6
	ambiguitySlope = 2.0

	// headBonus rewards a candidate whose head noun (see headToken) matches one
	// of the query's tokens, nudging ranking toward the generic food a user
	// meant over a derivative product that merely shares more tokens with a
	// shorter document. It feeds the ranking key ONLY — never the reported
	// MatchScore — so it cannot inflate a confidence tier; several rows can
	// share a head noun, which is ambiguity, not confidence. Top-1 accuracy on
	// the golden set was measured stable across 0.10–0.30, so this is not a
	// tuned knife-edge; 0.15 sits in the middle of that stable range.
	headBonus = 0.15
)

// headToken returns the head noun of a raw (un-normalized) food name — the
// signal that identifies which candidate is the generic food rather than a
// derivative product ("Almonds, raw" vs "Oil, almond").
//
// Two naming conventions coexist in the index:
//   - USDA, comma-inverted: "Almonds, raw", "Beef, cured, dried" — the head
//     noun comes first, with descriptors trailing after the comma.
//   - Curated/AFCD, natural English: "Wholemeal bread", "Cheddar cheese",
//     "Chicken biryani" — English noun compounds are head-final, so the head
//     noun is the LAST word.
//
// The rule that covers both conventions: the head is the last token of the
// segment before the first comma (or of the whole name, when there is no
// comma).
//
// This MUST be derived from FoodItem.Name (the raw name), never from
// normalized_name: Normalize() replaces punctuation — including the comma
// that marks the USDA convention — with spaces before this function ever
// sees it, so deriving the head from normalized_name would silently give the
// wrong answer for every USDA row (7,695 of 7,848 names in the index).
func headToken(rawName string) string {
	segment := rawName
	if idx := strings.IndexByte(rawName, ','); idx >= 0 {
		segment = rawName[:idx]
	}
	fields := strings.Fields(Normalize(segment))
	if len(fields) == 0 {
		return ""
	}
	return fields[len(fields)-1]
}

// components are the raw per-candidate signals feeding quality().
type components struct {
	Coverage  float64 // |Q∩D| / |Q| — how much of the query this row accounts for
	Precision float64 // |Q∩D| / |D| — how much of this row the query explains
	Trigram   float64 // pg_trgm similarity(normalized_name, query)
	EmbSim    float64 // cosine similarity; 0 when the row has no embedding
}

// tokenOverlap returns coverage and precision for two already-Normalize()d
// phrases, comparing them as token *sets* so a repeated word cannot inflate
// either side. Both are 0 when either phrase has no tokens.
func tokenOverlap(query, doc string) (coverage, precision float64) {
	qSet := fieldSet(query)
	dSet := fieldSet(doc)
	if len(qSet) == 0 || len(dSet) == 0 {
		return 0, 0
	}
	shared := 0
	for w := range qSet {
		if dSet[w] {
			shared++
		}
	}
	return float64(shared) / float64(len(qSet)), float64(shared) / float64(len(dSet))
}

func fieldSet(s string) map[string]bool {
	fields := strings.Fields(s)
	set := make(map[string]bool, len(fields))
	for _, w := range fields {
		set[w] = true
	}
	return set
}

// lexical combines the three lexical signals into 0..1.
//
// Coverage is always 1.0 *within* the full-text candidate set, because
// plainto_tsquery ANDs every term. It is not dead weight: it is what separates
// full-text candidates from embedding-only ones, which share few or no query
// terms. That is the mechanism making a sub-0.70 score reachable at all.
func lexical(c components) float64 {
	return weightCoverage*c.Coverage + weightPrecision*c.Precision + weightTrigram*c.Trigram
}

// quality is per-candidate match strength. The embedding term is a booster and
// never a penalty: a row with no embedding has EmbSim 0 and scores exactly its
// lexical value, so the index's partial embedding coverage cannot distort a
// comparison between rows.
func quality(c components) float64 {
	l := lexical(c)
	if e := embeddingFactor * c.EmbSim; e > l {
		return e
	}
	return l
}

// ambiguityMargin returns how far the presented answer's BASE quality sits
// above that of its strongest rival — with the rival found by scanning the
// whole pool, so it does not depend on the order the pool was ranked in.
//
// THE INVARIANT (kora#212, first proved on the parked
// feat/184-brand-aware-ranking branch): **a ranking signal that demotes a rival
// must never promote its twin.**
//
// The margin is what tells confidence "one of these is right and I can't tell
// which". Reading the rival off items[1] of the RANKED list breaks that,
// because any ranking-only bonus can substitute a weaker row into second place
// and widen a gap that did not really widen. Worked example, with headBonus
// alone:
//
//	base qualities   A 0.95, C 0.85, B 0.75
//	ranked by score  A, C, B   -> rival C -> margin 0.10 -> factor 0.80
//	B gets headBonus A, B, C   -> rival B -> margin 0.20 -> factor 1.00
//
// A's confidence rose because an unrelated third row moved, while A's real
// rival C still sits there at 0.85. That is the mechanism which silently
// promoted an arbitrary branded milk to `auto` when a discount was tried, and
// it was latent in headBonus. Scanning for the strongest rival gives 0.10 in
// both orderings.
//
// Making the RIVAL independent of presentation order is what lets a Phase 2
// retrieval policy express "prefer generics" without touching MatchScore: any
// number of ranking signals can be added and none of them can quietly move
// confidence.
//
// Callers must not use this for a pool of fewer than two — there is no rival to
// measure against. Use ambiguityFactorFor, which handles that case; this
// returns 0 for it, and 0 means "dead tie", which is the OPPOSITE of the truth.
//
// Note carefully WHICH row is the subject and which is the rival:
//
//   - The SUBJECT is items[0] — the row actually being presented as the answer.
//     It must be, because confidence is reported about that row.
//   - The RIVAL is the strongest of ALL the others, found by scanning rather
//     than by reading items[1]. That is the half that removes the bug.
//
// Getting this backwards inverts the guard. An earlier attempt here took the
// top TWO base qualities regardless of which was presented, which looks more
// symmetric and is wrong: when headBonus deliberately promotes a lower-quality
// row to top-1, that version measured the gap as though the stronger rival were
// the answer and so RAISED confidence for the weaker row it actually returned.
// Keeping items[0] as the subject means such a promotion yields a negative
// margin, which clamps to 0 and floors confidence — the cautious answer, and
// the behaviour TestResolveMatchScoreUnaffectedByHeadBonus pins.
func ambiguityMargin(items []*scoredItem) float64 {
	if len(items) < 2 {
		return 0
	}
	rival := math.Inf(-1)
	for _, s := range items[1:] {
		if s.score > rival {
			rival = s.score
		}
	}
	margin := items[0].score - rival
	if margin < 0 {
		return 0
	}
	return margin
}

// ambiguityFactorFor is what Resolve calls: the confidence multiplier for a
// whole candidate pool.
//
// A pool with fewer than two candidates gets 1.0 — no damping. One row and no
// rival is the LEAST ambiguous situation there is; there is nothing for the
// resolver to confuse it with. Treating it as a dead tie (margin 0) instead
// floors confidence at 0.6 and turns unambiguous single answers into targeted
// questions — measured on the harness, it dropped `palak paneer` from `auto`
// to `follow_up` and `bhindi` and `Coke Zero` from `confirm` to `follow_up`,
// each of which returns exactly one candidate.
func ambiguityFactorFor(items []*scoredItem) float64 {
	if len(items) < 2 {
		return 1
	}
	return ambiguityFactor(ambiguityMargin(items))
}

// ambiguityFactor scales confidence by how clearly the best candidate beats the
// runner-up. A perfect top match surrounded by near-identical alternatives is
// not a confident answer — it is a question.
func ambiguityFactor(margin float64) float64 {
	f := ambiguityFloor + ambiguitySlope*margin
	if f < ambiguityFloor {
		return ambiguityFloor
	}
	if f > 1 {
		return 1
	}
	return f
}
