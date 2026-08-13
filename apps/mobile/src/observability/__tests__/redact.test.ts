import { templateRoute, buildAttributes } from "../redact";

describe("templateRoute", () => {
  test("replaces a uuid segment with :id", () => {
    expect(templateRoute("/v1/logs/6f1b11bc-1234-4abc-89ef-0123456789ab")).toBe("/v1/logs/:id");
  });

  test("replaces a numeric segment with :id", () => {
    expect(templateRoute("/v1/foods/12345")).toBe("/v1/foods/:id");
  });

  test("leaves a parameterless path unchanged", () => {
    expect(templateRoute("/v1/dashboard")).toBe("/v1/dashboard");
  });

  test("strips the query string, which can carry user input", () => {
    expect(templateRoute("/v1/search?q=chicken%20curry")).toBe("/v1/search");
  });

  test("templates every parameter segment, not just the first", () => {
    expect(templateRoute("/v1/groups/6f1b11bc-1234-4abc-89ef-0123456789ab/members/42")).toBe(
      "/v1/groups/:id/members/:id",
    );
  });
});

describe("buildAttributes", () => {
  // The message here is what a leak would look like: it is the ONLY place a
  // meal description could enter a payload, so every assertion below is
  // really asking "did this string escape?".
  class FakeApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly requestId?: string,
    ) {
      super("chicken curry with rice, 320g");
      this.name = "ApiError";
    }
  }

  test("carries class, status, route and request id", () => {
    const attrs = buildAttributes(new FakeApiError(500, "req-abc-123"), "/v1/logs/:id");
    expect(attrs.error_class).toBe("ApiError");
    expect(attrs.status).toBe("500");
    expect(attrs.route).toBe("/v1/logs/:id");
    expect(attrs.request_id).toBe("req-abc-123");
  });

  test("NEVER includes the error message or a body", () => {
    const attrs = buildAttributes(new FakeApiError(500, "req-abc-123"), "/v1/logs/:id");
    const serialised = JSON.stringify(attrs);
    expect(serialised).not.toContain("chicken curry");
    expect(attrs).not.toHaveProperty("message");
    expect(attrs).not.toHaveProperty("body");
  });

  test("every value is a string — Crashlytics attributes are string-only", () => {
    const attrs = buildAttributes(new FakeApiError(503, "req-1"), "/v1/dashboard");
    for (const value of Object.values(attrs)) {
      expect(typeof value).toBe("string");
    }
  });

  test("omits status and request_id for a non-ApiError", () => {
    const attrs = buildAttributes(Object.assign(new Error("x"), { name: "NetworkError" }), "/v1/me");
    expect(attrs.error_class).toBe("NetworkError");
    expect(attrs.route).toBe("/v1/me");
    expect(attrs).not.toHaveProperty("status");
    expect(attrs).not.toHaveProperty("request_id");
  });

  test("falls back to a stable class name for a non-Error throwable", () => {
    expect(buildAttributes("just a string").error_class).toBe("UnknownError");
  });
});
