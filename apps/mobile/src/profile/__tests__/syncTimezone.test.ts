import { syncTimezone, deviceTimezone, resetTimezoneSyncForTests } from "../syncTimezone";
import { apiFetch } from "@/lib/api";

jest.mock("@/lib/api", () => ({ apiFetch: jest.fn() }));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";

const mockGet = AsyncStorage.getItem as jest.Mock;
const mockSet = AsyncStorage.setItem as jest.Mock;

const mockFetch = apiFetch as jest.Mock;

function withDeviceZone(tz: string | undefined) {
  jest.spyOn(Intl, "DateTimeFormat").mockReturnValue({
    resolvedOptions: () => ({ timeZone: tz }),
  } as unknown as Intl.DateTimeFormat);
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({});
  mockGet.mockReset();
  mockGet.mockResolvedValue(null);
  mockSet.mockReset();
  mockSet.mockResolvedValue(undefined);
  resetTimezoneSyncForTests();
  jest.restoreAllMocks();
});

// The whole point of persisting: a fresh launch must not re-send a zone the
// server already has.
test("sends nothing on a new launch when the zone was already synced before", async () => {
  withDeviceZone("Europe/London");
  mockGet.mockResolvedValue("Europe/London");
  await expect(syncTimezone()).resolves.toBeNull();
  expect(mockFetch).not.toHaveBeenCalled();
});

test("remembers a successful sync across launches", async () => {
  withDeviceZone("Europe/London");
  await syncTimezone();
  expect(mockSet).toHaveBeenCalledWith("profile.timezone.lastSynced", "Europe/London");
});

test("PATCHes when the device zone differs from the stored one", async () => {
  withDeviceZone("Asia/Kolkata");
  await expect(syncTimezone("Australia/Sydney")).resolves.toBe("Asia/Kolkata");
  expect(mockFetch).toHaveBeenCalledWith("/v1/me", {
    method: "PATCH",
    body: JSON.stringify({ timezone: "Asia/Kolkata" }),
  });
});

test("sends nothing when the stored zone already matches", async () => {
  withDeviceZone("Asia/Kolkata");
  await expect(syncTimezone("Asia/Kolkata")).resolves.toBeNull();
  expect(mockFetch).not.toHaveBeenCalled();
});

// This runs on EVERY foreground, so a steady state must not cost a request.
test("sends at most once per zone, even without a known stored value", async () => {
  withDeviceZone("Europe/London");
  await syncTimezone();
  await syncTimezone();
  await syncTimezone();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

test("retries on the next foreground after a failure", async () => {
  withDeviceZone("Europe/London");
  mockFetch.mockRejectedValueOnce(new Error("offline"));
  await expect(syncTimezone()).resolves.toBeNull();
  mockFetch.mockResolvedValueOnce({});
  await expect(syncTimezone()).resolves.toBe("Europe/London");
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

// A background correction the user never asked for must never surface an error
// or reject into the foreground handler.
test("never throws when the request fails", async () => {
  withDeviceZone("Europe/London");
  mockFetch.mockRejectedValue(new Error("500"));
  await expect(syncTimezone()).resolves.toBeNull();
});

describe("deviceTimezone rejects anything that is not a named IANA zone", () => {
  // "UTC" and "Local" are refused because the API refuses them: they mean "no
  // opinion" and "the server's zone" rather than where the user actually is.
  test.each(["UTC", "Local", "", undefined])("%s", (tz) => {
    withDeviceZone(tz as string | undefined);
    expect(deviceTimezone()).toBeNull();
  });

  test("accepts a real zone", () => {
    withDeviceZone("America/New_York");
    expect(deviceTimezone()).toBe("America/New_York");
  });
});

test("sends nothing when the device zone cannot be determined", async () => {
  withDeviceZone(undefined);
  await expect(syncTimezone("Australia/Sydney")).resolves.toBeNull();
  expect(mockFetch).not.toHaveBeenCalled();
});
