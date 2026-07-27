import { renderHook, waitFor } from "@testing-library/react-native";
import { Linking, Platform } from "react-native";
import {
  isHealthDataAvailable,
  queryCategorySamples,
  queryQuantitySamples,
  requestAuthorization,
} from "@kingstinct/react-native-healthkit";
import { useHealth } from "../useHealth";

// @kingstinct/react-native-healthkit is globally mocked in jest.setup.js as jest.fn()s
// (isHealthDataAvailable defaulting to "unavailable"), matching the same per-test
// override pattern already used for expo-camera's useCameraPermissions in this repo:
// grab the mocked function references and configure them per test.
const mockIsAvailable = isHealthDataAvailable as jest.Mock;
const mockRequestAuthorization = requestAuthorization as jest.Mock;
const mockQueryQuantitySamples = queryQuantitySamples as jest.Mock;
const mockQueryCategorySamples = queryCategorySamples as jest.Mock;

// Platform.OS is a getter on a shared singleton under jest-expo (not a real per-file
// module), so — as with the existing Icon.test.tsx convention — it's overridden via
// Object.defineProperty rather than jest.mock("react-native/.../Platform"), which does
// not intercept jest-expo's own react-native mock.
const originalOS = Platform.OS;
function setPlatformOS(os: string) {
  Object.defineProperty(Platform, "OS", { get: () => os, configurable: true });
}

describe("useHealth", () => {
  afterEach(() => {
    setPlatformOS(originalOS);
    jest.clearAllMocks();
  });

  it("reports unavailable on a non-iOS platform (the Health Connect seam)", async () => {
    setPlatformOS("android");

    const { result } = await renderHook(() => useHealth());

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.steps).toBeNull();
    expect(result.current.sleep).toBeNull();
    // Never touches the iOS-only HealthKit API when not on iOS.
    expect(mockIsAvailable).not.toHaveBeenCalled();
    expect(mockRequestAuthorization).not.toHaveBeenCalled();
  });

  it("reports unavailable when HealthKit itself is unavailable on iOS (e.g. simulator)", async () => {
    mockIsAvailable.mockReturnValue(false);

    const { result } = await renderHook(() => useHealth());

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.steps).toBeNull();
    expect(result.current.sleep).toBeNull();
    expect(mockRequestAuthorization).not.toHaveBeenCalled();
  });

  it("reports denied when the user declines authorization and exposes no numbers", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(false);

    const { result } = await renderHook(() => useHealth());

    await waitFor(() => expect(result.current.status).toBe("denied"));
    expect(result.current.steps).toBeNull();
    expect(result.current.sleep).toBeNull();
    // Denied means no HealthKit query should ever have run.
    expect(mockQueryQuantitySamples).not.toHaveBeenCalled();
    expect(mockQueryCategorySamples).not.toHaveBeenCalled();
  });

  it("reports authorized with summed steps and asleep hours when granted", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryQuantitySamples.mockResolvedValue([{ quantity: 3000 }, { quantity: 2200 }]);
    mockQueryCategorySamples.mockResolvedValue([
      // asleepCore (3): 3 hours — counted.
      {
        value: 3,
        startDate: new Date("2026-07-26T23:00:00.000Z"),
        endDate: new Date("2026-07-27T02:00:00.000Z"),
      },
      // inBed (0): excluded from the asleep total.
      {
        value: 0,
        startDate: new Date("2026-07-26T22:30:00.000Z"),
        endDate: new Date("2026-07-26T23:00:00.000Z"),
      },
    ]);

    const { result } = await renderHook(() => useHealth());

    await waitFor(() => expect(result.current.status).toBe("authorized"));
    expect(result.current.steps).toEqual({ today: 5200, goal: 10000 });
    expect(result.current.sleep).toEqual({ lastNightHours: 3 });
  });

  it("degrades to unavailable when a HealthKit query rejects (never crashes, never fabricates)", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryQuantitySamples.mockRejectedValue(new Error("HealthKit query failed"));
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());

    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.steps).toBeNull();
    expect(result.current.sleep).toBeNull();
  });

  it("connect() re-requests authorization when not denied", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryQuantitySamples.mockResolvedValue([]);
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.status).toBe("authorized"));

    const callsBefore = mockRequestAuthorization.mock.calls.length;
    result.current.connect();

    await waitFor(() => expect(mockRequestAuthorization.mock.calls.length).toBe(callsBefore + 1));
    // Let the second load() fully settle before the test (and its mocks) tear down.
    await waitFor(() => expect(result.current.status).toBe("authorized"));
  });

  it("connect() deep-links to the Health app in Settings when denied", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(false);
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as unknown as void);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.status).toBe("denied"));

    result.current.connect();

    await waitFor(() => expect(openURLSpy).toHaveBeenCalledWith("x-apple-health://"));
    openURLSpy.mockRestore();
  });
});
