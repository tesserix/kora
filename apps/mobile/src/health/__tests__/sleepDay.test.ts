import { recentSleepDays, sleepDayContaining, sleepLookbackMs } from "../sleepDay";

const at = (iso: string) => new Date(iso);

describe("sleepDayContaining", () => {
  // The case that motivated kora#417's second round: a user checking the app
  // at midday must be shown the night that just ended, not an empty day.
  test("before 18:00 belongs to the day that opened at 18:00 yesterday", () => {
    const day = sleepDayContaining(at("2026-03-10T12:46:00"));

    expect(day.start.getDate()).toBe(9);
    expect(day.start.getHours()).toBe(18);
    expect(day.end.getDate()).toBe(10);
    expect(day.end.getHours()).toBe(18);
  });

  test("at or after 18:00 a new sleep day has opened", () => {
    const day = sleepDayContaining(at("2026-03-10T18:00:00"));

    expect(day.start.getDate()).toBe(10);
    expect(day.start.getHours()).toBe(18);
    expect(day.end.getDate()).toBe(11);
  });

  test("just before the boundary is still the previous day", () => {
    const day = sleepDayContaining(at("2026-03-10T17:59:59"));

    expect(day.start.getDate()).toBe(9);
  });

  // Month and year rollover: setDate(0) and friends are where hand-rolled date
  // maths usually breaks, and a wrong window here silently reports the wrong
  // night rather than failing.
  test("rolls back across a month boundary", () => {
    const day = sleepDayContaining(at("2026-03-01T09:00:00"));

    expect(day.start.getMonth()).toBe(1); // February
    expect(day.start.getDate()).toBe(28);
  });

  test("rolls back across a year boundary", () => {
    const day = sleepDayContaining(at("2026-01-01T09:00:00"));

    expect(day.start.getFullYear()).toBe(2025);
    expect(day.start.getMonth()).toBe(11);
    expect(day.start.getDate()).toBe(31);
  });
});

describe("recentSleepDays", () => {
  test("returns days most recent first, contiguous and non-overlapping", () => {
    const days = recentSleepDays(at("2026-03-10T12:46:00"), 3);

    expect(days).toHaveLength(3);
    expect(days[0].start.getDate()).toBe(9);
    expect(days[1].start.getDate()).toBe(8);
    expect(days[2].start.getDate()).toBe(7);
    // Each day ends exactly where the next-newer one begins.
    expect(days[1].end.getTime()).toBe(days[0].start.getTime());
    expect(days[2].end.getTime()).toBe(days[1].start.getTime());
  });
});

describe("sleepLookbackMs", () => {
  test("reaches past the oldest day's start so a straddling sample is still returned", () => {
    const now = at("2026-03-10T12:46:00");
    const days = recentSleepDays(now, 2);

    const lookback = sleepLookbackMs(now, 2);

    expect(now.getTime() - lookback).toBeLessThan(days[1].start.getTime());
  });
});
