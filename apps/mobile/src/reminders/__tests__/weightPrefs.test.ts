import { DEFAULT_WEIGHT_PREF, nextWeightReminderAt, type WeightReminderPref } from "../weightPrefs";

// Monday 07:00, weekly. Dates below are local time, which is what the
// scheduler works in — the OS fires local triggers.
const MON_0700: WeightReminderPref = { enabled: true, hour: 7, minute: 0, days: [1] };

test("returns null when disabled", () => {
  expect(nextWeightReminderAt({ ...MON_0700, enabled: false }, null, new Date(2026, 7, 12, 9, 0))).toBeNull();
});

test("returns null when no days are selected", () => {
  expect(nextWeightReminderAt({ ...MON_0700, days: [] }, null, new Date(2026, 7, 12, 9, 0))).toBeNull();
});

test("with no weigh-in ever, returns the next Monday 07:00", () => {
  // Wed 2026-08-12 09:00 -> Mon 2026-08-17 07:00
  const got = nextWeightReminderAt(MON_0700, null, new Date(2026, 7, 12, 9, 0));
  expect(got).toEqual(new Date(2026, 7, 17, 7, 0, 0, 0));
});

test("weighing in earlier the same day skips that occurrence", () => {
  // Now Mon 06:45, weighed in Mon 06:40 — this Monday's 07:00 must be skipped.
  // This is the case the whole feature exists for.
  const got = nextWeightReminderAt(MON_0700, new Date(2026, 7, 17, 6, 40), new Date(2026, 7, 17, 6, 45));
  expect(got).toEqual(new Date(2026, 7, 24, 7, 0, 0, 0));
});

test("weighing in the evening before still lets the reminder fire", () => {
  // Sun 20:00, next occurrence Mon 07:00 — different calendar day, so it fires.
  // The user asked to be reminded on Monday; yesterday's weigh-in is not a
  // reason to stay silent.
  const got = nextWeightReminderAt(MON_0700, new Date(2026, 7, 16, 20, 0), new Date(2026, 7, 16, 21, 0));
  expect(got).toEqual(new Date(2026, 7, 17, 7, 0, 0, 0));
});

test("weighing in earlier in the week still lets the reminder fire", () => {
  // Weighed in last Tuesday; the upcoming Monday must still fire.
  const got = nextWeightReminderAt(MON_0700, new Date(2026, 7, 11, 8, 0), new Date(2026, 7, 12, 9, 0));
  expect(got).toEqual(new Date(2026, 7, 17, 7, 0, 0, 0));
});

test("now exactly at the scheduled minute rolls to the following week", () => {
  // Strictly after `now`, so 07:00 on the dot is already gone.
  const got = nextWeightReminderAt(MON_0700, null, new Date(2026, 7, 17, 7, 0, 0, 0));
  expect(got).toEqual(new Date(2026, 7, 24, 7, 0, 0, 0));
});

test("a multi-day selection picks the nearest upcoming day", () => {
  // Mon + Thu, now Tue -> Thu.
  const monThu: WeightReminderPref = { ...MON_0700, days: [1, 4] };
  const got = nextWeightReminderAt(monThu, null, new Date(2026, 7, 18, 9, 0));
  expect(got).toEqual(new Date(2026, 7, 20, 7, 0, 0, 0));
});

test("the default pref is disabled at 07:00 on Mondays", () => {
  expect(DEFAULT_WEIGHT_PREF).toEqual({ enabled: false, hour: 7, minute: 0, days: [1] });
});

test("a future weigh-in one occurrence ahead skips past that occurrence too", () => {
  // lastWeighedAt lands on what would be the SECOND candidate (Aug 24), so a
  // single-step skip that stops after advancing past the first candidate
  // (Aug 17 -> Aug 24) is not enough — Aug 24 is still covered by the same
  // calendar-day rule and must also be skipped, landing on Aug 31.
  const got = nextWeightReminderAt(MON_0700, new Date(2026, 7, 24, 10, 0), new Date(2026, 7, 12, 9, 0));
  expect(got).toEqual(new Date(2026, 7, 31, 7, 0, 0, 0));
});

test("a far-future weigh-in skips every occurrence it covers", () => {
  // Weighed in (or backdated) to Mon 2026-08-31, several weeks out from `now`.
  // The candidate must advance past every intervening Monday, not just one.
  const got = nextWeightReminderAt(MON_0700, new Date(2026, 7, 31, 10, 0), new Date(2026, 7, 12, 9, 0));
  expect(got).toEqual(new Date(2026, 8, 7, 7, 0, 0, 0));
});

test("a same-day future weigh-in still skips today's occurrence", () => {
  // Weighed in at 08:00, after the 07:00 slot, on the very day of the next
  // occurrence — still the same calendar day, so today is skipped.
  const got = nextWeightReminderAt(MON_0700, new Date(2026, 7, 17, 8, 0), new Date(2026, 7, 17, 6, 0));
  expect(got).toEqual(new Date(2026, 7, 24, 7, 0, 0, 0));
});
