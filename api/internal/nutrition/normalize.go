package nutrition

import (
	"strings"
	"unicode"
)

// Normalize reduces a food phrase to a canonical form for alias/index matching:
// lowercase, punctuation → space, collapsed whitespace, trailing-plural trimmed.
func Normalize(phrase string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(phrase) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			b.WriteRune(r)
		case unicode.IsSpace(r):
			b.WriteRune(' ')
		default:
			b.WriteRune(' ')
		}
	}
	words := strings.Fields(b.String())
	for i, w := range words {
		words[i] = singularize(w)
	}
	return strings.Join(words, " ")
}

func singularize(w string) string {
	if len(w) > 3 && strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss") {
		return w[:len(w)-1]
	}
	return w
}
