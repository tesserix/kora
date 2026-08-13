# Crash & Error Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Kora fault visibility in the F&F beta — crashes, unhandled rejections, render errors and server/client API failures reported to Firebase Crashlytics, with no user content in the payloads.

**Architecture:** A thin facade in `src/observability/` with Crashlytics behind it. Two pure units (`classify`, `redact`) hold the rules and carry the test coverage; a sink module isolates the native SDK and no-ops when it is absent, which is what keeps Jest and the Expo dev client working. Call sites report unconditionally; the facade decides what is reportable and what is stripped.

**Tech Stack:** React Native / Expo SDK 57, TypeScript, `@react-native-firebase/app` + `@react-native-firebase/crashlytics` v26.2.0, Jest + `@testing-library/react-native`.

## Global Constraints

- **Expo v57.** Read https://docs.expo.dev/versions/v57.0.0/ before using any Expo API. Do not rely on remembered APIs.
- **Both suites must stay green:** `cd apps/mobile && npx tsc --noEmit` and `cd apps/mobile && npx jest --ci --forceExit`. **Baseline: 165 suites / 1348 tests.** Report counts after each task.
- **No `console.log`** in `app/` or `src/`. A deliberately swallowed best-effort failure is a commented empty `catch` (convention: `src/lib/push.ts:46-50`).
- **No user content in any payload.** No meal descriptions, no photos, no voice transcripts, no free text, no response bodies. This is an acceptance criterion, not a preference.
- **Explicit types on exported functions.** Props get a named `type`/`interface`. No `any` — use `unknown` and narrow.
- **Immutability.** Never mutate existing objects; construct new ones.
- **Commit messages:** single-line, conventional-commit prefix, **no signature, no body**.
- **Tests: `fireEvent` MUST be awaited.** Under `@testing-library/react-native` 14.0.1 + React 19.2.3, an un-awaited `fireEvent` does not flush state and gate assertions silently pass against a broken implementation. Write `await fireEvent.press(...)`. See `app/__tests__/sign-in.test.tsx:69-121`.
- **Spec of record:** `docs/superpowers/specs/2026-08-13-kora-crash-reporting-design.md`.

## Context an implementer needs

**Error taxonomy already exists** in `src/lib/api.ts` — do not create new error types:

| Class | Line | Meaning |
|---|---|---|
| `ApiError` | 6 | Non-2xx. Carries `status`, `code`, `message`, **`requestId`** |
| `AuthTokenError` | 31 | `getIdToken()` rejected — nothing ever reached the server |
| `NetworkError` | 40 | `fetch()` rejected — no HTTP response at all |
| `ResponseParseError` | 62 | 2xx whose body would not parse |
| `TimeoutError` | 72 | Client deadline passed |

**Match on `name`, not only `instanceof`.** The repo already learned this: `isNetworkError` (`src/lib/api.ts:56-58`) checks `instanceof` **and** `err.name`, because class identity does not survive Jest module mocks or hand-built fixtures, and a caller recognising only the class silently takes the wrong branch. Your `classify` must be equally defensive.

**`ApiError.requestId`** is the server's `X-Request-Id` (set in `throwApiError`, `src/lib/api.ts:295-299`). The Go API logs `request_id` on every line, so this field joins a client report to the exact server log entry. It is the highest-value attribute in this feature.

**The complete insertion surface is two functions.** All five error types surface through `apiFetchEnvelope` (`src/lib/api.ts:316`) and `apiFetchMultipart` (`src/lib/api.ts:361`). `apiFetch` delegates to `apiFetchEnvelope`, so wrapping those two covers every caller.

**Native module reality:** `@react-native-firebase/crashlytics` cannot load in Jest or in the Expo dev client. Everything except Task 6 must work without it — that is why the sink no-ops.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/observability/redact.ts` | Create | Pure: template route paths, build the attribute map |
| `src/observability/__tests__/redact.test.ts` | Create | Templating + no-user-content proof |
| `src/observability/classify.ts` | Create | Pure: is this error reportable? |
| `src/observability/__tests__/classify.test.ts` | Create | The reportable table |
| `src/observability/reporter.ts` | Create | Facade + `ReportSink` interface |
| `src/observability/crashlytics.ts` | Create | Crashlytics sink; returns null when native module absent |
| `src/observability/__tests__/reporter.test.ts` | Create | Facade behaviour against a fake sink |
| `src/components/ErrorBoundary.tsx` | Create | Catch render errors, report, render fallback |
| `src/components/__tests__/ErrorBoundary.test.tsx` | Create | Fallback renders + reporter called + reset |
| `app/_layout.tsx` | Modify | Init, global handlers, wrap tree |
| `src/lib/api.ts` | Modify (`apiFetchEnvelope` ~316, `apiFetchMultipart` ~361) | Report every failure |
| `src/lib/__tests__/api-reporting.test.ts` | Create | 500 reports, 401 does not |
| `jest.setup.js` | Modify | Mock the native Crashlytics module |
| `app.json` | Modify | Plugins + `ios.googleServicesFile` |
| `firebase.json` | Modify | Add `react-native` keys **alongside** existing `auth` config |
| `docs/runbooks/kora-symbolicate-js-stack.md` | Create | The minified-stack runbook |

---

## Task 1: `redact.ts` — route templating and attribute building

**Files:**
- Create: `apps/mobile/src/observability/redact.ts`
- Test: `apps/mobile/src/observability/__tests__/redact.test.ts`

**Interfaces:**
- Consumes: nothing. Pure module, no imports from `api.ts` or any SDK.
- Produces:
  - `templateRoute(path: string): string`
  - `buildAttributes(error: unknown, route?: string): Record<string, string>`

Both are used by `reporter.ts` in Task 3.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/observability/__tests__/redact.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/observability/__tests__/redact.test.ts --ci --forceExit`
Expected: FAIL — cannot resolve module `../redact`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/src/observability/redact.ts`:

```ts
// Redaction for crash reports. Every value that leaves the device passes
// through here, which is the whole point: "no user content in payloads" is an
// acceptance criterion of #104, and enforcing it at N call sites is how a meal
// description eventually leaks.
//
// Pure by design — no imports from api.ts or any SDK — so the rules are
// testable without a native module.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d+$/;

/**
 * Collapses identifying path segments to `:id`.
 *
 * Two reasons, both load-bearing. A raw id leaks an identifier into a third
 * party. It also shatters grouping — a thousand distinct issues with a count
 * of one each, instead of one issue with a count of a thousand.
 *
 * The query string is dropped entirely: it can carry a search term the user
 * typed.
 */
export function templateRoute(path: string): string {
  const [withoutQuery] = path.split("?");
  return withoutQuery
    .split("/")
    .map((segment) => (UUID.test(segment) || DIGITS.test(segment) ? ":id" : segment))
    .join("/");
}

// Duck-typed rather than `instanceof ApiError`: importing api.ts here would
// drag firebase/auth into this module and its tests purely to read two
// fields. Same reasoning as src/lib/apiErrorMessage.ts:12-24.
function isApiErrorShape(e: unknown): e is { status: number; requestId?: string } {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "ApiError" &&
    typeof (e as { status?: unknown }).status === "number"
  );
}

function errorClass(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.length > 0 ? name : "UnknownError";
}

/**
 * Builds the Crashlytics attribute map for an error.
 *
 * Constructed from `(class, status, route, requestId)` ONLY. The error's
 * `message` and the response body are deliberately not sources: the server can
 * echo user input, so forwarding either would defeat the redaction this module
 * exists to guarantee.
 *
 * All values are strings because Crashlytics attributes are string-only.
 */
export function buildAttributes(error: unknown, route?: string): Record<string, string> {
  const attrs: Record<string, string> = { error_class: errorClass(error) };

  if (route) attrs.route = templateRoute(route);

  if (isApiErrorShape(error)) {
    attrs.status = String(error.status);
    if (error.requestId) attrs.request_id = error.requestId;
  }

  return attrs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest src/observability/__tests__/redact.test.ts --ci --forceExit`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/observability/redact.ts apps/mobile/src/observability/__tests__/redact.test.ts
git commit -m "feat(mobile): route templating and attribute redaction for crash reports"
```

---

## Task 2: `classify.ts` — what is worth reporting

**Files:**
- Create: `apps/mobile/src/observability/classify.ts`
- Test: `apps/mobile/src/observability/__tests__/classify.test.ts`

**Interfaces:**
- Consumes: nothing. Pure module.
- Produces: `isReportable(error: unknown): boolean` — used by `reporter.ts` in Task 3.

The rule, from the spec: report 5xx and the typed client faults; do **not** report 4xx. A 401 from an expired session is the app working correctly, and reporting it lets one expired session storm the dashboard and bury the signal.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/observability/__tests__/classify.test.ts`:

```ts
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

  test("reports an unrecognised Error — an unknown fault is still a fault", () => {
    expect(isReportable(new Error("something unexpected"))).toBe(true);
  });

  test("does not report null or undefined", () => {
    expect(isReportable(null)).toBe(false);
    expect(isReportable(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/observability/__tests__/classify.test.ts --ci --forceExit`
Expected: FAIL — cannot resolve module `../classify`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/src/observability/classify.ts`:

```ts
// Decides whether an error is worth a crash report.
//
// Matched on `name` rather than `instanceof`: class identity does not survive
// jest module mocks or hand-built fixtures, and a check that recognises only
// the class silently takes the wrong branch on those. src/lib/api.ts:56-58
// already learned this the hard way for NetworkError.

// Client-side faults that always indicate something is wrong.
const REPORTABLE_NAMES = new Set([
  "NetworkError",
  "TimeoutError",
  "ResponseParseError",
  "AuthTokenError",
]);

function isApiErrorShape(e: unknown): e is { status: number } {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "ApiError" &&
    typeof (e as { status?: unknown }).status === "number"
  );
}

/**
 * True when this failure should reach Crashlytics.
 *
 * 4xx is deliberately excluded. An expired session (401), a permission check
 * (403), a missing row (404) and a validation refusal (422) are the app
 * working as designed. Reporting them would let a single expired session storm
 * the dashboard and bury the signal #104 exists to surface.
 */
export function isReportable(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  if (isApiErrorShape(error)) return error.status >= 500;

  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && REPORTABLE_NAMES.has(name)) return true;

  // An error we do not recognise is still a fault — the unknown case is
  // exactly what this feature exists to surface.
  return error instanceof Error;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest src/observability/__tests__/classify.test.ts --ci --forceExit`
Expected: PASS, 17 tests.

- [ ] **Step 5: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/observability/classify.ts apps/mobile/src/observability/__tests__/classify.test.ts
git commit -m "feat(mobile): classify which errors are worth reporting"
```

---

## Task 3: The facade and the Crashlytics sink

**Files:**
- Create: `apps/mobile/src/observability/reporter.ts`
- Create: `apps/mobile/src/observability/crashlytics.ts`
- Create: `apps/mobile/src/observability/__tests__/reporter.test.ts`
- Modify: `apps/mobile/jest.setup.js` (append a mock)

**Interfaces:**
- Consumes: `isReportable` (Task 2), `buildAttributes` (Task 1).
- Produces, used by Tasks 4 and 5:
  - `export interface ReportSink { recordError(error: Error, attributes: Record<string, string>): void; setUser(id: string | null): void; }`
  - `initReporting(sink: ReportSink | null): void` — the argument is required; pass `null` to disable
  - `setReportingUser(id: string | null): void`
  - `reportError(error: unknown, context?: { route?: string }): void`

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/observability/__tests__/reporter.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/observability/__tests__/reporter.test.ts --ci --forceExit`
Expected: FAIL — cannot resolve module `../reporter`.

- [ ] **Step 3: Write the facade**

Create `apps/mobile/src/observability/reporter.ts`:

```ts
import { isReportable } from "./classify";
import { buildAttributes } from "./redact";

export interface ReportSink {
  recordError(error: Error, attributes: Record<string, string>): void;
  setUser(id: string | null): void;
}

export interface ReportContext {
  route?: string;
}

// Module-level because reporting is process-wide, like the auth session it
// shadows. Null means "no sink installed", which is the normal state in Jest
// and in the Expo dev client — the native Crashlytics module cannot load in
// either.
let sink: ReportSink | null = null;

/** Installs the sink. Pass null to disable (tests, dev client). */
export function initReporting(installed: ReportSink | null): void {
  sink = installed;
}

/**
 * Associates subsequent reports with a Kora user.
 *
 * The UUID only — never email or display name. It answers "did one user hit
 * this forty times, or forty users once?", which is usually the first question
 * a beta crash raises, without putting a human-readable identifier into a
 * third-party processor.
 */
export function setReportingUser(id: string | null): void {
  if (!sink) return;
  try {
    sink.setUser(id);
  } catch {
    // Deliberately swallowed — see src/lib/push.ts for this convention.
    // Failing to report must never become a failure the app has to handle.
  }
}

/**
 * Reports a failure, if it is worth reporting.
 *
 * Call sites report EVERY failure and never consult `isReportable` themselves.
 * Filtering lives here for the same reason redaction does: one enforcement
 * point. A call site that decides for itself is a call site that can get it
 * wrong, and "why did this failure never appear?" is the hardest kind of gap
 * to notice.
 */
export function reportError(error: unknown, context: ReportContext = {}): void {
  if (!sink) return;
  if (!isReportable(error)) return;

  try {
    const attributes = buildAttributes(error, context.route);
    // The sink contract needs an Error for its stack. Anything else is
    // wrapped, preserving only the class name — never the original message,
    // which could carry user input.
    const reportable =
      error instanceof Error ? error : new Error(attributes.error_class);
    sink.recordError(reportable, attributes);
  } catch {
    // Deliberately swallowed — see above.
  }
}
```

- [ ] **Step 4: Write the Crashlytics sink**

Create `apps/mobile/src/observability/crashlytics.ts`:

```ts
import type { ReportSink } from "./reporter";

/**
 * Builds the Crashlytics-backed sink, or null when the native module is not
 * present.
 *
 * `require` rather than a static import, inside try/catch: the native module
 * is absent in Jest and in the Expo dev client, and a static import would make
 * merely loading this file throw there. Returning null is what lets the rest
 * of the app behave identically with and without Crashlytics.
 *
 * Modular API per @react-native-firebase/crashlytics v26 — the namespaced
 * `crashlytics().recordError()` form is deprecated.
 */
export function createCrashlyticsSink(): ReportSink | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@react-native-firebase/crashlytics") as {
      getCrashlytics: () => unknown;
      recordError: (c: unknown, e: Error) => void;
      setUserId: (c: unknown, id: string) => void;
      setAttributes: (c: unknown, a: Record<string, string>) => void;
    };
    if (typeof mod?.getCrashlytics !== "function") return null;

    const instance = mod.getCrashlytics();

    return {
      recordError(error, attributes) {
        // Attributes first: they must be attached to the instance before the
        // record call that snapshots them.
        mod.setAttributes(instance, attributes);
        mod.recordError(instance, error);
      },
      setUser(id) {
        // Crashlytics has no "clear user" call; empty string is its documented
        // way of dissociating, and is what a sign-out should leave behind.
        mod.setUserId(instance, id ?? "");
      },
    };
  } catch {
    // Deliberately swallowed — absence of the native module is an expected
    // state (Jest, Expo dev client), not an error worth surfacing.
    return null;
  }
}
```

- [ ] **Step 5: Add the Jest mock**

Append to `apps/mobile/jest.setup.js`, following the existing mock style in that file:

```js
// The native Crashlytics module cannot load under Jest. createCrashlyticsSink
// already returns null when the require fails, but mocking it explicitly keeps
// the failure path deliberate rather than incidental.
jest.mock("@react-native-firebase/crashlytics", () => ({
  getCrashlytics: jest.fn(() => ({})),
  recordError: jest.fn(),
  setUserId: jest.fn(),
  setAttributes: jest.fn(),
  log: jest.fn(),
}));
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/mobile && npx jest src/observability --ci --forceExit`
Expected: PASS — Task 1, 2 and 3 suites all green (10 + 17 + 7 tests).

- [ ] **Step 7: Typecheck and full suite**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Expected: no type errors; suite green. Report the counts.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/src/observability/reporter.ts apps/mobile/src/observability/crashlytics.ts apps/mobile/src/observability/__tests__/reporter.test.ts apps/mobile/jest.setup.js
git commit -m "feat(mobile): error reporting facade with a crashlytics sink"
```

---

## Task 4: `ErrorBoundary` with a user-facing fallback

**Files:**
- Create: `apps/mobile/src/components/ErrorBoundary.tsx`
- Test: `apps/mobile/src/components/__tests__/ErrorBoundary.test.tsx`

**Interfaces:**
- Consumes: `reportError` from `@/observability/reporter` (Task 3).
- Produces: `export function ErrorBoundary({ children }: { children: ReactNode })` — used by `app/_layout.tsx` in Task 5.

There is no ErrorBoundary anywhere in the app today, so a render error currently shows a blank screen and the session is over.

**Note on structure:** `useTheme` is a hook and cannot be called in a class component, but only a class can implement `componentDidCatch`. So the boundary is a class that renders a separate function component for the fallback.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/components/__tests__/ErrorBoundary.test.tsx`:

```tsx
import { Text } from "react-native";
import { render, fireEvent } from "@testing-library/react-native";

const mockReportError = jest.fn();
jest.mock("@/observability/reporter", () => ({
  reportError: (...a: unknown[]) => mockReportError(...a),
}));

import { ErrorBoundary } from "../ErrorBoundary";

function Boom(): never {
  throw new Error("render exploded");
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockReportError.mockClear();
  // React logs caught render errors; silencing keeps the suite output honest
  // about real failures.
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

test("renders children when nothing throws", async () => {
  const { getByText } = await render(
    <ErrorBoundary>
      <Text>all good</Text>
    </ErrorBoundary>,
  );
  expect(getByText("all good")).toBeTruthy();
});

test("renders the fallback and reports when a child throws", async () => {
  const { getByText } = await render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );

  expect(getByText("Something went wrong.")).toBeTruthy();
  expect(mockReportError).toHaveBeenCalledTimes(1);
  const [reported] = mockReportError.mock.calls[0];
  expect((reported as Error).message).toBe("render exploded");
});

test("the reset action clears the error state", async () => {
  const { getByText, queryByText } = await render(
    <ErrorBoundary>
      <Boom />
    </ErrorBoundary>,
  );

  expect(getByText("Something went wrong.")).toBeTruthy();
  await fireEvent.press(getByText("Try again"));

  // The child throws again on re-render, so the fallback is expected to
  // return. What this proves is that the reset path runs and re-renders —
  // asserted via a SECOND report, which a no-op reset could not produce.
  expect(mockReportError).toHaveBeenCalledTimes(2);
  expect(queryByText("Something went wrong.")).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/components/__tests__/ErrorBoundary.test.tsx --ci --forceExit`
Expected: FAIL — cannot resolve module `../ErrorBoundary`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/mobile/src/components/ErrorBoundary.tsx`:

```tsx
import { Component, type ErrorInfo, type ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "@/components/Text";
import { GlassPanel } from "@/components/instrument/GlassPanel";
import { PressableScale } from "@/motion";
import { reportError } from "@/observability/reporter";
import { useTheme } from "@/theme";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

// Split out because useTheme is a hook and cannot be called in the class that
// owns componentDidCatch.
function ErrorFallback({ onReset }: { onReset: () => void }) {
  const { instrument, spacing } = useTheme();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: instrument.bg,
        alignItems: "center",
        justifyContent: "center",
        padding: spacing.lg,
      }}
    >
      <GlassPanel radius={22} style={{ padding: spacing.lg, gap: spacing.sm, alignItems: "center" }}>
        <AppText style={{ fontSize: 17, fontWeight: "600", color: instrument.ink }}>
          Something went wrong.
        </AppText>
        <AppText style={{ fontSize: 14, color: instrument.mut, textAlign: "center" }}>
          Kora hit an unexpected problem. Your logged meals are safe.
        </AppText>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Try again"
          haptic="none"
          onPress={onReset}
          style={{
            marginTop: spacing.sm,
            minHeight: 44,
            paddingHorizontal: spacing.lg,
            borderRadius: 14,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: instrument.inset,
          }}
        >
          <AppText style={{ fontSize: 15, fontWeight: "600", color: instrument.ink }}>
            Try again
          </AppText>
        </PressableScale>
      </GlassPanel>
    </View>
  );
}

/**
 * Catches render errors, reports them, and shows a recoverable screen.
 *
 * Without this a render error leaves a blank screen and ends the session —
 * for a beta tester, indistinguishable from the app being dead.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is React's own string and can name user-authored
    // content in props, so it is deliberately NOT forwarded — only the error.
    void info;
    reportError(error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback onReset={() => this.setState({ hasError: false })} />;
    }
    return this.props.children;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest src/components/__tests__/ErrorBoundary.test.tsx --ci --forceExit`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/components/ErrorBoundary.tsx apps/mobile/src/components/__tests__/ErrorBoundary.test.tsx
git commit -m "feat(mobile): error boundary with a recoverable fallback screen"
```

---

## Task 5: Wire it up — global handlers, boundary, and API reporting

**Files:**
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/src/lib/api.ts` (`apiFetchEnvelope` ~line 316, `apiFetchMultipart` ~line 361)
- Test: `apps/mobile/src/lib/__tests__/api-reporting.test.ts` (create)

**Interfaces:**
- Consumes: `initReporting`, `reportError`, `setReportingUser` (Task 3); `ErrorBoundary` (Task 4); `createCrashlyticsSink` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `apps/mobile/src/lib/__tests__/api-reporting.test.ts`:

```ts
const mockReportError = jest.fn();
jest.mock("@/observability/reporter", () => ({
  reportError: (...a: unknown[]) => mockReportError(...a),
  initReporting: jest.fn(),
  setReportingUser: jest.fn(),
}));

jest.mock("../firebase", () => ({ auth: null, isFirebaseConfigured: false }));
jest.mock("firebase/auth", () => ({
  onAuthStateChanged: jest.fn(),
  signOut: jest.fn(),
}));

import { apiFetch } from "../api";

const realFetch = global.fetch;

beforeEach(() => {
  mockReportError.mockClear();
});

afterEach(() => {
  global.fetch = realFetch;
});

test("a 500 is reported once, with the route", async () => {
  global.fetch = jest.fn(async () =>
    new Response(JSON.stringify({ error: "internal", message: "boom" }), {
      status: 500,
      headers: { "Content-Type": "application/json", "X-Request-Id": "req-99" },
    }),
  ) as unknown as typeof fetch;

  await expect(apiFetch("/v1/dashboard")).rejects.toBeDefined();

  expect(mockReportError).toHaveBeenCalledTimes(1);
  const [error, context] = mockReportError.mock.calls[0];
  expect((error as { status?: number }).status).toBe(500);
  expect(context).toEqual({ route: "/v1/dashboard" });
});

test("a 401 reaches the reporter, which is what drops it — the call site does not decide", async () => {
  global.fetch = jest.fn(async () =>
    new Response(JSON.stringify({ error: "unauthorized", message: "nope" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;

  await expect(apiFetch("/v1/me")).rejects.toBeDefined();

  // api.ts reports unconditionally; isReportable (unit-tested in Task 2) is
  // what filters. Asserting the call happens here proves the wiring, and
  // proves the filtering is NOT duplicated at the call site.
  expect(mockReportError).toHaveBeenCalledTimes(1);
  const [error] = mockReportError.mock.calls[0];
  expect((error as { status?: number }).status).toBe(401);
});

test("a successful request reports nothing", async () => {
  global.fetch = jest.fn(async () =>
    new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;

  await apiFetch("/v1/dashboard");

  expect(mockReportError).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/mobile && npx jest src/lib/__tests__/api-reporting.test.ts --ci --forceExit`
Expected: FAIL — `mockReportError` receives 0 calls, because `api.ts` does not report yet.

- [ ] **Step 3: Add reporting to `api.ts`**

Add the import at the top of `apps/mobile/src/lib/api.ts`, with the other imports:

```ts
import { reportError } from "@/observability/reporter";
```

Then wrap the body of `apiFetchEnvelope`. Replace:

```ts
  const res = await fetchWithRetry(
    path,
    (token) => ({
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    }),
    init.signal,
  );

  if (isNoContent(res)) return { data: undefined as T };
  if (!res.ok) return throwApiError(res);
  return parseJson<{ data: T; meta?: Record<string, unknown> }>(res);
```

with:

```ts
  try {
    const res = await fetchWithRetry(
      path,
      (token) => ({
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init.headers ?? {}),
        },
      }),
      init.signal,
    );

    if (isNoContent(res)) return { data: undefined as T };
    if (!res.ok) return throwApiError(res);
    return parseJson<{ data: T; meta?: Record<string, unknown> }>(res);
  } catch (err) {
    // Report EVERY failure and rethrow unchanged. This call site deliberately
    // does not decide what is worth reporting — reportError applies
    // isReportable itself, so the rule lives in exactly one place.
    reportError(err, { route: path });
    throw err;
  }
```

Apply the identical treatment to `apiFetchMultipart`, wrapping from its `const res = await fetchWithRetry(` through its final `return body.data ?? body;` in the same `try { … } catch (err) { reportError(err, { route: path }); throw err; }`.

**Note:** if the `isNoContent` line is not present in your copy, this repo is behind commit `bdb1015`; report that rather than inventing it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/mobile && npx jest src/lib/__tests__/api-reporting.test.ts --ci --forceExit`
Expected: PASS, 3 tests.

- [ ] **Step 5: Wire the root layout**

In `apps/mobile/app/_layout.tsx`, add these imports:

```tsx
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { createCrashlyticsSink } from "@/observability/crashlytics";
import { initReporting, reportError } from "@/observability/reporter";
```

Add this beside the existing module-level `setupPushHandler();` call (line 17):

```tsx
// Module scope, like setupPushHandler above: reporting must be installed
// before any component renders, or the first crash is the one we miss.
initReporting(createCrashlyticsSink());

// React Native's global handler catches what escapes every try/catch and
// every boundary. `isFatal` is not forwarded — Crashlytics distinguishes
// fatal from non-fatal itself, and the attribute map is deliberately minimal.
// The previous handler is preserved and still called: replacing it outright
// would silence RedBox in development.
const previousHandler = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error, isFatal) => {
  reportError(error);
  previousHandler?.(error, isFatal);
});

// Unhandled promise rejections do NOT reach ErrorUtils. React Native tracks
// them through the `promise` polyfill's rejection-tracking module, which is
// the same mechanism Sentry's React Native SDK hooks. Without this, an async
// failure with no catch is invisible — which is precisely the #82 class of bug
// this feature exists to surface.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rejectionTracking = require("promise/setimmediate/rejection-tracking") as {
    enable: (opts: {
      allRejections: boolean;
      onUnhandled: (id: number, error: unknown) => void;
      onHandled: () => void;
    }) => void;
  };
  rejectionTracking.enable({
    allRejections: true,
    onUnhandled: (_id, error) => reportError(error),
    onHandled: () => {
      // Required by the API. A rejection handled late is not a fault.
    },
  });
} catch {
  // Deliberately swallowed — see src/lib/push.ts for this convention. If the
  // polyfill path changes in a future React Native, crash reporting must
  // degrade rather than prevent the app from starting.
}
```

**Verify the require path resolves** before trusting it:

```bash
cd apps/mobile && node -e "require.resolve('promise/setimmediate/rejection-tracking'); console.log('ok')"
```

If it does not resolve, **stop and report it** rather than substituting a different API — an invented rejection hook that silently never fires is worse than none, because it looks like coverage.

Then wrap the tree. Change the outermost return so `ErrorBoundary` sits directly inside `GestureHandlerRootView`:

```tsx
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
```

and close it after `</QueryClientProvider>`:

```tsx
        </QueryClientProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
```

It goes **inside** `GestureHandlerRootView` so the fallback still renders with gesture handling available, and **outside** the providers so a provider's own render error is caught rather than escaping.

- [ ] **Step 6: Bind the Kora user id to reports**

Without this, `setReportingUser` is exported and never called, and every report is anonymous.

**Use `Profile.id`, NOT `currentUserId()`.** `currentUserId()` (`src/lib/api.ts:291`) returns the **Firebase uid**; the spec specifies the **Kora UUID**, which is `Profile.id` from `useProfile()`. These are different identifiers and only the Kora one joins to the database.

Because `useProfile()` needs the query client, the binder must render *inside* `QueryClientProvider`.

Create `apps/mobile/src/observability/ReportingUserBinder.tsx`:

```tsx
import { useEffect } from "react";
import { useProfile } from "@/api/hooks";
import { setReportingUser } from "@/observability/reporter";

/**
 * Associates crash reports with the signed-in Kora user.
 *
 * Renders nothing. Lives inside QueryClientProvider because useProfile needs
 * the query client. Uses the Kora UUID (Profile.id), never the Firebase uid
 * and never email or display name — it answers "one user forty times or forty
 * users once?" without putting a human-readable identifier into a third party.
 */
export function ReportingUserBinder(): null {
  const { data } = useProfile();

  useEffect(() => {
    setReportingUser(data?.id ?? null);
  }, [data?.id]);

  return null;
}
```

Render it in `app/_layout.tsx` as the first child inside `QueryClientProvider`:

```tsx
        <QueryClientProvider client={queryClient}>
          <ReportingUserBinder />
```

with the import:

```tsx
import { ReportingUserBinder } from "@/observability/ReportingUserBinder";
```

Add `apps/mobile/src/observability/__tests__/ReportingUserBinder.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";

const mockSetReportingUser = jest.fn();
jest.mock("@/observability/reporter", () => ({
  setReportingUser: (...a: unknown[]) => mockSetReportingUser(...a),
}));

let mockProfile: { data?: { id: string } } = {};
jest.mock("@/api/hooks", () => ({ useProfile: () => mockProfile }));

import { ReportingUserBinder } from "../ReportingUserBinder";

beforeEach(() => {
  mockSetReportingUser.mockClear();
  mockProfile = {};
});

test("sets the Kora uuid once the profile loads", async () => {
  mockProfile = { data: { id: "f5c11f49-fca2-4804-9809-03ac631b1fc7" } };
  await render(<ReportingUserBinder />);
  expect(mockSetReportingUser).toHaveBeenCalledWith("f5c11f49-fca2-4804-9809-03ac631b1fc7");
});

test("clears the user when there is no profile", async () => {
  await render(<ReportingUserBinder />);
  expect(mockSetReportingUser).toHaveBeenCalledWith(null);
});
```

- [ ] **Step 7: Run the full suite**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Expected: no type errors; suite green. Report the counts. If `ErrorUtils` is flagged as an unknown global by TypeScript, import its type from `react-native` rather than declaring `any`.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/app/_layout.tsx apps/mobile/src/lib/api.ts apps/mobile/src/lib/__tests__/api-reporting.test.ts apps/mobile/src/observability/ReportingUserBinder.tsx apps/mobile/src/observability/__tests__/ReportingUserBinder.test.tsx
git commit -m "feat(mobile): wire crash reporting into the root layout and api client"
```

---

## Task 6: Native install, configuration, and the symbolication runbook

**Files:**
- Modify: `apps/mobile/package.json` (via `npx expo install`)
- Modify: `apps/mobile/app.json`
- Modify: `apps/mobile/firebase.json`
- Create: `docs/runbooks/kora-symbolicate-js-stack.md`
- Add: `apps/mobile/GoogleService-Info.plist` (**human step — see below**)

**Interfaces:**
- Consumes: `createCrashlyticsSink` (Task 3) — this task makes it return a real sink instead of null.
- Produces: nothing in code.

> **BLOCKED ON A HUMAN STEP.** `GoogleService-Info.plist` must be downloaded from the Firebase console for project **`kora-app-e6d38`**, iOS app **`com.tesserix.kora`**, and placed at `apps/mobile/GoogleService-Info.plist`. It cannot be generated. If it is not present, complete every other step, commit, and report the task as blocked on that file — do **not** invent a placeholder plist, which would produce a build that fails confusingly at runtime.

- [ ] **Step 1: Install the packages**

```bash
cd apps/mobile
npx expo install @react-native-firebase/app @react-native-firebase/crashlytics expo-build-properties
```

`expo-build-properties` is **required**, not optional: React Native 0.75+ needs dynamic frameworks on iOS for the Firebase SDK, and it is not currently a dependency of this project.

- [ ] **Step 2: Configure `app.json`**

Add to `expo.ios` (which currently has `bundleIdentifier`, `usesAppleSignIn`, `config`, `entitlements`, `appleTeamId`):

```json
"googleServicesFile": "./GoogleService-Info.plist"
```

Append to the existing `expo.plugins` array (keep every current entry — `expo-router`, `expo-dev-client`, `expo-splash-screen`, `expo-image-picker`, `expo-camera`, `expo-audio`, `expo-notifications`, `@kingstinct/react-native-healthkit`, `@react-native-community/datetimepicker`, `expo-apple-authentication`, `@react-native-google-signin/google-signin`, `@bacons/apple-targets`, `expo-asset`, `expo-font`):

```json
"@react-native-firebase/app",
"@react-native-firebase/crashlytics",
[
  "expo-build-properties",
  {
    "ios": { "useFrameworks": "dynamic" }
  }
]
```

- [ ] **Step 3: Configure `firebase.json`**

`apps/mobile/firebase.json` **already exists** and holds Firebase CLI auth configuration (`auth.authorizedDomains`, `auth.providers`). React Native Firebase reads its own settings from a **`react-native`** key in the same file. **Add the key; do not replace the file** — the two coexist:

```json
{
  "auth": { "…leave exactly as it is…" },
  "react-native": {
    "crashlytics_debug_enabled": false,
    "crashlytics_auto_collection_enabled": true
  }
}
```

`crashlytics_debug_enabled: false` is deliberate: Crashlytics is disabled in debug builds by default, and that is what we want — a developer's own deliberate crashes must not pollute the beta's data.

- [ ] **Step 4: Verify the suites still pass**

Run: `cd apps/mobile && npx tsc --noEmit && npx jest --ci --forceExit`
Expected: green, unchanged counts. The Jest mock from Task 3 means adding the real package must not alter test behaviour — if counts change, something regressed.

- [ ] **Step 5: Write the symbolication runbook**

Create `docs/runbooks/kora-symbolicate-js-stack.md`:

```markdown
# Turning a minified Crashlytics stack into a readable one

Crashlytics does not consume React Native source maps, so a JS stack in the
dashboard is minified. This is the accepted cost of choosing Crashlytics over
Sentry (see `docs/superpowers/specs/2026-08-13-kora-crash-reporting-design.md`).

## Before you reach for this

Most reports do not need a stack. Each carries `error_class`, `status`, `route`
and — for API failures — `request_id`. That last one appears verbatim in the Go
API's logs, which are not minified:

    kubectl --context=gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke \
      logs -n kora deploy/kora-api | grep '<request_id>'

Start there. Symbolicate only when the failure is genuinely client-side.

## Symbolicating

1. Read the **build number** from the Crashlytics report. Crashlytics records
   it natively from the binary, so there is no ambiguity about which build.
2. Download that build's source map from the EAS build's artifacts.
3. Save the minified stack to a file, then:

       npx metro-symbolicate /path/to/main.jsbundle.map < stack.txt

## Keeping the maps

Source maps are EAS build artifacts and expire. For any build distributed to
TestFlight, download the map and retain it for as long as that build is
installable — a map you cannot fetch makes this runbook useless exactly when
you need it.
```

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/package.json apps/mobile/package-lock.json apps/mobile/app.json apps/mobile/firebase.json docs/runbooks/kora-symbolicate-js-stack.md
git commit -m "feat(mobile): install and configure firebase crashlytics"
```

If the plist is present, add it in the same commit:

```bash
git add apps/mobile/GoogleService-Info.plist
```

---

## Definition of done

- [ ] `cd apps/mobile && npx tsc --noEmit` clean.
- [ ] `cd apps/mobile && npx jest --ci --forceExit` green.
- [ ] A 500 produces exactly one report carrying `error_class`, `status`, `route`, `request_id`.
- [ ] A 401 produces none.
- [ ] No payload contains an error message, a response body, or a raw path id.
- [ ] A render error shows the fallback and is recoverable via "Try again".
- [ ] With no native module present, the app behaves exactly as before.

## Device verification (cannot be done in CI or the simulator)

`@react-native-firebase/crashlytics` is a native module and **cannot load in the
Expo dev client**, so unlike #106 this cannot be proven on the simulator. It
needs a real EAS build. Carry these into #104's closing comment:

1. Build a **production-profile** EAS build and install via TestFlight.
2. Trigger a deliberate throw; confirm it appears in the Crashlytics console
   with a stack, and that the **app version and build number** shown match the
   binary — this is the "maps to a known binary" criterion.
3. Force an `apiFetch` failure against a 5xx; confirm it appears with `status`
   and `route`, and **without** any user content.
4. Confirm the `request_id` on that report matches a `request_id` in the API
   logs for the same request.
5. Trigger a 401; confirm **no** report appears.

## Out of scope

- **#43** product instrumentation.
- Breadcrumbs and session replay.
- Native crash tuning and ANR reporting beyond Crashlytics' defaults.
- Android verification — R1 is iOS TestFlight. The code is platform-neutral but only iOS is verified.
- Alerting thresholds — deliberately unset for R1; 10–30 users give no baseline to alert against.
