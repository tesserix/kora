package bodyread

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestResolveReadingDateText_ISO pins the explicit-year path: an ISO date
// (the format the model is told to NEVER produce itself, but which this
// resolver still handles in case a scale app prints one, or a future
// prompt/model change reintroduces it) resolves directly, no year search.
func TestResolveReadingDateText_ISO(t *testing.T) {
	got := resolveReadingDateText(sptr("2026-08-22"), fixedNow)
	require.NotNil(t, got)
	assert.Equal(t, "2026-08-22", *got)

	gotSlash := resolveReadingDateText(sptr("2026/08/22"), fixedNow)
	require.NotNil(t, gotSlash)
	assert.Equal(t, "2026-08-22", *gotSlash)
}

// TestResolveReadingDateText_NilText pins "no date shown" staying nil —
// the resolver must never invent a date from nothing.
func TestResolveReadingDateText_NilText(t *testing.T) {
	assert.Nil(t, resolveReadingDateText(nil, fixedNow))
}

// TestResolveReadingDateText_DayMonthUnambiguousOnToday pins the primary
// kora#314 case: a day/month with no year, where the day (22) rules out a
// month interpretation, and the date falls exactly ON the reference "now" —
// still "at or before today", so it must resolve to THIS year.
func TestResolveReadingDateText_DayMonthUnambiguousOnToday(t *testing.T) {
	got := resolveReadingDateText(sptr("22/08"), fixedNow)
	require.NotNil(t, got)
	assert.Equal(t, "2026-08-22", *got)
}

// TestResolveReadingDateText_EmbeddedInLargerString pins extraction from a
// realistic scale-app string that also carries a weekday and a time — the
// resolver must find the date group without being told where it is.
func TestResolveReadingDateText_EmbeddedInLargerString(t *testing.T) {
	got := resolveReadingDateText(sptr("Sat, 22/08, 10:57"), fixedNow)
	require.NotNil(t, got)
	assert.Equal(t, "2026-08-22", *got)
}

// TestResolveReadingDateText_NotYetOccurredThisYearResolvesToLastYear pins
// the exact scenario the product owner named explicitly: a day/month that
// has not happened yet relative to "now" must resolve to LAST year's
// occurrence, never this year's (which would be a future date) and never
// silently drop to null when the day/month is otherwise unambiguous.
// "08/25" disambiguates as month/day (25 cannot be a month) = 25 August,
// which is after fixedNow's 22 August — so this must land on 25 Aug 2025.
func TestResolveReadingDateText_NotYetOccurredThisYearResolvesToLastYear(t *testing.T) {
	got := resolveReadingDateText(sptr("08/25"), fixedNow)
	require.NotNil(t, got)
	assert.Equal(t, "2025-08-25", *got)
}

// TestResolveReadingDateText_LeapDayResolvesToMostRecentLeapYear pins the
// 29 Feb case explicitly called out in the task: with no year printed and
// "now" in a non-leap year (2026), the most recent real occurrence of
// 29 Feb is 2024, two years back — not 2025 or 2026, which do not have a
// 29 Feb at all.
func TestResolveReadingDateText_LeapDayResolvesToMostRecentLeapYear(t *testing.T) {
	got := resolveReadingDateText(sptr("29/02"), fixedNow)
	require.NotNil(t, got)
	assert.Equal(t, "2024-02-29", *got)
}

// TestResolveReadingDateText_AmbiguousDayMonthOrderReturnsNil pins the
// explicitly-declared unresolved ambiguity: when both numeric components
// are <=12, D/M and M/D are both live readings of the same text and
// nothing in the text says which. Guessing either way would be exactly the
// fabrication kora#314 exists to prevent, so this must be nil, not a
// coin-flip date.
func TestResolveReadingDateText_AmbiguousDayMonthOrderReturnsNil(t *testing.T) {
	assert.Nil(t, resolveReadingDateText(sptr("05/06"), fixedNow))
}

// TestResolveReadingDateText_ImpossibleDayMonthReturnsNil pins "31/02" —
// not a real calendar date in any year — resolving to nil rather than
// silently rolling over to March (Go's time.Date would otherwise normalize
// it), across the full 8-year search window.
func TestResolveReadingDateText_ImpossibleDayMonthReturnsNil(t *testing.T) {
	assert.Nil(t, resolveReadingDateText(sptr("31/02"), fixedNow))
}

// TestResolveReadingDateText_TwoDigitYearReturnsNil pins the second
// explicitly-declared ambiguity: "22/08/26" could mean 1926 or 2026, and
// this resolver takes no side on centuries.
func TestResolveReadingDateText_TwoDigitYearReturnsNil(t *testing.T) {
	assert.Nil(t, resolveReadingDateText(sptr("22/08/26"), fixedNow))
}

// TestResolveReadingDateText_ExplicitYearInTheFutureReturnsNil pins that an
// explicit-year date is still subject to the "never a future reading"
// guard applied to every other path — a screenshot cannot show a weigh-in
// that has not happened yet, printed year or not.
func TestResolveReadingDateText_ExplicitYearInTheFutureReturnsNil(t *testing.T) {
	assert.Nil(t, resolveReadingDateText(sptr("22/08/2027"), fixedNow))
}

// TestResolveReadingDateText_MonthNameNotHandledReturnsNil pins the
// documented non-goal: a month-name date falls through every pattern and
// returns nil rather than partially parsing — see
// resolveReadingDateText's doc comment for why this format is out of
// scope rather than silently mishandled.
func TestResolveReadingDateText_MonthNameNotHandledReturnsNil(t *testing.T) {
	assert.Nil(t, resolveReadingDateText(sptr("22 Aug 2026"), fixedNow))
}

// TestResolveReadingDateText_ImpossibleExplicitYearDateReturnsNil pins the
// rollover guard on the EXPLICIT-year path specifically (distinct from
// TestResolveReadingDateText_ImpossibleDayMonthReturnsNil, which exercises
// the no-year search): "31/02/2026" must not silently normalize into
// 3 March 2026 the way time.Date would if its rollover were left
// unchecked.
func TestResolveReadingDateText_ImpossibleExplicitYearDateReturnsNil(t *testing.T) {
	assert.Nil(t, resolveReadingDateText(sptr("31/02/2026"), fixedNow))
}
