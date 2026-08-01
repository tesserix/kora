import { renderHook, waitFor } from "@testing-library/react-native";
import { Platform } from "react-native";
import {
  isHealthDataAvailable,
  queryQuantitySamples,
  queryWorkoutSamples,
  requestAuthorization,
} from "@kingstinct/react-native-healthkit";
import {
  bucketStepsByDay,
  workoutsPerWeek,
  useActivityHistory,
} from "../useActivityHistory";

// @kingstinct/react-native-healthkit is globally mocked in jest.setup.js; grab the
// mocked references and configure them per test, matching useHealth.test.tsx.
const mockIsAvailable = isHealthDataAvailable as jest.Mock;
const mockRequestAuthorization = requestAuthorization as jest.Mock;
const mockQueryQuantitySamples = queryQuantitySamples as jest.Mock;
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

const stepSamples = (days: number, perDay: number) =>
  Array.from({ length: days }, (_, i) => ({ startDate: day(i), quantity: perDay }));

describe("bucketStepsByDay", () => {
  it("sums multiple samples falling on the same day", () => {
    expect(
      bucketStepsByDay([
        { startDate: day(0, 9), quantity: 1000 },
        { startDate: day(0, 18), quantity: 2500 },
      ]),
    ).toEqual([3500]);
  });

  it("keeps separate days separate", () => {
    expect(
      bucketStepsByDay([
        { startDate: day(0), quantity: 1000 },
        { startDate: day(1), quantity: 2000 },
      ]),
    ).toHaveLength(2);
  });

  it("does NOT zero-fill days that have no samples", () => {
    // Zero-filling a gap would drag the mean down and bias the inferred level —
    // and so the calorie target — downward.
    expect(
      bucketStepsByDay([
        { startDate: day(0), quantity: 9000 },
        { startDate: day(10), quantity: 9000 },
      ]),
    ).toEqual([9000, 9000]);
  });

  it("discards negative and non-finite quantities", () => {
    expect(
      bucketStepsByDay([
        { startDate: day(0), quantity: 5000 },
        { startDate: day(0), quantity: -100 },
        { startDate: day(0), quantity: Number.NaN },
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
    mockQueryQuantitySamples.mockResolvedValue(stepSamples(14, 8000));
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
    mockQueryQuantitySamples.mockResolvedValue(stepSamples(3, 8000));
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("insufficient"));
    expect(result.current.inference).toBeNull();
  });

  it("degrades honestly when HealthKit is unavailable", async () => {
    mockIsAvailable.mockReturnValue(false);
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("degrades instead of crashing when a native call rejects", async () => {
    mockQueryQuantitySamples.mockRejectedValue(new Error("bridge exploded"));
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
    mockQueryQuantitySamples.mockResolvedValue(stepSamples(14, 3000)); // sedentary on steps
    mockQueryWorkoutSamples.mockResolvedValue(Array.from({ length: 10 }, () => ({}))); // 5/wk
    const { result } = await renderHook(() => useActivityHistory());
    result.current.request();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.inference?.level).toBe("moderate");
  });
});
