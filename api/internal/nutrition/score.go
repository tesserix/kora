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

	// unqualifiedBrandFactor discounts a BRANDED row when the query carries no
	// brand signal at all (see brandUnqualified).
	//
	// Every lexical signal is computed over FoodItem.Name alone, but a branded
	// row's name is elliptical: "Oat" is not a food, it is Sanitarium So Good's
	// oat MILK (46 kcal/100g), and "Rye" is Bürgen's rye BREAD (249). Against
	// the bare query "oat" such a row saturates coverage, precision and trigram
	// simultaneously and scores a perfect 1.0 — beating "Rolled oats, raw"
	// (AFCD, 379 kcal), which is what the user actually meant. 286 single-token
	// OpenFoodFacts product rows in the index can win a bare-word query this
	// way, and they win it at tier auto, i.e. logged with no confirmation.
	//
	// The rule: an unqualified query names the food, not a product named after
	// it. The constant states the reason literally — a branded row is
	// identified by two things, what the food is (name) and whose product it is
	// (brand); an unqualified query supplies evidence for the first and none
	// whatsoever for the second, so at most half the row's identity is
	// accounted for and at most half the evidence is earned. 0.5 is the only
	// value that argument admits; it is not fitted to the golden set, and it
	// was deliberately not swept against the ranking harness.
	//
	// The discount is deliberately narrow. It applies only when ALL THREE hold:
	//   1. the row has a brand (a generic row has no second half to be missing);
	//   2. the query names nothing of that brand (brandUnqualified) — so
	//      "Coke Zero" -> Coke's "Coke Zero Sugar" and "weet bix" -> Weet-Bix's
	//      "Weet-Bix" are never touched;
	//   3. some UNBRANDED row also answers this query (genericAlternative in
	//      repository.go) — a discount is a demotion, and there has to be
	//      something to demote to.
	//
	// Condition 3 is the one a reader is most likely to think redundant. It is
	// not: it makes the discount a comparison rather than a verdict. Deciding
	// from the (query, row) pair alone that a query "means a food" is guessing
	// at which words are trademarks; the candidate pool answers it with
	// evidence instead. "oat" has generic oats sitting in its result set and
	// losing to oat milk — that is the whole defect — whereas a bare product
	// query with no generic behind it has no better answer available, and
	// demoting its only real candidate would trade a wrong confidence for a
	// wrong answer.
	//
	// Consequence worth stating out loud rather than discovering later: where
	// the discount does apply, the branded row can no longer reach the confirm
	// floor (0.70) on lexical evidence alone, let alone auto — it becomes a
	// follow-up question ("which one?"). That is the intent. We must not
	// silently log a specific commercial product the user never named while
	// the food they did name sits in the same result set.
	unqualifiedBrandFactor = 0.5

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

	// UnqualifiedBrand marks a branded row the query never named the maker of,
	// in a result set where an unbranded food answers the same query. It is
	// not a signal like the others — it is the statement that the signals
	// above were measured against half a document. See unqualifiedBrandFactor
	// for the three conditions and brandUnqualified/genericAlternative for
	// where each is decided.
	UnqualifiedBrand bool
}

// brandUnqualified reports whether a row is branded AND the query carries no
// signal of that brand — the case in which the query names a food and the row
// answers with a product.
//
// query and normalizedName must already be Normalize()d; brand is normalized
// here so all three go through the same pipeline (lowercase, punctuation
// stripped, singularized) — "Coke" and "coke" must not be different tokens.
//
// A brand token only carries a signal if the row's own NAME does not already
// supply it. This is the whole subtlety, and getting it wrong was measurable:
// the row "Milk" by "a2 Milk Company" shares the token "milk" with the bare
// query "milk", but that word came from the food, not the maker — reading it
// as "the user named a2" exempted the row and let a 46 kcal/100g branded milk
// reach tier auto for a query that plainly means milk. The maker's identifying
// tokens there are "a2" and "company", and the query has neither. Same trap in
// reverse for OFF's junk brand strings ("Sonora Corn Chips  Salted 500g"),
// where a food word smuggled into the brand would otherwise exempt every corn
// chip query.
//
// The remaining case is a brand wholly contained in the name — "Coke" for
// "Coke Zero Sugar", "Vegemite" for "Vegemite", "Weet-Bix" for "Weet-Bix".
// There the brand contributes no token of its own, and that is not a missing
// signal but the answer: the product is named after its maker, so naming the
// product IS naming the maker. Such a row is never unqualified.
//
// Where a maker does have distinguishing tokens, ANY of them appearing in the
// query is enough — OFF brands often carry more than a name ("Youfoodz
// Fuel'd", "Australia's Own"), so requiring all of them would make the
// exemption dead code.
func brandUnqualified(query, normalizedName, brand string) bool {
	brandTokens := fieldSet(Normalize(brand))
	if len(brandTokens) == 0 {
		return false // generic row: no brand to leave unqualified
	}
	nameTokens := fieldSet(normalizedName)
	qTokens := fieldSet(query)
	distinguishing := false
	for t := range brandTokens {
		if nameTokens[t] {
			continue // the name already supplies this word; it names no maker
		}
		distinguishing = true
		if qTokens[t] {
			return false // the query named the maker
		}
	}
	// No token distinguishes the brand from the name: the product is named
	// after its maker, so the name carries the brand.
	return distinguishing
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
// quality deliberately does NOT apply the unqualified-brand discount: it is
// the raw evidence for a candidate, and the ambiguity margin must be measured
// on raw evidence (see discount below and ambiguityFactor). Callers that need
// the reported score apply discount() to this value.
func quality(c components) float64 {
	l := lexical(c)
	if e := embeddingFactor * c.EmbSim; e > l {
		return e
	}
	return l
}

// discount turns a candidate's raw quality into its reported match strength by
// applying the unqualified-brand factor.
//
// It is split out from quality() rather than folded into it because of an
// interaction that was measured, not theorised. ambiguityFactor damps
// confidence when the top two candidates are indistinguishable, and that
// damping is often the only thing standing between a bare-word query and tier
// auto: "vegemite" returned Bega's Vegemite and Vegemite's Vegemite tied at
// 1.0, so the margin was 0 and both were held to 0.60. Discounting one of a
// tied pair separates them — and if the margin is read off the discounted
// values, the SURVIVOR's confidence goes UP. Demoting a rival promoted its
// twin from follow_up straight to auto (0.60 -> 1.00), the exact harm this
// change exists to prevent, inflicted by the change itself.
//
// So the discount must never be visible to the ambiguity computation. The
// invariant the caller maintains is: the ambiguity factor is computed from
// quality() and the ranking quality() alone would produce, so deleting the
// discount entirely would leave every factor identical. Since the factor is
// then independent of the discount, and discount() is non-increasing, no
// candidate's reported score can ever rise because a different candidate was
// discounted.
//
// The discount is applied to whichever of the lexical/embedding paths won, so
// as a common factor it also cannot flip the full_text/embedding tier
// decision, which compares the two paths before this runs.
func discount(rawQuality float64, c components) float64 {
	if c.UnqualifiedBrand {
		return rawQuality * unqualifiedBrandFactor
	}
	return rawQuality
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
