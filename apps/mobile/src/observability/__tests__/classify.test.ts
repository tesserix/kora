import { isReportable } from "../classify";

// Built by hand rather than imported from api.ts on purpose: this mirrors how
// a jest module mock or a test fixture produces an error whose class identity
// does not match, which is exactly the case isReportable must survive.
function named(name: string, extra: Record<string, unknown> = {}): unknown {
  return Object.assign(new Error("should never be read"), { name }, extra);
}

describe("isReportable", () => {
  test.each([500, 502, 503, 504])("reports a %i — the server broke", (status) => {
    expect(isReportable(named("ApiError", { status }))).toBe(true);
  });

  test.each([400, 401, 403, 404, 409, 422, 429])(
    "does NOT report a %i — the app is behaving correctly",
    (status) => {
      expect(isReportable(named("ApiError", { status }))).toBe(false);
    },
  );

  test.each(["NetworkError", "TimeoutError", "ResponseParseError", "AuthTokenError"])(
    "reports %s",
    (name) => {
      expect(isReportable(named(name))).toBe(true);
    },
  );

  // #136: capture's Cancel genuinely aborts the in-flight resolve, and every
  // abort used to reach Crashlytics as a NetworkError — a user-initiated
  // outcome misattributed as a client network fault, once per Cancel and once
  // per unmount-while-resolving. NetworkError is asserted alongside it so this
  // can never pass by disabling reporting wholesale.
  test("does NOT report a CancelledError — a user cancelling is not a fault", () => {
    expect(isReportable(named("CancelledError"))).toBe(false);
    expect(isReportable(named("NetworkError"))).toBe(true);
  });

  test("reports an unrecognised Error — an unknown fault is still a fault", () => {
    expect(isReportable(new Error("something unexpected"))).toBe(true);
  });

  test("does not report null or undefined", () => {
    expect(isReportable(null)).toBe(false);
    expect(isReportable(undefined)).toBe(false);
  });
});
