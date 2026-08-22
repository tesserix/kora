// date_resolve.go turns the vision model's VERBATIM date text
// (ai.BodyCompositionReading.ReadingDateText) into a resolved calendar date
// (ReadingDate, "YYYY-MM-DD") — kora#314's third fix. The model's job ends
// at transcription; this file's job is the derivation, by an EXPLICIT,
// DETERMINISTIC rule that a test can drive with a fixed "now" and a human
// can be told in one sentence: when no year is printed, resolve to the most
// recent occurrence of that day/month at or before today. That is
// derivation with a stated rule, not fabrication — the model never guesses
// a year; this code does, but only ever in the single direction "most
// recent past occurrence," which is the only direction a scale reading can
// plausibly point (a screenshot cannot show a future weigh-in).
package bodyread

import (
	"regexp"
	"strconv"
	"time"
)

// isoDatePattern matches an explicit YYYY-MM-DD or YYYY/MM/DD — the model
// is told never to invent this shape itself, but a future prompt/model
// change, or a scale app that genuinely prints an ISO-formatted date on
// screen, should still resolve correctly rather than falling through to the
// day/month path below.
var isoDatePattern = regexp.MustCompile(`(\d{4})[-/](\d{1,2})[-/](\d{1,2})`)

// numericDatePattern matches a bare day/month(/year) group — "22/08",
// "22-08", "22.08.2026" — embedded anywhere in a larger string like
// "Sat, 22/08, 10:57". It is intentionally permissive about the separator
// (/, -, .) since scale apps are not consistent about which one they use.
var numericDatePattern = regexp.MustCompile(`(\d{1,4})[/\-.](\d{1,2})(?:[/\-.](\d{1,4}))?`)

// resolveReadingDateText derives a "YYYY-MM-DD" calendar date from raw,
// verbatim date text, or nil when the text is absent, unparseable, or
// genuinely ambiguous. now is passed explicitly (never time.Now() inside
// this function) so the whole thing is unit-testable with a fixed clock —
// see date_resolve_test.go.
//
// AMBIGUITIES DELIBERATELY LEFT UNRESOLVED (return nil rather than guess):
//   - Two numeric components where BOTH are <=12, e.g. "05/06": could be
//     5 June (D/M, the convention every fixture and scale app seen so far
//     uses) or 6 May (M/D, the US convention). Nothing in the text itself
//     says which, so guessing either way is a coin flip dressed up as a
//     read. PR B's date row catches this the same way it catches a stale
//     screenshot.
//   - Month names ("22 Aug", "Aug 22", "22 August 2026"): not implemented.
//     Neither real fixture this resolver was built and measured against
//     uses one, and a month abbreviation table adds a second, separate
//     ambiguity surface (locale, language) for no fixture that currently
//     needs it. A month-name format falls through every pattern below and
//     returns nil, same as any other unparseable text — safe, just not
//     smart. Add a table here if a real scale app is found using one.
//   - A day/month combination that is not a real calendar date in ANY of
//     the last 8 years (e.g. 31/02, and non-leap years for 29/02): nil.
//     8 years is generous headroom for the only case this actually bites
//     (a 29 Feb every 4 years) while keeping the search bounded.
func resolveReadingDateText(text *string, now time.Time) *string {
	if text == nil {
		return nil
	}

	if m := isoDatePattern.FindStringSubmatch(*text); m != nil {
		year := atoiOrZero(m[1])
		month := atoiOrZero(m[2])
		day := atoiOrZero(m[3])
		return resolvedDateOrNil(year, month, day, now)
	}

	if m := numericDatePattern.FindStringSubmatch(*text); m != nil {
		a := atoiOrZero(m[1])
		b := atoiOrZero(m[2])
		yearText := m[3]

		if yearText != "" {
			year := atoiOrZero(yearText)
			if year < 100 {
				// A 2-digit year ("22/08/26") is itself a second ambiguity
				// (1926 vs 2026) this resolver does not take a side on.
				return nil
			}
			day, month, ok := resolveDayMonthOrder(a, b)
			if !ok {
				return nil
			}
			return resolvedDateOrNil(year, month, day, now)
		}

		day, month, ok := resolveDayMonthOrder(a, b)
		if !ok {
			return nil
		}
		return mostRecentOccurrenceOrNil(day, month, now)
	}

	return nil
}

// resolveDayMonthOrder disambiguates two numeric components into
// (day, month) using magnitude alone — the only signal the text itself
// carries. See resolveReadingDateText's doc comment for the both-<=12 case
// this deliberately refuses to guess.
func resolveDayMonthOrder(a, b int) (day, month int, ok bool) {
	aValidDay, bValidDay := a >= 1 && a <= 31, b >= 1 && b <= 31
	aValidMonth, bValidMonth := a >= 1 && a <= 12, b >= 1 && b <= 12

	switch {
	case a > 12 && bValidMonth && aValidDay:
		// a can only be a day (>12 rules out month) — D/M.
		return a, b, true
	case b > 12 && aValidMonth && bValidDay:
		// b can only be a day — M/D.
		return b, a, true
	case aValidMonth && bValidMonth:
		// Both fit as a month, so both fit as a day too (1-12 is always a
		// valid day-of-month floor check) — genuinely ambiguous.
		return 0, 0, false
	default:
		return 0, 0, false
	}
}

// resolvedDateOrNil validates (year, month, day) as a real calendar date —
// never past today — and formats it, or returns nil. Used for the
// explicit-year paths (ISO, D/M/Y), where the year is a printed fact, not derived, so
// there is no "most recent occurrence" search: the model's/text's own year
// either is a real, non-future date or the whole field is dropped.
func resolvedDateOrNil(year, month, day int, now time.Time) *string {
	if month < 1 || month > 12 {
		return nil
	}
	candidate := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	if candidate.Year() != year || int(candidate.Month()) != month || candidate.Day() != day {
		return nil // day rolled over — not a real calendar date (e.g. 31 Feb)
	}
	if candidate.After(truncateToDate(now)) {
		return nil // a screenshot cannot show a future reading
	}
	formatted := candidate.Format(readingDateLayout)
	return &formatted
}

// mostRecentOccurrenceOrNil is the year-less resolution rule: the most
// recent calendar date matching (day, month) that falls on or before now's
// calendar date, searching back up to 8 years to cover a 29 Feb printed in
// a non-leap year. Returns nil if no such date exists in that window
// (day/month is not a real date at all, e.g. 31/02).
func mostRecentOccurrenceOrNil(day, month int, now time.Time) *string {
	today := truncateToDate(now)
	for back := 0; back < 8; back++ {
		year := today.Year() - back
		candidate := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
		if candidate.Year() != year || int(candidate.Month()) != month || candidate.Day() != day {
			continue // not a real date in this year (e.g. 29 Feb, non-leap)
		}
		if !candidate.After(today) {
			formatted := candidate.Format(readingDateLayout)
			return &formatted
		}
	}
	return nil
}

func atoiOrZero(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}
