import { mergeAsleepMillis } from "../useHealth";

const HOUR = 60 * 60 * 1000;

// A fixed anchor so every test builds offsets from the same base instant instead
// of depending on wall-clock "now" — keeps the interval math (and any failure
// diffs) readable in plain hours.
const BASE = new Date("2026-01-01T22:00:00.000Z").getTime();
const at = (hoursFromBase: number) => new Date(BASE + hoursFromBase * HOUR);

// value: 1 = asleepUnspecified, 3 = asleepCore, 4 = asleepDeep, 5 = asleepREM,
// 0 = inBed, 2 = awake — mirrors HealthKit's CategoryValueSleepAnalysis enum.
const sample = (value: number, startHour: number, endHour: number) => ({
  value,
  startDate: at(startHour),
  endDate: at(endHour),
});

describe("mergeAsleepMillis", () => {
  test("empty list is zero", () => {
    expect(mergeAsleepMillis([])).toBe(0);
  });

  test("a single sample counts its own duration", () => {
    const millis = mergeAsleepMillis([sample(3, 0, 7)]);
    expect(millis).toBe(7 * HOUR);
  });

  test("fully overlapping samples (e.g. two sources agreeing on the same span) count once", () => {
    const millis = mergeAsleepMillis([sample(1, 0, 8), sample(3, 0, 8)]);
    expect(millis).toBe(8 * HOUR);
  });

  test("partially overlapping samples merge to their union, not their sum", () => {
    // [0,5) and [3,8) overlap on [3,5) — naive summing would give 5+5=10h;
    // the true union is [0,8) = 8h.
    const millis = mergeAsleepMillis([sample(3, 0, 5), sample(4, 3, 8)]);
    expect(millis).toBe(8 * HOUR);
  });

  test("adjacent samples that only touch (no gap, no overlap) merge into one continuous span", () => {
    // [0,3) then [3,6): one ends exactly when the next begins.
    const millis = mergeAsleepMillis([sample(3, 0, 3), sample(4, 3, 6)]);
    expect(millis).toBe(6 * HOUR);
  });

  test("disjoint samples with a real gap between them are counted separately", () => {
    // Asleep [0,3), a genuine awake gap, asleep again [5,7).
    const millis = mergeAsleepMillis([sample(3, 0, 3), sample(4, 5, 7)]);
    expect(millis).toBe(3 * HOUR + 2 * HOUR);
  });

  test("out-of-order input is sorted before merging", () => {
    const inOrder = mergeAsleepMillis([sample(3, 0, 5), sample(4, 3, 8)]);
    const outOfOrder = mergeAsleepMillis([sample(4, 3, 8), sample(3, 0, 5)]);
    expect(outOfOrder).toBe(inOrder);
    expect(outOfOrder).toBe(8 * HOUR);
  });

  test("awake and in-bed samples are excluded from the union entirely", () => {
    const millis = mergeAsleepMillis([
      sample(0, -1, 0), // inBed, before sleep started — excluded
      sample(3, 0, 7), // asleepCore — the only span that counts
      sample(2, 3, 3.25), // a brief awake blip inside the night — excluded
    ]);
    expect(millis).toBe(7 * HOUR);
  });

  // The exact shape from #327: one long third-party `asleepUnspecified` block
  // covering the whole night, plus Apple Watch's Core/Deep/REM samples layered
  // across the same span. Naive summing gave ~7h + ~6h = 12.8h; the union must
  // land close to the real single-night duration instead.
  test("the reported 12.8h shape (unspecified block plus overlapping staged samples) merges to a plausible night", () => {
    const millis = mergeAsleepMillis([
      sample(1, 0, 7), // third-party app: one unspecified block, 7h
      sample(3, 0.5, 2.5), // Watch: core, 2h — inside the unspecified block
      sample(4, 2.5, 4), // Watch: deep, 1.5h — contiguous with the core sample
      sample(5, 4, 6.5), // Watch: REM, 2.5h — still inside the unspecified block
    ]);
    // The staged samples together span [0.5, 6.5), entirely inside the
    // unspecified [0, 7) block, so the union is exactly the unspecified span.
    expect(millis).toBe(7 * HOUR);
    const hours = millis / HOUR;
    expect(hours).toBeGreaterThan(4);
    expect(hours).toBeLessThan(10);
  });

  test("unspecified samples are kept, not dropped, when they cover minutes no staged sample touches", () => {
    // Staged samples only cover [1,3); the third-party unspecified block additionally
    // covers [3,5), which no staged sample describes. Dropping unspecified whenever
    // staged samples exist would silently lose those two hours.
    const millis = mergeAsleepMillis([sample(1, 0, 5), sample(3, 1, 3)]);
    expect(millis).toBe(5 * HOUR);
  });

  test("zero-duration and inverted-duration samples contribute nothing", () => {
    const millis = mergeAsleepMillis([
      { value: 3, startDate: at(0), endDate: at(0) }, // zero duration
      { value: 3, startDate: at(5), endDate: at(2) }, // end before start
      sample(3, 6, 7),
    ]);
    expect(millis).toBe(1 * HOUR);
  });

  // --- window clipping (kora#417) ---
  //
  // HealthKit's default predicate returns any sample merely OVERLAPPING the
  // queried window, so a night that began before the window still comes back —
  // in full. Counting it whole attributes hours slept before the window to the
  // window, which is how the tile came to disagree with the Health app.
  //
  // The steps query already guards against exactly this with strictStartDate,
  // and its comment says so. Sleep never did.

  test("a sample starting before the window contributes only its part inside", () => {
    // Window [0, 10). The sample runs [-4, 2): only [0, 2) is inside.
    const millis = mergeAsleepMillis([sample(3, -4, 2)], at(0).getTime(), at(10).getTime());
    expect(millis).toBe(2 * HOUR);
  });

  test("a sample ending after the window contributes only its part inside", () => {
    const millis = mergeAsleepMillis([sample(3, 8, 14)], at(0).getTime(), at(10).getTime());
    expect(millis).toBe(2 * HOUR);
  });

  test("a sample entirely outside the window contributes nothing", () => {
    const millis = mergeAsleepMillis([sample(3, -8, -4)], at(0).getTime(), at(10).getTime());
    expect(millis).toBe(0);
  });

  test("clipping happens before the union, so a clipped sample cannot extend a run", () => {
    // [-4, 2) clips to [0, 2); [1, 3) is wholly inside. Union inside the window
    // is [0, 3) = 3h. Unclipped it would have been [-4, 3) = 7h.
    const millis = mergeAsleepMillis(
      [sample(3, -4, 2), sample(4, 1, 3)],
      at(0).getTime(),
      at(10).getTime(),
    );
    expect(millis).toBe(3 * HOUR);
  });

  test("omitting the window keeps the previous unbounded behaviour", () => {
    expect(mergeAsleepMillis([sample(3, -4, 2)])).toBe(6 * HOUR);
  });
});
