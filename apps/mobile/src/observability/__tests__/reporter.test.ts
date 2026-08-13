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

test("never hands the server's message to the sink on the Error object itself", () => {
  // Crashlytics transmits error.message as the non-fatal's reason — it is not
  // attributes-only. For an ApiError that message is body.message straight
  // from the server, which can echo user input, so reportError must
  // synthesize its own Error rather than forward the original.
  const { sink, recorded } = fakeSink();
  initReporting(sink);

  reportError(apiError(500, "req-42"), { route: "/v1/me" });

  expect(recorded[0].error.message).not.toContain("chicken curry");
  expect(recorded[0].error.message).toBe("ApiError 500");
});

test("preserves the original stack when synthesizing an ApiError's report", () => {
  const { sink, recorded } = fakeSink();
  initReporting(sink);

  const original = apiError(500);
  reportError(original, { route: "/v1/me" });

  expect(recorded[0].error.stack).toBe(original.stack);
});

test("forwards our own static messages unchanged for non-ApiError failures", () => {
  // NetworkError/TimeoutError/ResponseParseError messages are our literals,
  // never server- or user-derived, and they aid triage.
  const { sink, recorded } = fakeSink();
  initReporting(sink);

  reportError(Object.assign(new Error("network request failed"), { name: "NetworkError" }), {
    route: "/v1/me",
  });

  expect(recorded[0].error.message).toBe("network request failed");
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

test("a value with a throwing property getter never propagates out of reportError", () => {
  // isReportable() does defensive reads of `name`/`status`. Those reads must
  // be inside the same guard as everything else, or a hostile/malformed
  // error defeats the "never throw into the caller" guarantee.
  const { sink, recorded } = fakeSink();
  initReporting(sink);

  const hostile: unknown = {
    get name(): string {
      throw new Error("boom");
    },
  };

  expect(() => reportError(hostile, { route: "/v1/me" })).not.toThrow();
  expect(recorded).toHaveLength(0);
});

test("a Proxy that throws on every property access never propagates out of reportError", () => {
  const { sink, recorded } = fakeSink();
  initReporting(sink);

  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("boom");
      },
    },
  );

  expect(() => reportError(hostile, { route: "/v1/me" })).not.toThrow();
  expect(recorded).toHaveLength(0);
});
