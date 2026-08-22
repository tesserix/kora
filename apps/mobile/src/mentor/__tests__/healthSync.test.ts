import { Platform } from "react-native";
import {
  isHealthDataAvailable,
  queryCategorySamples,
  queryStatisticsCollectionForQuantity,
  queryWorkoutSamples,
  requestAuthorization,
} from "@kingstinct/react-native-healthkit";
import { collectMentorHealthDays } from "../healthSync";

const originalOS = Platform.OS;

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, "OS", { get: () => "ios", configurable: true });
  (isHealthDataAvailable as jest.Mock).mockReturnValue(true);
  (requestAuthorization as jest.Mock).mockResolvedValue(true);
  (queryStatisticsCollectionForQuantity as jest.Mock).mockResolvedValue([]);
  (queryCategorySamples as jest.Mock).mockResolvedValue([]);
  (queryWorkoutSamples as jest.Mock).mockResolvedValue([]);
});

afterAll(() => {
  Object.defineProperty(Platform, "OS", { get: () => originalOS, configurable: true });
});

test("Health sync requests only consented metrics and uploads seven-day aggregates", async () => {
  const day = new Date(2026, 7, 22, 0, 0);
  (queryStatisticsCollectionForQuantity as jest.Mock).mockResolvedValue([
    { startDate: day, sumQuantity: { unit: "count", quantity: 7210.4 } },
  ]);
  (queryWorkoutSamples as jest.Mock).mockResolvedValue([
    { startDate: new Date(2026, 7, 22, 7, 0), duration: { unit: "s", quantity: 1860 } },
  ]);

  const result = await collectMentorHealthDays({ steps: true, sleep: false, workouts: true }, new Date(2026, 7, 22, 12, 0));

  expect(requestAuthorization).toHaveBeenCalledWith({
    toRead: ["HKQuantityTypeIdentifierStepCount", "HKWorkoutTypeIdentifier"],
  });
  expect(queryCategorySamples).not.toHaveBeenCalled();
  expect(result.status).toBe("ready");
  expect(result.days).toEqual([expect.objectContaining({
    local_date: "2026-08-22",
    steps: 7210,
    workout_minutes: 31,
  })]);
  expect(result.days[0]).not.toHaveProperty("sleep_minutes");
});

test("overlapping HealthKit sleep stages are merged instead of double-counted", async () => {
  (queryCategorySamples as jest.Mock).mockResolvedValue([
    { value: 3, startDate: new Date(2026, 7, 21, 23, 0), endDate: new Date(2026, 7, 22, 1, 0) },
    { value: 5, startDate: new Date(2026, 7, 22, 0, 30), endDate: new Date(2026, 7, 22, 2, 0) },
  ]);

  const result = await collectMentorHealthDays({ steps: false, sleep: true, workouts: false }, new Date(2026, 7, 22, 12, 0));

  expect(result.days).toEqual([expect.objectContaining({ local_date: "2026-08-22", sleep_minutes: 180 })]);
});

test("Health sync degrades without querying when HealthKit is unavailable", async () => {
  (isHealthDataAvailable as jest.Mock).mockReturnValue(false);

  const result = await collectMentorHealthDays({ steps: true, sleep: true, workouts: true }, new Date());

  expect(result).toEqual({ status: "unavailable", days: [] });
  expect(requestAuthorization).not.toHaveBeenCalled();
});
