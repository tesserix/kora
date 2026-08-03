# Handoff — 2026-08-04

Take over Kora development at `/Users/Mahesh.Sangawar/personal/tesserix-new/kora`
(branch `main`, clean, everything pushed). Sibling repo: `../tesserix-k8s`.

## START HERE

    .superpowers/sdd/progress.md    ← the ledger. Trust it and `git log` over
                                      anything else, including this file.
    ~/.claude/projects/.../memory/MEMORY.md   ← durable gotchas, several written today

`main` is at `9e16b45`. Two PRs merged today: **#78** (offline queue slice 1,
deployed and digest-verified) and **#80** (the `food_logs.source` fix).

## THE TASK

**Fix #82 — photo and voice capture have never worked.** This is the R1 blocker.

Both upload through the same legacy React Native file part, which this RN
version rejects outright:

```ts
// src/api/hooks.ts:588 (useResolvePhoto) and :621 (useResolveVoice)
form.append("file", { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
```

Runtime error, captured with a temporary `console.warn` of the `NetworkError`'s
`cause`:

```
NetworkError | Network request failed | cause: Unsupported FormDataPart implementation
```

Those two lines are the **only** `FormData` appends in the app, so one mistake
breaks both modalities — which is why `identify_photo` **and** `transcribe` both
sit at zero rows in `ai_usage_events`.

**Read `apps/mobile/AGENTS.md` first.** It says: *"Expo HAS CHANGED. Read the
exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing
any code."* That warning is exactly what this bug is. Do not guess the API.

Two candidate fixes, and the trade-off is real:

1. **A real `Blob`** — `await fetch(file.uri).then(r => r.blob())`, then
   `form.append("file", blob, file.name)`. Keeps `apiFetchMultipart` and
   therefore `fetchWithRetry`'s token refresh and 401 retry.
2. **`expo-file-system`'s `uploadAsync`** with `FileSystemUploadType.MULTIPART`.
   Bypasses `FormData` entirely but loses `fetchWithRetry`'s auth handling, which
   you would have to reimplement.

Check what the SDK 57 docs actually prescribe before choosing.

### Why the tests did not catch it, and what that means for yours

The existing tests **mock `apiFetchMultipart`**, so `FormData.append` is never
executed and the suite stayed green through a completely broken feature. A fix
whose test also mocks the transport proves nothing. Write a test that exercises a
real `FormData`, and verify on the simulator too.

### THE TRAP THAT KEEPS CATCHING THIS CODEBASE

More than a dozen assertions here have passed while verifying nothing. Two shapes:

- **The assertion is true but not binding.** A "leaves the queue alone" check run
  against a queue that was never populated.
- **The test runs in a state the feature isn't for.** Fourteen green tests
  nominally covering offline behaviour, every one executed with `onlineManager`
  reporting online — so the feature was dead in its only real condition. This
  one recurred three times in a single plan. And #82 itself is the same shape:
  green tests that never touch the code path they name.

So: reason **backward** from "what implementation would make this pass while
broken?", never forward from your implementation. Then break the behaviour each
test names, confirm it fails **on that test's own assertion**, revert, and
confirm `git diff` is clean. Review-by-reading has never once caught these.

## AFTER #82

- **Verify voice end to end**, not just photo. Same line, but not separately
  reproduced.
- **#81** — `ai_usage_events` records only *successful* calls, and `withFallback`
  drops the primary leg. COGS is a one-directional undercount, and a failing AI
  path leaves no trace. This is *why* nobody noticed #82. Fix before #43's
  exporter.
- **#79** — Istio's `perTryTimeout: 30s` makes `router.go`'s 90s `fallbackBudget`
  unreachable; the comment justifying 90s cites a ~75s cold start the gateway
  makes impossible. Three costed options in the issue; needs a human decision.
- **#43** — taxonomy is **decided** (two counters: `resolution` =
  identify_photo|identify_text|transcribe|coach, median 6.0; `derived` =
  decompose|embed, median 8.0; total COGS is the sum). Exporter deliberately
  unbuilt until #81 and #82 land, or it ships wrong.
- **#83 / #84 / #85** — filed follow-ups: 13 mutation sites with no error
  surface; the device-vs-profile timezone split; the grouped chore checklist.
- **#22 slice 2** — deferred AI resolution of photo/voice. Blocked on #82.

## R1 STATUS

Milestone shows 3 open / 2 closed, which understates it. Working and **verified
on device against prod**: onboarding (the bounce is fixed, `08f57ff`), manual
search, barcode, memory/pins logging, corrections (#20), confidence tiers (#21),
safety guardrails (#23), and the offline queue (#22 slice 1). The coach backend
is deployed; its mobile UI is a differentiator, not R1-blocking.

Broken: **photo and voice**. That is the whole remaining gap on the critical
path — and a beta user handed this app reaches for the camera first.

## ENVIRONMENT

    Postgres (Go tests):  TEST_DATABASE_URL='postgres://kora:kora_dev@localhost:55432/kora?sslmode=disable'
    Mobile (from apps/mobile): npx tsc --noEmit; npx jest --ci --forceExit
      — currently 108 suites / 710 tests green, must stay green
    Expo deps: `npx expo install <pkg>`, never plain npm install
    `npx expo lint` REGENERATES apps/mobile/eslint.config.js, which is untracked
      on purpose. Never commit it — check `git status` before staging.

### Metro — the trap that nearly wasted a whole verification pass

`npx expo run:ios` printed *"Waiting on http://localhost:8081"* and silently
**attached to a Metro belonging to a different project** (`Home-Chef-App`). The
bundle contained `EXPO_PUBLIC_API_URL = "https://vendors.fe3dr.com/api/v1"`.
8081 and 8082 are both taken by Home-Chef-App, so the old handoff's "use 8082" is
stale. Use 8083:

    cd apps/mobile && EXPO_PUBLIC_API_URL=https://kora-api.tesserix.app \
      npx expo start --port 8083 --dev-client

**Always verify by grepping the served bundle, never Metro's startup line:**

    curl -s "http://localhost:8083/node_modules/expo-router/entry.bundle?platform=ios&dev=true" \
      | grep -oE '"EXPO_PUBLIC_API_URL": \{ enumerable: true, value: "[^"]*"'

### Simulator

Sim `AD109A46-2F99-43C3-8AAA-FEE68DC8499E`. `idb` lives at
`~/Library/Python/3.9/bin` (PATH-hidden). `idb ui describe-all` returns one JSON
**array** (not JSONL) — there's a helper at
`scratchpad/ui.sh` pattern in the ledger.

- **A native rebuild is needed after any new native module.** The build installed
  before today lacked `netinfo` and `expo-crypto` and physically could not run
  the offline-queue code. `npx expo run:ios --device <udid>`.
- **The sim camera cannot capture** — tapping the shutter does nothing. To reach
  `pickMealPhoto`'s library branch: `xcrun simctl privacy <udid> revoke camera
  com.tesserix.kora`, seed with `xcrun simctl addmedia <udid> <file>`, then accept
  "Allow Full Access" in-app.
- `idb ui text` **truncates** multi-word input — type, then check `AXValue`, then
  append the remainder.

### Testing offline — do NOT disable Wi-Fi

Mahesh declined this outright. It takes down the whole workstation including the
agent's own connectivity.

- **Mid-flight `NetworkError` path:** restart Metro with
  `EXPO_PUBLIC_API_URL=https://something.invalid` and reload. Firebase auth is a
  different host, so the session survives.
- **netinfo / pre-flight path:** needs a **physical device** in airplane mode.
  netinfo reads the *host's* interface state and there is no per-simulator
  toggle (`simctl status_bar --dataNetwork` only repaints the icon). This branch
  is **unverified** on device; its unit tests pass.

### Database — NOT Cloud SQL

The workspace `CLAUDE.md` says Cloud SQL + an Auth Proxy sidecar. That describes
the Tesserix marketplace services and is **wrong for Kora**. Kora is on
self-hosted **CloudNativePG**: cluster `global-postgres` in namespace `global`,
single instance, primary pod `global-postgres-1`, database `kora_db`, **shared
with devai/homechef/mark8ly/stockpilot**. Keep prod queries cheap and set
`statement_timeout`.

    kubectl exec -n global -i global-postgres-1 -c postgres -- \
      psql -U postgres -d kora_db < query.sql

### Deploying

`:latest` is a GAR pull-through mirror of GHCR and serves **stale** — "successfully
rolled out" has twice meant old code. `image.tag` on the live ArgoCD Application
is pinned to a commit SHA (the parent app-of-apps has `ignoreDifferences` on
`/spec/source/helm/parameters`, so it won't be reverted). Every deploy must bump
that parameter, then **verify the running digest against what CI printed**:

    kubectl -n argocd patch application kora-api --type=json \
      -p='[{"op":"replace","path":"/spec/source/helm/parameters/0/value","value":"<sha>"}]'
    kubectl -n kora get pod -l 'app.kubernetes.io/name=kora-api' \
      --field-selector=status.phase=Running \
      -o jsonpath='{.items[0].status.containerStatuses[0].imageID}'

Currently deployed: `sha256:93555349ba6b…` (commit `104b6de`). **Note `9e16b45`
is merged but NOT deployed** — it is mobile-only, so no API deploy was needed.

## PROCESS

Mahesh's global CLAUDE.md mandates **subagent-driven execution** for plans — use
`superpowers:subagent-driven-development`, regenerate each brief with that
skill's `scripts/task-brief`, and keep appending to the ledger. Never ask "inline
or subagent". Tell implementer subagents to run tests in the **foreground** —
backgrounded runs stall in this environment.

Commits: conventional prefix, **single line, no body, no trailers, no signature**.
Recent PRs are **squash**-merged.

## THREE LESSONS THAT KEPT PAYING TODAY

- **Measure before designing.** Every one of #79, #81 and #82 came from querying
  prod or driving the real app — none from reading code first. #43's exporter was
  *not* built precisely because measuring showed two of its three metrics were
  untrustworthy.
- **Green tests, merged PRs and "successfully rolled out" are all independently
  worthless as evidence.** #82 shipped broken behind a green suite because the
  tests mocked the transport. Verify the running digest, not the rollout.
- **Zero rows never means "unused."** #81 means a failed AI call leaves no trace,
  so a never-working path and a never-attempted path are indistinguishable. That
  ambiguity hid #82 for the life of the project.
