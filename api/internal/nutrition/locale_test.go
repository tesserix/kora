package nutrition

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLocaleFromTimezone(t *testing.T) {
	tests := []struct {
		tz   string
		want Locale
		why  string
	}{
		{"Australia/Sydney", LocaleAU, "the default timezone for every new user"},
		{"Australia/Perth", LocaleAU, "any Australian zone, not just the default"},
		{"Asia/Kolkata", LocaleIN, ""},
		{"Asia/Calcutta", LocaleIN, "the older name, still emitted by plenty of devices"},
		{"Pacific/Auckland", LocaleNZ, ""},
		{"Pacific/Chatham", LocaleNZ, "the Chathams are NZ too"},
		{"Pacific/Fiji", LocaleUnknown, "Pacific/ must NOT prefix-match the way Australia/ does"},
		{"America/New_York", LocaleUS, ""},
		{"US/Pacific", LocaleUS, "the legacy US/* aliases"},
		{"asia/kolkata", LocaleIN, "case must not matter"},
		{"  Australia/Sydney  ", LocaleAU, "surrounding whitespace must not matter"},
		{"", LocaleUnknown, "no timezone means no preference, not a guessed one"},
		{"Europe/London", LocaleUnknown, "the index holds no GB rows, so a guess would be noise"},
		{"Asia/Tokyo", LocaleUnknown, "same — unrecognised must mean no preference"},
		{"Antarctica/Casey", LocaleUnknown, "an Australian territory, but not an Australian food locale"},
	}
	for _, tc := range tests {
		t.Run(tc.tz, func(t *testing.T) {
			require.Equal(t, tc.want, LocaleFromTimezone(tc.tz), tc.why)
		})
	}
}

// TestDeriveLocaleCoversEveryProvenance pins the provenance→locale rule,
// including the two that deliberately yield unknown. `curated` is the one that
// matters: au_in_dishes.json mixes 46 Indian dishes with 15 Australian ones, so
// deriving it from provenance would confidently mislabel two thirds of the file
// — those rows carry an explicit per-row locale instead.
func TestDeriveLocaleCoversEveryProvenance(t *testing.T) {
	require.Equal(t, LocaleAU, DeriveLocale(ProvenanceAFCD))
	require.Equal(t, LocaleAU, DeriveLocale(ProvenanceOFF), "off_au.json is filtered to Australian products")
	require.Equal(t, LocaleIN, DeriveLocale(ProvenanceIFCT))
	require.Equal(t, LocaleUS, DeriveLocale(ProvenanceUSDA))
	require.Equal(t, LocaleUnknown, DeriveLocale(ProvenanceCurated),
		"curated is mixed AU/IN and must NOT be derived from provenance")
	require.Equal(t, LocaleUnknown, DeriveLocale(ProvenanceUserEstimate))
	require.Equal(t, LocaleUnknown, DeriveLocale("something_new"),
		"an unknown source must get no preference rather than a wrong one")
}
