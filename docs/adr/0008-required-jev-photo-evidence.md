# Required Jev decisions and OCR evidence

Status: accepted. Deployment and live verification are tracked in Kora PR #596 and infrastructure PRs #1344 and the processor release PR.

## Boundaries and budgets

Reuse the API, deterministic nutrition-label OCR, private gateway and its external
processor. No new service or datastore. ADR-0007's planning assumptions remain
10,000 photos/day, 8 MiB maximum and 1.2 photos/s peak. Non-photo model traffic must
be measured before estimating total decision cost. Every gateway model request
adds one Jev call; photo evidence routing and meal-identity review add decisions. Readable labels avoid
vision, but net savings and accuracy improvements are not yet established.

The existing targets are 99.9% availability and photo p99 under 30 seconds, not
measured results. The former ten-second food-identification limit canceled real
Vertex reads, and the 22-second overall limit could not contain OCR plus required
meal review. Photo analysis is now bounded to 65 seconds: OCR at most ten,
each Jev decision at most four (gateway at most three), primary identification at
most 25 and independent meal review at most 15. Their serial maxima total 58
seconds, leaving seven for database matching and orchestration. Independent label
review remains bounded to ten. Caller cancellation and shorter deadlines take
precedence. Archive upload precedes analysis (at most five seconds), and persistence
adds at most two; the photo multipart client allows 75 seconds, inside the existing
100-second Istio per-try bound and the HTTP server's 150-second limit. Other mobile
requests retain their original deadlines. This bounded repair does not establish
the p99 target; measure before claiming it. No new queue or store is introduced.
Primary photo calls disable SDK retries, as independent review already does, so a
paid provider failure cannot silently run the same image three times. An analysis
deadline returns a retryable 503 with `ai_analysis_timeout`; Jev failures retain
their separate fail-closed error.
Existing storage precedes analysis. Gateway buffering is bounded to 16 MiB for
base64 overhead. Jev concurrency uses a bounded HTTP connection pool.

## Flow

Archive normalized image, run OCR, pass bounded status evidence to Jev, then route
to label facts, independent label review, ordinary food vision or retake. Preserve
OCR job, status, decision model, policy and checked label in capture analysis.
Readable labels return nutrition per 100 g/ml with unknown consumption. Vision
portions are explicitly assumed and require confirmation. Before database matching,
Jev reviews the initial food guesses. Mixed dishes, curry, gravy and ambiguous
fish/meat preparation can trigger one original-image reading on the independent
Claude Sonnet 5.5 route. The API rejects a different review model. Keep complete
dish identity (fish curry, not plain fish); never claim hidden spices or oil
quantities from appearance. Each model and decision attempt is metered, and
a failed usage write or exhausted quota stops escalation. Numerical validation
can downgrade Jev decisions; Jev cannot override units or authorize diary writes.

The gateway sets a constant `kora.jev_required` attribute on every model route,
including Python agents and workload embeddings. Its external processor calls
Jev before forwarding. The existing decisions endpoint is excluded to prevent
recursion. Deterministic OCR and arithmetic are not AI operations.

The global gate permits or stops the current operation. Photo routing chooses
between existing food-vision and stronger label-review models. Arbitrary model
selection for other capabilities is not implemented. Jev receives bounded user
text and operation metadata, not image/audio bytes, system prompts or credentials.
All content is untrusted. Existing authentication and ownership checks remain
independent of Jev.

## Failure and security

Jev unavailable/invalid/timed out: no downstream model call, retryable failure.
Review/reject: stop processing and request better evidence. Kora's external
processor fails closed; other products keep existing behavior. OCR unavailable
is evidence for Jev, which can choose vision. Quota/usage-ledger failures stop
photo processing. Cancellation propagates; usage writes have detached bounded
deadlines. No new retry loops, database migration or deletion behavior.

Assets are images, nutrition data, credentials and decision integrity. Malicious
uploads/prompts and compromised callers cross validated boundaries. The API owns
user authentication and private archive ownership. The gateway processor consumes
the existing Kora-specific OpenBao-backed TypeSafe credential; payloads are never
logged. Image retention and account deletion remain governed by ADR-0007.

## Release gates

First build and verify an external-processor image supporting mandatory Jev and
16 MiB buffering. Pin its digest before enabling credentials/egress and the
registry-owned fail-closed policy. Cloud Build `0f006cff-692a-4151-bea1-68d5ce0fbeb6` verified and published
processor digest `sha256:4e58d6ac0922db2954d24f6f81d7624d1f99944002e8ea7415b25d37133643db`.
Deploy that processor before the gateway policy; the previous image does not enforce Jev. Test synthetic chat, image, speech, workload
embeddings and induced Jev failure. Then release the OCR-first API and verify
upload, analysis, archive and diary behavior through the real API.

Reverting the gate restores bypass behavior and conflicts with mandatory Jev;
prefer the last working mandatory-gate image. Photo routing can be reverted
independently without deleting captures. Production rollout and failure injection
remain separate from local and provider-contract tests.

## Validation and limits

The Go API race suite passed with a migrated disposable Postgres database. Gateway
processor checks cover strict decisions, missing credentials, provider failures,
and rejecting unsupported measurements; its 72 tests meet the 90% coverage floor.
The rendered gateway manifests pass 39 tests. A local agentgateway v1.4.1 protocol
probe preserved an 8 MiB synthetic image payload byte-for-byte, rejected an
oversized body, and blocked backend forwarding on a simulated Jev failure.
Live TypeSafe checks passed seven operation cases and three meal-routing cases
(plain fish and fish curry require review; a simple banana is accepted).

These are contract and routing checks, not measured nutritional accuracy or a
production end-to-end release test. The observed customer capture already matched
Fish curry before this change. Its ingredients, oil quantity, served weight and
consumed weight cannot be established from the image. Photo candidates retain
reference portions marked assumed; the mobile calorie-range flag is reserved
for results that actually contain a range. No customer image is a test fixture.

Existing scanner findings remain in the mobile lockfile and the processor's
transitive dependencies. Do not represent this release as vulnerability-free.
Decision attempts are recorded but TypeSafe pricing and gateway per-user cost
attribution require verification before claiming cost accounting or savings.

Verification commands: `gofmt -l .`, `go vet ./...`, `go build ./...`, and
`TEST_DATABASE_URL=<disposable local database> go test -race -p 1 ./...` passed.
Processor Ruff formatting/lint, strict mypy, pytest (72 passed, 91.43% coverage),
`uv build` and generated-protobuf verification passed. Gateway manifest unittest
discovery and Helm lint passed. `govulncheck ./...` reported no reachable
vulnerabilities. Trivy reported pre-existing dependency findings; full-history
`gitleaks git --redact` exited nonzero with eight historical findings in test and
planning files, requiring triage rather than suppression. New source scans found
no secrets. Mobile checks were skipped because no mobile source changed.
Production lifecycle and accuracy benchmarking remain unrun for this release.
