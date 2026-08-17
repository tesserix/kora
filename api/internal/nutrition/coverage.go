package nutrition

// phraseStopwords are the function words a food phrase carries that say
// nothing about WHICH food it is. They are excluded from PhraseCoverage so
// that "chicken with rice" answered by {chicken, rice} counts as fully
// accounted for — otherwise every natural-English phrase would be penalised
// for its grammar rather than for lost information.
//
// Kept deliberately short and closed: only words that can never be a food, a
// brand, a quantity or a preparation. "meal", "plate", "half" and the like are
// NOT here — they carry real information about what was eaten.
var phraseStopwords = map[string]bool{
	"a": true, "an": true, "the": true, "and": true, "with": true,
	"of": true, "on": true, "in": true, "plus": true, "some": true,
	"my": true, "for": true, "to": true,
}

// PhraseCoverage reports the fraction of the user's phrase that `accounted`
// collectively explains: |meaningful phrase tokens ∩ accounted tokens| /
// |meaningful phrase tokens|, comparing token SETS (via the same Normalize and
// fieldSet the match scorer uses, so a repeated word cannot inflate either
// side, and "Chips"/"chip" are the same token on both sides).
//
// It answers a different question from the per-candidate Coverage in score.go.
// That one asks "how much of the QUERY does this row explain?", where the query
// is whatever identify handed the index. This one asks "how much of what the
// USER SAID did we keep at all?" — the information identify itself discarded is
// invisible to every downstream signal, which is exactly how a bare guess of
// "chicken" from "El Janah 1/2 chicken with Chips" could score a perfect 1.0
// (kora#184).
//
// An empty phrase, or a phrase of nothing but stopwords, returns 1: nothing was
// said that could have been discarded. This is what keeps the photo path — which
// has no phrase at all — completely unaffected.
func PhraseCoverage(phrase string, accounted []string) float64 {
	meaningful := meaningfulTokens(phrase)
	if len(meaningful) == 0 {
		return 1
	}

	covered := make(map[string]bool, len(meaningful))
	for _, a := range accounted {
		for token := range fieldSet(Normalize(a)) {
			covered[token] = true
		}
	}

	shared := 0
	for _, token := range meaningful {
		if covered[token] {
			shared++
		}
	}
	return float64(shared) / float64(len(meaningful))
}

// PhraseTokenCount is the DENOMINATOR PhraseCoverage divided by: how many
// meaningful (non-stopword) tokens the phrase had. Exported so a diagnostic can
// report it alongside a coverage figure, which is otherwise uninterpretable —
// 0.5 of two tokens is one word lost, 0.5 of eight is four, and only the second
// is evidence about where phraseCoverageFloor belongs.
//
// It is a COUNT, deliberately not the tokens themselves: the phrase is the
// user's own utterance and must never reach a log line.
func PhraseTokenCount(phrase string) int {
	return len(meaningfulTokens(phrase))
}

// meaningfulTokens is the one definition of "what the user actually said",
// shared so a reported count can never drift from the count the ratio used.
func meaningfulTokens(phrase string) []string {
	tokens := make([]string, 0)
	for token := range fieldSet(Normalize(phrase)) {
		if !phraseStopwords[token] {
			tokens = append(tokens, token)
		}
	}
	return tokens
}
