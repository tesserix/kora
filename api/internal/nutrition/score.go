package nutrition

import "strings"

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
