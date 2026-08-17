package nutrition

import "strings"

// LocaleFromTimezone maps an IANA timezone to the food locale it implies.
//
// Timezone is used as the locale signal because users ALREADY have one — it is
// set at onboarding, defaults to Australia/Sydney, and the auth middleware
// already resolves it on every request. Adding a separate country preference
// would mean a new setting, a new onboarding question and a migration, to learn
// something the timezone almost always already says.
//
// It is a proxy, not an identity, and it is only ever allowed to BOOST ranking
// (kora#212 Phase 4) — never to filter. That asymmetry is what makes the proxy
// safe: an Australian user eating Indian food is the normal case here, not an
// edge case, so being wrong costs a small ordering nudge rather than a missing
// answer.
//
// Anything unrecognised returns LocaleUnknown, which applies no preference at
// all. That is deliberately the behaviour for the large majority of the world's
// timezones: this index only holds AU, IN and US reference data, so guessing a
// locale we have no rows for would be noise.
func LocaleFromTimezone(tz string) Locale {
	switch normalized := strings.ToLower(strings.TrimSpace(tz)); {
	case normalized == "":
		return LocaleUnknown
	case strings.HasPrefix(normalized, "australia/"):
		return LocaleAU
	// Asia/Calcutta is the older name for Asia/Kolkata and is still emitted by
	// plenty of devices, so both must map or a large share of Indian users
	// would silently get no locale preference.
	case normalized == "asia/kolkata", normalized == "asia/calcutta":
		return LocaleIN
	case strings.HasPrefix(normalized, "america/"), normalized == "us/eastern",
		normalized == "us/central", normalized == "us/mountain", normalized == "us/pacific":
		return LocaleUS
	default:
		return LocaleUnknown
	}
}
