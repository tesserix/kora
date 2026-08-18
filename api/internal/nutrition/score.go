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

	// genericBonus implements kora#212 Phase 2's retrieval policy: when a query
	// names no brand, prefer generic reference data over branded retail
	// products.
	//
	// It is a RANKING signal, exactly like headBonus and for the same reason.
	// The parked feat/184 branch tried expressing this as a 0.5 discount on the
	// branded row's quality instead, and it broke the product: 25 of 28 queries
	// collapsed to follow_up, because quality drives ordering, the tier decision
	// AND the abstain floor at once, so perturbing it to fix ranking moved
	// confidence everywhere. Adding to rankKey moves ordering and NOTHING else —
	// MatchScore is still the unmodified quality, and ambiguityMargin finds the
	// rival by scanning, so a demoted row cannot inflate the survivor.
	//
	// Sized to match headBonus. It has to be able to reorder rows that are
	// genuinely close (the branded/generic pairs this exists to separate sit
	// within ~0.1 of each other) without being so large it buries a branded row
	// the user actually asked for — and when they DID ask, brandEvidence
	// switches the bonus off entirely rather than relying on its magnitude.
	genericBonus = 0.15

	// brandMatchBonus rewards a row whose brand is the one the user actually
	// named (kora#212 Phase 3). Larger than genericBonus and headBonus because
	// it acts on strictly better evidence: those two are heuristics about what
	// a bare phrase probably means, whereas this is the user having said the
	// brand out loud. When someone types "McSpicy", a McDonald's row should
	// beat a generic chicken burger decisively rather than by a nose.
	//
	// Still a RANKING signal on rankKey, never on score — the same discipline
	// as the other two, so it cannot move a confidence tier by itself.
	brandMatchBonus = 0.40

	// localeBonus prefers food from the user's own food culture (kora#212
	// Phase 4).
	//
	// Sized SMALLER than the others on purpose. `headBonus` and `genericBonus`
	// act on the query, and `brandMatchBonus` on something the user actually
	// said; locale acts on a proxy for the user — their timezone — which is
	// right most of the time and silently wrong for travellers, expats and
	// anyone eating another culture's food. It should break ties between
	// comparable rows and settle "chips"/"biscuit"/"capsicum", not overrule a
	// clearly better lexical match.
	//
	// It BOOSTS and never filters, which is the property that makes a proxy
	// safe here: an Australian user eating Indian food is the normal case, so
	// being wrong costs a small ordering nudge rather than a missing answer.
	localeBonus = 0.10

	// cookingMethodBonus rewards a row prepared the way the user said it was.
	//
	// identify has always returned a cooking method and the resolver never used
	// it, which is why "grilled barramundi and chips" could resolve to
	// `Barramundi, raw`. Raw entries are legitimate reference data — a food
	// composition database is full of them — but nobody LOGS raw fish, and
	// ingesting AUSNUT multiplied the raw/cooked pairs competing for every
	// query.
	//
	// Sized with headBonus and genericBonus rather than with brandMatchBonus:
	// a stated method is good evidence, but it is the model's reading of the
	// phrase rather than something the user necessarily said, and a row can
	// mention a method it was not primarily cooked by.
	cookingMethodBonus = 0.15
)

// brandMatches reports whether a candidate's brand is the brand the user named.
// want must already be Normalize()d; got is the raw column value.
//
// Substring in either direction, because the two sides are written by different
// hands and rarely agree exactly: the user says "McDonald's" while USDA stores
// "McDONALD'S" (normalizing settles the case), and says "Coke" where
// OpenFoodFacts stores "Coca-Cola Amatil" or USDA stores "KRAFT BREAKSTONE'S
// FREE" for something a user would just call "Kraft". Requiring equality would
// match almost nothing; containment matches the shapes that actually occur.
//
// Empty on either side is never a match — an unbranded row must not be treated
// as matching a named brand just because "" is contained in everything.
func brandMatches(want, got string) bool {
	if want == "" {
		return false
	}
	normalized := Normalize(got)
	if normalized == "" {
		return false
	}
	return strings.Contains(normalized, want) || strings.Contains(want, normalized)
}

// headToken returns the head noun of a raw (un-normalized) food name — the
// signal that identifies which candidate is the generic food rather than a
// derivative product ("Almonds, raw" vs "Oil, almond").
//
// Two naming conventions coexist in the index:
//   - USDA, comma-inverted: "Almonds, raw", "Beef, cured, dried" — the head
//     noun comes first, with descriptors trailing after the comma.
//   - Curated/AFCD, natural English: "Wholemeal bread", "Cheddar cheese" —
//     English noun compounds are head-final, so the head is the LAST word.
//
// The rule covering both: the last token of the segment before the first comma
// (or of the whole name when there is no comma).
//
// MEASURED AND REJECTED (kora#219): also heading on the SECOND comma segment,
// so that "Potato, chips, ..." would head on "chips". It does fix the chips
// case, and it promotes `Kheer, rice` (a dessert) to top-1 for "rice" and
// `Fish, tuna salad` for "salad", because plenty of rows carry a second segment
// that is a common food word without the row being that food. Net worse.
//
// MUST be derived from FoodItem.Name (the raw name), never normalized_name:
// Normalize() replaces the comma that marks the convention with a space, so
// deriving the head from normalized_name would give the wrong answer for every
// USDA row.
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

// queryNamesABrand reports whether the query carries brand evidence — that is,
// whether the user appears to have named one of the brands present among the
// candidates. It is the fallback for the plain-string Resolve path, where
// identify has not stated a brand (kora#212 Phase 3 states it directly).
//
// The rule is "every token of some candidate's brand appears in the query",
// deliberately requiring the WHOLE brand rather than any one token. Brands
// routinely contain ordinary food words — `SMART SOUP`, `HOT POCKETS`,
// `CAMPBELL'S CHUNKY` — so a single-token rule would read the bare query "soup"
// as naming a brand and switch off the very preference that query needs most.
// Requiring both "smart" and "soup" cannot misfire that way, while a
// single-token brand ("KFC", "Coke") still matches on its one token, which is
// correct: those words genuinely are the brand.
//
// Brands are compared through Normalize so they match the query on the same
// terms the rest of the scorer uses.
func queryNamesABrand(qTokens map[string]bool, items []*scoredItem) bool {
	if len(qTokens) == 0 {
		return false
	}
	for _, s := range items {
		brandTokens := strings.Fields(Normalize(s.item.Brand))
		if len(brandTokens) == 0 {
			continue
		}
		all := true
		for _, t := range brandTokens {
			if !qTokens[t] {
				all = false
				break
			}
		}
		if all {
			return true
		}
	}
	return false
}

// components are the raw per-candidate signals feeding quality().
type components struct {
	Coverage  float64 // |Q∩D| / |Q| — how much of the query this row accounts for
	Precision float64 // |Q∩D| / |D| — how much of this row the query explains
	Trigram   float64 // pg_trgm similarity(normalized_name, query)
	EmbSim    float64 // cosine similarity; 0 when the row has no embedding
}

// identityPhrase returns the part of a raw food name that says WHICH FOOD it
// is, dropping the trailing qualifiers — "Potato, chips, regular, fast food
// outlet, deep fried, blended oil, salted" becomes "potato chips".
//
// It is the first TWO comma segments, because the comma-inverted convention
// USDA and AFCD share writes the identity across at most two of them
// ("Potato, chips"; "Beef, ground"; "Cheese, cheddar") and everything after is
// preparation, cut, packaging or fat source. Names in natural English have no
// comma at all and are returned whole.
//
// Derived from the RAW name for the same reason headToken is: Normalize()
// replaces the comma that marks the convention with a space, so by the time a
// name is normalized this boundary no longer exists.
func identityPhrase(rawName string) string {
	return strings.Join(identitySegments(rawName), " ")
}

// identitySegments returns the normalized head segments of a name: the first
// comma segment always, and the second only when it names the food rather than
// its preparation state.
func identitySegments(rawName string) []string {
	parts := strings.SplitN(rawName, ",", 3)
	if len(parts) > 2 {
		parts = parts[:2]
	}
	var out []string
	for _, part := range parts {
		normalized := Normalize(part)
		if normalized == "" {
			continue
		}
		out = append(out, normalized)
	}
	return out
}

// tokenOverlap returns coverage and precision, comparing already-Normalize()d
// phrases as token *sets* so a repeated word cannot inflate either side.
//
// COVERAGE is measured against the whole document — how much of the query this
// row accounts for — so a query term that only appears in a trailing qualifier
// still counts as found.
//
// PRECISION is measured against the row's IDENTITY only (see identityPhrase),
// not the whole name. Using the whole name charged a row for being described
// carefully: `Potato, chips, regular, fast food outlet, deep fried, blended
// oil, salted` scored 1/10 = 0.10 for the query "chips" while `Banana chip`
// scored 1/2 = 0.50, so AFCD's precise naming lost to a shorter, wronger row
// (kora#219). Against the identity both score 0.50, and the decision falls to
// signals that are actually about relevance.
//
// All three are 0 when either side has no tokens.
func tokenOverlap(query, doc, identity string) (coverage, precision float64) {
	qSet := fieldSet(query)
	dSet := fieldSet(doc)
	iSet := fieldSet(identity)
	if len(qSet) == 0 || len(dSet) == 0 {
		return 0, 0
	}
	shared := 0
	for w := range qSet {
		if dSet[w] {
			shared++
		}
	}
	coverage = float64(shared) / float64(len(qSet))
	if len(iSet) == 0 {
		return coverage, 0
	}
	sharedIdentity := 0
	for w := range qSet {
		if iSet[w] {
			sharedIdentity++
		}
	}
	return coverage, float64(sharedIdentity) / float64(len(iSet))
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
