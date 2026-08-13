import { createCrashlyticsSink } from "../crashlytics";

// jest.setup.js registers a virtual mock of @react-native-firebase/crashlytics
// (the native package is not installed yet), so the sink is testable today.
interface NativeCrashlyticsMock {
  getCrashlytics: jest.Mock;
  recordError: jest.Mock;
  setUserId: jest.Mock;
  setAttributes: jest.Mock;
}

const native = jest.requireMock<NativeCrashlyticsMock>("@react-native-firebase/crashlytics");

beforeEach(() => {
  native.getCrashlytics.mockClear();
  native.recordError.mockClear();
  native.setUserId.mockClear();
  native.setAttributes.mockClear();
});

test("recordError sets attributes on the instance BEFORE recording", () => {
  const sink = createCrashlyticsSink();
  expect(sink).not.toBeNull();

  const instance = native.getCrashlytics.mock.results[0].value;
  const error = new Error("ApiError 500");
  sink?.recordError(error, { error_class: "ApiError", status: "500" });

  // Argument order matters as much as call order: a swapped (error, instance)
  // would otherwise only surface on a TestFlight build.
  expect(native.setAttributes).toHaveBeenCalledWith(instance, {
    error_class: "ApiError",
    status: "500",
  });
  expect(native.recordError).toHaveBeenCalledWith(instance, error);
  expect(native.setAttributes.mock.invocationCallOrder[0]).toBeLessThan(
    native.recordError.mock.invocationCallOrder[0],
  );
});

test("setUser(null) dissociates with the empty string", () => {
  const sink = createCrashlyticsSink();
  const instance = native.getCrashlytics.mock.results[0].value;

  sink?.setUser(null);

  expect(native.setUserId).toHaveBeenCalledWith(instance, "");
});

test("setUser(id) passes the id through unchanged", () => {
  const sink = createCrashlyticsSink();
  const instance = native.getCrashlytics.mock.results[0].value;

  sink?.setUser("abc");

  expect(native.setUserId).toHaveBeenCalledWith(instance, "abc");
});

test("a rejecting native call produces no unhandled rejection", async () => {
  // reportError's try/catch only guards synchronous throws. An unhandled
  // rejection here is routed back into reportError by app/_layout.tsx's
  // rejection tracking, which would call this sink again — a report loop.
  const unhandled = jest.fn();
  process.on("unhandledRejection", unhandled);

  try {
    native.setAttributes.mockImplementationOnce(() => Promise.reject(new Error("native boom")));
    native.recordError.mockImplementationOnce(() => Promise.reject(new Error("native boom")));
    native.setUserId.mockImplementationOnce(() => Promise.reject(new Error("native boom")));

    const sink = createCrashlyticsSink();
    expect(() => sink?.recordError(new Error("boom"), { error_class: "Error" })).not.toThrow();
    expect(() => sink?.setUser("abc")).not.toThrow();

    // Let the microtask queue drain and the turn end — Node reports unhandled
    // rejections only after that.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off("unhandledRejection", unhandled);
  }
});
