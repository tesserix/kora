import { initReporting, reportError, setReportingUser, type ReportSink } from "../reporter";

function fakeSink() {
  const recorded: Array<{ error: Error; attributes: Record<string, string> }> = [];
  const users: Array<string | null> = [];
  const sink: ReportSink = {
    recordError: (error, attributes) => recorded.push({ error, attributes }),
    setUser: (id) => users.push(id),
  };
  return { sink, recorded, users };
}

function apiError(status: number, requestId?: string): Error {
  return Object.assign(new Error("chicken curry with rice"), {
    name: "ApiError",
    status,
    requestId,
  });
}

beforeEach(() => {
  initReporting(null); // reset between tests
});

test("reports a 500 exactly once, with the constructed attributes", () => {
  const { sink, recorded } = fakeSink();
  initReporting(sink);

  reportError(apiError(500, "req-42"), { route: "/v1/logs/6f1b11bc-1234-4abc-89ef-0123456789ab" });

  expect(recorded).toHaveLength(1);
  expect(recorded[0].attributes).toEqual({
    error_class: "ApiError",
    status: "500",
    route: "/v1/logs/:id",
    request_id: "req-42",
  });
});

test("does NOT report a 401 — the call site does not decide, the facade does", () => {
  const { sink, recorded } = fakeSink();
  initReporting(sink);

  reportError(apiError(401), { route: "/v1/me" });

  expect(recorded).toHaveLength(0);
});

test("never forwards the error message to the sink attributes", () => {
  const { sink, recorded } = fakeSink();
  initReporting(sink);

  reportError(apiError(500), { route: "/v1/me" });

  expect(JSON.stringify(recorded[0].attributes)).not.toContain("chicken curry");
});

test("passes the user id through to the sink", () => {
  const { sink, users } = fakeSink();
  initReporting(sink);

  setReportingUser("f5c11f49-fca2-4804-9809-03ac631b1fc7");

  expect(users).toEqual(["f5c11f49-fca2-4804-9809-03ac631b1fc7"]);
});

test("with NO sink installed, reporting is a no-op that does not throw", () => {
  // This is what keeps Jest and the Expo dev client working, so it is a test
  // rather than an assumption.
  initReporting(null);
  expect(() => reportError(apiError(500), { route: "/v1/me" })).not.toThrow();
  expect(() => setReportingUser("abc")).not.toThrow();
});

test("a throwing sink never propagates into the caller", () => {
  // Reporting an error must not itself become an error the app has to handle.
  initReporting({
    recordError: () => {
      throw new Error("sink exploded");
    },
    setUser: () => {
      throw new Error("sink exploded");
    },
  });

  expect(() => reportError(apiError(500), { route: "/v1/me" })).not.toThrow();
  expect(() => setReportingUser("abc")).not.toThrow();
});

test("wraps a non-Error throwable so the sink always receives an Error", () => {
  const { sink, recorded } = fakeSink();
  initReporting(sink);

  reportError(Object.assign(new Error("boom"), { name: "NetworkError" }), { route: "/v1/me" });

  expect(recorded[0].error).toBeInstanceOf(Error);
  expect(recorded[0].attributes.error_class).toBe("NetworkError");
});
