package nutrition

import (
	"strings"
	"unicode"
)

// SplitEmbeddedBrand pulls a brand out of a USDA food name that carries it in
// the name text, returning the brand and the name with that brand removed.
// It returns ("", name) when the name carries no brand, which is the case for
// the overwhelming majority of rows.
//
// WHY THIS EXISTS (kora#212): USDA writes chain and packaged items as
// `McDONALD'S, FILET-O-FISH` or `SILK Chocolate, soymilk` — the brand lives in
// `name` and the `brand` column is empty. 310 rows in SR Legacy are like this.
// Two things went wrong as a result:
//
//  1. `DeriveEntityType` reads the row's own identity columns, so an empty
//     brand made every one of them type as `generic` REFERENCE data — when they
//     are the single most locale-inappropriate content in an index serving
//     India and Australia, and are exactly the rows behind kora#184's
//     `DENNY'S french fries` result.
//  2. Brand matching was blind to them. A query naming McDonald's cannot match
//     an empty brand column, so any retrieval policy that weighs brand evidence
//     silently skipped the 310 rows that need it most.
//
// This is deliberately done HERE, at the point the USDA source is read, and NOT
// as a name-shape rule inside DeriveEntityType. Teaching the derivation that
// "a leading ALL-CAPS token means branded" would re-import the string-shape
// inference kora#212 exists to eliminate, and would apply one dataset's
// formatting convention to every row in the table. Parsing the brand into the
// column where it belongs lets the EXISTING derivation type these rows
// correctly with no rule change at all.
//
// THE RULE: take the longest leading run of brand-shaped tokens. A token is
// brand-shaped when every letter in it is uppercase (`KFC`, `BURGER`, `KING`,
// `T.G.I.`, `CHICK-FIL-A`), plus one documented exception for `Mc`/`Mac` names
// (`McDONALD'S`), which USDA writes with a lowercase c. A token with no letters
// at all (`14"`) does not extend the brand but does end it, so
// `LITTLE CAESARS 14" Cheese Pizza` yields `LITTLE CAESARS` rather than
// swallowing the size and product words.
//
// The run must hold at least three letters and at least two uppercase ones, so
// a stray initial cannot become a brand.
//
// VALIDATED against the whole committed SR Legacy file: 310 of 7,756 rows match,
// producing 44 distinct brands, and every one is a real brand — no generic row
// is misread. TestSplitEmbeddedBrandFindsNoBrandInGenericNames guards that
// direction specifically, because a false positive here is far worse than a
// miss: it would relabel reference data as a branded product.
//
// Known and accepted: the run is greedy, so `KRAFT BREAKSTONE'S FREE Fat Free
// Sour Cream` yields the brand `KRAFT BREAKSTONE'S FREE` rather than `KRAFT`.
// That is still brand text rather than food text, and a query naming Kraft
// still matches it on substring. `WEND'YS` is a misspelling in USDA's own data
// and is preserved verbatim — correcting source typos here would start a
// hand-maintained fixup list, which is the thing kora#212 rejected.
func SplitEmbeddedBrand(name string) (brand, rest string) {
	head := name
	if i := strings.IndexByte(name, ','); i >= 0 {
		head = name[:i]
	}

	var run []string
	for _, tok := range strings.Fields(head) {
		state := brandShaped(tok)
		if state == tokenBrand {
			run = append(run, tok)
			continue
		}
		// Anything else terminates the run: a food word ends the brand, and so
		// does a size token like `14"`, which must not be absorbed into it.
		break
	}
	if len(run) == 0 {
		return "", name
	}

	var letters, uppers int
	for _, tok := range run {
		for _, r := range tok {
			if unicode.IsLetter(r) {
				letters++
				if unicode.IsUpper(r) {
					uppers++
				}
			}
		}
	}
	if letters < 3 || uppers < 2 {
		return "", name
	}

	brand = strings.Join(run, " ")
	// Trim the separator the brand left behind, which is a comma for
	// `McDONALD'S, FILET-O-FISH` and a plain space for `SILK Chocolate, soymilk`.
	rest = strings.TrimSpace(strings.TrimLeft(name[len(brand):], " ,"))
	if rest == "" {
		// A row that is nothing but a brand has no food left to name, so leave
		// it exactly as found rather than emitting an item with an empty name.
		return "", name
	}
	return brand, rest
}

type tokenState int

const (
	tokenOther tokenState = iota
	tokenBrand
	tokenNoLetters
)

// brandShaped classifies a single token. See SplitEmbeddedBrand for the rule.
func brandShaped(tok string) tokenState {
	var letters, uppers int
	for _, r := range tok {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				uppers++
			}
		}
	}
	if letters == 0 {
		return tokenNoLetters
	}
	if letters == uppers {
		return tokenBrand
	}
	// The Mc/Mac exception: USDA writes McDONALD'S with a lowercase c, so the
	// token is not fully uppercase but is unambiguously a brand. Accept it only
	// when everything after the prefix is uppercase, which `Mcdonalds` is not.
	for _, prefix := range []string{"Mc", "Mac"} {
		if !strings.HasPrefix(tok, prefix) {
			continue
		}
		tail := tok[len(prefix):]
		if tail == "" {
			continue
		}
		tailLetters, tailUppers := 0, 0
		for _, r := range tail {
			if unicode.IsLetter(r) {
				tailLetters++
				if unicode.IsUpper(r) {
					tailUppers++
				}
			}
		}
		if tailLetters > 0 && tailLetters == tailUppers {
			return tokenBrand
		}
	}
	return tokenOther
}
