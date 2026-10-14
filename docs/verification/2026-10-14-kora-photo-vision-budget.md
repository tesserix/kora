# Kora photo analysis latency repair

A real Chicken Salad upload returned HTTP 500 after 19.2 seconds: native OCR had
no usable fields, Jev successfully chose vision, and the primary Vertex request
was canceled by the ten-second caller budget. An authenticated `kora-eval` public
API reproduction failed in the same flow. Component recognition was not proof
of successful photo analysis.

## Resulting behavior

Native OCR runs first. Missing or unreadable label evidence goes to mandatory
Jev routing, which can select food vision. The original normalized image is
preserved for Vertex and any required independent Claude Sonnet 5.5 reading.
The food-identity schema remains strict; nutrition comes from database rows;
consumed portions remain unknown and assumed portions require confirmation.
No OCR AI provider, automatic diary write or new authentication bypass is added.

Analysis is bounded to 65 seconds. Native OCR retains ten seconds; each Jev
request retains four; primary food identity has 25 and independent meal review
has 15. Their serial maxima total 58, leaving seven seconds for matching and
orchestration. Archive upload and completion have separate five- and two-second
bounds. Only photo multipart transport receives 75 seconds, within the existing
100-second Istio per-try and 150-second server limits. Direct and queued uploads
use the same transport helper. Other routes retain their deadlines. Caller
cancellation still takes precedence. No new service, store, retry loop or queue
is required. These bounds do not establish the unmeasured p99 latency target.

The SDK previously made three accepted HTTP requests on a transient primary
photo failure. Photo SDK retries are now disabled, as independent review retries
already were. Analysis deadlines return a retryable `ai_analysis_timeout` 503;
mandatory decision failures retain the separate fail-closed error.

Go is exactly 1.27.2 in the module, CI and digest-pinned Docker builder, and the
repository instructions record that these must remain aligned.

## Verification

Regression tests failed before their fixes:

- Real-Postgres photo HTTP pipeline: expected 200, got 500 when the primary food
  provider needed 14 seconds. The fixed test covers native OCR with no fields,
  both Jev decisions, a 12-second independent review, original-image preservation,
  actual nutrition matching, completed archive analysis and zero diary rows.
- Primary provider failure: expected one paid request, observed three SDK retries.
- Photo multipart response after 40 seconds: expected success, got TimeoutError.
- Analysis deadline: expected retryable 503, got generic 500.

All now pass. Deterministic virtual-time tests also verify the 25-second primary
and 15-second review limits stop further work. Mobile tests cover the separate
hard deadlines for photo and voice, unchanged cancellation, authentication,
real Expo multipart conversion and queued photo uploads.

Commands run with GOTOOLCHAIN=go1.27.2: full `go test -race -p 1 ./...` against the
migrated disposable Postgres database (67 packages passed), `go vet ./...`,
`go build ./...` and `gofmt -l .`. After the final deadline test addition, the full
OCR package and its vet/format checks were run again. Mobile `npx tsc --noEmit`,
`npm run lint`, `npx expo-doctor`, `npx expo customize tsconfig.json` and the full
`npm test -- --runInBand` succeeded: 256 suites, 2499 tests. Lint has 44 existing
warnings and zero errors. One earlier full mobile run hit a five-second timeout
in the unchanged saved-meals test; its isolated run passed in 63 ms and the complete
suite then passed without skipping tests or increasing their timeout.

`govulncheck ./...` found no reachable vulnerabilities. Gitleaks scans of the
patch and new HTTP test found no secrets. Trivy source scans found no secrets,
and reported existing Go/mobile dependency advisories and the low-severity
missing Docker HEALTHCHECK. `npm audit --audit-level=high` still reports the
existing 52 high and eight moderate advisories; no mobile dependency changed.

## Release boundary

Production rollout and an authenticated full public API success are pending.
Use the existing non-admin kora-eval identity with a supported Kora-audience JWT,
keep credentials only in memory, and use a public Chicken Salad fixture. Verify
completed native OCR evidence, Jev vision routing, primary identity, required
independent review, nutrition result and private archive completion; no diary
write is permitted. The mobile deadline patch requires a new binary build because
this application has no configured OTA delivery. Do not claim installed mobile
clients received the transport change from an API rollout.

The public OCR UI stays at zero replicas. Native OCR installations and gateway
model/review configuration are unchanged. Rollback is the prior working API image
with the mandatory gate intact; retained captures and database tables remain.
