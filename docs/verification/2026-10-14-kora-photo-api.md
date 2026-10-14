# Kora Chicken Salad API investigation

The production request failed at its mandatory Jev decision, before food vision.
Two fixes are prepared and tested in isolated worktrees. They are uncommitted and
not deployed. The public OCR UI remains outside this change.

## Observed production request

The failing deployment preceded the API fix in this change.
Request: `POST /v1/resolve/photo`, HTTP 503, 2026-10-14 07:16:05 UTC.
Request ID: `6d939dd2-b57e-90db-8f19-a28266599153`.

A narrowly scoped read-only query of Kora's usage ledger showed:

| Step | Outcome | Duration |
| --- | --- | --- |
| Document Intelligence photo OCR | error/unreadable evidence | 9,165 ms |
| TypeSafe photo decision | timeout | 1,542 ms |

The corresponding native OCR job `job_909f3bd0c32a46209a41f8fc691f2bdf`
reached `review_required`. Missing label fields are expected for a food photograph
in strict native-only processing. Kora already understands that terminal status.
Its required decision subsequently expired against a 1,500 ms client budget.
Gateway access metadata confirms that it selected the TypeSafe upstream; the
record has no completed response status. No food-vision attempt was recorded for
that request. The specific cause of the upstream latency is not established.

This is distinct from the intentional native-only OCR restriction: embedded PDF
text is supported, while images/scanned documents require review. Kora's separate
food-image identification and mandatory Jev decisions continue to use AI.

## Prepared fixes

1. Allow four seconds for each Kora decision call and three seconds at both
   gateway decision routes. The caller's earlier cancellation/deadline still wins.
   Photo orchestration retains its 22-second limit. Strict identity checks,
   response validation, mandatory decisions, quotas and fail-closed behavior remain.
   There are no new retries or additional provider calls in a successful flow.
2. Treat OCR job status `failed` as terminal unreadable evidence. Previously Kora
   kept polling that terminal job until the caller deadline. This second defect
   was reproduced locally; it was not the status of the observed production job.

The gateway Helm source and generated Registry bundle are changed together.
Chart versions are `kora-ai-gateway` 0.1.29 and `agentgateway-route-sync` 0.4.27.
No imperative production configuration change, migration, credential rotation,
account creation or diary write was performed.

## Live component tests

Only a public Wikimedia Chicken Salad photograph was used:
https://upload.wikimedia.org/wikipedia/commons/4/42/Flickr_sa_ku_ra_10556400--Chicken_salad.jpg

| Component | Observed result |
| --- | --- |
| Actual Kora Go OCR client, signed as existing Kora workload | `review_required`, no label fields, reported OCR provider cost USD 0.00 |
| Native photo job | `job_a5e6daa7879a4cd08c204a81e7e43316`, 11.11 seconds |
| Authenticated internal gateway route, three OCR-evidence probes | HTTP 200, `jev-1.13.0`, route `vision`, 304–309 ms |
| Gateway negative authentication probe | Invalid synthetic signature rejected, HTTP 401, 155 ms |
| Configured primary Vertex model `gemini-3.5-flash` | HTTP 200, identified Chicken Salad, unknown portion, 7.33 seconds |
| Required Jev review of the resulting meal candidates | HTTP 200, route `review`, 314 ms |
| Configured independent model `claude-sonnet-5-5` | HTTP 200, identified Chicken Salad, unknown portion, 3.83 seconds |

The first standalone Vertex probe timed out at 20 seconds. A second bounded probe
succeeded. This is evidence of latency variability, not proof that vision meets
its production per-step deadline under all conditions. The native photo probe
used a 20-second test context; its 11.11-second duration exceeded the production
photo OCR step's ten-second budget. Production treats an OCR timeout as evidence
for the required Jev routing step. Neither probe is a latency or accuracy benchmark.

These live tests exercised component contracts. They did not authenticate an
end-user request through the public production Kora photo endpoint. The user
requested API testing without emulator login; no login bypass or synthetic JWT
was accepted by production. The isolated HTTP test uses a test identity only in
its local router.

## Regression and validation evidence

New tests first failed with:

- A valid decision delayed two seconds returned `context deadline exceeded`.
- The decision hard-limit test observed 1.5 seconds instead of the intended four.
- Both rendered gateway decision policies still had `1500ms` instead of `3s`.
- A terminal `failed` OCR job returned a polling deadline error instead of
  `ErrUnreadable`.

Those regressions now pass. The HTTP regression drives the actual Kora photo
handler and real typed decision client with isolated external dependencies. It
verifies success after the former decision limit, confirmation of assumed
portions, preservation of OCR review evidence, and HTTP 503 with no downstream
vision when the mandatory decision fails or exceeds its budget.

Commands actually run successfully:

```sh
# Kora API, with a migrated isolated local Postgres database:
TEST_DATABASE_URL=<isolated local database> go run ./cmd/migrate
TEST_DATABASE_URL=<isolated local database> go test -race -p 1 ./...
go vet ./...
go build ./...
gofmt -l <changed Go files>
git diff --check

# Infrastructure:
uv run --with pyyaml python -m unittest discover -s tests -p 'test_kora*gateway*.py'
uv run --with pyyaml python scripts/generate-agentgateway-platform-resources.py --check
helm lint charts/apps/kora-ai-gateway charts/apps/agentgateway-route-sync
git diff --check
```

The final API race suite passed across 67 packages; the gateway suite passed 40 tests. Patch-only Gitleaks scans passed with redacted
output. The initial photo HTTP suite could not run without `TEST_DATABASE_URL`;
that was resolved using a separate disposable database, never production data.
No repository GolangCI configuration was found. There is no mobile source change.
The iOS development build also succeeded, but authenticated emulator capture was
not exercised after the user chose API-only testing.

## Rollout and remaining verification

Production is still running the previous behavior. A new Kora API image and the
Registry-owned GitOps change require their own approved production rollout.
After rollout, verify the exact image/configuration, exercise the public photo
endpoint with an authorized test-user API token, and correlate successful photo
routing, identity review, archive persistence and usage records. Check that an
induced decision failure remains closed in an isolated environment. Live failure
injection into production was not performed.

The cloud boundary used for diagnosis was account `unidevidp@gmail.com`, project
`tesseracthub-480811`, context
`gke_tesseracthub-480811_asia-south1_tesseract-prod-in-gke`, Kora namespace `kora`
and gateway namespace `agentgateway-system`. Reconfirm that boundary before any
approved mutation. Prefer reviewed GitOps changes and the normal CI gates.

OCR still makes no AI-provider call. Successful Kora food analysis will incur its
existing Vertex, TypeSafe and independent-review costs. No savings, nutritional
accuracy guarantee or production end-to-end success is claimed from these tests.
