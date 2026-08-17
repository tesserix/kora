package nutrition

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// PhraseCoverage answers "how much of what the user said did we keep?".
// Pure token math — no DB, no index — so the cases below are the whole
// specification of the function.
func TestPhraseCoverage(t *testing.T) {
	tests := []struct {
		name      string
		phrase    string
		accounted []string
		want      float64
		notes     string
	}{
		{
			name:      "empty phrase is never a discard",
			phrase:    "",
			accounted: []string{"chicken"},
			want:      1,
			notes:     "the photo path has no phrase; it must be completely unaffected",
		},
		{
			name:      "phrase of nothing but stopwords",
			phrase:    "with and of",
			accounted: []string{"chicken"},
			want:      1,
			notes:     "no meaningful token was said, so none could be discarded",
		},
		{
			name:      "exact restatement",
			phrase:    "grilled chicken breast",
			accounted: []string{"grilled chicken breast"},
			want:      1,
			notes:     "the regression guard: a phrase kept whole must carry no penalty",
		},
		{
			name:      "stopword-only difference",
			phrase:    "chicken with rice",
			accounted: []string{"chicken", "rice"},
			want:      1,
			notes:     "stopwords must not count against coverage",
		},
		{
			name:      "plural/singular difference",
			phrase:    "chips",
			accounted: []string{"chip"},
			want:      1,
			notes:     "Normalize singularizes both sides",
		},
		{
			name:      "brand dropped, food and portion kept",
			phrase:    "El Janah 1/2 chicken with Chips",
			accounted: []string{"1/2 chicken", "1/2", "chips"},
			want:      4.0 / 6.0,
			notes:     "el + janah lost out of {el janah 1 2 chicken chip}",
		},
		{
			name:      "portion accounted for by PortionEstimate alone",
			phrase:    "1/2 chicken",
			accounted: []string{"chicken", "1/2"},
			want:      1,
			notes:     "a quantity identify preserved in PortionEstimate is NOT a discard (ca9e2de)",
		},
		{
			name:      "guesses about something else entirely",
			phrase:    "McSpicy chicken meal",
			accounted: []string{"French Fries", "Red Bull energy drink"},
			want:      0,
			notes:     "the live #184 failure: neither mcspicy nor chicken survives",
		},
		{
			name:      "nothing accounted for at all",
			phrase:    "chicken biryani",
			accounted: nil,
			want:      0,
			notes:     "no guesses resolved anything of the phrase",
		},
		{
			name:      "extra guess tokens do not inflate coverage",
			phrase:    "chicken",
			accounted: []string{"chicken tikka masala with rice"},
			want:      1,
			notes:     "coverage is over the PHRASE's tokens; precision is not this function's job",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.InDelta(t, tt.want, PhraseCoverage(tt.phrase, tt.accounted), 1e-9, tt.notes)
		})
	}
}
