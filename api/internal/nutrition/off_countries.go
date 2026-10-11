package nutrition

import (
	"encoding/json"
	"slices"
	"strings"
)

// OFFCountry is a supported packaged-food market.
type OFFCountry struct {
	Tag    string
	Locale Locale
}

// OFFCountries follows the committed snapshots' sorted filename priority.
func OFFCountries() []OFFCountry {
	return []OFFCountry{
		{Tag: "en:united-arab-emirates", Locale: LocaleAE},
		{Tag: "en:australia", Locale: LocaleAU},
		{Tag: "en:brazil", Locale: LocaleBR},
		{Tag: "en:france", Locale: LocaleFR},
		{Tag: "en:united-kingdom", Locale: LocaleGB},
		{Tag: "en:india", Locale: LocaleIN},
		{Tag: "en:japan", Locale: LocaleJP},
		{Tag: "en:mexico", Locale: LocaleMX},
		{Tag: "en:new-zealand", Locale: LocaleNZ},
		{Tag: "en:singapore", Locale: LocaleSG},
		{Tag: "en:thailand", Locale: LocaleTH},
		{Tag: "en:south-africa", Locale: LocaleZA},
	}
}

// OFFLocale reads the market metadata shared by product lookups and deltas.
func OFFLocale(raw json.RawMessage) Locale {
	var tags []string
	if err := json.Unmarshal(raw, &tags); err != nil {
		var joined string
		if err := json.Unmarshal(raw, &joined); err != nil {
			return LocaleUnknown
		}
		tags = strings.Split(joined, ",")
	}
	for i := range tags {
		tags[i] = strings.TrimSpace(tags[i])
	}
	for _, country := range OFFCountries() {
		if slices.Contains(tags, country.Tag) {
			return country.Locale
		}
	}
	return LocaleUnknown
}
