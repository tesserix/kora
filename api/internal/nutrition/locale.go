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
	// Pacific/ is NOT prefix-matched the way Australia/ is: it spans Honolulu
	// to Fiji, almost none of which is New Zealand.
	case normalized == "pacific/auckland", normalized == "pacific/chatham":
		return LocaleNZ
	case normalized == "europe/london", normalized == "europe/belfast", normalized == "gb", normalized == "gb-eire":
		return LocaleGB
	case normalized == "europe/paris":
		return LocaleFR
	case normalized == "asia/tokyo", normalized == "japan":
		return LocaleJP
	case normalized == "asia/singapore", normalized == "singapore":
		return LocaleSG
	case normalized == "asia/bangkok":
		return LocaleTH
	case normalized == "asia/dubai":
		return LocaleAE
	case normalized == "africa/johannesburg":
		return LocaleZA
	case strings.HasPrefix(normalized, "brazil/"), normalized == "america/sao_paulo", normalized == "america/manaus",
		normalized == "america/fortaleza", normalized == "america/recife", normalized == "america/bahia",
		normalized == "america/belem", normalized == "america/cuiaba", normalized == "america/porto_velho",
		normalized == "america/boa_vista", normalized == "america/rio_branco", normalized == "america/noronha",
		normalized == "america/araguaina", normalized == "america/maceio", normalized == "america/santarem",
		normalized == "america/campo_grande", normalized == "america/eirunepe":
		return LocaleBR
	case strings.HasPrefix(normalized, "mexico/"), normalized == "america/mexico_city", normalized == "america/cancun",
		normalized == "america/tijuana", normalized == "america/monterrey", normalized == "america/merida",
		normalized == "america/mazatlan", normalized == "america/chihuahua", normalized == "america/hermosillo",
		normalized == "america/matamoros", normalized == "america/ojinaga", normalized == "america/bahia_banderas",
		normalized == "america/ciudad_juarez":
		return LocaleMX
	case strings.HasPrefix(normalized, "america/"), normalized == "us/eastern",
		normalized == "us/central", normalized == "us/mountain", normalized == "us/pacific":
		return LocaleUS
	default:
		return LocaleUnknown
	}
}
