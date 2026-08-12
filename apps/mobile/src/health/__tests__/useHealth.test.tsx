import { act, renderHook, waitFor } from "@testing-library/react-native";
import { AppState, Linking, Platform } from "react-native";
import {
  isHealthDataAvailable,
  queryCategorySamples,
  queryQuantitySamples,
  queryStatisticsForQuantity,
  requestAuthorization,
} from "@kingstinct/react-native-healthkit";
import { useHealth } from "../useHealth";

// expo-router's real useFocusEffect needs a navigation container above it, which a
// renderHook has no business mounting. The mock records the callback instead so the
// focus trigger can be fired explicitly — the same shape the repo already uses for
// expo-router's `router` in the screen tests. The body only runs at render time, well
// after this const is initialised, so the jest.mock hoist is safe.
const mockFocusCallbacks: (() => void | (() => void))[] = [];
jest.mock("expo-router", () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    mockFocusCallbacks.push(cb);
  },
}));

// @kingstinct/react-native-healthkit is globally mocked in jest.setup.js as jest.fn()s
// (isHealthDataAvailable defaulting to "unavailable"), matching the same per-test
// override pattern already used for expo-camera's useCameraPermissions in this repo:
// grab the mocked function references and configure them per test.
const mockIsAvailable = isHealthDataAvailable as jest.Mock;
const mockRequestAuthorization = requestAuthorization as jest.Mock;
const mockQueryQuantitySamples = queryQuantitySamples as jest.Mock;
const mockQueryCategorySamples = queryCategorySamples as jest.Mock;
const mockQueryStatistics = queryStatisticsForQuantity as jest.Mock;

/** A cumulative-sum statistics response carrying a real total. */
function statsWithSum(total: number) {
  return { sumQuantity: { unit: "count", quantity: total }, sources: [] };
}
/** What HealthKit returns for a window with no samples: no sumQuantity at all. */
function statsWithoutSum() {
  return { sources: [] };
}

// Platform.OS is a getter on a shared singleton under jest-expo (not a real per-file
// module), so — as with the existing Icon.test.tsx convention — it's overridden via
// Object.defineProperty rather than jest.mock("react-native/.../Platform"), which does
// not intercept jest-expo's own react-native mock.
const originalOS = Platform.OS;
function setPlatformOS(os: string) {
  Object.defineProperty(Platform, "OS", { get: () => os, configurable: true });
}

describe("useHealth", () => {
  // AppState has no public "emit" under Jest, so the "change" handlers are captured
  // from the subscription call and fired directly.
  let appStateHandlers: ((state: string) => void)[] = [];

  beforeEach(() => {
    appStateHandlers = [];
    mockFocusCallbacks.length = 0;
    jest.spyOn(AppState, "addEventListener").mockImplementation(((
      type: string,
      handler: (state: string) => void,
    ) => {
      if (type === "change") appStateHandlers.push(handler);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
    mockQueryStatistics.mockResolvedValue(statsWithoutSum());
  });

  afterEach(() => {
    setPlatformOS(originalOS);
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  const foreground = async () => {
    await act(async () => {
      appStateHandlers.forEach((h) => h("active"));
    });
  };
  const focus = async () => {
    await act(async () => {
      mockFocusCallbacks.forEach((cb) => cb());
    });
  };

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
    expect(mockQueryStatistics).not.toHaveBeenCalled();
    expect(mockQueryCategorySamples).not.toHaveBeenCalled();
  });

  it("reports authorized with summed steps and asleep hours when granted", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithSum(5200));
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
    mockQueryStatistics.mockRejectedValue(new Error("HealthKit query failed"));
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

  // HealthKit returns an empty sample array both when the user has genuinely not
  // moved and when read access was denied — the two are indistinguishable. The
  // app must therefore report "unknown" (null), never a confident 0.
  it("reports null steps when no samples are readable", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryQuantitySamples.mockResolvedValue([]);
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toBeNull());
  });

  it("reports a real count when samples are readable", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithSum(3500));
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toEqual({ today: 3500, goal: 10000 }));
  });

  // The whole point of BUG 2: raw samples are per-source, so an iPhone + Apple Watch
  // user double-counts. Only a cumulative-sum statistics query applies HealthKit's
  // source-priority dedup — the same query the native KoraWidget already uses.
  it("reads today's total with a cumulative-sum statistics query, not raw samples", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithSum(7421));
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toEqual({ today: 7421, goal: 10000 }));

    const [identifier, statistics, options] = mockQueryStatistics.mock.calls[0];
    expect(identifier).toBe("HKQuantityTypeIdentifierStepCount");
    expect(statistics).toEqual(["cumulativeSum"]);
    expect(options.unit).toBe("count");
    // A sample that started before midnight must not be counted in full toward today.
    expect(options.filter.date.strictStartDate).toBe(true);
    expect(options.filter.date.startDate.getHours()).toBe(0);
    expect(options.filter.date.startDate.getMinutes()).toBe(0);
  });

  // A statistics response with no sumQuantity is HealthKit saying "nothing in this
  // window" — which is exactly as ambiguous as an empty sample array was, so the
  // week probe still decides between a real 0 and an unknown.
  it("never turns an absent statistics sum into a confident zero", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithoutSum());
    mockQueryQuantitySamples.mockResolvedValue([]); // probe: nothing all week either
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.status).toBe("authorized"));
    expect(result.current.steps).toBeNull();
    expect(result.current.steps).not.toEqual({ today: 0, goal: 10000 });
  });

  // A sum that IS present and zero is a different fact from an absent one: HealthKit
  // measured the window and found nothing. That is a real 0, not an unknown.
  it("reports a present zero sum as a real zero", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithSum(0));
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toEqual({ today: 0, goal: 10000 }));
    expect(mockQueryQuantitySamples).not.toHaveBeenCalled();
  });

  // 7am on a real device with access granted: no steps yet today, but the week
  // has data. This is a REAL zero and must render as 0 — showing the connect
  // prompt here would nag every user every morning.
  it("reports zero for an empty day when the week has data", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithoutSum()); // today
    mockQueryQuantitySamples.mockResolvedValue([{ quantity: 3500 }]); // last 7 days
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toEqual({ today: 0, goal: 10000 }));
  });

  // A whole week with nothing is the honest signal that reads are not working.
  it("reports unknown steps when the whole week is empty", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithoutSum()); // today
    mockQueryQuantitySamples.mockResolvedValue([]); // last 7 days
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toBeNull());
  });

  // The probe is a fallback, not the primary path: a day WITH data must not
  // trigger the raw-sample probe at all.
  it("does not probe the week when today already has data", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithSum(1200));
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toEqual({ today: 1200, goal: 10000 }));
    expect(mockQueryStatistics).toHaveBeenCalledTimes(1);
    expect(mockQueryQuantitySamples).not.toHaveBeenCalled();
  });

  // The old connect() only opened Health when status === "denied", a state that
  // cannot occur — so a user who denied had no route back.
  it("connect always opens Health settings", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryQuantitySamples.mockResolvedValue([]);
    mockQueryCategorySamples.mockResolvedValue([]);
    const openURLSpy = jest.spyOn(Linking, "openURL").mockResolvedValue(true as unknown as void);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toBeNull());
    result.current.connect();
    await waitFor(() => expect(openURLSpy).toHaveBeenCalledWith("x-apple-health://"));
    openURLSpy.mockRestore();
  });

  // BUG 1: the reported symptom. Expo Router keeps Home mounted, so a load that
  // fires once per mount freezes whatever HealthKit said at app launch — a user
  // who opened Kora at ~1,000 steps and then walked all day kept seeing 1,000.
  it("re-reads on return to the foreground", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithSum(1000));
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toEqual({ today: 1000, goal: 10000 }));

    mockQueryStatistics.mockResolvedValue(statsWithSum(8400));
    await foreground();

    await waitFor(() => expect(result.current.steps).toEqual({ today: 8400, goal: 10000 }));
  });

  it("does not re-read for non-active app states", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithSum(1000));
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toEqual({ today: 1000, goal: 10000 }));
    const callsBefore = mockQueryStatistics.mock.calls.length;

    await act(async () => {
      appStateHandlers.forEach((h) => h("background"));
      appStateHandlers.forEach((h) => h("inactive"));
    });

    expect(mockQueryStatistics.mock.calls.length).toBe(callsBefore);
  });

  it("re-reads when the screen regains focus", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithSum(1000));
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toEqual({ today: 1000, goal: 10000 }));
    expect(mockFocusCallbacks.length).toBeGreaterThan(0);

    mockQueryStatistics.mockResolvedValue(statsWithSum(2600));
    await focus();

    await waitFor(() => expect(result.current.steps).toEqual({ today: 2600, goal: 10000 }));
  });

  it("exposes refresh() so a pull-to-refresh can re-read on demand", async () => {
    mockIsAvailable.mockReturnValue(true);
    mockRequestAuthorization.mockResolvedValue(true);
    mockQueryStatistics.mockResolvedValue(statsWithSum(1000));
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(result.current.steps).toEqual({ today: 1000, goal: 10000 }));

    mockQueryStatistics.mockResolvedValue(statsWithSum(4321));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.steps).toEqual({ today: 4321, goal: 10000 });
  });

  // Foreground and focus land within milliseconds of each other on a real tab
  // switch. Two loads racing could interleave their setState calls and apply the
  // older answer last, so the second one must be dropped, not queued.
  it("does not start a second load while one is still in flight", async () => {
    mockIsAvailable.mockReturnValue(true);
    let release: (granted: boolean) => void = () => {};
    mockRequestAuthorization.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    mockQueryStatistics.mockResolvedValue(statsWithSum(1200));
    mockQueryCategorySamples.mockResolvedValue([]);

    const { result } = await renderHook(() => useHealth());
    await waitFor(() => expect(mockRequestAuthorization).toHaveBeenCalledTimes(1));

    await foreground();
    await focus();
    expect(mockRequestAuthorization).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(true);
    });
    await waitFor(() => expect(result.current.steps).toEqual({ today: 1200, goal: 10000 }));
  });
});
