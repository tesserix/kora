import { renderHook, waitFor } from "@testing-library/react-native";
import { Platform } from "react-native";
import {
  isHealthDataAvailable,
  queryStatisticsCollectionForQuantity,
  queryWorkoutSamples,
  requestAuthorization,
} from "@kingstinct/react-native-healthkit";
import {
  dailyStepTotals,
  workoutsPerWeek,
  useActivityHistory,
} from "../useActivityHistory";

// @kingstinct/react-native-healthkit is globally mocked in jest.setup.js; grab the
// mocked references and configure them per test, matching useHealth.test.tsx.
const mockIsAvailable = isHealthDataAvailable as jest.Mock;
const mockRequestAuthorization = requestAuthorization as jest.Mock;
const mockQueryStatisticsCollectionForQuantity = queryStatisticsCollectionForQuantity as jest.Mock;
const mockQueryWorkoutSamples = queryWorkoutSamples as jest.Mock;

// Platform.OS is a getter on a shared singleton under jest-expo, so it is
// overridden via defineProperty rather than jest.mock — same convention as
// useHealth.test.tsx and Icon.test.tsx.
const originalOS = Platform.OS;
function setPlatformOS(os: string) {
  Object.defineProperty(Platform, "OS", { get: () => os, configurable: true });
}

const day = (offset: number, hour = 9) => {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  return d;
};

// Buckets shaped like queryStatisticsCollectionForQuantity's QueryStatisticsResponse[].
const statsBuckets = (days: number, perDay: number) =>
  Array.from({ length: days }, (_, i) => ({
    startDate: day(i),
    sumQuantity: { unit: "count", quantity: perDay },
  }));

describe("dailyStepTotals", () => {
  it("takes each bucket's sum as the day's total", () => {
    expect(
      dailyStepTotals([
        { startDate: day(0), sumQuantity: { unit: "count", quantity: 3500 } },
      ]),
    ).toEqual([3500]);
  });

  it("keeps separate days separate", () => {
    expect(
      dailyStepTotals([
        { startDate: day(0), sumQuantity: { unit: "count", quantity: 1000 } },
        { startDate: day(1), sumQuantity: { unit: "count", quantity: 2000 } },
      ]),
    ).toHaveLength(2);
  });

  it("does NOT include a bucket with no sumQuantity — absent stays absent", () => {
    // Zero-filling a gap would drag the mean down and bias the inferred level —
    // and so the calorie target — downward. A missing sumQuantity means HealthKit
    // has no data for that day, so it is dropped, not zeroed.
    const result = dailyStepTotals([
      { startDate: day(0), sumQuantity: { unit: "count", quantity: 9000 } },
      { startDate: day(1) }, // no sumQuantity at all
      { startDate: day(2), sumQuantity: { unit: "count", quantity: 9000 } },
    ]);
    expect(result).toHaveLength(2);
    expect(result).toEqual([9000, 9000]);
  });

  it("DOES include a bucket with sumQuantity: { quantity: 0 } — a present zero is real evidence", () => {
    // The inverse of the above: HealthKit measured and found nothing, which is a
    // genuine sedentary day, not a gap.
    const result = dailyStepTotals([
      { startDate: day(0), sumQuantity: { unit: "count", quantity: 0 } },
      { startDate: day(1), sumQuantity: { unit: "count", quantity: 9000 } },
    ]);
    expect(result).toHaveLength(2);
    expect(result).toEqual([0, 9000]);
  });

  it("discards negative and non-finite quantities", () => {
    expect(
      dailyStepTotals([
        { startDate: day(0), sumQuantity: { unit: "count", quantity: 5000 } },
        { startDate: day(1), sumQuantity: { unit: "count", quantity: -100 } },
        { startDate: day(2), sumQuantity: { unit: "count", quantity: Number.NaN } },
      ]),
    ).toEqual([5000]);
  });
});

describe("workoutsPerWeek", () => {
  it("converts a window count into a weekly rate", () => {
    expect(workoutsPerWeek(6, 14)).toBe(3);
  });
  it("cannot divide by a zero-length window", () => {
    expect(workoutsPerWeek(3, 0)).toBe(0);
  });
});

describe("useActivityHistory", () => {
  beforeEach(() => {
    setPlatformOS("ios");
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatisticsCollectionForQuantity.mockResolvedValue(statsBuckets(14, 8000));
    mockQueryWorkoutSamples.mockResolvedValue([]);
  });

  afterEach(() => {
    setPlatformOS(originalOS);
    jest.clearAllMocks();
  });

  it("starts idle and requests nothing until asked", async () => {
    const { result } = await renderHook(() => useActivityHistory());
    expect(result.current.status).toBe("idle");
    expect(mockRequestAuthorization).not.toHaveBeenCalled();
  });

  it("infers a level once granted", async () => {
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.inference?.level).toBe("moderate");
  });

  it("asks for both the step and workout scopes", async () => {
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(mockRequestAuthorization).toHaveBeenCalled());
    expect(mockRequestAuthorization).toHaveBeenCalledWith({
      toRead: ["HKQuantityTypeIdentifierStepCount", "HKWorkoutTypeIdentifier"],
    });
  });

  it("reports denied and infers nothing when the user declines", async () => {
    mockRequestAuthorization.mockResolvedValue(false);
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("denied"));
    expect(result.current.inference).toBeNull();
  });

  it("reports insufficient rather than guessing when data is thin", async () => {
    mockQueryStatisticsCollectionForQuantity.mockResolvedValue(statsBuckets(3, 8000));
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("insufficient"));
    expect(result.current.inference).toBeNull();
  });

  it("queries a bounded window with a daily interval and cumulative-sum statistic", async () => {
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(mockQueryStatisticsCollectionForQuantity).toHaveBeenCalled());

    const [identifier, statistics, anchorDate, intervalComponents, options] =
      mockQueryStatisticsCollectionForQuantity.mock.calls[0];
    expect(identifier).toBe("HKQuantityTypeIdentifierStepCount");
    expect(statistics).toEqual(["cumulativeSum"]);

    // anchorDate must be local MIDNIGHT — not merely "a Date" — because it is now
    // the bucket-grid anchor for queryStatisticsCollectionForQuantity. A
    // millisecond-subtraction anchor (now - N*MS_PER_DAY) drifts off midnight
    // across a DST transition, shifting every bucket boundary in the window.
    expect(anchorDate).toBeInstanceOf(Date);
    expect((anchorDate as Date).getHours()).toBe(0);
    expect((anchorDate as Date).getMinutes()).toBe(0);
    expect((anchorDate as Date).getSeconds()).toBe(0);
    expect((anchorDate as Date).getMilliseconds()).toBe(0);

    const expectedAnchor = new Date();
    expectedAnchor.setHours(0, 0, 0, 0);
    expectedAnchor.setDate(expectedAnchor.getDate() - 13); // WINDOW_DAYS - 1
    expect((anchorDate as Date).getTime()).toBe(expectedAnchor.getTime());

    expect(intervalComponents).toEqual({ day: 1 });
    expect(options).toMatchObject({
      filter: {
        date: expect.objectContaining({
          startDate: expect.any(Date),
          endDate: expect.any(Date),
        }),
      },
      unit: "count",
    });
  });

  it("degrades honestly when HealthKit is unavailable", async () => {
    mockIsAvailable.mockReturnValue(false);
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("degrades instead of crashing when a native call rejects", async () => {
    mockQueryStatisticsCollectionForQuantity.mockRejectedValue(new Error("bridge exploded"));
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.inference).toBeNull();
  });

  it("never touches HealthKit on Android", async () => {
    setPlatformOS("android");
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(mockIsAvailable).not.toHaveBeenCalled();
  });

  it("lets workouts lift the level above what steps alone would give", async () => {
    mockQueryStatisticsCollectionForQuantity.mockResolvedValue(statsBuckets(14, 3000)); // sedentary on steps
    mockQueryWorkoutSamples.mockResolvedValue(Array.from({ length: 10 }, () => ({}))); // 5/wk
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.inference?.level).toBe("moderate");
  });
});
