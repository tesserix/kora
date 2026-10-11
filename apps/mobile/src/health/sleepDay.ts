// Apple's sleep day, so Kora's "last night" means the same night the Health
// app means (kora#417).
//
// # Why not midnight
//
// The first implementation queried `startOfLocalDay() - 16h -> now`. That is
// anchored to MIDNIGHT, so its start drifts with the time of day: checked at
// noon it spans nearly 29 hours, and it opens at 08:00 the previous morning —
// early enough to swallow the tail of the night BEFORE last night for anyone
// who sleeps past 8am. A device comparison showed Kora reporting materially
// more than the Health app for the same night for exactly that reason.
//
// Apple does not use midnight. Its sleep day runs 18:00 -> 18:00, and sleep
// that crosses 18:00 is SPLIT at the boundary and attributed to both days.
// Matching that boundary is what makes the two numbers comparable at all.
const SLEEP_DAY_BOUNDARY_HOUR = 18;

const MS_PER_HOUR = 60 * 60 * 1000;

/** A half-open [start, end) sleep day. */
export type SleepDay = {
  readonly start: Date;
  readonly end: Date;
};

/**
 * sleepDayContaining returns the Apple sleep day that `at` falls inside.
 *
 * Before 18:00 the current instant still belongs to the day that opened at
 * 18:00 YESTERDAY — which is why a check at noon reports last night rather
 * than an empty new day.
 */
export function sleepDayContaining(at: Date): SleepDay {
  const start = new Date(at);
  start.setHours(SLEEP_DAY_BOUNDARY_HOUR, 0, 0, 0);
  if (at.getHours() < SLEEP_DAY_BOUNDARY_HOUR) {
    start.setDate(start.getDate() - 1);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

/**
 * recentSleepDays returns `count` sleep days ending with the one containing
 * `at`, most recent FIRST.
 *
 * More than one is needed because the day containing `at` can legitimately be
 * empty: at 20:00 a new sleep day has just opened and nobody has slept in it
 * yet. Reporting that as "no sleep" would erase last night at exactly the hour
 * a user is most likely to look.
 */
export function recentSleepDays(at: Date, count = 2): SleepDay[] {
  const days: SleepDay[] = [];
  let day = sleepDayContaining(at);
  for (let i = 0; i < count; i++) {
    days.push(day);
    const start = new Date(day.start);
    start.setDate(start.getDate() - 1);
    day = { start, end: day.start };
  }
  return days;
}

/**
 * sleepLookbackMs is how far back the HealthKit query must reach to cover
 * every day recentSleepDays can return, plus one boundary's slack so a session
 * straddling the oldest boundary is still returned and can be clipped.
 */
export function sleepLookbackMs(at: Date, count = 2): number {
  const oldest = recentSleepDays(at, count)[count - 1];
  return at.getTime() - oldest.start.getTime() + 24 * MS_PER_HOUR;
}
