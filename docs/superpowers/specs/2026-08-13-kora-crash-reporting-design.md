# Crash & error reporting (#104)

Design for #104 — fault visibility for the mobile app. R1 is TestFlight to
~10–30 friends and family; today, when a friend's app crashes or a request
fails, we get **nothing**: no stack, no breadcrumb, no device context. The only
channel is asking them what they saw.

**This gates #109.** A beta without crash reporting is a beta you learn nothing
from, which is why it must precede TestFlight rather than follow it.

**Not #43.** That is product instrumentation — time-to-log, retention, source
mix. This is fault visibility. They answer different questions and neither
substitutes for the other.

## Why now

#81 taught this exact lesson at the API layer: a failing AI path left no trace,
so a never-working path and a never-attempted path were indistinguishable, and
that ambiguity hid #82 for the life of the project. The mobile app is in that
state today.

## Decisions

| Question | Decision |
|---|---|
| Provider | **Firebase Crashlytics** |
| Identity in reports | **Kora user UUID only** — no email, no display name |
| Handled API failures | **Server and client faults only** — 5xx and the typed errors; **not** 4xx |
| React render errors | **ErrorBoundary with a user-facing fallback**, not reporting alone |
| Reporting call sites | **A facade**, not direct SDK calls |

### On the provider choice

Sentry was recommended and **not** chosen. The trade-off was surfaced before
the decision and reaffirmed after, so it is recorded here rather than
relitigated:

- Kora uses the Firebase **JS** SDK (`firebase: ^12.16.0`). Crashlytics does
  not exist in it. This adds `@react-native-firebase/app` and
  `@react-native-firebase/crashlytics` — a **second, native** Firebase SDK
  running alongside the JS one. Auth stays on the JS SDK.
- It requires `GoogleService-Info.plist`, which this repo has never needed:
  there is no `googleServicesFile` in `app.json` today.
- Crashlytics is built for native crashes. **JS stacks will be minified**, and
  it does not consume React Native source maps the way Sentry does.

What was bought: no new vendor, no new processor holding user data, no new
bill, and everything stays inside the Firebase project the team already owns.

The minified-stack consequence is mitigated in two ways, both deliberate:
structured custom keys carry the diagnostic weight so triage rarely needs the
stack at all, and source maps are retained per build with a documented
symbolication step (§ Readable stacks).

## Architecture

A thin facade in `src/observability/`, with Crashlytics behind it. The
alternative — calling `crashlytics()` directly from `api.ts`, the global
handler and the boundary — was rejected for three practical reasons, none of
them purity:

1. **The native SDK cannot run in Jest, Expo Go, or the dev client.** A facade
   with a no-op fallback keeps the suite green and keeps the app runnable in the
   dev client used for day-to-day work. Direct calls would need native mocks at
   every call site.
2. **The provider may change.** Sentry was a live option and may become one
   again if JS-stack pain bites. A facade makes that one file.
3. **Redaction must live in exactly one place.** "No user content" is an
   acceptance criterion; enforcing it at N call sites is how a photo caption
   eventually leaks.

### Components

| File | Responsibility |
|---|---|
| `src/observability/reporter.ts` | Facade: `initReporting()`, `setReportingUser(id \| null)`, `reportError(error, context)` |
| `src/observability/classify.ts` | Pure: is this error reportable? |
| `src/observability/redact.ts` | Pure: strip user content, template route paths |
| `src/observability/crashlytics.ts` | The Crashlytics sink; no-ops when the native module is absent |
| `src/components/ErrorBoundary.tsx` | Catch render errors, report, render the fallback |
| `app/_layout.tsx` | `initReporting()`, global + unhandled-rejection handlers, wrap the tree |
| `src/lib/api.ts` | Call `reportError` on every failure; it decides |

`classify` and `redact` are pure functions with no imports from the SDK or from
`api.ts`. That is what makes the rules testable without a native module, and it
is where the real coverage lives.

**Where filtering happens, explicitly:** `api.ts` calls `reportError` on
**every** failure and never consults `classify` itself. `reportError` applies
`classify` internally and drops what is not reportable. The reason is the same
as for redaction — one enforcement point. A call site that decides for itself
whether to report is a call site that can get it wrong, and "why did this
failure never appear?" is the hardest kind of gap to notice.

## What is reported

### Crashes and unhandled rejections

Installed in `app/_layout.tsx` via React Native's `ErrorUtils.setGlobalHandler`
and the unhandled-rejection hook. Both route through `reportError`.

### React render errors

There is no `ErrorBoundary` anywhere in the app today, so a render error
currently shows a blank or red screen and the session is over. The boundary
reports **and** renders a Kora-styled fallback with a reset action, turning a
dead app into a recoverable one.

### Handled API failures

The point of the issue: the #82 class of bug never crashed, it just always
failed. Reported:

- **5xx** — the server broke.
- **`NetworkError`** — the request never reached a server.
- **`TimeoutError`** — the deadline passed.
- **`ResponseParseError`** — the server answered and the client could not read
  it. This is the class that hid the bodiless-204 bug in #106.
- **`AuthTokenError`** — `getIdToken()` rejected before any request was built.

Not reported: **4xx**. A 401 from an expired session, a 403, a 404, a 422 from
validation — these are the app behaving correctly. Reporting them would let one
expired session storm the dashboard and bury the signal the issue exists to
surface.

## What is attached

Crashlytics records **app version, build number, device model and OS natively**
from the binary, so "attach release/build id so a report maps to a known
binary" needs no additional work. Verify this on the first TestFlight build
rather than assuming it.

On top of that:

- `user_id` — the Kora UUID, via `setUserId`. Nothing else identifying.
- For API failures, as custom keys: `error_class`, `status`, `route`,
  `request_id`.

### `request_id` is the highest-value field here

`ApiError` already carries the server's `X-Request-Id` (`src/lib/api.ts:6-18`),
and the Go API logs `request_id` on every line. A client report therefore joins
directly to the exact server log entry that produced it. Most crash setups
cannot do this; it costs nothing here because both halves already exist.

## Privacy

The posture from #24 §7: no meal content, no photos, no free text in payloads.
Two rules enforce it, both inside `redact.ts`.

### Never forward the server's message

For a reported API failure the payload is constructed from `(class, status,
route)` only. The response body is **not** a source, because it can echo user
input. Meal descriptions, photos, voice transcripts and free text never leave
the device.

This also means `reportError` must not simply pass `error.message` through for
`ApiError`. It constructs its own.

### Template the route

Report `/v1/logs/:id`, never `/v1/logs/6f1b11bc-...`. Raw paths do two kinds of
damage: they leak identifiers into a third party, and they shatter grouping —
producing a thousand distinct issues with a count of one each, instead of one
issue with a count of a thousand.

Templating replaces path segments that are UUIDs or all-digits with `:id`.

## Testing

Per the #110 lesson — *an assertion whose expected value equals the initial
state cannot distinguish "it worked" from "nothing ran"* — the assertions below
check for the **presence** of constructed values.

- **`classify`** — a 500 is reportable; a 401 is not; a 404 is not; each typed
  error (`NetworkError`, `TimeoutError`, `ResponseParseError`, `AuthTokenError`)
  is. Table-driven, since the rule is a table.
- **`redact`** — a UUID path segment becomes `:id`; a numeric segment becomes
  `:id`; a path with no parameters is unchanged. **The payload contains no
  `message` field and no response body**, asserted against an `ApiError`
  constructed with a message that would be obvious if it leaked.
- **`reporter`** — with a fake sink, a reportable error produces one call
  carrying `error_class`, `status`, `route` and `request_id`; a non-reportable
  one produces **zero** calls.
- **No-op safety** — with the native module absent, `reportError` resolves and
  throws nothing. This is what keeps the dev client and Jest working, so it is
  a test, not an assumption.
- **`ErrorBoundary`** — a child that throws renders the fallback **and** calls
  the reporter; the reset action clears the error state.
- **`api.ts` integration** — a 500 response triggers exactly one report; a 401
  triggers none.

Suites must stay green: `cd apps/mobile && npx tsc --noEmit && npx jest --ci
--forceExit`. Baseline at time of writing: 165 suites / 1348 tests.

## Readable stacks

Crashlytics will show a **minified** JS stack. Two mitigations, in priority
order:

1. **The custom keys are the primary triage surface.** `error_class`, `status`,
   `route` and `request_id` identify most failures without reading a stack at
   all — and `request_id` reaches the server log, which is not minified.
2. **Source maps are retained per build**, and a runbook documents
   `npx metro-symbolicate` against the map for the build number in the report.
   Crashlytics records the build number natively, so there is no ambiguity
   about which map applies.

This is the accepted cost of the provider decision, recorded plainly rather
than discovered later.

## Acceptance criteria (from #104)

- A deliberately thrown error in a production-profile build appears in the
  dashboard with a stack — readable directly, or via the documented
  symbolication step.
- A failed `apiFetch` appears with **status + route**, and **without** user
  content.
- Verified on a **real TestFlight build**, not just the simulator.

Additionally, from this design:

- A 401 produces **no** report — verified by query on the dashboard, not by
  reading the code.
- `request_id` on a reported API failure matches a `request_id` in the API's
  logs for the same request.

## Verification, and its one hard constraint

`@react-native-firebase/crashlytics` is a native module. **It cannot load in the
current dev client**, so unlike #106 this cannot be proven on the simulator — it
needs a real EAS build. That is a property of the provider decision, not an
oversight.

On that build: throw deliberately, force an `apiFetch` failure, confirm both
land, and confirm a 401 does not.

## Out of scope

- **#43** product instrumentation. Different question, different issue.
- Breadcrumbs and session replay.
- Native crash tuning and ANR reporting beyond what Crashlytics does by default.
- Android verification. R1 is iOS TestFlight; the code is platform-neutral but
  only iOS is verified.

## Open follow-ups

- Revisit Sentry if minified stacks prove painful in practice. The facade makes
  this a one-file change, which is most of why it exists.
- Alerting thresholds. Deliberately unset for R1: with ~10–30 users there is no
  baseline yet to alert against.
