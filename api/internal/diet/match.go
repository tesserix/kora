package diet

import "sort"

// negationCues mark a mention as a statement about avoiding something rather
// than a recommendation of it. "Beef is a good iron source, but you avoid it"
// must not read as a violation, or the coach cannot discuss a constraint at all.
var negationCues = map[string]struct{}{
	"no": {}, "not": {}, "never": {}, "without": {}, "avoid": {}, "avoids": {},
	"avoiding": {}, "skip": {}, "skipping": {}, "exclude": {}, "excluding": {},
	"excludes": {}, "instead": {}, "minus": {}, "free": {}, "omit": {},
	"omitting": {}, "replace": {}, "replacing": {}, "swap": {}, "substitute": {},
	"except": {}, "cannot": {}, "dont": {}, "doesnt": {}, "wont": {},
}

// negationWindow is how many words before a mention are searched for a cue.
// Three covers "no beef", "avoid any beef" and "instead of the beef" without
// reaching back into an unrelated clause.
const negationWindow = 3

// Hit is one taxonomy subject found in text.
type Hit struct {
	Subject string
	Match   string
	Negated bool
}

// span is one alias occurrence, before overlap resolution.
type span struct {
	subject string
	alias   string
	start   int
	length  int
	negated bool
}

// Match finds every taxonomy subject mentioned in text. Negated hits are
// returned rather than dropped so callers can decide: tagging a food ignores
// them, screening an answer treats them as compliance.
//
// Longest alias wins an overlap, so "peanut butter" is peanut and not also
// dairy, and "sweet potato" is one root vegetable rather than two matches.
func Match(text string) []Hit {
	words := tokenize(text)
	if len(words) == 0 {
		return nil
	}

	found := []span{}
	for _, s := range subjects {
		for _, alias := range s.Aliases {
			aliasWords := tokenize(alias)
			if len(aliasWords) == 0 {
				continue
			}
			for i := 0; i+len(aliasWords) <= len(words); i++ {
				if !matchesAt(words, i, aliasWords) {
					continue
				}
				found = append(found, span{
					subject: s.Token,
					alias:   alias,
					start:   i,
					length:  len(aliasWords),
					negated: negatedAt(words, i, len(aliasWords)),
				})
			}
		}
	}

	sort.Slice(found, func(i, j int) bool {
		if found[i].length != found[j].length {
			return found[i].length > found[j].length
		}
		return found[i].start < found[j].start
	})

	claimed := make([]bool, len(words))
	seen := map[string]Hit{}
	for _, sp := range found {
		if overlaps(claimed, sp) {
			continue
		}
		for i := sp.start; i < sp.start+sp.length; i++ {
			claimed[i] = true
		}
		hit := Hit{Subject: sp.subject, Match: sp.alias, Negated: sp.negated}
		// A single affirmative mention outweighs any number of negated ones:
		// "skip the beef Monday, beef curry Tuesday" is a recommendation.
		if prev, ok := seen[sp.subject]; !ok || (prev.Negated && !hit.Negated) {
			seen[sp.subject] = hit
		}
	}

	out := make([]Hit, 0, len(seen))
	for _, h := range seen {
		out = append(out, h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Subject < out[j].Subject })
	return out
}

func overlaps(claimed []bool, sp span) bool {
	for i := sp.start; i < sp.start+sp.length; i++ {
		if claimed[i] {
			return true
		}
	}
	return false
}

// Subjects returns the affirmatively mentioned subjects in text, which is what
// food tagging needs.
func Subjects(text string) []string {
	out := []string{}
	for _, h := range Match(text) {
		if !h.Negated {
			out = append(out, h.Subject)
		}
	}
	return out
}

func matchesAt(words []string, start int, alias []string) bool {
	for j, w := range alias {
		if !wordsEqual(words[start+j], w) {
			return false
		}
	}
	return true
}

// negatedAt reports whether a mention is qualified by a nearby cue, either
// before it ("without beef") or immediately after it ("beef-free", which
// tokenises to "beef free").
func negatedAt(words []string, start, length int) bool {
	from := max(start-negationWindow, 0)
	for _, w := range words[from:start] {
		if _, ok := negationCues[w]; ok {
			return true
		}
	}
	if end := start + length; end < len(words) {
		if words[end] == "free" {
			return true
		}
	}
	return false
}
