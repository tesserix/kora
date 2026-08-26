# Handoff — R6's console integration is done; #43 and #328 are what remain

You are picking up **Kora** (`/Users/Mahesh.Sangawar/personal/tesserix-new/kora`),
a nutrition-tracking iOS app: Go API + Expo/React Native, pre-launch.

**There is ONE real user — the owner.** Unchanged from the previous handoff and
still the single most useful fact for judging urgency.

`main` is at **`41a005b6`**. Six PRs merged here today, newest first: `41a005b6`
conformance in CI (#464) · `ce185b50` the real first-try rate (#463) ·
`1e2812ba` resolution outcomes (#462) · `1d386147` the metrics rollup (#461) ·
`08f5ba74` data export (#460) · `be38069b` the console contract's five read
endpoints (#458). Plus **tesserix-k8s#637**, which registered Kora with the
platform console, and **tesserix-k8s#638** (chart version bump — see the
mistakes section).

**The repo is PUBLIC.** Never put a real weight, measurement or intake value in
a commit, comment, test fixture, issue or PR. Describe results as counts.

## The single most important thing

**Kora is federating with the platform console, verified in production.**

Not inferred — driven end to end against the live cluster:

| | |
|---|---|
| unsigned `/v1/admin/kpis` | **401** (was 404 before registration) |
| signed `/admin/kpis` | **501** `not_implemented`, the deliberate answer |
| signed `/admin/audit-logs?limit=5&since_hours=720` | **200**, real rows in §4.1's envelope |
| replay of that exact request | **401** — the nonce store refused it |

That audit-logs call used the fan-out's exact query shape, which is what proves
the canonical-QUERY half of the signature agrees byte-for-byte between
platform-api's client and Kora's verifier. `bffauth` does not sign the query at
all, so nothing else in this repo exercises that.

## Ten issues closed

#431 #432 #433 #434 #435 #447 (the console contract) · #24 (data export) ·
#105 (Redis — was already fixed in prod, nobody had shut the issue) · #459
(resolution outcomes) · #430 (registration + conformance).

## What is actually left in R6

- **#43 — success metrics.** The exporter and the SQL rollup are done. The
  Grafana dashboard is **blocked on infrastructure**, see below.
- **#328 — the closed-beta epic.** Entry criteria: #105 done, #24 done, #43
  partial.

Unrelated and still open: **PR #450** (identity design doc) and **PR #309**
(offline barcode queue, draft).

## The finding most likely to go stale, and it is silent

**Kora's metrics are exported correctly and collected by NOBODY.**

- The observability estate — Grafana, `prometheus-server`, Alertmanager, the
  whole OTel/ClickHouse stack — is parked at **0 pods** since 2026-08-01 to cut
  spend (`tesserix-k8s/docs/observability-park.md`). The `observability` node
  pool was deleted.
- GCP Managed Prometheus is **not enabled** on the cluster:
  `managedPrometheusConfig: {}`, and there is no `gmp-system` namespace.
- `PodMonitoring` is GMP's CRD. `PodMonitoring/kora-api` has existed for 21+
  days and **nothing reconciles it**.

The exporter itself works — verified off the live pod. It is talking to an empty
room. Do not write a Grafana dashboard until one of those is fixed; it would
render nothing, querying a Prometheus that is not running, over metrics nobody
collects.

**One trap if you do revive it:** only the food-index GAUGES appear on
`/metrics`. A Prometheus `CounterVec` emits no series until first incremented,
so with one real user `kora_ai_calls_total` renders **No data**, not zero — and
in PromQL that is indistinguishable from the exporter being down. Any dashboard
needs a liveness panel built on a gauge.

## Decisions made today — do not relitigate

- **#447: the console is READ-ONLY for Kora.** Foods and users are edited in
  Kora's own portal. Reopening means first answering §8.3 — capability values
  (the vocabulary is unsettled; mark8ly's `RequiredWriteCapabilities` values are
  all empty for the same reason), reason codes, and confirmation semantics.
- **#435 stays a 501.** §3.1 forbids `{}` and zeroes. #43 decides which numbers
  are headline; one candidate became computable with #459 and it still should
  not ship alone.
- **Two signing schemes, permanently.** `bffauth` (the tesserix-home admin
  portal) and `platformauth` (the console's federation client) verify
  byte-incompatible canonical strings. They are separate keys and must stay so —
  sharing one would mean rotating either caller's credential silently revokes
  the other's.
- **The export records every table, read as maps via `SELECT *`.** No Go struct
  mirrors any table, so a new COLUMN appears with no code change.
- **`food_resolution_outcomes` records every ATTEMPT, not every failure.**
  Failures-only gives a count and not a rate; the denominator is attempts, and a
  cache hit never reaches the provider so `ai_usage_events` cannot supply it.
- **`FirstTryRate` excludes alias hits.** An alias hit is a phrase the resolver
  got wrong once already and a human fixed; counting it as a first-try success
  would let the correction loop improve the metric measuring whether corrections
  are still needed.

## Two mistakes I made, so you do not repeat them

**1. I asserted a published package did not exist by checking the wrong place.**
I looked for `tesserix-home/packages/admin-conformance` and concluded
`@tesserix/admin-conformance` "does not exist" — repeated across three issue
comments and a PR body, and it had #430 recorded as blocked for hours. It is on
npm (`0.3.0`). **For a published package, query the registry, not the monorepo.**

**2. I merged tesserix-k8s#637 with `Lint Helm Charts` still in flight, and it
failed.** `ct lint` requires a `Chart.yaml` version bump on any chart change;
I changed two `values.yaml` files and bumped neither. #638 fixes it. Nothing
broke — ArgoCD syncs from the path, not a chart version — but `main` carried a
red check and the next person touching either chart would have inherited it.

## Repo traps — new today

- **`ct lint` requires a chart version bump** on every change to a chart in
  `tesserix-k8s`. Patch bump, per the convention in `792764fc`.
- **There is no Service named `kora-api`.** It is `kora-api-direct` (port 8080).
  The others in that namespace are `kora-ai-agents` and the postgres set.
- **Kora's federation base URL must end in `/v1`.** The client signs the DECODED
  `URL.Path` including whatever prefix `BaseURL` carries.
- **Order matters when adding a federated product.** platform-api went into
  `CreateContainerConfigError` because it referenced the `kora-federation`
  secret before the ExternalSecret Application had synced. Old pods kept
  serving, so it was a stuck rollout rather than an outage. Sync the
  secret-bearing Application first, or nudge it with
  `kubectl annotate application -n argocd external-secrets-resources argocd.argoproj.io/refresh=normal --overwrite`.
- **`external-secrets-resources`** (path `external-secrets/prod`) is what owns
  `external-secrets/prod/tesserix/externalsecret.yaml`, despite `recurse`
  reading empty.
- **GORM's `.Limit(1).Update(...)` does not limit in Postgres** — UPDATE takes no
  LIMIT, so GORM drops it and the update hits every matching row. Update by id.
- **`npm i` in a bare `/tmp` dir walked up and installed elsewhere.** Create a
  `package.json` first and use `npm --prefix`.
- Everything in the previous handoff still applies: gopls lies here, 5432 is the
  dev DB and 5433 the test DB, `config.Load()` does not read `.env`,
  `pkill -f "go run"` kills the wrapper not the binary, never run prettier,
  `Closes #1, #2` only closes #1, and `gh pr merge --auto` does not gate in this
  repo (no required checks).

## The verification practice that earned the most today

**Mutation testing caught three of my own tests passing while checking nothing.**

- A `jest.mock("react-native/Libraries/Share/Share")` that intercepted no module,
  so "removes the file even when sharing fails" was green while the file had
  never been written.
- A double-press test that awaited between presses, letting `pending` commit so
  `disabled` blocked the second press — the ref latch it claimed to test was
  never exercised, and removing it entirely still passed.
- A voice test that exhausted the budget, so `ResolveVoice` returned at its own
  branch and never delegated — reverting the delegation still passed.

Each looked green. **Treat any suite here without a mutation pass as
unverified.** Roughly 40 mutations were run today and all were eventually
killed, but only after fixing those three tests.

Also still true, and re-earned: check the exit code rather than the summary; a
skipped test is not a pass; run DB suites twice and confirm tables return to
zero.

## Session state — cleaned up

Both local API processes (ports 8098/8099) are stopped and the ports are clear.
The test DB (5433) is back to zero rows in every table the suites touch. Nothing
is left running.

**Disk:** the machine was at 2.3 GiB free (100% full). Cleared ~24 GB — Xcode
DerivedData, npm/CocoaPods caches, iOS DeviceSupport, Xcode Archives,
`apps/mobile/ios`, and 21 of 22 simulators. **Kept `iPhone 17 Pro Max`
(`8B6D805C`)** — it has `com.tesserix.kora` plus three other Tesserix apps and
was in use today.

**Next local iOS build needs `npx expo prebuild -p ios`** — the `ios/` directory
was deleted (it is gitignored and regenerable).

Three `com.apple.os.update-*` APFS snapshots still hold space, one named
`MSUPrepareUpdate`. Left alone deliberately: deleting an OS-update snapshot can
break a staged macOS update.

## Unverified / in flight at handoff time

- **The `api` job for #464 was still running when this was written.** It ran
  green locally (8 passed, 0 failed, exit 0) but that was its first CI run.
  If `main` is red, that step is the place to look.
- **The dependabot alerts are NOT the emergency the count suggests.** Eight
  open, seven "high" — but all are transitive BUILD-TIME deps of the Expo
  toolchain (`@bacons/apple-targets`, `expo-splash-screen`, react-native's
  Metro), and three do not match the installed versions at all: the `uuid`
  advisory covers `>=12.0.0` while 8.3.2/7.0.3 are installed, and one xmldom
  advisory covers `<=0.6.0` while 0.7.13/0.8.13/0.9.10 are. **Four apply**, and
  `image-size` has no patch at any version. Nothing ships into the app bundle.
