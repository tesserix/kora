# Kora image analysis review — 19 October 2026

The patch fixes reproduced defects in nutrition-label analysis: incompatible
deadlines, missing kilojoule extraction, and incorrect unreadable-image responses
for review outages and quota exhaustion. It also applies Expo's required SDK 57
patch updates. The user approved committing and releasing this patch on
19 October 2026. Production verification will follow the normal release process.

The review uses `a178707` from current `origin/main` in the isolated worktree
`/tmp/kora-prod-ocr-review`. The original working directory predates label OCR and
contains substantial unrelated edits; those files were preserved. Production API
image `6ff4dd8acf8cc2d7bda9b43f1dc80da3db46392d` already contains the previous food
photo latency improvements. The subsequent main-branch commits concern mobile
release tooling, signup links, and permissions.

| Reproduced problem | Change and regression evidence |
| --- | --- |
| Native OCR can take 14 seconds and independent review 12 seconds, but their shared deadline was 22 seconds. A valid 13-second OCR / 11-second review sequence failed as unreadable. | Allow 35 seconds overall while retaining the existing per-step deadlines. A deterministic `testing/synctest` regression now returns validated label values after 24 seconds. |
| The mobile label upload used the ordinary 25-second deadline despite sequential OCR/review. | Give `/v1/resolve/label` the existing 75-second image-analysis deadline, within the production ingress's 100-second per-try timeout. Photo, label, and ordinary voice deadline regressions pass; caller cancellation still works. |
| The review schema could return kcal but could not return printed kJ. A kJ-only panel could not reach the existing deterministic server conversion. | Add raw `energy_kj` to the strict schema and request printed values only. The regression preserves 1046 kJ and obtains 250 kcal through the existing validator; the model does no conversion. |
| When OCR found no fields and the review provider failed, the handler returned 422 and asked for a clearer photo. | Preserve review failure as a service failure and return 503 `ai_analysis_unavailable`. A reviewer that actually confirms no readable label still returns 422. Existing partial readable evidence remains available during an outage. |
| Exhausting quota between OCR and review also returned 422. | Return 429 `budget_exhausted` and make no review call. The regression first observed 422, then passed with 429. |
| Expo Doctor found two SDK patch mismatches. | Update Expo 57.0.29 → 57.0.30 and Expo Router 57.0.27 → 57.0.28 with a regenerated lockfile. Expo Doctor now passes all 21 checks. These configuration updates were verified with compatibility, type, lint, and full test checks rather than an artificial behavioral test. |

The assets at the trust boundary are private images, nutrition facts, user
identity, and paid AI allowance. An authenticated uploader can supply arbitrary
image content, including instructions printed inside an image. Extracted text
remains untrusted; strict schemas and numerical validation still govern the
result. The existing authenticated user context and delegated identity checks
are unchanged. The patch adds no endpoint, diary write, inferred consumption,
provider retry, credential, migration, or live configuration change.

Verification actually run:

| Command/check | Result |
| --- | --- |
| `go run ./cmd/migrate`, with `DATABASE_URL` and `TEST_DATABASE_URL` pointing only to the disposable localhost Postgres/pgvector database | Passed |
| `go test -race -p 1 ./...`, with the migrated local `TEST_DATABASE_URL` | Passed across 69 test packages; final confirmation recorded in `/tmp/kora-ocr-api-race-final.log` |
| `go test -race ./internal/labelocr ./internal/ai/providers -count=1` | Passed |
| `gofmt -l .` | Passed, no formatting output |
| `go vet ./...` | Passed |
| `go build ./...` | Passed |
| `CI=1 npx expo customize tsconfig.json` | Passed; no resulting tsconfig diff |
| `npx tsc --noEmit` | Passed |
| `npm test -- --runInBand` | Passed: 262 suites, 2,535 tests, after the SDK updates |
| `npm run lint` | Passed with 48 existing warnings and zero errors |
| `npx expo-doctor` | Passed: 21/21 checks after the SDK updates |
| `git diff --check` | Passed |
| `git apply --reverse --check /tmp/kora-ocr-fix.patch` | Passed; the generated patch matches the reviewed worktree |
| `gitleaks stdin --redact --no-banner < /tmp/kora-ocr-fix.patch` | Passed: no findings in the patch, including new test files |
| GolangCI-Lint | Not run: no repository GolangCI configuration or CI invocation was found; formatting and Go vet passed |
| Local HTTP integration test | Passed: a real multipart request through the actual Kora label handler, signed OCR client, upload/job/result protocol, and independent-review SDK against synthetic external services; verifies uploaded bytes, kJ conversion, usage records, review status, and unknown consumption |
| Authenticated public production upload / iOS and Android device capture | Not run: no authorized end-user test session was supplied. No screen layout or native API implementation changed. A mobile release and device smoke test remain necessary. |

Security checks completed, with unresolved baseline findings explicitly retained:

- `govulncheck ./...` passed with zero reachable vulnerabilities. It reported one
  advisory in a required module that the code does not call.
- `npm audit --audit-level=high` failed: 52 high and 8 moderate dependency findings
  after the patch, down from 54 high and 8 moderate before the SDK patch updates.
  High root advisories concern `braces` and `node-forge`; the installed versions
  are also the latest published versions checked during this review, and the
  vulnerability feed lists no patched releases. No force downgrade or advisory
  suppression was applied. Moderate findings also remain.
- `gitleaks git --redact` failed with eight pre-existing historical findings in
  tests and planning documents. These were not introduced by this patch. The
  redacted metadata is in `/tmp/kora-ocr-secrets.json`; no secret value was printed.
  History was not rewritten and no credential was rotated.
- `trivy fs --scanners vuln,secret,misconfig` completed against source and lockfiles
  with installed dependencies, generated graph files, and Git metadata excluded.
  It reported no source secrets, dependency advisories, and the existing low
  severity Dockerfile HEALTHCHECK finding. Its final result is
  `/tmp/kora-ocr-trivy-final.json`; this is not a clean security sign-off.

Production inspection was read-only under account `unidevidp@gmail.com`, project
`tesseracthub-480811`, context
`gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke`, namespaces `kora`,
`agentgateway-system`, and `document-intelligence`. Kora API, AI gateway, and OCR
production workers/APIs were Ready. Available API container logs contained no
recent image-analysis requests to correlate with the reported incident. The
specific production failure therefore remains unconfirmed until a failed request
time/ID or an authorized end-user smoke test is available.

The disposable local Postgres container was removed after verification. The
reviewed patch is `/tmp/kora-ocr-fix.patch`; it includes all modified and new files
and is based on current main, not the older original checkout.

During release, GitHub CI exposed an npm-version lockfile difference: npm 11 had
omitted two optional nested TypeScript 5.9.3 peers required by npm 10. The failure
was reproduced using CI's Node 22.19.0 / npm 10.9.3 (`npm ci` reported the missing
peers), then the lockfile was regenerated with that same toolchain. A real clean
install subsequently passed. The application's pinned TypeScript 6 remains
unchanged; no dependency constraint, install flag, or CI gate was relaxed.

Release through the normal reviewed GitOps API path and the normal mobile release
path. The approved mobile release uses version 1.0.4, with EAS-managed platform
build numbers incremented by the production profile. This version-only config
change uses release validation rather than a behavioral regression test. At the
time of this review, no production workload had been restarted, patched, scaled,
or rolled out. After release, test both a kJ-only panel and a meal photo,
correlate request IDs with usage/archive records, and confirm cancellation and
quota messages. The unresolved dependency advisories must remain visible during
release review; this patch is not a claim that every Kora issue is fixed.
